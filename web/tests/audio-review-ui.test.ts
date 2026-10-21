// 纯函数单测：老孙点评（录音或文字）改写的前端推导（页头入口形态、上传前的文件分类、
// 粘贴文字的校验、轮询并回、确认面板分组、原话前的引用（时间点／第 N 段）、
// 点评版正文的「依据」与「已手改」、文字稿校正词切分）。见 lib/audio-review-ui.ts
// 与 docs/25_录音点评改写_实施规格_V0.1.md 二、二之二、七。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_REVIEW_PASTED_MIN_CHARS,
  AUDIO_REVIEW_UNSUPPORTED_DOCUMENT_MESSAGE,
  activeAudioReviewSegmentId,
  audioReviewForVersion,
  audioReviewOpinionLanded,
  audioReviewOpinionQuotes,
  audioReviewParagraphNumber,
  audioReviewSegmentRef,
  audioReviewSourceMeta,
  audioReviewSourceNoun,
  audioReviewTextLength,
  audioReviewTransitionToast,
  audioReviewValueAt,
  buildV19ReviewBasis,
  checkAudioReviewPastedText,
  checkAudioReviewRecording,
  classifyAudioReviewUpload,
  describeAudioReviewDocumentSummary,
  describeAudioReviewFailure,
  describeAudioReviewNavHint,
  describeAudioReviewProgress,
  describeAudioReviewUploadedToast,
  formatAudioReviewParagraphs,
  groupAudioReviewOpinions,
  inFlightAudioReviewKey,
  nextV19VersionNumber,
  pastedAudioReviewFile,
  removeAudioReviewSummary,
  resolveV19AudioReviewEntry,
  sameAudioReviewValue,
  splitAudioReviewCorrections,
  summarizeAudioReview,
  upsertAudioReviewSummary,
} from "../lib/audio-review-ui.ts";
import {
  AUDIO_REVIEW_DOCX_CONTENT_TYPE,
  AUDIO_REVIEW_DOCUMENT_MAX_BYTES,
  AUDIO_REVIEW_DOCUMENT_MAX_CHARS,
  AUDIO_REVIEW_MAX_BYTES,
  AUDIO_REVIEW_PASTED_FILE_NAME,
  audioReviewSourceKindOf,
} from "../lib/audio-review-model.ts";
import type {
  AudioReviewChange,
  AudioReviewOpinion,
  AudioReviewSegment,
  AudioReviewView,
  V19AudioReviewSummary,
} from "../lib/audio-review-model.ts";
import { formatShortDateTime } from "../lib/date-format.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1, V04ShotPayload } from "../lib/v04-contract.ts";

function summary(overrides: Partial<V19AudioReviewSummary> = {}): V19AudioReviewSummary {
  return {
    id: "arv-1", baseVersionId: "ver-1", sourceKind: "AUDIO", status: "TRANSCRIBING", step: 1, failReason: null,
    changeCount: 0, reviewVersionId: null, reviewVersionNumber: null,
    ...overrides,
  };
}

function opinion(overrides: Partial<AudioReviewOpinion> & Pick<AudioReviewOpinion, "id" | "number">): AudioReviewOpinion {
  return { kind: "GENERAL", summary: `意见${overrides.number}`, rationale: "", segmentIds: [], changeIds: [], ...overrides };
}

function change(overrides: Partial<AudioReviewChange> & Pick<AudioReviewChange, "id" | "key">): AudioReviewChange {
  return {
    targetKey: overrides.key, subKey: null, label: overrides.key, valueType: "TEXT",
    before: "", after: "", beforeText: "", afterText: "", opinionIds: [],
    ...overrides,
  };
}

function view(overrides: Partial<AudioReviewView> = {}): AudioReviewView {
  return {
    id: "arv-1", videoId: "vid-1", baseVersionId: "ver-1", baseVersionNumber: 1, baseOwnerName: "刘梦娜",
    sourceKind: "AUDIO", reviewerName: "老孙", uploaderName: "老孙",
    status: "PENDING_CONFIRM", failedStep: null, failReason: null, step: 2,
    audio: { fileName: "捉迷藏点评.m4a", sizeBytes: 1000, durationMs: 684_000, url: "/audio" },
    transcript: null, proposal: null, selectedChangeIds: null, reviewVersionId: null, reviewVersionNumber: null,
    createdAt: "2026-10-10T07:00:00.000Z", updatedAt: "2026-10-10T07:00:00.000Z", confirmedAt: null,
    ...overrides,
  };
}

function shot(id: string, overrides: Partial<V04ShotPayload> = {}): V04ShotPayload {
  return {
    id, orderIndex: 0, startTime: "", endTime: "", shotScale: "", cameraAngle: "", cameraMovement: "",
    visualContent: "", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "", soundEffect: "", music: "",
    ...overrides,
  };
}

