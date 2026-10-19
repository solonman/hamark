// ② 汇总纪要、③ 汇总方法的校验（docs/26 6.5），以及草稿组装、候选排序，和本地假实现
// 走完三步后的覆盖面（三类候选、跨案例合并、observations、客户录音出处、被丢弃的引用）。
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRetroExtraction, type RetroExtractionOutput } from "../lib/retro/extraction";
import { buildFakeRetroDistill, buildFakeRetroExtraction, buildFakeRetroSummary } from "../lib/retro/month-fake";
import {
  assembleRetroMinutes,
  normalizeRetroDistill,
  normalizeRetroSummary,
  orderRetroCandidates,
  type RetroSynthesisContext,
} from "../lib/retro/synthesis";
import type { RetroMethodCandidate } from "../lib/retro-model";
import { CASE_A, CASE_B, sampleSnapshot } from "./retro-month-fixtures";

const SUMMARY_SPEAKERS = { rtr_sum: { founder: "S0", labels: { S0: "老孙" } } };

function context(): RetroSynthesisContext {
  const snapshot = sampleSnapshot();
  const a = normalizeRetroExtraction({
    speakers: { founder: ["1:S0", "2:S0"], labels: { "1:S1": "汇报人" } },
    review: {
      process: "经过",
      processSegmentIds: ["cast_voice:1"],
      disputes: [{ text: "争议", segmentIds: [4, 3] }],
      founderPoints: [{ text: "没追问", segmentIds: [2], roundIds: ["rnd_a1"] }],
      suggestions: [{ text: "放到堆头", segmentIds: [6] }],
    },
    methods: [{ dimension: "ENTRY", kind: "METHOD", title: "先问为什么", description: "", situation: "", transfer: "TRANSFERABLE", transferNote: "", segmentIds: [2], roundIds: ["rnd_a1"] }],
  }, CASE_A).output;
  const b = normalizeRetroExtraction({
    speakers: { founder: ["1:S0"], labels: {} },
    review: { process: "茶饮经过", disputes: [], founderPoints: [{ text: "问过吗", segmentIds: [2] }], suggestions: [] },
    methods: [{ dimension: "ENTRY", kind: "METHOD", title: "先问为什么", description: "", situation: "", transfer: "TRANSFERABLE", transferNote: "", segmentIds: [2] }],
  }, CASE_B).output;
  return { snapshot, extractions: { rtc_a: a, rtc_b: b } };
}

test("② sources may cite only segments ① already cited, or real summary segments", () => {
  const ctx = context();
  const { output, dropped } = normalizeRetroSummary({
    summarySpeakers: { founder: ["1:S0"], labels: { "1:S1": "其他同事" } },
    insights: [
      { text: "线索不是答案", segments: ["2:2", "3:2", "S2"] },
      { text: "引用了①没引用过的片段", segments: ["2:1", "3:3"] },
      { text: "引用了不存在的总结片段", segments: ["S99"] },
    ],
    actions: [{ text: "提案前写一句", segments: ["S2", "2:6", "bogus"] }],
  }, ctx);
  assert.equal(output.insights.length, 1);
  assert.deepEqual(output.insights[0].sources, [
    { kind: "REVIEW", recordingId: "rtr_a1", segmentIds: [2], caseId: "rtc_a" },
    { kind: "REVIEW", recordingId: "rtr_b1", segmentIds: [2], caseId: "rtc_b" },
    { kind: "REVIEW", recordingId: "rtr_sum", segmentIds: [2], caseId: null },
  ]);
  assert.deepEqual(output.actions[0].sources.map((source) => source.kind === "REVIEW" && source.recordingId), ["rtr_a2", "rtr_sum"]);
  assert.deepEqual(output.speakers, { rtr_sum: { founder: "S0", labels: { S1: "其他同事", S0: "老孙" } } });
  assert.ok(dropped.some((line) => line.includes("2:1")));
  assert.ok(dropped.some((line) => line.includes("S99")));
});

test("② falls back to the dominant summary speaker when the founder is not recognised", () => {
  const { output } = normalizeRetroSummary({ summarySpeakers: { founder: ["1:S5"] }, insights: [], actions: [] }, context());
  assert.equal(output.speakers.rtr_sum.founder, "S0");
});

test("③ merges across cases, keeps the founder rule, and validates round ids against the cited cases", () => {
  const ctx = context();
  const { output, dropped } = normalizeRetroDistill({
    candidates: [
      { dimension: "ENTRY", kind: "METHOD", title: "先问为什么", description: "", situation: "", transfer: "TRANSFERABLE", transferNote: "", segments: ["2:2", "3:2"], roundIds: ["rnd_a1", "rnd_b1", "rnd_zzz"] },
      { dimension: "PATH", kind: "METHOD", title: "只有同事的话", description: "", situation: "", transfer: "UNSURE", transferNote: "", segments: ["2:4"] },
      { dimension: "VALUE", kind: "SITUATIONAL", title: "没写情境", description: "", situation: "", transfer: "UNSURE", transferNote: "", segments: ["2:3"] },
      { dimension: "INFO", kind: "INTUITION", title: "总结里的判断", description: "", situation: "", transfer: "UNSURE", transferNote: "", segments: ["S1"] },
    ],
    observations: [{ text: "差异", segments: ["2:6", "3:2"] }, { text: "无据", segments: [] }],
  }, ctx, SUMMARY_SPEAKERS);
  assert.deepEqual(output.candidates.map((candidate) => candidate.title), ["先问为什么", "总结里的判断"]);
  const merged = output.candidates[0];
  assert.deepEqual(merged.sources, [
    { kind: "REVIEW", recordingId: "rtr_a1", segmentIds: [2], caseId: "rtc_a", roundIds: ["rnd_a1"] },
    { kind: "REVIEW", recordingId: "rtr_b1", segmentIds: [2], caseId: "rtc_b", roundIds: ["rnd_b1"] },
  ]);
  assert.deepEqual(output.candidates.map((candidate) => candidate.number), [1, 2]);
  assert.equal(output.observations.length, 1);
  assert.ok(dropped.some((line) => line.includes("rnd_zzz")));
  assert.ok(dropped.some((line) => line.includes("没有引用老孙的原话")));
  assert.ok(dropped.some((line) => line.includes("情境")));
});

