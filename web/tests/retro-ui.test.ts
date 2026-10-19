// 客户需求复盘库前端纯函数（lib/retro-ui.ts）：分组、筛选、搜索、封面轨迹、新建校验、文字稿拼接、出处标记、
// 生成前提与整理进度、地址栏跳转参数、草稿的本地先改。组件的接线见 tests/retro-ui-source.test.ts。

import assert from "node:assert/strict";
import test from "node:test";
import type { RetroCaseCard, RetroRecordingView, RetroMonthView, RetroMinutes, RetroMethods, RetroItem } from "../lib/retro-model.ts";
import {
  applyRetroDraftPatch,
  blankRetroBasics,
  buildClientTranscript,
  buildRetroBasicsInput,
  buildRetroCaseNumberMap,
  buildRetroTranscript,
  describeRetroRoundMarks,
  describeRetroSource,
  filterRetroCards,
  formatRetroHM,
  groupRetroCardsByMonth,
  hasPendingCaseWork,
  hasPendingRetroWork,
  isRetroReviewing,
  matchesRetroQuery,
  nextRetroPartNo,
  nextRetroRoundTitle,
  parseRetroCaseJump,
  parseRetroMonthJump,
  retroBasicsClosable,
  retroCoverTrack,
  retroDepartments,
  retroEditMonthChoices,
  retroGenerateConfirmLines,
  retroJobSteps,
  retroMonthBadgeFromView,
  retroMonthBadgeLabel,
  retroMonthChoices,
  retroMonthOverview,
  retroPreconditionItems,
  retroRecordingLabel,
  retroRoundHasContent,
  retroSpeakerName,
  retroVersionOptions,
  uniqueRetroSources,
  validateRetroBasics,
  checkRetroAttachFile,
  type RetroSourceContext,
} from "../lib/retro-ui.ts";

function card(overrides: Partial<RetroCaseCard> = {}): RetroCaseCard {
  return {
    id: "rtc_1",
    monthKey: "2026-10",
    department: "创意一部",
    clientName: "某乳企",
    title: "年货节主视觉三次被否",
    sceneTags: ["改稿"],
    backgroundExcerpt: "客户要喜庆",
    roundTrack: [{ title: "第 1 版", hasFeedback: true }],
    hasOutcome: false,
    recording: { state: "NONE" },
    createdByName: "刘梦娜",
    createdAt: "2026-10-10T08:00:00.000Z",
    canManage: true,
    ...overrides,
  };
}

test("recording label covers the four card states, uploading counts as 转写中", () => {
  assert.deepEqual(retroRecordingLabel({ state: "NONE" }), { tone: "none", label: "无录音" });
  assert.deepEqual(retroRecordingLabel({ state: "PROCESSING" }), { tone: "busy", label: "转写中" });
  assert.deepEqual(retroRecordingLabel({ state: "FAILED" }), { tone: "failed", label: "转写失败" });
  assert.deepEqual(retroRecordingLabel({ state: "READY", parts: 2, durationMs: 2_892_000 }), { tone: "ready", label: "录音 2 段 · 48:12" });
});

test("month badge has the five states of 10.1", () => {
  assert.equal(retroMonthBadgeLabel({ state: "NONE" }).label, "未整理");
  assert.equal(retroMonthBadgeLabel({ state: "RUNNING", publishedVersion: null }).label, "整理中");
  assert.equal(retroMonthBadgeLabel({ state: "RUNNING", publishedVersion: 2 }).label, "已发布 v2 · 整理中");
  assert.equal(retroMonthBadgeLabel({ state: "PUBLISHED", version: 1, changed: false }).label, "已发布 v1");
  assert.deepEqual(retroMonthBadgeLabel({ state: "PUBLISHED", version: 1, changed: true }), { tone: "updated", label: "已发布 v1 · 有更新" });
});

test("polling is only needed while some recording is still processing", () => {
  assert.equal(hasPendingRetroWork([card()]), false);
  assert.equal(hasPendingRetroWork([card(), card({ recording: { state: "PROCESSING" } })]), true);
});