function payload(): V04DraftPayloadV1 {
  const base = emptyV04DraftPayload();
  return {
    ...base,
    script: {
      shotGroups: [{
        id: "g1", orderIndex: 0, bridgeName: "城市变游乐场",
        primaryCreativeRole: { ...emptyV04ChoiceValue(), selectedOptionIds: ["REPEAT_AND_SHIFT_MEANING"] },
        auxiliaryCreativeRole: emptyV04ChoiceValue(),
        keyCreativeDescription: "路人纷纷躲起来。",
        shots: [shot("s1", { visualContent: "井盖被顶起，一个人探出头。" })],
      }],
    },
    factsAndCoreJudgement: { ...base.factsAndCoreJudgement, creativeMotif: "让最体面的大人被允许重新当一回孩子" },
    perceptionPath: {
      primaryType: "FUN",
      primaryDetails: { reveal: "原来全城都在陪一个孩子玩", deviation: "大人一个个躲起来" },
      auxiliaryTypes: [{ type: "LOVE", description: "亲子", creativeRole: "托底" }],
    },
  };
}

// ---------------------------------------------------------------------------
// 摘要与并回
// ---------------------------------------------------------------------------

test("summarizeAudioReview: 待确认时是拟定改动总数，已生成时是实际选中的处数，在途时为 0", () => {
  const proposal = { opinions: [], changes: [change({ id: "c1", key: "facts.creativeMotif" }), change({ id: "c2", key: "facts.tensionButton" })], unaddressed: [], model: null, promptVersion: null };
  assert.equal(summarizeAudioReview(view({ proposal })).changeCount, 2);
  const generated = summarizeAudioReview(view({
    status: "GENERATED", proposal, selectedChangeIds: ["c2"], reviewVersionId: "ver-3", reviewVersionNumber: 3,
  }));
  assert.deepEqual(
    { changeCount: generated.changeCount, reviewVersionId: generated.reviewVersionId, reviewVersionNumber: generated.reviewVersionNumber },
    { changeCount: 1, reviewVersionId: "ver-3", reviewVersionNumber: 3 },
  );
  assert.equal(summarizeAudioReview(view({ status: "TRANSCRIBING", step: 1, proposal: null })).changeCount, 0);
});

test("upsertAudioReviewSummary 按 id 替换；放弃了的任务直接拿掉", () => {
  const list = [summary({ id: "a" }), summary({ id: "b", baseVersionId: "ver-2" })];
  const replaced = upsertAudioReviewSummary(list, summary({ id: "a", status: "PENDING_CONFIRM", changeCount: 5 }));
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find((item) => item.id === "a")?.changeCount, 5);
  assert.deepEqual(upsertAudioReviewSummary(list, summary({ id: "a", status: "ABANDONED" })).map((item) => item.id), ["b"]);
  assert.deepEqual(upsertAudioReviewSummary([], summary({ id: "c" })).map((item) => item.id), ["c"]);
  assert.deepEqual(removeAudioReviewSummary(list, "b").map((item) => item.id), ["a"]);
});

test("audioReviewForVersion：虚拟 v1（id 为 null）不可能挂着任务；放弃的不算", () => {
  const list = [summary({ id: "a", baseVersionId: "ver-1", status: "ABANDONED" }), summary({ id: "b", baseVersionId: "ver-1" })];
  assert.equal(audioReviewForVersion(list, null), null);
  assert.equal(audioReviewForVersion(list, "ver-1")?.id, "b");
  assert.equal(audioReviewForVersion(list, "ver-9"), null);
});

test("inFlightAudioReviewKey 只收上传、转写、理解中的任务，排序后拼成稳定的键", () => {
  const list = [
    summary({ id: "z", status: "UNDERSTANDING" }),
    summary({ id: "a", status: "UPLOADING" }),
    summary({ id: "m", status: "PENDING_CONFIRM" }),
    summary({ id: "f", status: "FAILED" }),
    summary({ id: "g", status: "GENERATED" }),
  ];
  assert.equal(inFlightAudioReviewKey(list), "a,z");
  assert.equal(inFlightAudioReviewKey([]), "");
});

// ---------------------------------------------------------------------------
// 页头入口
// ---------------------------------------------------------------------------

const someoneElses = { id: "ver-1", kind: "PERSONAL" as const, isFinal: false, ownerName: "刘梦娜" };

test("入口只在上传名单里的人看别人的普通版本时出现：不可用、集成版、点评版、老孙本人的版本都不出现", () => {
  const base = { reviews: [] };
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: false, current: someoneElses }).kind, "HIDDEN");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, isFinal: true } }).kind, "HIDDEN");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, kind: "AUDIO_REVIEW" } }).kind, "HIDDEN");
  // 录音里点评的人始终是老孙：他自己的版本不挂点评，不管是谁在看。
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, ownerName: "老孙" } }).kind, "HIDDEN");
  // 替老孙上传的秦欣欣看自己的作业时照常出现——老孙点评的可能正是她那一版。
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, ownerName: "秦欣欣" } }).kind, "UPLOAD");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: someoneElses }).kind, "UPLOAD");
  // 虚拟 v1：id 为 null，只能是上传
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, id: null } }).kind, "UPLOAD");
});