test("③ client audio can never back a candidate (client refs are not citable in synthesis)", () => {
  const ctx = context();
  const { output } = normalizeRetroDistill({
    candidates: [{ dimension: "ENTRY", kind: "METHOD", title: "x", description: "", situation: "", transfer: "UNSURE", transferNote: "", segments: ["cast_voice:1"] }],
    observations: [],
  }, ctx, SUMMARY_SPEAKERS);
  assert.equal(output.candidates.length, 0);
});

test("candidates are ordered by dimension, never by frequency, and renumbered", () => {
  const make = (id: string, dimension: RetroMethodCandidate["dimension"]): RetroMethodCandidate => ({
    id, number: 9, dimension, kind: "METHOD", title: id, description: "", situation: "", transfer: "UNSURE", transferNote: "", sources: [], origin: "AI", edited: false,
  });
  const ordered = orderRetroCandidates([make("x", "INTERACTION"), make("y", "ENTRY"), make("z", "VALUE"), make("w", "ENTRY")]);
  assert.deepEqual(ordered.map((item) => [item.id, item.number]), [["y", 1], ["w", 2], ["z", 3], ["x", 4]]);
});

test("minutes reuse ① verbatim for case reviews and list unanalyzed cases", () => {
  const ctx = context();
  const minutes = assembleRetroMinutes(ctx, { insights: [], actions: [] });
  assert.deepEqual(minutes.cases.map((item) => item.caseId), ["rtc_a", "rtc_b"]);
  assert.deepEqual(minutes.unanalyzedCaseIds, ["rtc_c"]);
  assert.equal(minutes.cases[0].process, "经过");
  assert.equal(minutes.cases[0].founderPoints[0].text, "没追问");
});

test("the fake provider covers all three kinds, a cross-case merge, observations, client sources and dropped references", () => {
  const snapshot = sampleSnapshot();
  const extractions: Record<string, RetroExtractionOutput> = {};
  const droppedAll: string[] = [];
  for (const item of snapshot.cases.filter((entry) => entry.recordings.length)) {
    const result = normalizeRetroExtraction(buildFakeRetroExtraction(item), item);
    extractions[item.caseId] = result.output;
    droppedAll.push(...result.dropped);
  }
  const ctx = { snapshot, extractions };
  const summary = normalizeRetroSummary(buildFakeRetroSummary(ctx), ctx);
  const distill = normalizeRetroDistill(buildFakeRetroDistill(ctx, summary.output.speakers), ctx, summary.output.speakers);
  droppedAll.push(...summary.dropped, ...distill.dropped);

  const kinds = new Set(distill.output.candidates.map((candidate) => candidate.kind));
  assert.deepEqual([...kinds].sort(), ["INTUITION", "METHOD", "SITUATIONAL"]);
  const merged = distill.output.candidates.find((candidate) => candidate.title === "先问客户为什么提这个要求，再动手改");
  assert.ok(merged);
  assert.deepEqual([...new Set(merged.sources.map((source) => source.caseId))], ["rtc_a", "rtc_b"]);
  assert.ok(distill.output.observations.length >= 1);
  assert.ok(extractions.rtc_a.review.processSources.some((source) => source.kind === "CLIENT"));
  assert.ok(extractions.rtc_a.review.disputes.some((item) => item.sources.some((source) => source.kind === "CLIENT")));
  for (const candidate of distill.output.candidates) assert.ok(candidate.sources.every((source) => source.kind === "REVIEW"));
  for (const reason of ["9999", "rnd_not_exist", "客户录音不能", "没有引用老孙的原话", "情境", "GOLDEN_CIRCLE", "99:1", "S9999"]) {
    assert.ok(droppedAll.some((line) => line.includes(reason)), `expected a dropped reason mentioning ${reason}`);
  }
  assert.ok(summary.output.insights.length >= 1);
  assert.ok(summary.output.actions.length >= 1);
});

test("③ a summary sentence backs a candidate only if that summary recording's founder said it", () => {
  const ctx = context();
  const candidate = { dimension: "INFO", kind: "INTUITION", title: "总结里的判断", description: "", situation: "", transfer: "UNSURE", transferNote: "", segments: ["S3"] };
  // S3 是 S1 说的（同事插话）：按这段录音的认定，它不是老孙。
  assert.equal(normalizeRetroDistill({ candidates: [candidate], observations: [] }, ctx, SUMMARY_SPEAKERS).output.candidates.length, 0);
  assert.equal(normalizeRetroDistill({ candidates: [candidate], observations: [] }, ctx, { rtr_sum: { founder: "S1", labels: {} } }).output.candidates.length, 1);
});
