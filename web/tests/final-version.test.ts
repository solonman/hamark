// 纯函数单测：集成版的汇入算法。见 lib/final-version.ts 与
// docs/20_最终版与评论跨版本_实施规格_V0.1.md 三（汇入算法）/ 六（验收清单）。
// 不接触数据库——db 函数（ensureFinalVersion 等）走本机 Postgres 的走查，
// 不在这份单测覆盖范围内。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyFinalIntake,
  applyFinalIntakeBatch,
  computeFinalFromHistory,
  decomposeV19ChangesForFinal,
  deriveFinalOrigin,
  type FinalHistoryEvent,
  type FinalIntakeDraft,
} from "../lib/final-version.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04Change, V04DraftPayloadV1, V04ShotGroupPayload, V04ShotPayload } from "../lib/v04-contract.ts";

function shot(id: string, orderIndex: number, overrides: Partial<V04ShotPayload> = {}): V04ShotPayload {
  return {
    id, orderIndex,
    startTime: "", endTime: "", shotScale: "", cameraAngle: "", cameraMovement: "",
    visualContent: "", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "",
    soundEffect: "", music: "",
    ...overrides,
  };
}

function group(
  id: string, orderIndex: number, shots: V04ShotPayload[], overrides: Partial<V04ShotGroupPayload> = {},
): V04ShotGroupPayload {
  return {
    id, orderIndex, bridgeName: `桥段${orderIndex}`,
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

function structureChange(before: V04ShotGroupPayload[], after: V04ShotGroupPayload[]): V04Change {
  return { targetKey: "script.structure", targetLabel: "脚本结构", valueType: "STRUCTURE", beforeValue: before, afterValue: after };
}

// ---------------------------------------------------------------------------
// 3.1 decomposeV19ChangesForFinal — 三种拆解场景。
// ---------------------------------------------------------------------------

test("decompose: 普通字段变更（非 script.structure）直接映射成一条 FIELD 记录", () => {
  const changes: V04Change[] = [
    { targetKey: "facts.commercialIntent", targetLabel: "商业意图", valueType: "TEXT", beforeValue: "", afterValue: "回家" },
  ];
  const drafts = decomposeV19ChangesForFinal(changes);
  assert.deepEqual(drafts, [
    { kind: "FIELD", targetKey: "facts.commercialIntent", targetLabel: "商业意图", value: "回家" },
  ]);
});

test("decompose: 删除整个桥段 → 只产生一条 REMOVE_GROUP", () => {
  const before = [group("g1", 0, [shot("s1", 0)]), group("g2", 1, [shot("s2", 1)])];
  const after = [group("g1", 0, [shot("s1", 0)])];
  const drafts = decomposeV19ChangesForFinal([structureChange(before, after)]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, "REMOVE_GROUP");
  assert.equal(drafts[0].targetKey, "shotGroup:g2");
});

test("decompose: 同一桥段内删除一个镜头（桥段本身保留）→ REMOVE_SHOT", () => {
  const before = [group("g1", 0, [shot("s1", 0), shot("s2", 1)])];
  const after = [group("g1", 0, [shot("s1", 0)])];
  const drafts = decomposeV19ChangesForFinal([structureChange(before, after)]);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0], { kind: "REMOVE_SHOT", targetKey: "shot:s2", targetLabel: "镜头", value: {} });
});

test("decompose: 在已有镜头后插入新镜头 → INSERT_SHOT 带正确的 afterId", () => {
  const before = [group("g1", 0, [shot("s1", 0)])];
  const after = [group("g1", 0, [shot("s1", 0), shot("s2", 1)])];
  const drafts = decomposeV19ChangesForFinal([structureChange(before, after)]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, "INSERT_SHOT");
  assert.equal(drafts[0].targetKey, "shot:s2");
  assert.deepEqual(drafts[0].value, { item: after[0].shots[1], parentGroupId: "g1", afterId: "s1" });
});

test("decompose: 新增桥段 → INSERT_GROUP 携带完整桥段（含镜头）与 afterId", () => {
  const before = [group("g1", 0, [shot("s1", 0)])];
  const g2 = group("g2", 1, [shot("s2", 1)]);
  const after = [group("g1", 0, [shot("s1", 0)]), g2];
  const drafts = decomposeV19ChangesForFinal([structureChange(before, after)]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, "INSERT_GROUP");
  assert.equal(drafts[0].targetKey, "shotGroup:g2");
  assert.deepEqual(drafts[0].value, { item: g2, afterId: "g1" });
});