test("search: NFKC, case-insensitive, hits title / client / department / scenes / background / rounds / uploader / searchText", () => {
  const c = card({ searchText: "回合里写了红金配色" });
  assert.equal(matchesRetroQuery(c, ""), true);
  for (const word of ["年货节", "某乳企", "创意一部", "改稿", "喜庆", "第 1 版", "刘梦娜", "红金配色"]) assert.equal(matchesRetroQuery(c, word), true, word);
  assert.equal(matchesRetroQuery(c, "不存在"), false);
  assert.equal(matchesRetroQuery(card({ title: "Q4 case" }), "ｑ４"), true);
});

test("department filter and departments list keep first-seen order", () => {
  const cards = [card({ id: "a", department: "创意二部" }), card({ id: "b", department: "创意一部" }), card({ id: "c", department: "创意二部" })];
  assert.deepEqual(retroDepartments(cards), ["创意二部", "创意一部"]);
  assert.deepEqual(filterRetroCards(cards, { department: "创意二部", query: "" }).map((x) => x.id), ["a", "c"]);
  assert.equal(filterRetroCards(cards, { department: "ALL", query: "" }).length, 3);
});

test("grouping: months newest first, cases newest first inside, totals ignore the filter", () => {
  const all = [
    card({ id: "a", monthKey: "2026-09", createdAt: "2026-09-02T00:00:00Z" }),
    card({ id: "b", monthKey: "2026-10", createdAt: "2026-10-02T00:00:00Z" }),
    card({ id: "c", monthKey: "2026-10", createdAt: "2026-10-05T00:00:00Z", recording: { state: "READY", parts: 1, durationMs: 1000 } }),
  ];
  const sections = groupRetroCardsByMonth(all.filter((x) => x.id !== "b"), all, [
    { monthKey: "2026-10", caseCount: 2, recordedCaseCount: 1, badge: { state: "PUBLISHED", version: 1, changed: false } },
  ]);
  assert.deepEqual(sections.map((s) => s.monthKey), ["2026-10", "2026-09"]);
  assert.deepEqual(sections[0].items.map((x) => x.id), ["c"]);
  assert.equal(sections[0].total, 2);
  assert.equal(sections[0].recordedCaseCount, 1);
  assert.equal(sections[0].badge.state, "PUBLISHED");
  assert.equal(sections[1].badge.state, "NONE"); // 服务端没给的月份：现算，没整理
});

test("CASE numbers: newest upload is 01, numbering ignores filters", () => {
  const numbers = buildRetroCaseNumberMap([card({ id: "old", createdAt: "2026-09-01T00:00:00Z" }), card({ id: "new", createdAt: "2026-10-01T00:00:00Z" })]);
  assert.equal(numbers.get("new"), 1);
  assert.equal(numbers.get("old"), 2);
});

test("cover track: 需求 → rounds → 结果, folds in the middle beyond 5 rounds", () => {
  const short = retroCoverTrack({ roundTrack: [{ title: "第 1 版", hasFeedback: true }, { title: "第 2 版", hasFeedback: false }], hasOutcome: true });
  assert.deepEqual(short.map((n) => n.label), ["需求", "第 1 版", "第 2 版", "结果"]);
  assert.equal(short[1].feedback, true);
  assert.equal(short.at(-1)?.end, true);
  const long = retroCoverTrack({ roundTrack: Array.from({ length: 7 }, (_, i) => ({ title: `R${i + 1}`, hasFeedback: false })), hasOutcome: false });
  assert.deepEqual(long.map((n) => n.label), ["需求", "R1", "R2", "…3", "R6", "R7", "结果"]);
  assert.equal(long.at(-1)?.empty, true);
});

