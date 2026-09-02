// 纯函数单测：最终版溯源视图的推导逻辑。见 lib/v19-final-trace.ts 与
// docs/20_最终版与评论跨版本_实施规格_V0.1.md 五、18/19。
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveV19AuxiliaryPathTrace,
  deriveV19ChoiceFieldTrace,
  deriveV19FinalFieldTrace,
  deriveV19PrimaryDetailTrace,
  describeV19ChoiceValue,
  describeV19FinalIntakeSource,
  describeV19FinalTraceHoverSource,
  describeV19FinalTraceRowLabel,
  describeV19StructuralIntake,
  firstLineV19TraceValue,
  latestAppliedV19FinalIntake,
  pendingV19StructuralIntakes,
  v19FinalTraceTargetExists,
} from "../lib/v19-final-trace.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1, V04ShotGroupPayload, V04ShotPayload } from "../lib/v04-contract.ts";
import type { V19FinalIntake } from "../lib/v19-ui-model.ts";
// Used to build expected strings for time-bearing assertions below instead of
// hardcoding a clock time — `formatShortDateTime` reads the local timezone
// (`date.getHours()`), so a literal "09-02 11:00" would only hold on a
// machine set to UTC+8.
import { formatShortDateTime } from "../lib/date-format.ts";

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

function factsOrigin(commercialIntent: string): V04DraftPayloadV1 {
  return { ...emptyV04DraftPayload(), factsAndCoreJudgement: { ...emptyV04DraftPayload().factsAndCoreJudgement, commercialIntent } };
}

// ---------------------------------------------------------------------------
// 简化规则 4（用户看了线上溯源模式后的调整）: 没变过的字段也要显示「当前采用」
// 一行（如「当前采用 · v1 赵雅诗 原稿」）——这一行就是溯源本身，不显示反而
// 让人以为漏了；只是不加旧写法／未纳入列表。真正什么都不渲染，只发生在连
// 当前采用都定不出来的时候：目标在原稿里不存在、也从没有过任何汇入记录。
// ---------------------------------------------------------------------------

test("deriveV19FinalFieldTrace: a field with no intakes at all still shows its 当前采用 line, just no history/pending lists", () => {
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿意图"), [], "facts.commercialIntent", "王大明");
  assert.equal(trace.hasTrace, true);
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
  assert.deepEqual(trace.overridden, []);
  assert.deepEqual(trace.pending, []);
});

test("deriveV19FinalFieldTrace: a field whose target does not exist in originPayload and has no intakes has truly nothing to show (no current line either)", () => {
  const origin = payloadWithGroups([group("b1", [shot("s1")])]);
  const trace = deriveV19FinalFieldTrace(origin, [], "shot:s-not-there.visualContent");
  assert.equal(trace.hasTrace, false);
  assert.equal(trace.currentSourceLabel, null);
});

// ---------------------------------------------------------------------------
// 简化规则 1: 合并重复行 — 紧邻前一行值相同就删掉，保留先出现的那行。这只处理
// 严格相邻的一对；一份原稿所属版本（v1）自己写下、但和它不相邻的重复记录，
// 由下面「假原稿行」一节的 buildV19OriginRow 兜底处理。
// ---------------------------------------------------------------------------

test("deriveV19FinalFieldTrace: an intake whose value exactly repeats the origin's, from a version other than v1, is merged away by the adjacent dedupe — the field just shows its 当前采用 line, no duplicated history row", () => {
  const intakes = [intake({ id: "i1", seq: 1, value: "原稿意图", sourceVersionNumber: 2, actorName: "李晓芸" })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿意图"), intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.hasTrace, true);
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
  assert.deepEqual(trace.overridden, [], "the duplicate intake exactly repeats the origin, so there is no separate history row for it");
  assert.deepEqual(trace.pending, []);
});

test("deriveV19FinalFieldTrace: only the adjacent duplicate is dropped — a later, genuinely different intake still becomes current", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "原稿意图", sourceVersionNumber: 2, actorName: "李晓芸" }), // duplicate of origin, dropped
    intake({ id: "i2", seq: 2, value: "李晓芸改的意图", sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z" }),
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿意图"), intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.hasTrace, true);
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
  // The origin survives as the sole overridden entry — the duplicate i1 never appears at all.
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin"]);
  assert.deepEqual(trace.pending, []);
});