test("decompose: 结构变更同时改字段——先 REMOVE，再 INSERT，再 FIELD，且都在同一批里", () => {
  const before = [
    group("g1", 0, [shot("s1", 0, { visualContent: "旧画面" })], { bridgeName: "旧桥段名" }),
    group("g2", 1, [shot("s3", 2)]),
  ];
  const after = [
    // g2 removed; g1 kept but renamed and its shot's field changed, plus a new shot s2 inserted after s1.
    group("g1", 0, [shot("s1", 0, { visualContent: "新画面" }), shot("s2", 1)], { bridgeName: "新桥段名" }),
  ];
  const drafts = decomposeV19ChangesForFinal([structureChange(before, after)]);
  const kinds = drafts.map((draft) => draft.kind);
  assert.deepEqual(kinds, ["REMOVE_GROUP", "INSERT_SHOT", "FIELD", "FIELD"]);
  assert.equal(drafts[0].targetKey, "shotGroup:g2");
  assert.equal(drafts[1].targetKey, "shot:s2");
  assert.equal(drafts[2].targetKey, "shotGroup:g1.bridgeName");
  assert.equal(drafts[2].value, "新桥段名");
  assert.equal(drafts[3].targetKey, "shot:s1.visualContent");
  assert.equal(drafts[3].value, "新画面");
});

// ---------------------------------------------------------------------------
// 3.2 applyFinalIntake — 每种 kind 的 APPLIED 与 NOOP。
// ---------------------------------------------------------------------------

test("applyFinalIntake FIELD: 目标存在则 APPLIED 并写入新值", () => {
  const payload = payloadWithGroups([group("g1", 0, [], { bridgeName: "旧" })]);
  const draft: FinalIntakeDraft = { kind: "FIELD", targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", value: "新" };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "APPLIED");
  assert.equal(result.payload.script.shotGroups[0].bridgeName, "新");
});

test("applyFinalIntake FIELD: 目标已被别人删除 → NOOP，payload 原样返回", () => {
  const payload = payloadWithGroups([group("g1", 0, [])]);
  const draft: FinalIntakeDraft = { kind: "FIELD", targetKey: "shotGroup:missing.bridgeName", targetLabel: "桥段名称", value: "新" };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "NOOP");
  assert.equal(result.payload, payload);
});

test("applyFinalIntake INSERT_GROUP: afterId 存在则插到其后并重排序号", () => {
  const payload = payloadWithGroups([group("g1", 0, [])]);
  const g2 = group("g2", 99, []);
  const draft: FinalIntakeDraft = { kind: "INSERT_GROUP", targetKey: "shotGroup:g2", targetLabel: "桥段", value: { item: g2, afterId: "g1" } };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "APPLIED");
  assert.deepEqual(result.payload.script.shotGroups.map((g) => g.id), ["g1", "g2"]);
  assert.deepEqual(result.payload.script.shotGroups.map((g) => g.orderIndex), [0, 1]);
});

test("applyFinalIntake INSERT_GROUP: id 已存在 → NOOP", () => {
  const payload = payloadWithGroups([group("g1", 0, [])]);
  const draft: FinalIntakeDraft = {
    kind: "INSERT_GROUP", targetKey: "shotGroup:g1", targetLabel: "桥段",
    value: { item: group("g1", 0, []), afterId: null },
  };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "NOOP");
  assert.equal(result.payload.script.shotGroups.length, 1);
});

test("applyFinalIntake INSERT_SHOT: 插入父桥段并重排全局镜头序号", () => {
  const payload = payloadWithGroups([
    group("g1", 0, [shot("s1", 0)]),
    group("g2", 1, [shot("s3", 1)]),
  ]);
  const draft: FinalIntakeDraft = {
    kind: "INSERT_SHOT", targetKey: "shot:s2", targetLabel: "镜头",
    value: { item: shot("s2", 0), parentGroupId: "g1", afterId: "s1" },
  };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "APPLIED");
  assert.deepEqual(result.payload.script.shotGroups[0].shots.map((s) => s.id), ["s1", "s2"]);
  // 全局累计下标：g1 的两个镜头先编号，再轮到 g2 的镜头。
  assert.deepEqual(result.payload.script.shotGroups[0].shots.map((s) => s.orderIndex), [0, 1]);
  assert.equal(result.payload.script.shotGroups[1].shots[0].orderIndex, 2);
});