test("new-case form validates month → department → client → title → tags, in that order", () => {
  const months = ["2026-10"];
  const draft = { ...blankRetroBasics(new Date("2026-10-15T00:00:00Z")), monthKey: "2026-10" };
  assert.equal(validateRetroBasics({ ...draft, monthKey: "2026-01" }, months), "请选择复盘月份。");
  assert.equal(validateRetroBasics(draft, months), "请填写部门。");
  assert.equal(validateRetroBasics({ ...draft, department: "创意一部" }, months), "请填写客户。");
  assert.equal(validateRetroBasics({ ...draft, department: "创意一部", clientName: "某乳企" }, months), "请填写案例标题：一句话说清这件事。");
  const ok = { ...draft, department: "创意一部", clientName: "某乳企", title: "标题", sceneTagsText: "改稿，客户情绪" };
  assert.equal(validateRetroBasics(ok, months), "");
  assert.match(validateRetroBasics({ ...ok, sceneTagsText: Array.from({ length: 9 }, (_, i) => `t${i}`).join(",") }, months), /最多 8 个/);
  assert.match(validateRetroBasics({ ...ok, department: "x".repeat(31) }, months), /不超过 30 字/);
  assert.deepEqual(buildRetroBasicsInput(ok), { monthKey: "2026-10", department: "创意一部", clientName: "某乳企", title: "标题", sceneTags: ["改稿", "客户情绪"] });
});

test("dialog only closes lightly when still empty (create) or untouched (edit)", () => {
  const empty = blankRetroBasics();
  assert.equal(retroBasicsClosable("create", empty, false), true);
  assert.equal(retroBasicsClosable("create", { ...empty, title: "x" }, true), false);
  assert.equal(retroBasicsClosable("edit", { ...empty, title: "x" }, false), true);
  assert.equal(retroBasicsClosable("edit", empty, true), false);
});

test("month choices: create offers 上月／本月／下月, edit lists next month back 13 months and keeps older case months", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  const create = retroMonthChoices(now);
  assert.deepEqual(create.map((m) => m.key), ["2026-09", "2026-10", "2026-11"]);
  assert.match(create[1].label, /^本月 · 2026 年 10 月$/);
  const edit = retroEditMonthChoices("2024-01", now);
  assert.equal(edit[0].key, "2026-11");
  assert.equal(edit.length, 14);
  assert.equal(edit.at(-1)?.key, "2024-01");
});

test("round helpers: empty round is deleted without confirmation, filled ones ask first", () => {
  const empty = { occurredOn: "", deliveryText: " ", feedbackText: "", responseText: "", assets: [], links: [] };
  assert.equal(retroRoundHasContent(empty), false);
  assert.equal(retroRoundHasContent({ ...empty, feedbackText: "太土" }), true);
  assert.equal(retroRoundHasContent({ ...empty, assets: [{}] }), true);
  assert.equal(retroRoundHasContent({ ...empty, links: [{}] }), true);
  assert.equal(nextRetroRoundTitle(2), "第 3 版");
});

test("attachment check mirrors classifyRetroFile: SVG/GIF and unknown types refused", () => {
  assert.equal(checkRetroAttachFile({ name: "a.png", type: "image/png", size: 5 }).ok, true);
  assert.equal(checkRetroAttachFile({ name: "a.docx", type: "", size: 5 }).ok, true);
  const bad = checkRetroAttachFile({ name: "a.svg", type: "image/svg+xml", size: 5 });
  assert.equal(bad.ok, false);
  assert.equal(checkRetroAttachFile({ name: "a.zip", type: "application/zip", size: 5 }).ok, false);
  assert.equal(checkRetroAttachFile({ name: "a.mp3", type: "audio/mpeg", size: 0 }).ok, false);
});

function recording(overrides: Partial<RetroRecordingView> = {}): RetroRecordingView {
  return {
    id: "rtr_1", monthKey: "2026-10", caseId: "rtc_1", partNo: 1, status: "READY", failReason: null, fileName: "点评.m4a",
    sizeBytes: 1, durationMs: 60_000, audioUrl: "/api/retro-recordings/rtr_1/audio", uploadedByName: "周可", createdAt: "", canRemove: true,
    segments: [
      { id: 1, startMs: 1000, endMs: 2000, speakerId: "S1", text: "先请汇报人讲。" },
      { id: 2, startMs: 3000, endMs: 4000, speakerId: "S0", text: "先问清楚为什么。" },
    ],
    speakerLabels: null,
    ...overrides,
  };
}

test("part numbers: next free part 1..3, removed parts free their slot, null when full", () => {
  assert.equal(nextRetroPartNo([]), 1);
  assert.equal(nextRetroPartNo([{ partNo: 1, status: "READY" }, { partNo: 2, status: "REMOVED" }]), 2);
  assert.equal(nextRetroPartNo([1, 2, 3].map((partNo) => ({ partNo, status: "READY" as const }))), null);
});