test("入口按挂在这一版上的任务决定形态：处理中／失败／待确认／查看点评版", () => {
  const entry = (review: V19AudioReviewSummary) => resolveV19AudioReviewEntry({
    available: true, current: someoneElses, reviews: [review, summary({ id: "other", baseVersionId: "ver-2", status: "FAILED" })],
  });
  assert.equal(entry(summary({ status: "UPLOADING", step: 0 })).kind, "PROCESSING");
  assert.equal(entry(summary({ status: "UNDERSTANDING", step: 2 })).kind, "PROCESSING");
  assert.equal(entry(summary({ status: "FAILED", failReason: "识别失败" })).kind, "FAILED");
  const pending = entry(summary({ status: "PENDING_CONFIRM", changeCount: 18 }));
  assert.equal(pending.kind, "PENDING");
  assert.equal("review" in pending ? pending.review.changeCount : null, 18);
  assert.equal(entry(summary({ status: "GENERATED", reviewVersionId: "ver-3", reviewVersionNumber: 3 })).kind, "VIEW");
  // 状态已生成但还没拿到点评版 id（极短的空档）：先按处理中显示，不给一个点了没处去的按钮
  assert.equal(entry(summary({ status: "GENERATED" })).kind, "PROCESSING");
});

test("describeAudioReviewFailure 按失败那一步给标题；文档的第二步叫「读取文字」", () => {
  assert.equal(describeAudioReviewFailure("UPLOAD"), "上传失败");
  assert.equal(describeAudioReviewFailure("TRANSCRIBE"), "转写失败");
  assert.equal(describeAudioReviewFailure("UNDERSTAND"), "理解点评失败");
  assert.equal(describeAudioReviewFailure("TRANSCRIBE", "AUDIO"), "转写失败");
  assert.equal(describeAudioReviewFailure("TRANSCRIBE", "DOCUMENT"), "读取文字失败");
  assert.equal(describeAudioReviewFailure("UPLOAD", "DOCUMENT"), "上传失败");
  assert.equal(describeAudioReviewFailure("UNDERSTAND", "DOCUMENT"), "理解点评失败");
});

test("describeAudioReviewProgress：处理中胶囊按来源写三步，「点评处理中 · 读取文字 2/3」，不再写「录音」", () => {
  assert.equal(describeAudioReviewProgress("DOCUMENT", 0), "点评处理中 · 上传文档 1/3");
  assert.equal(describeAudioReviewProgress("DOCUMENT", 1), "点评处理中 · 读取文字 2/3");
  assert.equal(describeAudioReviewProgress("DOCUMENT", 2), "点评处理中 · 理解点评、拟定改动 3/3");
  assert.equal(describeAudioReviewProgress("AUDIO", 0), "点评处理中 · 上传录音 1/3");
  assert.equal(describeAudioReviewProgress("AUDIO", 1), "点评处理中 · 转写成文字 2/3");
});

test("summarizeAudioReview 带上来源；入口对文档任务照常给出处理中／待确认／查看", () => {
  assert.equal(summarizeAudioReview(view({ sourceKind: "DOCUMENT" })).sourceKind, "DOCUMENT");
  assert.equal(summarizeAudioReview(view()).sourceKind, "AUDIO");
  const entry = (review: V19AudioReviewSummary) => resolveV19AudioReviewEntry({ available: true, current: someoneElses, reviews: [review] });
  assert.equal(entry(summary({ sourceKind: "DOCUMENT", status: "TRANSCRIBING", step: 1 })).kind, "PROCESSING");
  assert.equal(entry(summary({ sourceKind: "DOCUMENT", status: "PENDING_CONFIRM", changeCount: 4 })).kind, "PENDING");
  assert.equal(entry(summary({ sourceKind: "DOCUMENT", status: "GENERATED", reviewVersionId: "ver-3", reviewVersionNumber: 3 })).kind, "VIEW");
});