test("applyFinalIntake INSERT_SHOT: 镜头 id 已存在 → NOOP", () => {
  const payload = payloadWithGroups([group("g1", 0, [shot("s1", 0)])]);
  const draft: FinalIntakeDraft = {
    kind: "INSERT_SHOT", targetKey: "shot:s1", targetLabel: "镜头",
    value: { item: shot("s1", 0), parentGroupId: "g1", afterId: null },
  };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "NOOP");
});

test("applyFinalIntake INSERT_SHOT: 父桥段不存在 → NOOP", () => {
  const payload = payloadWithGroups([group("g1", 0, [])]);
  const draft: FinalIntakeDraft = {
    kind: "INSERT_SHOT", targetKey: "shot:s2", targetLabel: "镜头",
    value: { item: shot("s2", 0), parentGroupId: "missing", afterId: null },
  };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "NOOP");
});

test("applyFinalIntake REMOVE_GROUP: 存在则删除并重排", () => {
  const payload = payloadWithGroups([group("g1", 0, []), group("g2", 1, [])]);
  const draft: FinalIntakeDraft = { kind: "REMOVE_GROUP", targetKey: "shotGroup:g1", targetLabel: "桥段", value: {} };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "APPLIED");
  assert.deepEqual(result.payload.script.shotGroups.map((g) => g.id), ["g2"]);
  assert.equal(result.payload.script.shotGroups[0].orderIndex, 0);
});

test("applyFinalIntake REMOVE_GROUP: 不存在 → NOOP", () => {
  const payload = payloadWithGroups([group("g1", 0, [])]);
  const draft: FinalIntakeDraft = { kind: "REMOVE_GROUP", targetKey: "shotGroup:missing", targetLabel: "桥段", value: {} };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "NOOP");
});

test("applyFinalIntake REMOVE_SHOT: 存在则删除并重排全局镜头序号", () => {
  const payload = payloadWithGroups([group("g1", 0, [shot("s1", 0), shot("s2", 1)])]);
  const draft: FinalIntakeDraft = { kind: "REMOVE_SHOT", targetKey: "shot:s1", targetLabel: "镜头", value: {} };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "APPLIED");
  assert.deepEqual(result.payload.script.shotGroups[0].shots.map((s) => s.id), ["s2"]);
  assert.equal(result.payload.script.shotGroups[0].shots[0].orderIndex, 0);
});

test("applyFinalIntake REMOVE_SHOT: 不存在 → NOOP", () => {
  const payload = payloadWithGroups([group("g1", 0, [shot("s1", 0)])]);
  const draft: FinalIntakeDraft = { kind: "REMOVE_SHOT", targetKey: "shot:missing", targetLabel: "镜头", value: {} };
  const result = applyFinalIntake(payload, draft);
  assert.equal(result.effect, "NOOP");
});

// ---------------------------------------------------------------------------
// applyFinalIntakeBatch — DONE 时不应用；OPEN 时按顺序应用。
// ---------------------------------------------------------------------------