test("speaker names: 说话人 N by first appearance until the published labels arrive", () => {
  const order = ["S1", "S0"];
  assert.equal(retroSpeakerName("S1", null, order), "说话人 1");
  assert.equal(retroSpeakerName("S0", null, order), "说话人 2");
  assert.equal(retroSpeakerName("S0", { S0: "老孙" }, order), "老孙");
});

test("transcript: parts are joined in order, dividers only when several parts, ids stay unique, 老孙 lines are marked", () => {
  const one = buildRetroTranscript([recording()]);
  assert.equal(one.dividers.size, 0);
  assert.equal(one.lines.length, 2);
  assert.equal(one.lines[0].speaker, "说话人 1");
  assert.equal(one.labelled, false);

  const labelled = recording({ id: "rtr_2", partNo: 2, speakerLabels: { S0: "老孙", S1: "汇报人" } });
  const two = buildRetroTranscript([recording({ speakerLabels: { S0: "老孙", S1: "汇报人" } }), labelled, recording({ id: "rtr_3", partNo: 3, status: "FAILED", segments: null })]);
  assert.equal(two.lines.length, 4);
  assert.equal(new Set(two.lines.map((l) => l.id)).size, 4);
  assert.equal(two.dividers.size, 2);
  assert.match([...two.dividers.values()][1], /^第 2 段 · 点评\.m4a · 01:00$/);
  assert.equal(two.lines.find((l) => l.speaker === "老孙")?.isReviewer, true);
  assert.equal(two.labelled, true);

  const client = buildClientTranscript("ast_1", [{ id: 1, startMs: 0, endMs: 1, speakerId: "S5", text: "喂" }]);
  assert.equal(client[0].speaker, "说话人 1");
  assert.equal(client[0].ownerId, "ast_1");
});

test("pending work includes recordings and client audio still transcribing", () => {
  const base = { recordings: [], needAssets: [], rounds: [] as never[] };
  assert.equal(hasPendingCaseWork(base), false);
  assert.equal(hasPendingCaseWork({ ...base, recordings: [recording({ status: "TRANSCRIBING" })] }), true);
  const audio = { type: "AUDIO", uploadStatus: "READY", transcribe: { status: "TRANSCRIBING" } } as never;
  assert.equal(hasPendingCaseWork({ ...base, needAssets: [audio] }), true);
});

const ctx: RetroSourceContext = {
  monthKey: "2026-10",
  quotedSegments: {
    "R:rtr_1": [
      { segmentId: 12, startMs: 760_000, speakerLabel: "老孙", text: "先别急着改。" },
      { segmentId: 3, startMs: 100_000, speakerLabel: "汇报人", text: "第二版客户说太幼稚。" },
    ],
    "R:rtr_sum": [{ segmentId: 1, startMs: 195_000, speakerLabel: "老孙", text: "总结" }],
    "C:ast_9": [{ segmentId: 2, startMs: 42_000, speakerLabel: "说话人 1", text: "要年轻一点" }],
  },
  recordingRefs: {
    rtr_1: { caseId: "rtc_1", caseNumber: 2, partNo: 2, partCount: 2 },
    rtr_sum: { caseId: null, caseNumber: null, partNo: 1, partCount: 1 },
  },
  caseNumbers: { rtc_1: 2, rtc_2: 3 },
  roundRefs: { rnd_2: { caseId: "rtc_1", title: "第 2 版" } },
  caseLabels: { rtc_1: { client: "某乳企", title: "年货节" } },
};

