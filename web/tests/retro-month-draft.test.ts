// 草稿审阅修改（docs/26 6.6）：各节的改／删／补权限、edited 与 origin、方法候选的维度／类别／迁移性、
// SITUATIONAL 必须有情境、请求体校验。纯函数测试；乐观锁与权限在 retro-month-service.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { applyRetroDraftPatch, normalizeDraftPatchRequest, type RetroDraft } from "../lib/retro/month-draft";
import { RetroMonthError } from "../lib/retro/month-errors";

const item = (id: string, text = id) => ({ id, text, sources: [{ kind: "REVIEW" as const, recordingId: "rtr", segmentIds: [1], caseId: "rtc_a" }], origin: "AI" as const, edited: false });

function draft(): RetroDraft {
  return {
    minutes: {
      cases: [{ caseId: "rtc_a", process: "经过", processSources: [], disputes: [item("d1")], founderPoints: [item("f1")], suggestions: [item("s1")], empty: false }],
      unanalyzedCaseIds: [],
      insights: [item("i1")],
      actions: [item("a1")],
    },
    methods: {
      candidates: [
        { id: "c1", number: 1, dimension: "ENTRY", kind: "METHOD", title: "先问为什么", description: "", situation: "", transfer: "TRANSFERABLE", transferNote: "", sources: [], origin: "AI", edited: false },
        { id: "c2", number: 2, dimension: "VALUE", kind: "INTUITION", title: "老板会皱眉", description: "", situation: "", transfer: "UNSURE", transferNote: "", sources: [], origin: "AI", edited: false },
      ],
      observations: [item("o1")],
    },
  };
}

const patch = (body: Record<string, unknown>) => normalizeDraftPatchRequest({ revision: 1, ...body });
const apply = (body: Record<string, unknown>, base = draft()) => applyRetroDraftPatch(base, patch(body), (prefix) => `${prefix}-new`);

function rejects(fn: () => unknown, status: number, pattern?: RegExp) {
  assert.throws(fn, (error: unknown) => error instanceof RetroMonthError && error.status === status && (!pattern || pattern.test(error.message)));
}

test("process can only be updated, never deleted or added", () => {
  const { draft: next } = apply({ section: "case.process", caseId: "rtc_a", op: "UPDATE", value: { text: "改过的经过" } });
  assert.equal(next.minutes.cases[0].process, "改过的经过");
  assert.equal(next.minutes.cases[0].processEdited, true);
  rejects(() => apply({ section: "case.process", caseId: "rtc_a", op: "DELETE" }), 400, /只能修改/);
  rejects(() => apply({ section: "case.process", caseId: "rtc_a", op: "ADD", value: { text: "x" } }), 400);
});

test("disputes, founder points and suggestions can be updated or deleted but not added", () => {
  for (const [section, id] of [["case.disputes", "d1"], ["case.founderPoints", "f1"], ["case.suggestions", "s1"]] as const) {
    const updated = apply({ section, caseId: "rtc_a", itemId: id, op: "UPDATE", value: { text: "新文字" } }).draft;
    const key = section.slice(5) as "disputes" | "founderPoints" | "suggestions";
    assert.deepEqual([updated.minutes.cases[0][key][0].text, updated.minutes.cases[0][key][0].edited, updated.minutes.cases[0][key][0].origin], ["新文字", true, "AI"]);
    assert.equal(apply({ section, caseId: "rtc_a", itemId: id, op: "DELETE" }).draft.minutes.cases[0][key].length, 0);
    rejects(() => apply({ section, caseId: "rtc_a", op: "ADD", value: { text: "x" } }), 400, /不能补充/);
  }
});

test("insights, actions and observations accept manual additions without sources", () => {
  for (const section of ["insights", "actions", "observations"] as const) {
    const { draft: next, itemId } = apply({ section, op: "ADD", value: { text: "老孙补充的一条" } });
    const list = section === "observations" ? next.methods.observations : next.minutes[section];
    assert.equal(itemId, "man-new");
    assert.deepEqual(list[list.length - 1], { id: "man-new", text: "老孙补充的一条", sources: [], origin: "MANUAL", edited: false });
    const removed = apply({ section, itemId: list[0].id, op: "DELETE" }).draft;
    assert.equal((section === "observations" ? removed.methods.observations : removed.minutes[section]).length, 0);
  }
});