test("applyFinalIntakeBatch: DONE 状态下 payload 原样不变、applied 为 false", () => {
  const payload = payloadWithGroups([group("g1", 0, [], { bridgeName: "定稿前" })]);
  const drafts: FinalIntakeDraft[] = [
    { kind: "FIELD", targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", value: "定稿后想改的值" },
  ];
  const result = applyFinalIntakeBatch(payload, drafts, "DONE");
  assert.equal(result.applied, false);
  assert.equal(result.payload, payload);
  assert.equal(result.payload.script.shotGroups[0].bridgeName, "定稿前");
});

test("applyFinalIntakeBatch: OPEN 状态下按顺序应用全部记录", () => {
  const payload = payloadWithGroups([group("g1", 0, [], { bridgeName: "A" })]);
  const drafts: FinalIntakeDraft[] = [
    { kind: "FIELD", targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", value: "B" },
    { kind: "FIELD", targetKey: "shotGroup:g1.keyCreativeDescription", targetLabel: "本桥段关键创意描述", value: "说明" },
  ];
  const result = applyFinalIntakeBatch(payload, drafts, "OPEN");
  assert.equal(result.applied, true);
  assert.equal(result.payload.script.shotGroups[0].bridgeName, "B");
  assert.equal(result.payload.script.shotGroups[0].keyCreativeDescription, "说明");
});

// ---------------------------------------------------------------------------
// 采纳按 seq 顺序：seq 大的（更晚采纳/更晚产生）覆盖 seq 小的。
// ---------------------------------------------------------------------------

test("采纳按 seq 升序应用：后一条覆盖前一条，与输入顺序无关", () => {
  const payload = payloadWithGroups([group("g1", 0, [], { bridgeName: "origin" })]);
  const pending = [
    { seq: 2, draft: { kind: "FIELD", targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", value: "第二条" } as FinalIntakeDraft },
    { seq: 1, draft: { kind: "FIELD", targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", value: "第一条" } as FinalIntakeDraft },
  ];
  const sortedBySeq = [...pending].sort((left, right) => left.seq - right.seq).map((entry) => entry.draft);
  const result = applyFinalIntakeBatch(payload, sortedBySeq, "OPEN");
  assert.equal(result.payload.script.shotGroups[0].bridgeName, "第二条");
});

// ---------------------------------------------------------------------------
// 3.3 computeFinalFromHistory — 两个版本对同一处先后修改，集成版取后者。
// ---------------------------------------------------------------------------

function historyEvent(overrides: Partial<FinalHistoryEvent>): FinalHistoryEvent {
  return {
    id: "event_1",
    createdAt: "2026-08-20T10:00:00.000Z",
    versionId: "version_1",
    versionNumber: 1,
    changeSetId: "changeset_1",
    targetKey: "shotGroup:g1.bridgeName",
    targetLabel: "桥段名称",
    valueType: "TEXT",
    beforeValue: "",
    afterValue: "",
    actorUserId: "user_1",
    actorName: "张三",
    ...overrides,
  };
}

test("computeFinalFromHistory: 两版本改同一字段，按 created_at 排序后取后改者", () => {
  const origin = payloadWithGroups([group("g1", 0, [], { bridgeName: "origin" })]);
  // 有意乱序传入：v3 的事件在数组里排在 v2 前面，函数必须自己按 created_at 排序。
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_v3", versionId: "version_3", versionNumber: 3,
      createdAt: "2026-08-20T12:00:00.000Z", afterValue: "v3 张三改的值",
    }),
    historyEvent({
      id: "event_v2", versionId: "version_2", versionNumber: 2,
      createdAt: "2026-08-20T11:00:00.000Z", afterValue: "v2 李晓芸改的值", actorName: "李晓芸",
    }),
  ];
  const { payload, intakes } = computeFinalFromHistory(origin, events);
  assert.equal(payload.script.shotGroups[0].bridgeName, "v3 张三改的值");
  assert.equal(intakes.length, 2);
  // 重放顺序遵从 created_at 升序，不是数组的输入顺序。
  assert.equal(intakes[0].sourceVersionNumber, 2);
  assert.equal(intakes[1].sourceVersionNumber, 3);
  assert.ok(intakes.every((intake) => intake.applied === true));
});

test("computeFinalFromHistory: created_at 相同时用 id 兜底排序，结果稳定", () => {
  const origin = payloadWithGroups([group("g1", 0, [], { bridgeName: "origin" })]);
  const sameTime = "2026-08-20T10:00:00.000Z";
  const events: FinalHistoryEvent[] = [
    historyEvent({ id: "event_b", versionId: "version_b", versionNumber: 2, createdAt: sameTime, afterValue: "b" }),
    historyEvent({ id: "event_a", versionId: "version_a", versionNumber: 1, createdAt: sameTime, afterValue: "a" }),
  ];
  const { payload } = computeFinalFromHistory(origin, events);
  // "event_a" < "event_b" 字典序更小，先重放；"event_b" 后重放，最终生效。
  assert.equal(payload.script.shotGroups[0].bridgeName, "b");
});

test("computeFinalFromHistory: 事件里的 script.structure 变更同样先拆解再重放", () => {
  const origin = payloadWithGroups([group("g1", 0, [shot("s1", 0)])]);
  const before = [group("g1", 0, [shot("s1", 0)])];
  const after = [group("g1", 0, [shot("s1", 0), shot("s2", 1)])];
  const events: FinalHistoryEvent[] = [
    historyEvent({
      targetKey: "script.structure", targetLabel: "脚本结构", valueType: "STRUCTURE",
      beforeValue: before, afterValue: after,
    }),
  ];
  const { payload, intakes } = computeFinalFromHistory(origin, events);
  assert.deepEqual(payload.script.shotGroups[0].shots.map((s) => s.id), ["s1", "s2"]);
  assert.equal(intakes.length, 1);
  assert.equal(intakes[0].kind, "INSERT_SHOT");
});

// ---------------------------------------------------------------------------
// deriveFinalOrigin — the backfill's true starting point is v1's payload
// *before* its own edits, not v1's current (already-edited) state. Getting
// this wrong made the 溯源 view's "v1 原稿" row show v1's latest value
// mislabeled as the original.
// ---------------------------------------------------------------------------

test("deriveFinalOrigin: v1 改过两次的字段，origin 是第一次修改前的值", () => {
  const v1Current = payloadWithGroups([group("g1", 0, [], { bridgeName: "第二次改的值" })]);
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_1", versionId: "v1", createdAt: "2026-08-26T17:00:00.000Z",
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称",
      beforeValue: "原始值", afterValue: "第一次改的值",
    }),
    historyEvent({
      id: "event_2", versionId: "v1", createdAt: "2026-08-26T17:34:00.000Z",
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称",
      beforeValue: "第一次改的值", afterValue: "第二次改的值",
    }),
  ];
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.equal(origin.script.shotGroups[0].bridgeName, "原始值");
});

