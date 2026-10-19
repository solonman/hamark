// ① 逐案提炼的校验与归一（docs/26 6.4），逐条规则测试。
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRetroExtraction } from "../lib/retro/extraction";
import { caseSegmentIndex, truncateClientAudio } from "../lib/retro/month-snapshot";
import { CASE_A, seg } from "./retro-month-fixtures";

const method = (overrides: Record<string, unknown> = {}) => ({
  dimension: "ENTRY",
  kind: "METHOD",
  title: "先问客户为什么提这个要求",
  description: "老孙先问为什么",
  situation: "",
  transfer: "TRANSFERABLE",
  transferNote: "通用",
  segmentIds: [2],
  roundIds: [],
  ...overrides,
});

const base = (overrides: Record<string, unknown> = {}) => ({
  speakers: { founder: "S0", labels: { S1: "汇报人", S2: "其他同事" } },
  review: { process: "经过", processSegmentIds: [], disputes: [], founderPoints: [], suggestions: [] },
  insights: [],
  actions: [],
  methods: [],
  corrections: [],
  ...overrides,
});

test("a case with several recordings is numbered continuously in part order", () => {
  const index = caseSegmentIndex(CASE_A);
  assert.deepEqual(index.map((ref) => [ref.n, ref.recordingId, ref.segment.id]), [
    [1, "rtr_a1", 1], [2, "rtr_a1", 2], [3, "rtr_a1", 3], [4, "rtr_a1", 4], [5, "rtr_a2", 1], [6, "rtr_a2", 2],
  ]);
});

test("segment numbers map back to (recording, segment) and group into one source per recording", () => {
  const { output } = normalizeRetroExtraction(base({
    review: { process: "", disputes: [], founderPoints: [{ text: "没追问", segmentIds: [2, 6, "3"], roundIds: ["rnd_a1"] }], suggestions: [] },
  }), CASE_A);
  assert.deepEqual(output.review.founderPoints[0].sources, [
    { kind: "REVIEW", recordingId: "rtr_a1", segmentIds: [2, 3], caseId: "rtc_a", roundIds: ["rnd_a1"] },
    { kind: "REVIEW", recordingId: "rtr_a2", segmentIds: [2], caseId: "rtc_a" },
  ]);
  assert.equal(output.review.founderPoints[0].origin, "AI");
  assert.equal(output.review.founderPoints[0].edited, false);
});

test("non-existent segment ids and round ids are removed; an item left with no valid reference is dropped", () => {
  const { output, dropped } = normalizeRetroExtraction(base({
    review: {
      process: "",
      disputes: [],
      founderPoints: [
        { text: "有一句有效", segmentIds: [99, 3], roundIds: ["rnd_a2", "rnd_missing"] },
        { text: "全是编的", segmentIds: [99, 100] },
      ],
      suggestions: [],
    },
  }), CASE_A);
  assert.equal(output.review.founderPoints.length, 1);
  assert.deepEqual(output.review.founderPoints[0].sources, [{ kind: "REVIEW", recordingId: "rtr_a1", segmentIds: [3], caseId: "rtc_a", roundIds: ["rnd_a2"] }]);
  assert.ok(dropped.some((line) => line.includes("99")));
  assert.ok(dropped.some((line) => line.includes("rnd_missing")));
  assert.ok(dropped.some((line) => line.includes("全是编的")));
});

test("client audio references are kept only in process and disputes", () => {
  const { output, dropped } = normalizeRetroExtraction(base({
    review: {
      process: "客户要年轻一点",
      processSegmentIds: ["cast_voice:1", 1],
      disputes: [{ text: "方向算不算错", segmentIds: [4, 3, "cast_voice:2"] }],
      founderPoints: [{ text: "客户自己也说了", segmentIds: ["cast_voice:1"] }],
      suggestions: [{ text: "放到堆头", segmentIds: [6, "cast_voice:2"] }],
    },
    insights: [{ text: "线索不是答案", segmentIds: ["cast_voice:1", 3] }],
  }), CASE_A);
  assert.deepEqual(output.review.processSources.map((source) => source.kind), ["REVIEW", "CLIENT"]);
  assert.deepEqual(output.review.processSources[1], { kind: "CLIENT", assetId: "ast_voice", segmentIds: [1], caseId: "rtc_a", roundId: "rnd_a1" });
  assert.deepEqual(output.review.disputes[0].sources.map((source) => source.kind), ["REVIEW", "CLIENT"]);
  assert.equal(output.review.founderPoints.length, 0, "a founder point backed only by client audio is dropped");
  assert.deepEqual(output.review.suggestions[0].sources.map((source) => source.kind), ["REVIEW"]);
  assert.deepEqual(output.insights[0].sources.map((source) => source.kind), ["REVIEW"]);
  assert.ok(dropped.filter((line) => line.includes("客户录音不能")).length >= 3);
});