test("audioReviewTransitionToast：只认亲眼看到的转变；待确认那条只弹一次；失败带原因", () => {
  const announced = new Set<string>();
  const ready = view({
    proposal: {
      opinions: [opinion({ id: "o1", number: 1 }), opinion({ id: "o2", number: 2 })],
      changes: [change({ id: "c1", key: "facts.creativeMotif" }), change({ id: "c2", key: "facts.tensionButton" }), change({ id: "c3", key: "facts.acceptanceContract" })],
      unaddressed: [], model: null, promptVersion: null,
    },
  });
  assert.equal(audioReviewTransitionToast(null, ready, announced), null, "打开页面时已经待确认：不提示");
  assert.equal(audioReviewTransitionToast(summary({ status: "PENDING_CONFIRM" }), ready, announced), null, "状态没变：不提示");
  assert.equal(
    audioReviewTransitionToast(summary({ status: "UNDERSTANDING" }), ready, announced),
    "点评改动已拟好：2 条意见、3 处改动，点页头的「点评改动待确认」核对",
  );
  assert.equal(audioReviewTransitionToast(summary({ status: "UNDERSTANDING" }), ready, announced), null, "同一个任务只弹一次");
  const failed = view({ id: "arv-2", status: "FAILED", failedStep: "TRANSCRIBE", failReason: "转写服务没能识别出人声" });
  const failedToast = audioReviewTransitionToast(summary({ id: "arv-2", status: "TRANSCRIBING" }), failed, announced) ?? "";
  assert.match(failedToast, /^点评处理失败：转写服务没能识别出人声。可以在页头重试或重新上传$/);
  assert.doesNotMatch(failedToast, /录音/, "录音、文字都叫点评");
  assert.equal(audioReviewTransitionToast(summary({ id: "arv-2", status: "TRANSCRIBING" }), view({ id: "arv-2", status: "UNDERSTANDING" }), announced), null);
});

// ---------------------------------------------------------------------------
// 确认面板
// ---------------------------------------------------------------------------

const sharedProposalView = view({
  proposal: {
    opinions: [
      opinion({ id: "o2", number: 2, kind: "SPECIFIC", changeIds: ["c2", "c3"] }),
      opinion({ id: "o1", number: 1, changeIds: ["c1"] }),
      opinion({ id: "o3", number: 3, changeIds: ["c3"] }),
      opinion({ id: "o4", number: 4, changeIds: [] }),
    ],
    changes: [
      change({ id: "c1", key: "facts.creativeMotif", opinionIds: ["o1"] }),
      change({ id: "c2", key: "shotGroup:g1.bridgeName", opinionIds: ["o2"] }),
      // 两条意见改到同一处：只列一处，挂在第一个引用它的意见下，标「同时依据 意见 3」
      change({ id: "c3", key: "shotGroup:g1.keyCreativeDescription", opinionIds: ["o2", "o3"] }),
    ],
    unaddressed: [], model: null, promptVersion: null,
  },
});

test("groupAudioReviewOpinions：按编号排；两条意见改到同一处只列一处，标同时依据；没有改动的意见保留", () => {
  const groups = groupAudioReviewOpinions(sharedProposalView);
  assert.deepEqual(groups.map((group) => group.opinion.number), [1, 2, 3, 4]);
  assert.deepEqual(groups[0].changes.map((item) => item.change.id), ["c1"]);
  assert.deepEqual(groups[1].changes.map((item) => [item.change.id, item.alsoNumbers]), [["c2", []], ["c3", [3]]]);
  assert.deepEqual(groups[2].changes, [], "意见 3 的改动已经列在意见 2 下面");
  assert.deepEqual(groups[2].listedUnder, [2]);
  assert.deepEqual(groups[3].changes, []);
  assert.deepEqual(groups[3].listedUnder, [], "听到了但不需要改：没有改动，也没并到别处");
  const allListed = groups.flatMap((group) => group.changes.map((item) => item.change.id)).sort();
  assert.deepEqual(allListed, ["c1", "c2", "c3"], "每处改动恰好列一次");
  assert.deepEqual(groupAudioReviewOpinions(view({ proposal: null })), []);
});

test("audioReviewOpinionLanded：共享的改动两边都算；生成后只数选中的", () => {
  const [o2, , o3] = sharedProposalView.proposal!.opinions;
  assert.equal(audioReviewOpinionLanded(sharedProposalView, o2), 2);
  assert.equal(audioReviewOpinionLanded(sharedProposalView, o3), 1);
  const generated = { ...sharedProposalView, selectedChangeIds: ["c1", "c2"] };
  assert.equal(audioReviewOpinionLanded(generated, o2), 1);
  assert.equal(audioReviewOpinionLanded(generated, o3), 0, "取消了的那处不算落实");
});

const segments: AudioReviewSegment[] = [
  { id: 3, startMs: 112_000, endMs: 130_000, speaker: "老孙", isReviewer: true, text: "母题太虚了。", corrections: [] },
  { id: 1, startMs: 8_000, endMs: 20_000, speaker: "老孙", isReviewer: true, text: "下一个，梦娜的《捉迷藏》。", corrections: [] },
  { id: 7, startMs: 422_000, endMs: 428_000, speaker: "王一凡", isReviewer: false, text: "那主导机制还算形式游戏吗？", corrections: [] },
];

test("audioReviewOpinionQuotes 按时间排，找不到的片段跳过", () => {
  assert.deepEqual(audioReviewOpinionQuotes(segments, [7, 3, 99, 1]).map((segment) => segment.id), [1, 3, 7]);
  assert.deepEqual(audioReviewOpinionQuotes([], [1]), []);
});