test("an unchanged update does not flag the item as edited", () => {
  const { draft: next } = apply({ section: "insights", itemId: "i1", op: "UPDATE", value: { text: "i1" } });
  assert.equal(next.minutes.insights[0].edited, false);
});

test("candidates: change dimension, kind and transfer; the list is re-sorted by dimension and renumbered", () => {
  const { draft: next } = apply({ section: "candidates", itemId: "c1", op: "UPDATE", value: { dimension: "INTERACTION", transfer: "CASE_ONLY" } });
  assert.deepEqual(next.methods.candidates.map((candidate) => [candidate.id, candidate.number, candidate.edited]), [["c2", 1, false], ["c1", 2, true]]);
  assert.equal(next.methods.candidates[1].transfer, "CASE_ONLY");
});

test("situational candidates need a situation, on update and on add", () => {
  rejects(() => apply({ section: "candidates", itemId: "c1", op: "UPDATE", value: { kind: "SITUATIONAL" } }), 400, /情境/);
  const ok = apply({ section: "candidates", itemId: "c1", op: "UPDATE", value: { kind: "SITUATIONAL", situation: "客户当场发火" } }).draft;
  assert.equal(ok.methods.candidates[0].situation, "客户当场发火");
  rejects(() => apply({ section: "candidates", op: "ADD", value: { dimension: "ENTRY", kind: "SITUATIONAL", title: "x" } }), 400, /情境/);
});

test("adding a candidate requires a title, a dimension and a kind; it is MANUAL and may have no sources", () => {
  rejects(() => apply({ section: "candidates", op: "ADD", value: { kind: "METHOD", title: "x" } }), 400, /维度/);
  rejects(() => apply({ section: "candidates", op: "ADD", value: { dimension: "ENTRY", kind: "METHOD", title: "" } }), 400);
  const { draft: next, itemId } = apply({ section: "candidates", op: "ADD", value: { dimension: "ENTRY", kind: "METHOD", title: "老孙补充的方法" } });
  const added = next.methods.candidates.find((candidate) => candidate.id === itemId)!;
  assert.deepEqual([added.origin, added.sources, added.transfer, added.number], ["MANUAL", [], "UNSURE", 2]);
  assert.deepEqual(next.methods.candidates.map((candidate) => candidate.number), [1, 2, 3]);
});

test("illegal enums and over-long text are rejected", () => {
  rejects(() => apply({ section: "candidates", itemId: "c1", op: "UPDATE", value: { dimension: "WHY" } }), 400);
  rejects(() => apply({ section: "candidates", itemId: "c1", op: "UPDATE", value: { title: "题".repeat(41) } }), 400, /40/);
  rejects(() => apply({ section: "insights", itemId: "i1", op: "UPDATE", value: { text: "字".repeat(601) } }), 400, /600/);
  rejects(() => apply({ section: "insights", itemId: "i1", op: "UPDATE", value: { text: "  " } }), 400, /删除/);
});

test("unknown items and cases answer 404", () => {
  rejects(() => apply({ section: "insights", itemId: "nope", op: "DELETE" }), 404);
  rejects(() => apply({ section: "case.disputes", caseId: "rtc_x", itemId: "d1", op: "DELETE" }), 404);
});

test("the request body is validated before anything is applied", () => {
  rejects(() => normalizeDraftPatchRequest({ section: "nope", op: "UPDATE", revision: 1 }), 400);
  rejects(() => normalizeDraftPatchRequest({ section: "insights", op: "MOVE", revision: 1 }), 400);
  rejects(() => normalizeDraftPatchRequest({ section: "insights", op: "UPDATE", itemId: "i1" }), 400, /revision/);
  rejects(() => normalizeDraftPatchRequest({ section: "case.disputes", op: "DELETE", itemId: "d1", revision: 1 }), 400, /caseId/);
  rejects(() => normalizeDraftPatchRequest({ section: "insights", op: "DELETE", revision: 1 }), 400, /itemId/);
});

test("applying a patch never mutates the input draft", () => {
  const base = draft();
  const before = JSON.stringify(base);
  apply({ section: "insights", itemId: "i1", op: "DELETE" }, base);
  assert.equal(JSON.stringify(base), before);
});