// ---------------------------------------------------------------------------
// 假原稿行兜底 (用户第二次看了线上溯源模式后反馈): 原稿 = v1 自己当前的
// payload，回放又重放了 v1 自己的写入事件，所以只要 v1 自己写过这个字段，
// 原稿的值必然和 v1 最后一条记录相同——哪怕中间还有 v1 自己写下的、真的不同
// 的过渡值（不相邻，简化规则 1 抓不到），原稿这一行永远是多余的重复。
// buildV19OriginRow 按「值等于 v1 最后一条记录」整体丢弃原稿行，中间的过渡
// 记录仍然保留为真实历史。
// ---------------------------------------------------------------------------

test('deriveV19FinalFieldTrace: 原稿 equals v1\'s own *last* record even when a different v1 record sits between them ("侧面平视 → 特写 → 侧面平视" all from v1) — 原稿 is dropped, the real transition stays, and current is v1\'s last edit, not "原稿"', () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "特写", sourceVersionNumber: 1, actorName: "赵雅诗", createdAt: "2026-08-26T09:34:00.000Z" }),
    intake({ id: "i2", seq: 2, value: "侧面平视", sourceVersionNumber: 1, actorName: "赵雅诗", createdAt: "2026-08-26T09:35:00.000Z" }),
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("侧面平视"), intakes, "facts.commercialIntent", "赵雅诗");
  assert.equal(trace.currentSourceLabel, `当前采用 · v1 赵雅诗 ${formatShortDateTime("2026-08-26T09:35:00.000Z")}`,
    "current must be attributed to v1's actual last edit, not to a synthetic 原稿 row");
  assert.deepEqual(trace.overridden.map((row) => row.key), ["i1"],
    "the real intermediate transition (原稿→特写) stays as history; only the redundant 原稿 row itself is dropped");
});

test("deriveV19FinalFieldTrace: 原稿 is kept when it does NOT match v1's own last record — only an exact match is redundant", () => {
  const intakes = [intake({ id: "i1", seq: 1, value: "李晓芸后来改的", sourceVersionNumber: 1, actorName: "赵雅诗" })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿意图"), intakes, "facts.commercialIntent", "赵雅诗");
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin"], "原稿 does not match v1's last record's value, so it stays");
});

test("deriveV19FinalFieldTrace: the 假原稿行 fallback only looks at v1-sourced records — a matching value from another version or FINAL_DIRECT does not drop 原稿", () => {
  const intakes = [intake({ id: "i1", seq: 1, value: "原稿意图", sourceVersionNumber: 2, actorName: "张三" })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿意图"), intakes, "facts.commercialIntent", "赵雅诗");
  // This is exactly 简化规则 1's ordinary adjacent dedupe (already covered above) —
  // asserted again here just to make the "only v1" boundary explicit: the row
  // that disappears is the *duplicate intake*, not 原稿, even though the values match.
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 赵雅诗 原稿");
});

test("deriveV19FinalFieldTrace: two consecutive intakes with the same value merge into one, keeping the earlier (lower-seq) one's identity", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "李晓芸的版本", sourceVersionNumber: 2, actorName: "李晓芸" }),
    intake({ id: "i2", seq: 2, value: "李晓芸的版本", sourceVersionNumber: 3, actorName: "张三" }), // same value as i1 — dropped
    intake({ id: "i3", seq: 3, value: "张三的新版本", sourceVersionNumber: 3, actorName: "张三", createdAt: "2026-08-24T11:20:00.000Z" }),
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.currentSourceLabel, `当前采用 · v3 张三 ${formatShortDateTime("2026-08-24T11:20:00.000Z")}`);
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin", "i1"]);
});

test("deriveV19FinalFieldTrace: a pending row identical to its immediately preceding row is merged away too", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "现在的内容", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" }),
    intake({ id: "i2", seq: 2, value: "现在的内容", applied: false, sourceVersionNumber: 4, actorName: "老王" }), // duplicate of i1, dropped
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent", "王大明");
  assert.deepEqual(trace.pending, []);
});

// ---------------------------------------------------------------------------
// 简化规则 2: 当前采用来源行文案 — 「当前采用 · v2 老孙 09-02 11:00」/
// 「当前采用 · v1 赵雅诗 原稿」/「当前采用 · 最终版 老孙 直接修改 09-02 11:00」。
// ---------------------------------------------------------------------------