// 文档的片段：时间都是 0，按段落顺序排（id 不一定连续，也不一定从 1 开始）。
const paragraphs: AudioReviewSegment[] = [
  { id: 10, startMs: 0, endMs: 0, speaker: "老孙", isReviewer: true, text: "母题看浅了。", corrections: [] },
  { id: 11, startMs: 0, endMs: 0, speaker: "老孙", isReviewer: true, text: "关键创意描述都在复述画面。", corrections: [] },
  { id: 12, startMs: 0, endMs: 0, speaker: "王一凡", isReviewer: false, text: "王一凡问：那主导机制还算形式游戏吗？", corrections: [] },
  { id: 20, startMs: 0, endMs: 0, speaker: "老孙", isReviewer: true, text: "井盖里钻出来的是警察。", corrections: [] },
];

test("audioReviewOpinionQuotes：文档的时间都是 0 时按在原文里的先后排；重复引用只列一次", () => {
  assert.deepEqual(audioReviewOpinionQuotes(paragraphs, [20, 11, 10, 11]).map((segment) => segment.id), [10, 11, 20]);
});

test("audioReviewParagraphNumber：段落号是片段在 segments 里的序号 + 1，与 id 无关", () => {
  assert.equal(audioReviewParagraphNumber(paragraphs, 10), 1);
  assert.equal(audioReviewParagraphNumber(paragraphs, 12), 3);
  assert.equal(audioReviewParagraphNumber(paragraphs, 20), 4);
  assert.equal(audioReviewParagraphNumber(paragraphs, 99), null);
});

test("formatAudioReviewParagraphs：一段「第 N 段」，连着的「第 a–b 段」，不连着的用顿号", () => {
  assert.equal(formatAudioReviewParagraphs([3]), "第 3 段");
  assert.equal(formatAudioReviewParagraphs([4, 2, 3]), "第 2–4 段");
  assert.equal(formatAudioReviewParagraphs([5, 2]), "第 2、5 段");
  assert.equal(formatAudioReviewParagraphs([2, 2]), "第 2 段", "重复的只算一次");
  assert.equal(formatAudioReviewParagraphs([]), "");
});

test("audioReviewSegmentRef：录音写时间点、跳到那一刻；文档写「第 N 段」、跳到段落号最小的那一段", () => {
  const audio = audioReviewSegmentRef("AUDIO", segments, [3], 112_000);
  assert.deepEqual(audio, { label: "01:52", startMs: 112_000, segmentId: 3, title: "跳到录音这里播放" });
  const single = audioReviewSegmentRef("DOCUMENT", paragraphs, [12], 0);
  assert.equal(single.label, "第 3 段");
  assert.equal(single.segmentId, 12);
  assert.doesNotMatch(single.label, /\d{2}:\d{2}/, "文档不出现时间点");
  const several = audioReviewSegmentRef("DOCUMENT", paragraphs, [20, 11, 10], 0);
  assert.equal(several.label, "第 1、2、4 段");
  assert.equal(several.segmentId, 10, "点了跳到最前面那一段");
  assert.equal(audioReviewSegmentRef("DOCUMENT", paragraphs, [11, 12], 0).label, "第 2–3 段");
  const missing = audioReviewSegmentRef("DOCUMENT", paragraphs, [99], 0);
  assert.equal(missing.label, "原文");
  assert.equal(missing.segmentId, null);
});

test("describeAudioReviewDocumentSummary：「点评原文（N 段）」；有校正过的错别字才补虚线说明，不提「词表」「听写」", () => {
  assert.equal(describeAudioReviewDocumentSummary(paragraphs), "点评原文（4 段）");
  const corrected = [...paragraphs, { ...paragraphs[0], id: 30, corrections: [{ from: "对质生意", to: "对置生义" }] }];
  assert.equal(describeAudioReviewDocumentSummary(corrected), "点评原文（5 段 · 虚线＝校正过的错别字）");
  assert.doesNotMatch(describeAudioReviewDocumentSummary(corrected), /词表|听写|说话人/);
  assert.equal(describeAudioReviewDocumentSummary([]), "点评原文（0 段）");
});

test("describeAudioReviewNavHint：录音「录音、意见与文字稿」，文档与未知都不提录音", () => {
  assert.equal(describeAudioReviewNavHint("AUDIO"), "录音、意见与文字稿");
  assert.equal(describeAudioReviewNavHint("DOCUMENT"), "意见与点评原文");
  assert.equal(describeAudioReviewNavHint(null), "意见与点评原文");
});