test("deriveFinalOrigin: 只撤销 v1 自己的事件，其他版本的事件不影响 origin", () => {
  const v1Current = payloadWithGroups([group("g1", 0, [], { bridgeName: "v1的当前值" })]);
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_v1", versionId: "v1", createdAt: "2026-08-26T10:00:00.000Z",
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称",
      beforeValue: "v1真正的原始值", afterValue: "v1的当前值",
    }),
    historyEvent({
      id: "event_v2", versionId: "v2", createdAt: "2026-08-26T12:00:00.000Z",
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称",
      beforeValue: "不该被用到", afterValue: "李晓芸改的值，跟 v1 的 origin 无关",
    }),
  ];
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.equal(origin.script.shotGroups[0].bridgeName, "v1真正的原始值");
});

test("deriveFinalOrigin: script.structure 事件整体撤销回 before 的 shotGroups", () => {
  const before = [group("g1", 0, [shot("s1", 0)])];
  const after = [group("g1", 0, [shot("s1", 0), shot("s2", 1)])];
  const v1Current = payloadWithGroups(after);
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_1", versionId: "v1", createdAt: "2026-08-26T10:00:00.000Z",
      targetKey: "script.structure", targetLabel: "脚本结构", valueType: "STRUCTURE",
      beforeValue: before, afterValue: after,
    }),
  ];
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.deepEqual(origin.script.shotGroups[0].shots.map((s) => s.id), ["s1"]);
});

test("deriveFinalOrigin: 目标已不存在的事件被跳过，其余撤销照常进行", () => {
  const v1Current = payloadWithGroups([group("g1", 0, [], { bridgeName: "v1的当前值" })]);
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_missing", versionId: "v1", createdAt: "2026-08-26T09:00:00.000Z",
      targetKey: "shotGroup:missing.bridgeName", targetLabel: "桥段名称",
      beforeValue: "不存在", afterValue: "无所谓",
    }),
    historyEvent({
      id: "event_real", versionId: "v1", createdAt: "2026-08-26T10:00:00.000Z",
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称",
      beforeValue: "真正的原始值", afterValue: "v1的当前值",
    }),
  ];
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.equal(origin.script.shotGroups[0].bridgeName, "真正的原始值");
});

