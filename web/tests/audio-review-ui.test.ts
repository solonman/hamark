// 纯函数单测：录音点评改写的前端推导（页头入口形态、轮询并回、确认面板分组、
// 点评版正文的「依据」与「老孙已手改」、文字稿校正词切分）。见 lib/audio-review-ui.ts
// 与 docs/25_录音点评改写_实施规格_V0.1.md 二、七。
import assert from "node:assert/strict";
import test from "node:test";
import {
  activeAudioReviewSegmentId,
  audioReviewForVersion,
  audioReviewOpinionLanded,
  audioReviewOpinionQuotes,
  audioReviewTransitionToast,
  audioReviewValueAt,
  buildV19ReviewBasis,
  describeAudioReviewFailure,
  groupAudioReviewOpinions,
  inFlightAudioReviewKey,
  nextV19VersionNumber,
  removeAudioReviewSummary,
  resolveV19AudioReviewEntry,
  sameAudioReviewValue,
  splitAudioReviewCorrections,
  summarizeAudioReview,
  upsertAudioReviewSummary,
} from "../lib/audio-review-ui.ts";
import type {
  AudioReviewChange,
  AudioReviewOpinion,
  AudioReviewSegment,
  AudioReviewView,
  V19AudioReviewSummary,
} from "../lib/audio-review-model.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1, V04ShotPayload } from "../lib/v04-contract.ts";

function summary(overrides: Partial<V19AudioReviewSummary> = {}): V19AudioReviewSummary {
  return {
    id: "arv-1", baseVersionId: "ver-1", status: "TRANSCRIBING", step: 1, failReason: null,
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
    id: "arv-1", videoId: "vid-1", baseVersionId: "ver-1", baseVersionNumber: 1, baseOwnerName: "刘梦娜", reviewerName: "老孙",
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

const someoneElses = { id: "ver-1", kind: "PERSONAL" as const, isFinal: false, ownerUserId: "u-liu" };

test("入口只给老孙看别人的普通版本：不可用、集成版、点评版、自己的版本都不出现", () => {
  const base = { viewerUserId: "u-sun", reviews: [] };
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: false, current: someoneElses }).kind, "HIDDEN");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, isFinal: true } }).kind, "HIDDEN");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, kind: "AUDIO_REVIEW" } }).kind, "HIDDEN");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, ownerUserId: "u-sun" } }).kind, "HIDDEN");
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: someoneElses }).kind, "UPLOAD");
  // 虚拟 v1：id 为 null，只能是上传
  assert.equal(resolveV19AudioReviewEntry({ ...base, available: true, current: { ...someoneElses, id: null } }).kind, "UPLOAD");
});

test("入口按挂在这一版上的任务决定形态：处理中／失败／待确认／查看点评版", () => {
  const entry = (review: V19AudioReviewSummary) => resolveV19AudioReviewEntry({
    available: true, current: someoneElses, viewerUserId: "u-sun", reviews: [review, summary({ id: "other", baseVersionId: "ver-2", status: "FAILED" })],
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

test("describeAudioReviewFailure 按失败那一步给标题", () => {
  assert.equal(describeAudioReviewFailure("UPLOAD"), "上传失败");
  assert.equal(describeAudioReviewFailure("TRANSCRIBE"), "转写失败");
  assert.equal(describeAudioReviewFailure("UNDERSTAND"), "理解点评失败");
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
  assert.match(audioReviewTransitionToast(summary({ id: "arv-2", status: "TRANSCRIBING" }), failed, announced) ?? "", /点评录音处理失败：转写服务没能识别出人声/);
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