test("audioReviewSourceMeta：录音「录音 · 文件名 · 时长 · X 确认生成」；文档「文档 · 文件名 · X 确认生成」，文件名可下载", () => {
  const confirmedAt = "2026-10-21T06:30:00.000Z";
  const audio = audioReviewSourceMeta(view({ status: "GENERATED", confirmedAt, uploaderName: "秦欣欣" }));
  assert.deepEqual(audio, {
    kindLabel: "录音", fileName: "捉迷藏点评.m4a", downloadable: false,
    after: ["11:24", `秦欣欣 ${formatShortDateTime(confirmedAt)} 确认生成`],
  });
  const document = audioReviewSourceMeta(view({
    sourceKind: "DOCUMENT", status: "GENERATED", confirmedAt,
    audio: { fileName: "捉迷藏点评.docx", sizeBytes: 2048, durationMs: null, url: "/file" },
  }));
  assert.deepEqual(document, {
    kindLabel: "文档", fileName: "捉迷藏点评.docx", downloadable: true,
    after: [`老孙 ${formatShortDateTime(confirmedAt)} 确认生成`],
  });
  // 还没确认（理论上点评卡只给已生成的看）：只剩来源和文件名
  assert.deepEqual(audioReviewSourceMeta(view({ sourceKind: "DOCUMENT", audio: { fileName: "a.txt", sizeBytes: 1, durationMs: null, url: "" } })).after, []);
});

// ---------------------------------------------------------------------------
// 上传前的文件分类、粘贴文字（docs/25 二之二、1-2）
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

test("classifyAudioReviewUpload：.docx / .txt / .md 按扩展名认作文档，不看浏览器给的 MIME，大小写不论", () => {
  const docx = classifyAudioReviewUpload({ name: "捉迷藏点评.DOCX", type: "application/octet-stream", size: 30_000 });
  assert.deepEqual(docx, { ok: true, sourceKind: "DOCUMENT", contentType: AUDIO_REVIEW_DOCX_CONTENT_TYPE });
  assert.deepEqual(classifyAudioReviewUpload({ name: "点评.txt", type: "", size: 10 }), { ok: true, sourceKind: "DOCUMENT", contentType: "text/plain" });
  assert.deepEqual(classifyAudioReviewUpload({ name: "点评.md", type: "", size: 10 }), { ok: true, sourceKind: "DOCUMENT", contentType: "text/markdown" });
  // 服务端按同一个 Content-Type 推来源：三种文档类型都推成 DOCUMENT
  for (const name of ["a.docx", "a.txt", "a.md"]) {
    const result = classifyAudioReviewUpload({ name, type: "", size: 1 });
    assert.ok(result.ok);
    if (result.ok) assert.equal(audioReviewSourceKindOf(result.contentType), "DOCUMENT", name);
  }
});

test("classifyAudioReviewUpload：文档不超过 20MB，空文件不收", () => {
  assert.ok(classifyAudioReviewUpload({ name: "a.docx", type: "", size: AUDIO_REVIEW_DOCUMENT_MAX_BYTES }).ok, "正好 20MB 可以");
  const big = classifyAudioReviewUpload({ name: "a.docx", type: "", size: AUDIO_REVIEW_DOCUMENT_MAX_BYTES + 1 });
  assert.ok(!big.ok && /超过 20MB/.test(big.error));
  const empty = classifyAudioReviewUpload({ name: "a.txt", type: "text/plain", size: 0 });
  assert.ok(!empty.ok && /空文件/.test(empty.error));
});

test("classifyAudioReviewUpload：PDF 和老格式 .doc 明确拒收，提示另存为 .docx 或直接粘贴", () => {
  for (const file of [
    { name: "点评.pdf", type: "application/pdf", size: 100 },
    { name: "点评.PDF", type: "", size: 100 },
    { name: "点评.doc", type: "application/msword", size: 100 },
    { name: "无扩展名", type: "application/pdf", size: 100 },
  ]) {
    assert.deepEqual(classifyAudioReviewUpload(file), { ok: false, error: AUDIO_REVIEW_UNSUPPORTED_DOCUMENT_MESSAGE }, file.name);
  }
  assert.equal(AUDIO_REVIEW_UNSUPPORTED_DOCUMENT_MESSAGE, "暂不支持 PDF 和老格式 .doc，请另存为 .docx 或直接粘贴文字。");
});

test("classifyAudioReviewUpload：其余按录音的规则（补 Content-Type、500MB）；认不出的格式两种都提到", () => {
  assert.deepEqual(classifyAudioReviewUpload({ name: "点评.m4a", type: "", size: 5 * MB }), { ok: true, sourceKind: "AUDIO", contentType: "audio/mp4" });
  assert.deepEqual(classifyAudioReviewUpload({ name: "录音", type: "audio/webm", size: 5 * MB }), { ok: true, sourceKind: "AUDIO", contentType: "audio/webm" });
  const big = classifyAudioReviewUpload({ name: "点评.mp3", type: "audio/mpeg", size: AUDIO_REVIEW_MAX_BYTES + 1 });
  assert.ok(!big.ok && /超过 500MB/.test(big.error));
  const unknown = classifyAudioReviewUpload({ name: "点评.pages", type: "", size: 100 });
  assert.ok(!unknown.ok);
  if (!unknown.ok) {
    assert.match(unknown.error, /录音支持 m4a/);
    assert.match(unknown.error, /\.docx \/ \.txt \/ \.md/);
    assert.match(unknown.error, /直接粘贴文字/);
  }
});