test("deriveFinalOrigin: created_at 相同时按 id 降序撤销", () => {
  const v1Current = payloadWithGroups([group("g1", 0, [], { bridgeName: "z" })]);
  const sameTime = "2026-08-26T10:00:00.000Z";
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_a", versionId: "v1", createdAt: sameTime,
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", beforeValue: "x", afterValue: "y",
    }),
    historyEvent({
      id: "event_b", versionId: "v1", createdAt: sameTime,
      targetKey: "shotGroup:g1.bridgeName", targetLabel: "桥段名称", beforeValue: "y", afterValue: "z",
    }),
  ];
  // 降序：先撤销 event_b（z → y），再撤销 event_a（y → x）。
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.equal(origin.script.shotGroups[0].bridgeName, "x");
});

test("deriveFinalOrigin: 撤销后不再符合契约（如无效的固定选项）时退回 v1 当前 payload", () => {
  const v1Current = payloadWithGroups([group("g1", 0, [])]);
  const events: FinalHistoryEvent[] = [
    historyEvent({
      id: "event_1", versionId: "v1", createdAt: "2026-08-26T10:00:00.000Z",
      targetKey: "shotGroup:g1.primaryCreativeRole", targetLabel: "桥段主创意作用", valueType: "CHOICE_WITH_CUSTOM",
      beforeValue: { selectedOptionIds: ["NOT_A_REAL_OPTION"], customText: "", vocabularyVersion: "AD_VIDEO_VOCAB_V1" },
      afterValue: v1Current.script.shotGroups[0].primaryCreativeRole,
    }),
  ];
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.deepEqual(origin, v1Current);
});

test("deriveFinalOrigin: 没有 v1 自己的事件时，origin 就是 v1 当前 payload", () => {
  const v1Current = payloadWithGroups([group("g1", 0, [], { bridgeName: "唯一的值" })]);
  const events: FinalHistoryEvent[] = [
    historyEvent({ id: "event_v2", versionId: "v2", beforeValue: "别的", afterValue: "跟 v1 无关" }),
  ];
  const origin = deriveFinalOrigin(v1Current, "v1", events);
  assert.deepEqual(origin, v1Current);
});

// ---------------------------------------------------------------------------
// Bug fix regression guard: a case that was never saved through the V1.9
// surface only has a *virtual* final version (no analysis_final_versions
// row) until something materializes it. setFinalVersionStatus and
// adoptFinalIntakes are both writes that can be the very first thing 老孙
// does on such a case (定稿 as the first action after migration), so they
// must materialize (with backfill) rather than 404 on a row that simply
// hasn't been created yet — see the ensureFinalVersion call each of them
// makes right after resolveWorkspaceForWrite.
// ---------------------------------------------------------------------------

test("source: setFinalVersionStatus and adoptFinalIntakes both materialize the final version before touching it", async () => {
  const source = await readFile(new URL("../lib/final-version.ts", import.meta.url), "utf8");

  const sliceFunction = (name: string, nextMarker: string) => {
    const start = source.indexOf(`export async function ${name}(`);
    assert.notEqual(start, -1, `could not find export async function ${name}(`);
    const end = source.indexOf(nextMarker, start);
    assert.notEqual(end, -1, `could not find the end marker for ${name}`);
    return source.slice(start, end);
  };

  const setFinalVersionStatusBody = sliceFunction("setFinalVersionStatus", "export async function adoptFinalIntakes");
  const adoptFinalIntakesBody = sliceFunction("adoptFinalIntakes", "export type LoadedFinalVersion");

  for (const [name, body] of [
    ["setFinalVersionStatus", setFinalVersionStatusBody],
    ["adoptFinalIntakes", adoptFinalIntakesBody],
  ] as const) {
    assert.match(
      body, /await ensureFinalVersion\(tx, workspace, now\)/,
      `${name} must call ensureFinalVersion before reading/locking analysis_final_versions, ` +
      "so a case that was never saved through V1.9 (still a virtual final version) doesn't 404",
    );
    // The materializing call must happen before the row is read/locked, not after —
    // otherwise the SELECT ... FOR UPDATE above it would still 404 on a virtual case.
    const ensureIndex = body.indexOf("await ensureFinalVersion(tx, workspace, now)");
    const selectIndex = body.indexOf("FROM analysis_final_versions WHERE workspace_id = ? FOR UPDATE");
    assert.ok(ensureIndex < selectIndex, `${name} must materialize before the locked read`);
  }
});