test("source marks use formatRetroSourceLabel: 案例 N · 第 M 段 mm:ss, 总结 · mm:ss, 客户录音 · mm:ss", () => {
  const review = describeRetroSource({ kind: "REVIEW", recordingId: "rtr_1", segmentIds: [12, 3], caseId: "rtc_1" }, ctx);
  assert.equal(review.label, "案例 2 · 第 2 段 01:40"); // 取最早的引用时间
  assert.deepEqual(review.quotes.map((q) => q.segmentId), [3, 12]);
  assert.equal(review.href, "/retro/rtc_1?t=100&p=2#recording");
  assert.match(review.heading, /^案例 2 · 某乳企 · 年货节 · 第 2 段$/);

  const summary = describeRetroSource({ kind: "REVIEW", recordingId: "rtr_sum", segmentIds: [1], caseId: null }, ctx);
  assert.equal(summary.label, "总结 · 03:15");
  assert.equal(summary.href, "/retro/months/2026-10?focus=summary&t=195#summary");

  const client = describeRetroSource({ kind: "CLIENT", assetId: "ast_9", segmentIds: [2], caseId: "rtc_1", roundId: null }, ctx);
  assert.equal(client.label, "客户录音 · 00:42");
  assert.equal(client.href, "/retro/rtc_1?audio=ast_9&t=42#assets");
});

test("source mark falls back to the frozen case number when the recording ref is missing, and flags missing quotes", () => {
  const view = describeRetroSource({ kind: "REVIEW", recordingId: "rtr_x", segmentIds: [1], caseId: "rtc_2" }, { ...ctx, quotedSegments: {} });
  assert.equal(view.label, "案例 3 · 00:00");
  assert.equal(view.missing, true);
  assert.equal(view.href, "/retro/rtc_2?t=0#recording");
});

test("round marks: 「第二版」 label from roundRefs, only for review sources, jump to ?round=", () => {
  const marks = describeRetroRoundMarks({ kind: "REVIEW", recordingId: "rtr_1", segmentIds: [3], caseId: "rtc_1", roundIds: ["rnd_2", "rnd_gone"] }, ctx);
  assert.deepEqual(marks.map((m) => m.label), ["第 2 版", "对应回合"]);
  assert.equal(marks[0].href, "/retro/rtc_1?round=rnd_2");
  assert.deepEqual(describeRetroRoundMarks({ kind: "CLIENT", assetId: "a", segmentIds: [1], caseId: "rtc_1", roundId: null }, ctx), []);
});

test("duplicate sources collapse to one mark", () => {
  const source = { kind: "REVIEW" as const, recordingId: "rtr_1", segmentIds: [1], caseId: "rtc_1" };
  assert.equal(uniqueRetroSources([source, { ...source }, { ...source, segmentIds: [2] }]).length, 2);
});

test("generate preconditions list review recordings and client recordings separately", () => {
  const pre = {
    caseCount: 6, recordedCaseCount: 5, unrecordedCaseCount: 1, reviewRecordingsProcessing: 0, summaryParts: 0,
    clientAudio: { total: 3, ready: 2, transcribing: 1, failed: 0 }, canGenerate: false, blockedReason: "有客户录音还在转写",
  };
  const items = retroPreconditionItems(pre, [4]);
  assert.equal(items[0].text, "5 个案例的点评录音已就绪");
  assert.match(items.find((i) => i.ok === "note" && i.text.includes("没有录音"))!.text, /案例 4/);
  assert.equal(items.at(-1)?.text, "客户录音（附件）3 段 · 已转写 2 · 转写中 1");
  assert.equal(items.at(-1)?.ok, "no");
  assert.equal(retroPreconditionItems({ ...pre, clientAudio: { total: 0, ready: 0, transcribing: 0, failed: 0 } }).at(-1)?.text, "没有客户录音（附件）");
});

test("generate confirm lines: nothing to say means no dialog", () => {
  const pre = { unrecordedCaseCount: 0, summaryParts: 1, clientAudio: { total: 0, ready: 0, transcribing: 0, failed: 0 } };
  assert.deepEqual(retroGenerateConfirmLines({ fromReview: false, publishedVersion: null, pre }), []);
  const lines = retroGenerateConfirmLines({ fromReview: true, publishedVersion: 1, pre: { unrecordedCaseCount: 2, summaryParts: 0, clientAudio: { total: 2, ready: 0, transcribing: 0, failed: 1 } } });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /草稿上的修改会丢/);
  assert.match(lines[1], /有 2 个案例没有录音/);
  assert.match(lines[3], /1 段客户录音转写失败/);
  assert.match(retroGenerateConfirmLines({ fromReview: false, publishedVersion: 2, pre })[0], /再发布就是 v3，v2 原样保留/);
});