test("a client reference to an unknown asset or segment is treated as non-existent", () => {
  const { output } = normalizeRetroExtraction(base({
    review: { process: "", processSegmentIds: ["cast_voice:9", "cast_other:1"], disputes: [], founderPoints: [], suggestions: [] },
  }), CASE_A);
  assert.deepEqual(output.review.processSources, []);
});

test("a method candidate needs at least one sentence said by the founder", () => {
  const { output, dropped } = normalizeRetroExtraction(base({
    methods: [method({ segmentIds: [1, 4] }), method({ title: "混合引用", segmentIds: [1, 3] })],
  }), CASE_A);
  assert.deepEqual(output.methods.map((item) => item.title), ["混合引用"]);
  assert.ok(dropped.some((line) => line.includes("没有引用老孙的原话")));
});

test("without a recognised founder every method candidate is dropped", () => {
  const { output, dropped } = normalizeRetroExtraction(base({ speakers: { founder: "S9" }, methods: [method()] }), CASE_A);
  assert.equal(output.methods.length, 0);
  assert.equal(output.speakers.founder, null);
  assert.ok(dropped.some((line) => line.includes("没有认出老孙")));
});

test("illegal enums, empty titles and situational candidates without a situation are dropped", () => {
  const { output, dropped } = normalizeRetroExtraction(base({
    methods: [
      method({ dimension: "WHY" }),
      method({ kind: "GOLDEN_CIRCLE" }),
      method({ transfer: "ALWAYS" }),
      method({ title: "   " }),
      method({ kind: "SITUATIONAL", situation: "  " }),
      method({ kind: "SITUATIONAL", situation: "客户当场情绪激动", title: "先让他把火发完" }),
    ],
  }), CASE_A);
  assert.deepEqual(output.methods.map((item) => item.title), ["先让他把火发完"]);
  assert.equal(output.methods[0].situation, "客户当场情绪激动");
  assert.equal(dropped.filter((line) => line.includes("整条丢弃")).length, 5);
});

test("text is trimmed and clipped: titles to 40 characters, everything else to 600", () => {
  const { output } = normalizeRetroExtraction(base({
    review: { process: `  ${"经".repeat(700)}  `, disputes: [], founderPoints: [], suggestions: [] },
    methods: [method({ title: `  ${"题".repeat(50)}  `, description: "述".repeat(700) })],
  }), CASE_A);
  assert.equal([...output.review.process].length, 600);
  assert.equal([...output.methods[0].title].length, 40);
  assert.equal([...output.methods[0].description].length, 600);
});

test("situation is kept only for situational candidates", () => {
  const { output } = normalizeRetroExtraction(base({ methods: [method({ situation: "不该出现" })] }), CASE_A);
  assert.equal(output.methods[0].situation, "");
});

test("a case whose every item is dropped is marked empty, not failed", () => {
  const { output } = normalizeRetroExtraction(base({
    review: { process: "只剩经过", disputes: [{ text: "x", segmentIds: [77] }], founderPoints: [], suggestions: [] },
    methods: [method({ segmentIds: [1] })],
  }), CASE_A);
  assert.equal(output.empty, true);
  assert.equal(output.review.process, "只剩经过");
});

test("speaker labels: the founder becomes 老孙, unknown speakers are ignored", () => {
  const { output } = normalizeRetroExtraction(base({ speakers: { founder: "S0", labels: { S1: "汇报人", S7: "路人", S0: "别的" } } }), CASE_A);
  assert.deepEqual(output.speakers.labels, { S1: "汇报人", S0: "老孙" });
});

test("corrections must quote the segment text exactly", () => {
  const { output } = normalizeRetroExtraction(base({
    corrections: [{ segmentId: 3, from: "画风", to: "画面风格" }, { segmentId: 3, from: "不存在", to: "x" }, { segmentId: 42, from: "a", to: "b" }],
  }), CASE_A);
  assert.deepEqual(output.corrections, [{ recordingId: "rtr_a1", segmentId: 3, from: "画风", to: "画面风格" }]);
});

test("model-written quotes are never used: items only carry segment references", () => {
  const { output } = normalizeRetroExtraction(base({
    review: { process: "", disputes: [], founderPoints: [{ text: "x", quote: "老孙说过一句编造的话", segmentIds: [2] }], suggestions: [] },
  }), CASE_A);
  assert.equal(JSON.stringify(output).includes("编造"), false);
});

test("client transcripts are capped at 30,000 characters per case and the omission is counted", () => {
  const long = Array.from({ length: 40 }, (_, index) => seg(index + 1, index * 10, "S0", "字".repeat(1000)));
  const [first, second] = truncateClientAudio([
    { assetId: "a1", roundId: null, fileName: "a1.m4a", segments: long.slice(0, 25) },
    { assetId: "a2", roundId: "r1", fileName: "a2.m4a", segments: long.slice(25) },
  ]);
  assert.equal(first.segments.length, 25);
  assert.equal(first.omittedSegments, 0);
  assert.equal(second.segments.length, 5);
  assert.equal(second.omittedSegments, 10);
});
