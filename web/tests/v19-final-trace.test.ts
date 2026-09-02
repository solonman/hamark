// 纯函数单测：最终版溯源视图的推导逻辑。见 lib/v19-final-trace.ts 与
// docs/20_最终版与评论跨版本_实施规格_V0.1.md 五、18/19。
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveV19FinalFieldTrace,
  describeV19FinalIntakeSource,
  describeV19StructuralIntake,
  latestAppliedV19FinalIntake,
  pendingV19StructuralIntakes,
  v19FinalTraceTargetExists,
} from "../lib/v19-final-trace.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1, V04ShotGroupPayload, V04ShotPayload } from "../lib/v04-contract.ts";
import type { V19FinalIntake } from "../lib/v19-ui-model.ts";

function shot(id: string, overrides: Partial<V04ShotPayload> = {}): V04ShotPayload {
  return {
    id, orderIndex: 0,
    startTime: "", endTime: "", shotScale: "", cameraAngle: "", cameraMovement: "",
    visualContent: "", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "",
    soundEffect: "", music: "",
    ...overrides,
  };
}

function group(id: string, shots: V04ShotPayload[], overrides: Partial<V04ShotGroupPayload> = {}): V04ShotGroupPayload {
  return {
    id, orderIndex: 0, bridgeName: `桥段-${id}`,
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "",
    shots,
    ...overrides,
  };
}

function payloadWithGroups(groups: V04ShotGroupPayload[]): V04DraftPayloadV1 {
  return { ...emptyV04DraftPayload(), script: { shotGroups: groups } };
}

function intake(overrides: Partial<V19FinalIntake> & Pick<V19FinalIntake, "id" | "seq">): V19FinalIntake {
  return {
    kind: "FIELD",
    targetKey: "facts.commercialIntent",
    targetLabel: "商业意图",
    value: "",
    source: "VERSION",
    sourceVersionNumber: 2,
    actorName: "李晓芸",
    applied: true,
    createdAt: "2026-08-23T09:47:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// v19FinalTraceTargetExists / deriveV19FinalFieldTrace
// ---------------------------------------------------------------------------

test("v19FinalTraceTargetExists is true for a facts.* field present on the payload", () => {
  const payload = { ...emptyV04DraftPayload(), factsAndCoreJudgement: { ...emptyV04DraftPayload().factsAndCoreJudgement, commercialIntent: "x" } };
  assert.equal(v19FinalTraceTargetExists(payload, "facts.commercialIntent"), true);
});

test("v19FinalTraceTargetExists is false for a shot that does not exist in the payload (e.g. inserted later)", () => {
  const payload = payloadWithGroups([group("b1", [shot("s1")])]);
  assert.equal(v19FinalTraceTargetExists(payload, "shot:s-not-there.visualContent"), false);
});

test("deriveV19FinalFieldTrace prepends the origin row when the target exists in originPayload", () => {
  const origin = { ...emptyV04DraftPayload(), factsAndCoreJudgement: { ...emptyV04DraftPayload().factsAndCoreJudgement, commercialIntent: "原稿意图" } };
  const intakes = [intake({ id: "i1", seq: 1, value: "李晓芸改的意图" })];
  const { rows, currentIndex } = deriveV19FinalFieldTrace(origin, intakes, "facts.commercialIntent");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].isOrigin, true);
  assert.equal(rows[0].value, "原稿意图");
  assert.equal(rows[1].value, "李晓芸改的意图");
  assert.equal(currentIndex, 1);
  assert.equal(rows[1].status, "current");
  assert.equal(rows[0].status, "overridden");
});

test("deriveV19FinalFieldTrace's origin row carries v1's ownerName when given, not a blank actorName", () => {
  const origin = { ...emptyV04DraftPayload(), factsAndCoreJudgement: { ...emptyV04DraftPayload().factsAndCoreJudgement, commercialIntent: "原稿意图" } };
  const { rows } = deriveV19FinalFieldTrace(origin, [], "facts.commercialIntent", "王大明");
  assert.equal(rows[0].isOrigin, true);
  assert.equal(rows[0].actorName, "王大明");
});

test("deriveV19FinalFieldTrace's origin row falls back to an empty actorName when originOwnerName is omitted", () => {
  const origin = { ...emptyV04DraftPayload(), factsAndCoreJudgement: { ...emptyV04DraftPayload().factsAndCoreJudgement, commercialIntent: "原稿意图" } };
  const { rows } = deriveV19FinalFieldTrace(origin, [], "facts.commercialIntent");
  assert.equal(rows[0].actorName, "");
});

test("deriveV19FinalFieldTrace omits the origin row when the target does not exist in originPayload (e.g. an inserted shot's field)", () => {
  const origin = payloadWithGroups([group("b1", [shot("s1")])]);
  const intakes = [intake({
    id: "i1", seq: 1, targetKey: "shot:s2.visualContent", targetLabel: "画面内容", value: "新镜头内容",
  })];
  const { rows, currentIndex } = deriveV19FinalFieldTrace(origin, intakes, "shot:s2.visualContent");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isOrigin, false);
  assert.equal(currentIndex, 0);
});