test("deriveV19FinalFieldTrace: currentSourceLabel names the origin's owner and says 原稿 when nothing has overridden it yet but something else has changed", () => {
  // origin is current because the only intake is still pending — origin itself was never overridden.
  const intakes = [intake({ id: "i1", seq: 1, value: "老王想改的", applied: false, sourceVersionNumber: 4, actorName: "老王" })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("赵雅诗写的原稿"), intakes, "facts.commercialIntent", "赵雅诗");
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 赵雅诗 原稿");
});

test("deriveV19FinalFieldTrace: currentSourceLabel names the version, actor, and time for a VERSION-sourced current row", () => {
  const intakes = [intake({
    id: "i1", seq: 1, value: "老孙改的", applied: true, sourceVersionNumber: 2, actorName: "老孙", createdAt: "2026-09-02T03:00:00.000Z",
  })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent");
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 老孙 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`);
});

test("deriveV19FinalFieldTrace: currentSourceLabel says 最终版 ... 直接修改 for a FINAL_DIRECT current row", () => {
  const intakes = [intake({
    id: "i1", seq: 1, value: "老孙直接改的", applied: true, source: "FINAL_DIRECT", sourceVersionNumber: null,
    actorName: "老孙", createdAt: "2026-09-02T03:00:00.000Z",
  })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent");
  assert.equal(trace.currentSourceLabel, `当前采用 · 最终版 老孙 直接修改 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`);
});

test("deriveV19FinalFieldTrace: currentSourceLabel is null when there is no applied row at all (e.g. a freshly inserted shot's field with only a pending edit)", () => {
  const origin = payloadWithGroups([group("b1", [shot("s1")])]); // shot s2 doesn't exist in origin
  const intakes = [intake({
    id: "i1", seq: 1, targetKey: "shot:s2.visualContent", targetLabel: "画面内容", value: "有人写了但还没采纳",
    applied: false, sourceVersionNumber: 4, actorName: "老王",
  })];
  const trace = deriveV19FinalFieldTrace(origin, intakes, "shot:s2.visualContent");
  assert.equal(trace.hasTrace, true, "the pending edit itself must still show, per 简化规则 5");
  assert.equal(trace.currentSourceLabel, null);
  assert.deepEqual(trace.overridden, []);
  assert.equal(trace.pending.length, 1);
});

// ---------------------------------------------------------------------------
// 简化规则 3/5: 旧写法（合并后当前采用之前的行）与未纳入（applied=false）分类，
// 后者排在旧写法列表之后照旧展示，不受合并/位置影响。
// ---------------------------------------------------------------------------

test("deriveV19FinalFieldTrace: classifies every applied row before current as overridden and every unapplied row as pending, in seq order within each group", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "李晓芸的版本", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" }),
    intake({ id: "i2", seq: 2, value: "张三的版本", applied: true, sourceVersionNumber: 3, actorName: "张三" }),
    intake({ id: "i3", seq: 3, value: "定稿后老王的版本", applied: false, sourceVersionNumber: 4, actorName: "老王" }),
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent", "赵雅诗");
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin", "i1"]);
  assert.deepEqual(trace.pending.map((row) => row.key), ["i3"]);
  assert.match(trace.currentSourceLabel ?? "", /^当前采用 · v3 张三/);
});

test("deriveV19FinalFieldTrace: classification is by each row's own applied flag, not by position — a pending row can sit seq-earlier than the current applied row (e.g. after 取消定稿 reopens and new edits land before the old pending one is adopted)", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "OPEN 期间已应用", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" }),
    intake({ id: "i2", seq: 2, value: "DONE 期间未采纳", applied: false, sourceVersionNumber: 3, actorName: "张三" }),
    intake({ id: "i3", seq: 3, value: "重开后又应用了", applied: true, sourceVersionNumber: 5, actorName: "老王", createdAt: "2026-09-02T05:00:00.000Z" }),
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent", "赵雅诗");
  assert.equal(trace.currentSourceLabel, `当前采用 · v5 老王 ${formatShortDateTime("2026-09-02T05:00:00.000Z")}`);
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin", "i1"]);
  assert.deepEqual(trace.pending.map((row) => row.key), ["i2"]);
});

// ---------------------------------------------------------------------------
// 本机复核收尾: 空白不算「旧写法」——一个空的原稿（或任何空值的被覆盖行）
// 不该出现在旧写法列表里；当前采用行与未纳入行不受影响，可以合法为空。
// ---------------------------------------------------------------------------

test("deriveV19FinalFieldTrace: an empty origin overridden by real content is dropped from 旧写法, but the current line still shows", () => {
  const emptyOrigin = factsOrigin(""); // trims to empty
  const intakes = [intake({
    id: "i1", seq: 1, value: "演示同事写的实际内容", applied: true, sourceVersionNumber: 2, actorName: "演示同事",
    createdAt: "2026-09-02T03:00:00.000Z",
  })];
  const trace = deriveV19FinalFieldTrace(emptyOrigin, intakes, "facts.commercialIntent", "演示同事");
  assert.equal(trace.hasTrace, true, "content really did change from the (blank) origin, so there is still a current line to show");
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 演示同事 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`);
  assert.deepEqual(trace.overridden, [], "the blank origin is not a 写法 worth listing");
  assert.deepEqual(trace.pending, []);
});