test("job steps: 逐案提炼 i/N → 汇总纪要 → 汇总方法, failure marks the failed step", () => {
  const extracting = retroJobSteps({ status: "EXTRACTING", progress: { done: 2, total: 6 }, failedStep: null });
  assert.deepEqual(extracting.steps.map((s) => s.state), ["doing", "todo", "todo"]);
  assert.equal(extracting.extractLabel, "3 / 6");
  assert.equal(extracting.currentLabel, "逐案提炼 3/6");
  const summarizing = retroJobSteps({ status: "SUMMARIZING", progress: { done: 6, total: 6 }, failedStep: null });
  assert.deepEqual(summarizing.steps.map((s) => s.state), ["done", "doing", "todo"]);
  assert.equal(summarizing.extractLabel, "6 / 6");
  const failed = retroJobSteps({ status: "FAILED", progress: { done: 6, total: 6 }, failedStep: "DISTILL" });
  assert.deepEqual(failed.steps.map((s) => s.state), ["done", "done", "fail"]);
});

test("month overview line and durations", () => {
  assert.equal(formatRetroHM(4 * 3600_000 + 12 * 60_000), "4 小时 12 分");
  assert.equal(formatRetroHM(25 * 60_000), "25 分");
  const text = retroMonthOverview({
    cases: [{ recording: { state: "READY", parts: 2, durationMs: 1 } }, { recording: { state: "NONE" } }],
    summaryRecordings: [{ status: "READY" }, { status: "REMOVED" }],
    totalDurationMs: 3600_000,
  });
  assert.equal(text, "2 个案例 · 录音 2 段 · 总结 1 段 · 合计 1 小时 0 分");
});

test("version options: newest first, current marked", () => {
  assert.deepEqual(retroVersionOptions([1, 3, 2]).map((o) => o.label), ["v3（当前）", "v2", "v1"]);
});

test("month badge from the view: pending review looks like 整理中 to everyone, changed recordings flag 有更新", () => {
  const base = { job: null, latestPublication: null, changedSincePublish: 0 } as unknown as Pick<RetroMonthView, "job" | "latestPublication" | "changedSincePublish">;
  assert.equal(retroMonthBadgeFromView(base).state, "NONE");
  const published = { ...base, latestPublication: { versionNumber: 2 } } as unknown as typeof base;
  assert.deepEqual(retroMonthBadgeFromView(published), { state: "PUBLISHED", version: 2, changed: false });
  assert.deepEqual(retroMonthBadgeFromView({ ...published, changedSincePublish: 1 }), { state: "PUBLISHED", version: 2, changed: true });
  assert.deepEqual(retroMonthBadgeFromView({ ...published, job: { status: "PENDING_REVIEW" } as never }), { state: "RUNNING", publishedVersion: 2 });
  assert.deepEqual(retroMonthBadgeFromView({ ...base, job: { status: "ABANDONED" } as never }), { state: "NONE" });
});

test("only the reviewer with a draft in hand is reviewing", () => {
  const draft = { minutes: {}, methods: {} };
  assert.equal(isRetroReviewing({ viewer: { isReviewer: true, canUploadSummary: true }, job: { status: "PENDING_REVIEW", draft } } as never), true);
  assert.equal(isRetroReviewing({ viewer: { isReviewer: false, canUploadSummary: true }, job: { status: "PENDING_REVIEW", draft: null } } as never), false);
  assert.equal(isRetroReviewing({ viewer: { isReviewer: true, canUploadSummary: true }, job: { status: "EXTRACTING", draft: null } } as never), false);
});

test("address-bar jumps: case page", () => {
  assert.deepEqual(parseRetroCaseJump("?t=760&p=2", "#recording"), { audioAssetId: null, seconds: 760, partNo: 2, roundId: null, toRecording: true, created: false });
  assert.equal(parseRetroCaseJump("?audio=ast_1&t=42", "").audioAssetId, "ast_1");
  assert.equal(parseRetroCaseJump("?round=rnd_2", "").roundId, "rnd_2");
  assert.equal(parseRetroCaseJump("?created=1", "").created, true);
  assert.equal(parseRetroCaseJump("?t=abc", "").seconds, null);
  assert.equal(parseRetroCaseJump("?t=-5&p=0", "").seconds, null);
  assert.equal(parseRetroCaseJump("?t=0", "").seconds, 0);
  assert.equal(parseRetroCaseJump("?p=0", "").partNo, 1);
});