test("deriveV19FinalFieldTrace marks a later override current, the earlier applied row overridden, and an unapplied row pending", () => {
  const origin = { ...emptyV04DraftPayload(), factsAndCoreJudgement: { ...emptyV04DraftPayload().factsAndCoreJudgement, commercialIntent: "原稿" } };
  const intakes = [
    intake({ id: "i1", seq: 1, value: "李晓芸的版本", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" }),
    intake({ id: "i2", seq: 2, value: "张三的版本", applied: true, sourceVersionNumber: 3, actorName: "张三" }),
    intake({ id: "i3", seq: 3, value: "定稿后老王的版本", applied: false, sourceVersionNumber: 4, actorName: "老王" }),
  ];
  const { rows, currentIndex } = deriveV19FinalFieldTrace(origin, intakes, "facts.commercialIntent");
  assert.deepEqual(rows.map((row) => row.status), ["overridden", "overridden", "current", "pending"]);
  assert.equal(currentIndex, 2);
});

test("deriveV19FinalFieldTrace ignores intakes for other target keys and other kinds", () => {
  const origin = payloadWithGroups([]);
  const intakes = [
    intake({ id: "i1", seq: 1, targetKey: "shot:s-other.visualContent" }),
    intake({ id: "i2", seq: 2, kind: "INSERT_SHOT", targetKey: "shot:s2.visualContent", value: {} }),
  ];
  const { rows } = deriveV19FinalFieldTrace(origin, intakes, "shot:s2.visualContent");
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// latestAppliedV19FinalIntake
// ---------------------------------------------------------------------------

test("latestAppliedV19FinalIntake returns the highest-seq applied FIELD intake for the key", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, applied: true }),
    intake({ id: "i2", seq: 3, applied: true }),
    intake({ id: "i3", seq: 2, applied: true }),
  ];
  assert.equal(latestAppliedV19FinalIntake(intakes, "facts.commercialIntent")?.id, "i2");
});

test("latestAppliedV19FinalIntake skips unapplied rows and rows for other keys/kinds", () => {
  const intakes = [
    intake({ id: "i1", seq: 5, applied: false }),
    intake({ id: "i2", seq: 4, targetKey: "facts.storySynopsis" }),
    intake({ id: "i3", seq: 3, kind: "INSERT_SHOT" }),
  ];
  assert.equal(latestAppliedV19FinalIntake(intakes, "facts.commercialIntent"), null);
});

// ---------------------------------------------------------------------------
// describeV19FinalIntakeSource
// ---------------------------------------------------------------------------

test("describeV19FinalIntakeSource names the version and actor for a VERSION-sourced intake", () => {
  const text = describeV19FinalIntakeSource(intake({
    id: "i1", seq: 1, source: "VERSION", sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T01:47:00.000Z",
  }));
  assert.match(text, /^v2·李晓芸 08-23 /);
});

test("describeV19FinalIntakeSource labels a FINAL_DIRECT intake without a version number", () => {
  const text = describeV19FinalIntakeSource(intake({
    id: "i1", seq: 1, source: "FINAL_DIRECT", sourceVersionNumber: null, actorName: "老孙", createdAt: "2026-08-24T03:05:00.000Z",
  }));
  assert.match(text, /^最终版·直接修改 08-24 /);
});

// ---------------------------------------------------------------------------
// pendingV19StructuralIntakes / describeV19StructuralIntake
// ---------------------------------------------------------------------------

test("pendingV19StructuralIntakes keeps only unapplied INSERT_*/REMOVE_* intakes, sorted by seq", () => {
  const intakes: V19FinalIntake[] = [
    intake({ id: "i1", seq: 3, kind: "INSERT_SHOT", applied: false, value: {} }),
    intake({ id: "i2", seq: 1, kind: "REMOVE_GROUP", applied: false, value: {} }),
    intake({ id: "i3", seq: 2, kind: "FIELD", applied: false }),
    intake({ id: "i4", seq: 4, kind: "INSERT_GROUP", applied: true, value: {} }),
  ];
  const result = pendingV19StructuralIntakes(intakes);
  assert.deepEqual(result.map((row) => row.id), ["i2", "i1"]);
});

test("describeV19StructuralIntake names the bridge an inserted shot landed after, when that bridge still exists", () => {
  const current = payloadWithGroups([group("b1", []), group("b2", [])]);
  const text = describeV19StructuralIntake(
    intake({
      id: "i1", seq: 1, kind: "INSERT_SHOT", applied: false, sourceVersionNumber: 3, actorName: "张三",
      value: { parentGroupId: "b2", afterId: null },
    }),
    current,
  );
  assert.equal(text, "v3 张三 在桥段02后插入镜头");
});

test("describeV19StructuralIntake degrades to the bare verb when the parent bridge no longer exists in the current payload", () => {
  const current = payloadWithGroups([group("b1", [])]);
  const text = describeV19StructuralIntake(
    intake({
      id: "i1", seq: 1, kind: "INSERT_SHOT", applied: false, sourceVersionNumber: 3, actorName: "张三",
      value: { parentGroupId: "b-gone", afterId: null },
    }),
    current,
  );
  assert.equal(text, "v3 张三 插入镜头");
});

test("describeV19StructuralIntake labels a FINAL_DIRECT insert-group at the front of the list", () => {
  const current = payloadWithGroups([group("b1", [])]);
  const text = describeV19StructuralIntake(
    intake({
      id: "i1", seq: 1, kind: "INSERT_GROUP", applied: false, source: "FINAL_DIRECT", sourceVersionNumber: null, actorName: "老孙",
      value: { afterId: null },
    }),
    current,
  );
  assert.equal(text, "最终版·直接修改 老孙 插入桥段（列表最前）");
});

test("describeV19StructuralIntake names a removed group by its targetLabel", () => {
  const current = payloadWithGroups([]);
  const text = describeV19StructuralIntake(
    intake({
      id: "i1", seq: 1, kind: "REMOVE_GROUP", applied: false, sourceVersionNumber: 4, actorName: "老王",
      targetLabel: "乱世重逢", value: {},
    }),
    current,
  );
  assert.equal(text, "v4 老王 删除桥段「乱世重逢」");
});