test("deriveV19FinalFieldTrace: an empty origin with only a whitespace-only intake in between still drops both from 旧写法", () => {
  const emptyOrigin = factsOrigin("   "); // trims to empty
  const intakes = [
    intake({ id: "i1", seq: 1, value: "  ", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" }), // also blank, and not adjacent-identical to "" so survives dedupe
    intake({ id: "i2", seq: 2, value: "真正的内容", applied: true, sourceVersionNumber: 3, actorName: "张三", createdAt: "2026-08-24T11:20:00.000Z" }),
  ];
  const trace = deriveV19FinalFieldTrace(emptyOrigin, intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.currentSourceLabel, `当前采用 · v3 张三 ${formatShortDateTime("2026-08-24T11:20:00.000Z")}`);
  assert.deepEqual(trace.overridden, [], "both blank rows (origin and i1) are dropped, not just the origin");
});

test("deriveV19FinalFieldTrace: a blank field with no intakes that actually diverge from it still shows its (blank) 当前采用 line, per the adjusted 简化规则 4", () => {
  const emptyOrigin = factsOrigin("");
  // Same literal value as the (blank) origin, and from a version other than
  // v1, so 简化规则 1's adjacent dedupe merges it away — current ends up
  // being 原稿 itself, and its 当前采用 line renders regardless of being blank.
  const intakes = [intake({ id: "i1", seq: 1, value: "", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" })];
  const trace = deriveV19FinalFieldTrace(emptyOrigin, intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.hasTrace, true);
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
  assert.deepEqual(trace.overridden, []);
});

test("deriveV19FinalFieldTrace: current being blank-but-genuinely-different from a blank origin still shows a current line — only 旧写法 rows get the blank filter, not current", () => {
  const emptyOrigin = factsOrigin(""); // exactly ""
  // "   " is a different literal value from "" (not caught by 简化规则 1's
  // exact-match dedupe), so it becomes its own applied row and, being the
  // last one, the current row — even though it too is blank.
  const intakes = [intake({ id: "i1", seq: 1, value: "   ", applied: true, sourceVersionNumber: 1, actorName: "王大明" })];
  const trace = deriveV19FinalFieldTrace(emptyOrigin, intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.hasTrace, true, "the value did change (a different blank), so there is still something to attribute");
  assert.match(trace.currentSourceLabel ?? "", /^当前采用 · v1 王大明/);
  assert.deepEqual(trace.overridden, [], "the blank origin, now overridden, is still dropped from 旧写法");
});

test("deriveV19FinalFieldTrace: an empty overridden row is dropped even when it is not the origin", () => {
  const intakes = [
    intake({ id: "i1", seq: 1, value: "", applied: true, sourceVersionNumber: 2, actorName: "李晓芸" }),
    intake({ id: "i2", seq: 2, value: "李晓芸后来补上的内容", applied: true, sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z" }),
  ];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent", "王大明");
  // origin ("原稿") is non-empty so it survives; the blank i1 does not.
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin"]);
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
});

test("deriveV19FinalFieldTrace: pending and current rows are not filtered even when their value is blank", () => {
  const intakes = [intake({
    id: "i1", seq: 1, value: "   ", applied: false, sourceVersionNumber: 4, actorName: "老王",
  })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent", "王大明");
  assert.equal(trace.pending.length, 1, "a blank pending row must still show — it's still something someone tried to write");
  assert.equal(trace.pending[0].value, "   ");
});

test("deriveV19FinalFieldTrace ignores intakes for other target keys and other kinds", () => {
  const origin = payloadWithGroups([]);
  const intakes = [
    intake({ id: "i1", seq: 1, targetKey: "shot:s-other.visualContent" }),
    intake({ id: "i2", seq: 2, kind: "INSERT_SHOT", targetKey: "shot:s2.visualContent", value: {} }),
  ];
  const trace = deriveV19FinalFieldTrace(origin, intakes, "shot:s2.visualContent");
  assert.equal(trace.hasTrace, false);
});

// ---------------------------------------------------------------------------
// describeV19FinalTraceRowLabel / firstLineV19TraceValue — the small pure
// helpers the 旧写法摘要行 renderer reuses directly.
// ---------------------------------------------------------------------------

test("describeV19FinalTraceRowLabel formats each source kind", () => {
  assert.equal(
    describeV19FinalTraceRowLabel({
      key: "origin", intakeId: null, isOrigin: true, value: "x", source: "ORIGIN",
      sourceVersionNumber: null, actorName: "赵雅诗", createdAt: "",
    }),
    "v1 赵雅诗 原稿",
  );
  assert.equal(
    describeV19FinalTraceRowLabel({
      key: "i1", intakeId: "i1", isOrigin: false, value: "x", source: "VERSION",
      sourceVersionNumber: 2, actorName: "老孙", createdAt: "2026-09-02T03:00:00.000Z",
    }),
    `v2 老孙 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`,
  );
  assert.equal(
    describeV19FinalTraceRowLabel({
      key: "i1", intakeId: "i1", isOrigin: false, value: "x", source: "FINAL_DIRECT",
      sourceVersionNumber: null, actorName: "老孙", createdAt: "2026-09-02T03:00:00.000Z",
    }),
    `最终版 老孙 直接修改 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`,
  );
});

test("firstLineV19TraceValue keeps only the first line and trims it", () => {
  assert.equal(firstLineV19TraceValue("第一行\n第二行\n第三行"), "第一行");
  assert.equal(firstLineV19TraceValue("  只有一行，带首尾空格  "), "只有一行，带首尾空格");
});

test("firstLineV19TraceValue renders an em dash for empty/whitespace-only/nullish values", () => {
  assert.equal(firstLineV19TraceValue(""), "—");
  assert.equal(firstLineV19TraceValue("   "), "—");
  assert.equal(firstLineV19TraceValue(null), "—");
  assert.equal(firstLineV19TraceValue(undefined), "—");
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

// ---------------------------------------------------------------------------
// deriveV19PrimaryDetailTrace — 主导路径细项 (spec 五、18 补充): 后端把每次
// 改动整体存成一条 `path.primaryDetails` FIELD 记录，value 是
// `{ <detailKey>: string, ... }`；这里按 detailKey 抽取单个字段的溯源链。
// ---------------------------------------------------------------------------

function originWithPrimaryDetails(primaryType: "LOVE" | "FUN" | "PERCEPTION", details: Record<string, string>): V04DraftPayloadV1 {
  return {
    ...emptyV04DraftPayload(),
    perceptionPath: { primaryType, primaryDetails: details, auxiliaryTypes: [] },
  };
}

function primaryDetailIntake(overrides: Partial<V19FinalIntake> & Pick<V19FinalIntake, "id" | "seq" | "value">): V19FinalIntake {
  return intake({ targetKey: "path.primaryDetails", targetLabel: "主导路径细项", ...overrides });
}

test("deriveV19PrimaryDetailTrace: reads the origin's value for just that detailKey out of primaryDetails, and shows 当前采用 even untouched", () => {
  const origin = originWithPrimaryDetails("LOVE", { emotionalBase: "原稿情感基底", accumulation: "原稿累积" });
  const trace = deriveV19PrimaryDetailTrace(origin, [], "emotionalBase", "王大明");
  assert.equal(trace.hasTrace, true);
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
});

test("deriveV19PrimaryDetailTrace: a path.primaryDetails record only updates the current field's key, leaving other keys to merge via origin unaffected", () => {
  const origin = originWithPrimaryDetails("LOVE", { emotionalBase: "原稿情感基底", accumulation: "原稿累积" });
  const intakes = [
    primaryDetailIntake({
      id: "i1", seq: 1, value: { emotionalBase: "改过的情感基底", accumulation: "原稿累积" },
      sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z",
    }),
  ];
  const emotionalBaseTrace = deriveV19PrimaryDetailTrace(origin, intakes, "emotionalBase", "王大明");
  assert.equal(emotionalBaseTrace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
  assert.deepEqual(emotionalBaseTrace.overridden.map((row) => row.key), ["origin"]);
  // The same record didn't actually change `accumulation` — its extracted value ("原稿累积")
  // exactly repeats the origin's, so 简化规则 1's adjacent dedupe merges it away entirely.
  const accumulationTrace = deriveV19PrimaryDetailTrace(origin, intakes, "accumulation", "王大明");
  assert.equal(accumulationTrace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
  assert.deepEqual(accumulationTrace.overridden, []);
});

test("deriveV19PrimaryDetailTrace: a detailKey absent from a record's value (e.g. primaryType changed to a path without that key) reads as empty, not as a crash or 'undefined'", () => {
  const origin = originWithPrimaryDetails("LOVE", { emotionalBase: "原稿情感基底" });
  const intakes = [
    primaryDetailIntake({
      id: "i1", seq: 1, value: { perceptionRule: "切换到了感知路径的字段" }, // primaryType switched away from LOVE
      sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z",
    }),
  ];
  const trace = deriveV19PrimaryDetailTrace(origin, intakes, "emotionalBase", "王大明");
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
  assert.equal(trace.current?.value, "", "the record's value has no emotionalBase key at all, so it extracts as blank");
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin"]);
});

// ---------------------------------------------------------------------------
// deriveV19AuxiliaryPathTrace — 辅助路径描述／创意作用: `path.auxiliaryTypes`
// FIELD records store the whole list as `[{ type, description, creativeRole }]`;
// derive per (type, field).
// ---------------------------------------------------------------------------

function originWithAuxiliaryTypes(entries: Array<{ type: string; description: string; creativeRole: string }>): V04DraftPayloadV1 {
  return {
    ...emptyV04DraftPayload(),
    perceptionPath: { primaryType: "LOVE", primaryDetails: {}, auxiliaryTypes: entries as V04DraftPayloadV1["perceptionPath"]["auxiliaryTypes"] },
  };
}

function auxiliaryTypesIntake(overrides: Partial<V19FinalIntake> & Pick<V19FinalIntake, "id" | "seq" | "value">): V19FinalIntake {
  return intake({ targetKey: "path.auxiliaryTypes", targetLabel: "辅助路径", ...overrides });
}

test("deriveV19AuxiliaryPathTrace: reads the origin entry matching auxType and the requested field (description)", () => {
  const origin = originWithAuxiliaryTypes([{ type: "FUN", description: "原稿趣味描述", creativeRole: "原稿创意作用" }]);
  const trace = deriveV19AuxiliaryPathTrace(origin, [], "FUN", "description", "王大明");
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
});

test("deriveV19AuxiliaryPathTrace: an auxiliaryTypes record updating only creativeRole for the matching type changes that field's trace but not description's", () => {
  const origin = originWithAuxiliaryTypes([{ type: "FUN", description: "原稿趣味描述", creativeRole: "原稿创意作用" }]);
  const intakes = [
    auxiliaryTypesIntake({
      id: "i1", seq: 1,
      value: [{ type: "FUN", description: "原稿趣味描述", creativeRole: "改过的创意作用" }],
      sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z",
    }),
  ];
  const roleTrace = deriveV19AuxiliaryPathTrace(origin, intakes, "FUN", "creativeRole", "王大明");
  assert.equal(roleTrace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
  const descriptionTrace = deriveV19AuxiliaryPathTrace(origin, intakes, "FUN", "description", "王大明");
  assert.equal(descriptionTrace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
  assert.deepEqual(descriptionTrace.overridden, []);
});

test("deriveV19AuxiliaryPathTrace: an entry whose type isn't present in a record (that aux path wasn't active at that point) reads as empty", () => {
  const origin = originWithAuxiliaryTypes([{ type: "FUN", description: "原稿趣味描述", creativeRole: "原稿创意作用" }]);
  const intakes = [
    auxiliaryTypesIntake({
      id: "i1", seq: 1, value: [{ type: "PERCEPTION", description: "换成了别的辅助路径", creativeRole: "" }],
      sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z",
    }),
  ];
  const trace = deriveV19AuxiliaryPathTrace(origin, intakes, "FUN", "description", "王大明");
  assert.equal(trace.current?.value, "");
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
});

// ---------------------------------------------------------------------------
// describeV19ChoiceValue — 固定选项字段的人类可读文案：选项 id → 中文标签，
// 多选用「、」拼接，自定义／进阶文本追加；选中 id 排序后再格式化，使顺序不
// 同的同一选择格式化为同一字符串（既用于展示，也用于溯源的相邻去重比较）。
// ---------------------------------------------------------------------------

test("describeV19ChoiceValue: single selection resolves the option id to its 中文 label", () => {
  const text = describeV19ChoiceValue(
    { selectedOptionIds: ["ESTABLISH_CHARACTER_RELATIONSHIP"], customText: "", vocabularyVersion: 1 },
    "bridgeCreativeRole",
  );
  assert.equal(text, "建立人物／关系");
});

test("describeV19ChoiceValue: multiple selections join with 、, and appends custom text after a separator", () => {
  const text = describeV19ChoiceValue(
    { selectedOptionIds: ["ACCUMULATE_EMOTION", "ACCUMULATE_INFORMATION"], customText: "还有点别的", vocabularyVersion: 1 },
    "bridgeCreativeRole",
  );
  assert.equal(text, "累积情感、累积信息 ｜ 还有点别的");
});

test("describeV19ChoiceValue: two selections toggled in a different order format identically (sorted before formatting)", () => {
  const a = describeV19ChoiceValue({ selectedOptionIds: ["ACCUMULATE_INFORMATION", "ACCUMULATE_EMOTION"], customText: "", vocabularyVersion: 1 }, "bridgeCreativeRole");
  const b = describeV19ChoiceValue({ selectedOptionIds: ["ACCUMULATE_EMOTION", "ACCUMULATE_INFORMATION"], customText: "", vocabularyVersion: 1 }, "bridgeCreativeRole");
  assert.equal(a, b);
});

test("describeV19ChoiceValue: an unrecognized option id (e.g. a stale vocabulary version) falls back to showing the raw id rather than dropping it silently", () => {
  const text = describeV19ChoiceValue({ selectedOptionIds: ["SOME_RETIRED_OPTION"], customText: "", vocabularyVersion: 0 }, "bridgeCreativeRole");
  assert.equal(text, "SOME_RETIRED_OPTION");
});

test("describeV19ChoiceValue: an empty/non-choice-shaped value formats to empty string", () => {
  assert.equal(describeV19ChoiceValue(undefined, "bridgeCreativeRole"), "");
  assert.equal(describeV19ChoiceValue({ selectedOptionIds: [], customText: "", vocabularyVersion: 1 }, "bridgeCreativeRole"), "");
});

// ---------------------------------------------------------------------------
// deriveV19ChoiceFieldTrace — 固定选项字段整体溯源: 复用 describeV19ChoiceValue
// 做格式化，其余（合并／当前采用／旧写法／未纳入／假原稿行兜底）与普通字段共享。
// ---------------------------------------------------------------------------

function originWithStoryReference(value: { selectedOptionIds: string[]; customText: string }): V04DraftPayloadV1 {
  return {
    ...emptyV04DraftPayload(),
    factsAndCoreJudgement: {
      ...emptyV04DraftPayload().factsAndCoreJudgement,
      storyReference: { ...emptyV04ChoiceValue(), ...value },
    },
  };
}

test("deriveV19ChoiceFieldTrace: shows 当前采用 formatted via describeV19ChoiceValue even when nothing changed", () => {
  const origin = originWithStoryReference({ selectedOptionIds: ["YOUTH_NOSTALGIA"], customText: "" });
  const trace = deriveV19ChoiceFieldTrace(origin, [], "facts.storyReference", "storyReferenceType", "王大明");
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿");
});

test("deriveV19ChoiceFieldTrace: a later record with a different selection becomes current, formatted to its label; origin becomes 旧写法", () => {
  const origin = originWithStoryReference({ selectedOptionIds: ["YOUTH_NOSTALGIA"], customText: "" });
  const intakes = [
    intake({
      id: "i1", seq: 1, targetKey: "facts.storyReference", targetLabel: "故事参照类型",
      value: { selectedOptionIds: ["FAMILY_AFFECTION"], customText: "", vocabularyVersion: 1 },
      sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z",
    }),
  ];
  const trace = deriveV19ChoiceFieldTrace(origin, intakes, "facts.storyReference", "storyReferenceType", "王大明");
  assert.equal(trace.currentSourceLabel, `当前采用 · v2 李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
  assert.equal(trace.current?.value, "家庭亲情片");
  assert.deepEqual(trace.overridden.map((row) => row.key), ["origin"]);
  assert.equal(trace.overridden[0]?.value, "青春怀旧片");
});

test("deriveV19ChoiceFieldTrace: a record whose selection differs only in order from the origin is merged away by adjacent dedupe (both format to the same normalized string)", () => {
  const origin = originWithStoryReference({ selectedOptionIds: ["YOUTH_NOSTALGIA", "FAMILY_AFFECTION"], customText: "" });
  const intakes = [
    intake({
      id: "i1", seq: 1, targetKey: "facts.storyReference", targetLabel: "故事参照类型",
      value: { selectedOptionIds: ["FAMILY_AFFECTION", "YOUTH_NOSTALGIA"], customText: "", vocabularyVersion: 1 },
      sourceVersionNumber: 2, actorName: "李晓芸",
    }),
  ];
  const trace = deriveV19ChoiceFieldTrace(origin, intakes, "facts.storyReference", "storyReferenceType", "王大明");
  assert.equal(trace.currentSourceLabel, "当前采用 · v1 王大明 原稿", "same normalized selection as origin, just reordered — dedupe treats it as unchanged");
  assert.deepEqual(trace.overridden, []);
});

// ---------------------------------------------------------------------------
// describeV19FinalTraceHoverSource — 默认模式（非溯源视图）下 hover title 用
// 的单行来源提示，取自 trace.current；这是 finalPrimaryDetailExtras／
// finalAuxiliaryPathExtras／finalChoiceFieldExtras 在 traceMode=false 时
// 唯一挂出来的东西（spec 五、19）。
// ---------------------------------------------------------------------------

test("describeV19FinalTraceHoverSource: null current row (nothing to show) yields undefined", () => {
  assert.equal(describeV19FinalTraceHoverSource(null), undefined);
});

test("describeV19FinalTraceHoverSource: an origin row (isOrigin) yields undefined — 原稿本身不算 hover 来源", () => {
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿意图"), [], "facts.commercialIntent", "王大明");
  assert.equal(describeV19FinalTraceHoverSource(trace.current), undefined);
});

test("describeV19FinalTraceHoverSource: a VERSION-sourced current row formats as v<N>·<actor> <time>", () => {
  const intakes = [intake({
    id: "i1", seq: 1, value: "老孙改的", applied: true, sourceVersionNumber: 2, actorName: "老孙", createdAt: "2026-09-02T03:00:00.000Z",
  })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent");
  assert.equal(describeV19FinalTraceHoverSource(trace.current), `v2·老孙 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`);
});

test("describeV19FinalTraceHoverSource: a FINAL_DIRECT current row formats as 最终版·直接修改 <time>", () => {
  const intakes = [intake({
    id: "i1", seq: 1, value: "老孙直接改的", applied: true, source: "FINAL_DIRECT", sourceVersionNumber: null,
    actorName: "老孙", createdAt: "2026-09-02T03:00:00.000Z",
  })];
  const trace = deriveV19FinalFieldTrace(factsOrigin("原稿"), intakes, "facts.commercialIntent");
  assert.equal(describeV19FinalTraceHoverSource(trace.current), `最终版·直接修改 ${formatShortDateTime("2026-09-02T03:00:00.000Z")}`);
});

test("describeV19FinalTraceHoverSource: also works for a primary-detail trace's current row (same shared V19FinalFieldTrace shape)", () => {
  const origin = { ...emptyV04DraftPayload(), perceptionPath: { primaryType: "LOVE" as const, primaryDetails: { emotionalBase: "原稿" }, auxiliaryTypes: [] } };
  const intakes = [primaryDetailIntake({
    id: "i1", seq: 1, value: { emotionalBase: "改过的" }, sourceVersionNumber: 2, actorName: "李晓芸", createdAt: "2026-08-23T09:47:00.000Z",
  })];
  const trace = deriveV19PrimaryDetailTrace(origin, intakes, "emotionalBase", "王大明");
  assert.equal(describeV19FinalTraceHoverSource(trace.current), `v2·李晓芸 ${formatShortDateTime("2026-08-23T09:47:00.000Z")}`);
});