test("checkAudioReviewRecording（复盘库的录音上传也用它）：只认录音，文档不收", () => {
  assert.deepEqual(checkAudioReviewRecording({ name: "a.m4a", type: "", size: 10 }), { contentType: "audio/mp4" });
  const docx = checkAudioReviewRecording({ name: "a.docx", type: "", size: 10 });
  assert.ok("error" in docx && /不是能识别的录音格式/.test(docx.error));
  const empty = checkAudioReviewRecording({ name: "a.mp3", type: "audio/mpeg", size: 0 });
  assert.ok("error" in empty && /空文件/.test(empty.error));
});

test("checkAudioReviewPastedText：去首尾空白后至少 10 个字，交上去的是去过空白的文字", () => {
  assert.equal(AUDIO_REVIEW_PASTED_MIN_CHARS, 10);
  assert.deepEqual(checkAudioReviewPastedText("   \n\t "), { ok: false, error: "先把点评文字粘贴进来。" });
  const short = checkAudioReviewPastedText("  母题看浅了，要改。 ");
  assert.equal(audioReviewTextLength("  母题看浅了，要改。 "), 9);
  assert.ok(!short.ok && /只有 9 个字，至少要 10 个字/.test(short.error));
  assert.deepEqual(checkAudioReviewPastedText("\n  母题看浅了，全片都要改。\n\n第二段。  "), { ok: true, text: "母题看浅了，全片都要改。\n\n第二段。" });
  // 按字符算，不按字节：emoji 算一个字
  assert.equal(audioReviewTextLength("😀😀"), 2);
  const tooLong = checkAudioReviewPastedText("字".repeat(AUDIO_REVIEW_DOCUMENT_MAX_CHARS + 1));
  assert.ok(!tooLong.ok && /超过 10 万字/.test(tooLong.error));
  assert.ok(checkAudioReviewPastedText("字".repeat(AUDIO_REVIEW_DOCUMENT_MAX_CHARS)).ok);
});