test("address-bar jumps: month page", () => {
  assert.deepEqual(parseRetroMonthJump("?tab=MINUTES"), { tab: "MINUTES", focusSummary: false, seconds: null, partNo: 1 });
  assert.deepEqual(parseRetroMonthJump("?focus=summary&t=195&p=2"), { tab: "CASES", focusSummary: true, seconds: 195, partNo: 2 });
  assert.equal(parseRetroMonthJump("?tab=bogus").tab, "CASES");
});

function item(id: string, text: string, origin: "AI" | "MANUAL" = "AI"): RetroItem {
  return { id, text, sources: [], origin, edited: false };
}
const draft: { minutes: RetroMinutes; methods: RetroMethods } = {
  minutes: {
    cases: [{ caseId: "rtc_1", process: "旧经过", processSources: [], disputes: [item("d1", "争议")], founderPoints: [item("f1", "问题")], suggestions: [item("s1", "建议")], empty: false }],
    unanalyzedCaseIds: [],
    insights: [item("i1", "认识"), item("i2", "手补", "MANUAL")],
    actions: [item("a1", "事项")],
  },
  methods: {
    candidates: [{ id: "c1", number: 1, dimension: "ENTRY", kind: "METHOD", title: "标题", description: "d", situation: "", transfer: "UNSURE", transferNote: "", sources: [], origin: "AI", edited: false }],
    observations: [item("o1", "观察")],
  },
};

test("draft patch (optimistic): update marks AI items edited, manual ones not; delete removes; add is left to the server", () => {
  const updated = applyRetroDraftPatch(draft, { section: "insights", itemId: "i1", op: "UPDATE", value: { text: "改后" } });
  assert.equal(updated.minutes.insights[0].text, "改后");
  assert.equal(updated.minutes.insights[0].edited, true);
  assert.equal(draft.minutes.insights[0].text, "认识", "input is not mutated");
  const manual = applyRetroDraftPatch(draft, { section: "insights", itemId: "i2", op: "UPDATE", value: { text: "手补改" } });
  assert.equal(manual.minutes.insights[1].edited, false);
  assert.equal(applyRetroDraftPatch(draft, { section: "actions", itemId: "a1", op: "DELETE" }).minutes.actions.length, 0);
  assert.equal(applyRetroDraftPatch(draft, { section: "observations", itemId: "o1", op: "DELETE" }).methods.observations.length, 0);
  assert.equal(applyRetroDraftPatch(draft, { section: "insights", op: "ADD", value: { text: "x" } }), draft);
});

test("draft patch: case sections land on the right case, process is update-only text", () => {
  const process = applyRetroDraftPatch(draft, { section: "case.process", caseId: "rtc_1", op: "UPDATE", value: { text: "新经过" } });
  assert.equal(process.minutes.cases[0].process, "新经过");
  const removed = applyRetroDraftPatch(draft, { section: "case.disputes", caseId: "rtc_1", itemId: "d1", op: "DELETE" });
  assert.equal(removed.minutes.cases[0].disputes.length, 0);
  const other = applyRetroDraftPatch(draft, { section: "case.disputes", caseId: "rtc_other", itemId: "d1", op: "DELETE" });
  assert.equal(other.minutes.cases[0].disputes.length, 1);
});

test("draft patch: candidate fields are merged and flagged edited", () => {
  const next = applyRetroDraftPatch(draft, { section: "candidates", itemId: "c1", op: "UPDATE", value: { kind: "SITUATIONAL", situation: "客户情绪激动" } });
  assert.equal(next.methods.candidates[0].kind, "SITUATIONAL");
  assert.equal(next.methods.candidates[0].situation, "客户情绪激动");
  assert.equal(next.methods.candidates[0].title, "标题");
  assert.equal(next.methods.candidates[0].edited, true);
  assert.equal(applyRetroDraftPatch(draft, { section: "candidates", itemId: "c1", op: "DELETE" }).methods.candidates.length, 0);
});