test("pastedAudioReviewFile：存成「粘贴的点评文字.txt」、text/plain，大小按 UTF-8 字节，和上传 .txt 文档同一条路", async () => {
  const text = "母题看浅了，全片都要改。";
  const file = pastedAudioReviewFile(text);
  assert.equal(file.name, AUDIO_REVIEW_PASTED_FILE_NAME);
  assert.equal(file.name, "粘贴的点评文字.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(file.size, Buffer.byteLength(text, "utf8"));
  assert.equal(await file.text(), text);
  // 按文件分类也认作文档、text/plain（同一份 create → PUT → UPLOADED）
  assert.deepEqual(classifyAudioReviewUpload(file), { ok: true, sourceKind: "DOCUMENT", contentType: "text/plain" });
});

test("describeAudioReviewUploadedToast：文档和粘贴写「已收到…正在读取文字和理解点评」，录音照旧", () => {
  assert.equal(
    describeAudioReviewUploadedToast("DOCUMENT", "粘贴的点评文字.txt"),
    "已收到「粘贴的点评文字.txt」，正在读取文字和理解点评，大约一两分钟，可以先做别的",
  );
  assert.equal(
    describeAudioReviewUploadedToast("AUDIO", "捉迷藏点评.m4a"),
    "已上传「捉迷藏点评.m4a」，正在处理……大约需要一两分钟，可以先做别的",
  );
  assert.equal(audioReviewSourceNoun("DOCUMENT"), "文档");
  assert.equal(audioReviewSourceNoun("AUDIO"), "录音");
});

test("activeAudioReviewSegmentId：最后一个开始时间不晚于当前时刻的那句", () => {
  assert.equal(activeAudioReviewSegmentId(segments, 0), null);
  assert.equal(activeAudioReviewSegmentId(segments, 8_000), 1);
  assert.equal(activeAudioReviewSegmentId(segments, 200_000), 3);
  assert.equal(activeAudioReviewSegmentId(segments, 999_000), 7);
});

test("splitAudioReviewCorrections：校正后的词单独成段并带原听写；多次出现都标；没有校正时原样一段", () => {
  assert.deepEqual(splitAudioReviewCorrections("没有校正", []), [{ text: "没有校正", correction: null }]);
  const fix = { from: "对质生意", to: "对置生义" };
  assert.deepEqual(splitAudioReviewCorrections("辅助不是洞察共鸣，是对置生义——体面和幼稚放在一起。", [fix]), [
    { text: "辅助不是洞察共鸣，是", correction: null },
    { text: "对置生义", correction: fix },
    { text: "——体面和幼稚放在一起。", correction: null },
  ]);
  const twice = splitAudioReviewCorrections("对置生义还是对置生义", [fix]);
  assert.equal(twice.filter((part) => part.correction).length, 2);
  assert.equal(twice.map((part) => part.text).join(""), "对置生义还是对置生义", "切开以后拼回去和原文一样");
  // 两个校正互相重叠：先到先得，不重复切
  const overlapping = splitAudioReviewCorrections("形式游戏", [{ from: "行驶游戏", to: "形式游戏" }, { from: "游希", to: "游戏" }]);
  assert.deepEqual(overlapping.map((part) => part.text), ["形式游戏"]);
});

// ---------------------------------------------------------------------------
// 点评版正文：依据与手改
// ---------------------------------------------------------------------------

test("audioReviewValueAt 认得提案的每一种键，位置不存在时返回 undefined", () => {
  const current = payload();
  assert.equal(audioReviewValueAt(current, "facts.creativeMotif"), "让最体面的大人被允许重新当一回孩子");
  assert.equal(audioReviewValueAt(current, "shotGroup:g1.bridgeName"), "城市变游乐场");
  assert.equal(audioReviewValueAt(current, "shot:s1.visualContent"), "井盖被顶起，一个人探出头。");
  assert.equal(audioReviewValueAt(current, "path.primaryType"), "FUN");
  assert.equal(audioReviewValueAt(current, "path.primaryDetails.reveal"), "原来全城都在陪一个孩子玩");
  assert.equal(audioReviewValueAt(current, "path.primaryDetails.payoff"), "", "细项不存在读作空");
  assert.equal(audioReviewValueAt(current, "path.auxiliaryTypes.LOVE.creativeRole"), "托底");
  assert.equal(audioReviewValueAt(current, "path.auxiliaryTypes.FUN.description"), undefined);
  assert.equal(audioReviewValueAt(current, "shot:gone.visualContent"), undefined, "镜头被删了");
  assert.equal(audioReviewValueAt(current, "metadata.source"), undefined, "白名单以外的键不认");
});

test("sameAudioReviewValue：文字去首尾空白；固定选项不比顺序和词表版本", () => {
  assert.ok(sameAudioReviewValue(" 一样 ", "一样"));
  assert.ok(!sameAudioReviewValue("A", "S"));
  assert.ok(sameAudioReviewValue(
    { selectedOptionIds: ["B", "A"], customText: "身份对置 ", advancedText: "", vocabularyVersion: "AD_VIDEO_VOCAB_V1" },
    { selectedOptionIds: ["A", "B"], customText: "身份对置" },
  ));
  assert.ok(!sameAudioReviewValue({ selectedOptionIds: ["A"], customText: "" }, { selectedOptionIds: ["B"], customText: "" }));
  assert.ok(sameAudioReviewValue(["STORY", "COPY"], ["STORY", "COPY"]));
});

test("buildV19ReviewBasis：只算选中的改动；编号升序、悬停看意见摘要；当前值不是提案写法时标手改", () => {
  const basisView = {
    proposal: {
      opinions: [
        opinion({ id: "o1", number: 1, summary: "母题看浅了", changeIds: ["m", "r"] }),
        opinion({ id: "o2", number: 2, kind: "SPECIFIC" as const, summary: "井盖里钻出来的是警察", changeIds: ["v", "r"] }),
      ],
      changes: [
        change({ id: "m", key: "facts.creativeMotif", after: "让最体面的大人被允许重新当一回孩子", opinionIds: ["o1"] }),
        change({ id: "r", key: "path.primaryDetails.reveal", targetKey: "path.primaryDetails", subKey: "reveal", after: "原来全城的大人都在陪一个孩子玩", opinionIds: ["o2", "o1"] }),
        change({ id: "v", key: "shot:s1.visualContent", after: "井盖被顶起，一名警察探出头。", opinionIds: ["o2"] }),
        change({ id: "x", key: "facts.tensionButton", after: "没选中的改动", opinionIds: ["o1"] }),
        change({ id: "gone", key: "shot:deleted.visualContent", after: "镜头被删了", opinionIds: ["o2"] }),
      ],
      unaddressed: [], model: null, promptVersion: null,
    },
    selectedChangeIds: ["m", "r", "v", "gone"],
  };
  const basis = buildV19ReviewBasis(basisView, payload());
  assert.deepEqual([...basis.keys()].sort(), ["facts.creativeMotif", "path.primaryDetails.reveal", "shot:s1.visualContent"]);
  assert.deepEqual(basis.get("facts.creativeMotif"), { numbers: [1], tip: "意见 1（总体）：母题看浅了", handEdited: false });
  const reveal = basis.get("path.primaryDetails.reveal")!;
  assert.deepEqual(reveal.numbers, [1, 2]);
  assert.equal(reveal.tip, "意见 1（总体）：母题看浅了\n意见 2（具体）：井盖里钻出来的是警察");
  assert.equal(reveal.handEdited, true, "点评版里这一格已经不是提案的写法");
  assert.equal(basis.get("shot:s1.visualContent")?.handEdited, true);
  assert.equal(buildV19ReviewBasis({ proposal: null, selectedChangeIds: null }, payload()).size, 0);
});

test("nextV19VersionNumber：当前最大号 + 1", () => {
  assert.equal(nextV19VersionNumber([{ number: 1 }, { number: 3 }, { number: 2 }]), 4);
  assert.equal(nextV19VersionNumber([]), 1);
});
