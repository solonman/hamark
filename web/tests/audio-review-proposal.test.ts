// 提案校验与归一（docs/25 4.6）：模型输出一律当不可信输入。非法键、时间码、非法选项、个数上限与互斥、
// 空值、与原值相同、重复键合并、细项合并、主导路径切换、意见排序编号、changeIds 回填、「原 → 改」文字。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  UNADDRESSED_FALLBACK_REASON,
  audioReviewChangeReason,
  buildAudioReviewChangeSet,
  checkAudioReviewChanges,
  formatAudioReviewValue,
  isReviewerSegment,
  normalizeAudioReviewProposal,
  normalizeModelThinkingChain,
  type StoredAudioReviewProposal,
} from "../lib/audio-review/proposal";
import { interpretTaskStatus } from "../lib/audio-review/tencent-asr";
import { toAudioReviewView } from "../lib/audio-review/view";
import type { AudioReviewTranscriptSegment } from "../lib/audio-review/transcript";
import type { V04DraftPayloadV1 } from "../lib/v04-contract";
import { assertV04PayloadContract } from "../lib/v04-domain";

const sample = JSON.parse(readFileSync(new URL("../scripts/fixtures/audio-review-sample.json", import.meta.url), "utf8")) as {
  snapshot: V04DraftPayloadV1;
  transcript: AudioReviewTranscriptSegment[];
};
const snapshot = () => structuredClone(sample.snapshot);
const segments = sample.transcript;

/** 只带一条意见的最小输出，按需补改动。 */
function output(changes: unknown[], extra: Record<string, unknown> = {}) {
  return {
    speakers: { reviewer: "S0", labels: { S1: "刘梦娜", S2: "王一凡" } },
    opinions: [
      { id: "o1", kind: "GENERAL", summary: "母题看浅了", segmentIds: [3, 4, 6], rationale: "逐条检查" },
      { id: "o2", kind: "SPECIFIC", summary: "井盖里是警察", segmentIds: [8], rationale: "改镜头" },
    ],
    changes,
    unaddressed: [],
    corrections: [],
    ...extra,
  };
}

const run = (raw: unknown, payload = snapshot()) => normalizeAudioReviewProposal(raw, { snapshot: payload, segments });
const keys = (proposal: StoredAudioReviewProposal) => proposal.changes.map((change) => change.key);
const droppedReason = (proposal: StoredAudioReviewProposal, key: string) =>
  proposal.dropped.filter((entry) => entry.key === key).map((entry) => entry.reason).join(" | ");

test("the sample snapshot satisfies the payload contract", () => {
  assertV04PayloadContract(sample.snapshot);
});

test("valid changes keep workbench order, get ids c1…, readable before/after text and fine/target keys", () => {
  const proposal = run(output([
    { key: "path.primaryDetails.reveal", value: "原来全城的大人都在陪一个孩子捉迷藏。", opinionIds: ["o1"] },
    { key: "shot:shot-hide-05.visualContent", value: "井盖被顶起，一名执勤的警察探出头。", opinionIds: ["o2"] },
    { key: "facts.creativeMotif", value: "让最体面的大人被允许重新当一回孩子", opinionIds: ["o1"] },
    { key: "facts.overallCreativeRating", value: "A", opinionIds: ["o1"] },
  ]));
  assert.deepEqual(proposal.dropped, []);
  assert.deepEqual(keys(proposal), [
    "facts.creativeMotif",
    "shot:shot-hide-05.visualContent",
    "path.primaryDetails.reveal",
    "facts.overallCreativeRating",
  ]);
  assert.deepEqual(proposal.changes.map((change) => change.id), ["c1", "c2", "c3", "c4"]);
  const [motif, shot, reveal, rating] = proposal.changes;
  assert.equal(motif.label, "第一模块 · 创意母题");
  assert.equal(motif.beforeText, "让日常城市生活绽放活力美好");
  assert.equal(motif.valueType, "TEXT");
  assert.equal(shot.label, "第二模块 · 镜头 2-3 · 画面内容（镜头故事）");
  assert.equal(reveal.targetKey, "path.primaryDetails");
  assert.equal(reveal.subKey, "reveal");
  assert.equal(reveal.label, "第三模块 · 主导路径细项 · 揭示／反转");
  assert.equal(reveal.valueType, "PATH_DETAIL");
  assert.equal(rating.label, "第三模块 · 整体创意评价");
  assert.equal(rating.before, "S");
  assert.equal(rating.after, "A");
  assert.deepEqual(proposal.opinions.map((opinion) => opinion.changeIds), [["c1", "c3", "c4"], ["c2"]]);
});

test("unknown, structural, metadata, contract and missing-object keys are dropped with a reason", () => {
  const proposal = run(output([
    { key: "facts.notAField", value: "x", opinionIds: ["o1"] },
    { key: "metadata.source", value: "SYSTEM_MIGRATION", opinionIds: ["o1"] },
    { key: "contract.productVersion", value: "X", opinionIds: ["o1"] },
    { key: "script.structure", value: [], opinionIds: ["o1"] },
    { key: "shotGroup:bridge-hide-02.shots", value: [], opinionIds: ["o1"] },
    { key: "shotGroup:bridge-gone.bridgeName", value: "新桥段", opinionIds: ["o1"] },
    { key: "shot:shot-gone.visualContent", value: "补一个镜头", opinionIds: ["o1"] },
    { key: "", value: "x", opinionIds: ["o1"] },
  ]));
  assert.equal(proposal.changes.length, 0);
  assert.match(droppedReason(proposal, "facts.notAField"), /白名单/);
  assert.match(droppedReason(proposal, "metadata.source"), /不在可改范围/);
  assert.match(droppedReason(proposal, "contract.productVersion"), /不在可改范围/);
  assert.match(droppedReason(proposal, "script.structure"), /不在可改范围/);
  assert.match(droppedReason(proposal, "shotGroup:bridge-hide-02.shots"), /不在可改范围/);
  assert.match(droppedReason(proposal, "shotGroup:bridge-gone.bridgeName"), /不能增删桥段和镜头/);
  assert.match(droppedReason(proposal, "shot:shot-gone.visualContent"), /不能增删桥段和镜头/);
  assert.match(droppedReason(proposal, ""), /缺少键/);
});

test("time codes are read-only", () => {
  const proposal = run(output([
    { key: "shot:shot-hide-05.startTime", value: "00:11", opinionIds: ["o2"] },
    { key: "shot:shot-hide-05.endTime", value: "00:16", opinionIds: ["o2"] },
  ]));
  assert.equal(proposal.changes.length, 0);
  assert.match(droppedReason(proposal, "shot:shot-hide-05.startTime"), /时间码只读/);
  assert.match(droppedReason(proposal, "shot:shot-hide-05.endTime"), /时间码只读/);
});

test("option fields: labels map to option ids exactly; unknown labels, too many options and conflicts are dropped", () => {
  const proposal = run(output([
    { key: "facts.auxiliaryMechanism", value: { options: ["对置生义"], custom: "身份与行为对置", advanced: "" }, opinionIds: ["o1"] },
    { key: "facts.storyReference", value: { options: ["城市游戏片"], custom: "" }, opinionIds: ["o1"] },
    { key: "facts.mainMechanism", value: { options: ["形式游戏", "陌生化"] }, opinionIds: ["o1"] },
    { key: "shotGroup:bridge-hide-01.auxiliaryCreativeRole", value: { options: ["建立原始预期", "累积信息", "埋设伏笔", "延迟解释"] }, opinionIds: ["o1"] },
    { key: "shotGroup:bridge-hide-02.primaryCreativeRole", value: { options: ["制造偏离／异常"] }, opinionIds: ["o1"] },
  ]));
  assert.deepEqual(keys(proposal), ["facts.auxiliaryMechanism"]);
  const mechanism = proposal.changes[0];
  assert.equal(mechanism.valueType, "MECHANISM");
  assert.deepEqual((mechanism.after as { selectedOptionIds: string[] }).selectedOptionIds, ["JUXTAPOSITION_CREATES_MEANING"]);
  assert.equal(mechanism.beforeText, "洞察共鸣｜情绪感染与节奏推进");
  assert.equal(mechanism.afterText, "对置生义｜身份与行为对置");
  assert.match(droppedReason(proposal, "facts.storyReference"), /「城市游戏片」不在词表里/);
  assert.match(droppedReason(proposal, "facts.mainMechanism"), /最多选 1 项/);
  assert.match(droppedReason(proposal, "shotGroup:bridge-hide-01.auxiliaryCreativeRole"), /最多选 3 项/);
  // 主创意作用改成辅助作用里已有的那一项：单独套用就违反主辅互斥。
  assert.match(droppedReason(proposal, "shotGroup:bridge-hide-02.primaryCreativeRole"), /互斥/);
});

test("half-width slashes and a bare label are tolerated; omitted custom keeps the author's text", () => {
  const proposal = run(output([
    { key: "shotGroup:bridge-hide-02.primaryCreativeRole", value: "重复并改变意义", opinionIds: ["o1"] },
    { key: "shotGroup:bridge-hide-01.primaryCreativeRole", value: { options: ["建立人物/关系"] }, opinionIds: ["o1"] },
    { key: "facts.storyReference", value: { options: ["荒诞喜剧片"] }, opinionIds: ["o1"] },
  ]));
  assert.deepEqual(proposal.dropped, []);
  const story = proposal.changes.find((change) => change.key === "facts.storyReference")!;
  assert.equal((story.after as { customText: string }).customText, "城市游戏化概念片");
  assert.equal(story.afterText, "荒诞喜剧片 ＋ 自定义：城市游戏化概念片");
  assert.equal(
    (proposal.changes.find((change) => change.key === "shotGroup:bridge-hide-01.primaryCreativeRole")!.after as { selectedOptionIds: string[] }).selectedOptionIds[0],
    "ESTABLISH_CHARACTER_RELATIONSHIP",
  );
});

test("main/auxiliary mechanism changes that only clash together: the later one in workbench order is dropped", () => {
  const proposal = run(output([
    { key: "facts.auxiliaryMechanism", value: { options: ["对置生义"] }, opinionIds: ["o1"] },
    { key: "facts.mainMechanism", value: { options: ["对置生义"] }, opinionIds: ["o1"] },
  ]));
  assert.deepEqual(keys(proposal), ["facts.mainMechanism"]);
  assert.match(droppedReason(proposal, "facts.auxiliaryMechanism"), /与前面的改动合在一起/);
  // 留下来的任意子集都合规。
  assert.equal(checkAudioReviewChanges(snapshot(), proposal.changes), null);
});

test("the pending-new-mechanism option needs its advanced layer", () => {
  const proposal = run(output([
    { key: "facts.auxiliaryMechanism", value: { options: ["现有词表不适用／待形成新机制"], custom: "x", advanced: "" }, opinionIds: ["o1"] },
  ]));
  assert.match(droppedReason(proposal, "facts.auxiliaryMechanism"), /进阶机制层/);
  const ok = run(output([
    { key: "facts.auxiliaryMechanism", value: { options: ["现有词表不适用／待形成新机制"], custom: "x", advanced: "身份降格：让最体面的人做最幼稚的事" }, opinionIds: ["o1"] },
  ]));
  assert.equal(ok.changes[0].afterText, "现有词表不适用／待形成新机制｜x\n进阶机制层：身份降格：让最体面的人做最幼稚的事");
});

test("rating, carriers and empty values", () => {
  const proposal = run(output([
    { key: "facts.overallCreativeRating", value: "A级", opinionIds: ["o1"] },
    { key: "facts.creativeCarriers", value: ["故事", "画面"], opinionIds: ["o1"] },
    { key: "facts.creativeMotif", value: "   ", opinionIds: ["o1"] },
    { key: "facts.storyReference", value: { options: [], custom: "" }, opinionIds: ["o1"] },
    { key: "facts.tensionButton", value: 42, opinionIds: ["o1"] },
    { key: "facts.carrierExplanation", value: "字".repeat(5001), opinionIds: ["o1"] },
  ]));
  assert.deepEqual(keys(proposal), ["facts.overallCreativeRating"]);
  assert.equal(proposal.changes[0].after, "A");
  assert.match(droppedReason(proposal, "facts.creativeCarriers"), /只能是「故事」「文案」「视听规则」/);
  assert.match(droppedReason(proposal, "facts.creativeMotif"), /为空/);
  assert.match(droppedReason(proposal, "facts.storyReference"), /为空/);
  assert.match(droppedReason(proposal, "facts.tensionButton"), /不是文字/);
  assert.match(droppedReason(proposal, "facts.carrierExplanation"), /过长/);
  const bad = run(output([{ key: "facts.overallCreativeRating", value: "S+", opinionIds: ["o1"] }]));
  assert.match(droppedReason(bad, "facts.overallCreativeRating"), /S、A、B、C/);
  const carriers = run(output([{ key: "facts.creativeCarriers", value: ["文案", "故事", "文案"], opinionIds: ["o1"] }]));
  assert.deepEqual(carriers.changes[0].after, ["COPY", "STORY"]);
  assert.equal(carriers.changes[0].afterText, "文案、故事");
});

test("a change equal to the snapshot value is dropped", () => {
  const proposal = run(output([
    { key: "facts.creativeMotif", value: "  让日常城市生活绽放活力美好 ", opinionIds: ["o1"] },
    { key: "facts.creativeCarriers", value: ["故事", "视听规则"], opinionIds: ["o1"] },
  ]));
  assert.equal(proposal.changes.length, 0);
  assert.equal(droppedReason(proposal, "facts.creativeMotif"), "与原值相同");
  assert.equal(droppedReason(proposal, "facts.creativeCarriers"), "与原值相同");
});

test("a key given twice is merged: the last value wins and opinion ids are united in opinion order", () => {
  const proposal = run(output([
    { key: "facts.creativeMotif", value: "第一稿", opinionIds: ["o2"] },
    { key: "facts.creativeMotif", value: "第二稿", opinionIds: ["o1"] },
  ]));
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].after, "第二稿");
  assert.deepEqual(proposal.changes[0].opinionIds, ["o1", "o2"]);
  assert.deepEqual(proposal.opinions.map((opinion) => opinion.changeIds), [["c1"], ["c1"]]);
});

test("detail changes stay separate in the proposal and merge into one primaryDetails change on apply", () => {
  const proposal = run(output([
    { key: "path.primaryDetails.reveal", value: "原来全城都在陪孩子玩。", opinionIds: ["o1"] },
    { key: "path.primaryDetails.reinterpretation", value: "是大人心里一直想玩。", opinionIds: ["o2"] },
    { key: "path.primaryDetails.emotionalBase", value: "不属于有趣路径", opinionIds: ["o1"] },
  ]));
  assert.deepEqual(keys(proposal), ["path.primaryDetails.reveal", "path.primaryDetails.reinterpretation"]);
  assert.match(droppedReason(proposal, "path.primaryDetails.emotionalBase"), /不属于当前主导路径/);
  const { changes, payload } = buildAudioReviewChangeSet(
    snapshot(),
    proposal.changes,
    (ids) => audioReviewChangeReason(ids, proposal.opinions),
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].targetKey, "path.primaryDetails");
  assert.equal(changes[0].valueType, "STRUCTURE");
  assert.equal(changes[0].reason, "录音点评 意见 1、2");
  assert.deepEqual(payload.perceptionPath.primaryDetails, {
    ...sample.snapshot.perceptionPath.primaryDetails,
    reveal: "原来全城都在陪孩子玩。",
    reinterpretation: "是大人心里一直想玩。",
  });
  assertV04PayloadContract(payload);
});

const PERCEPTION_DETAILS = {
  perceptionRule: "同一个“躲”的动作被设成规则。",
  repetitionVariation: "躲的人一次比一次不该躲。",
  audiovisualRelation: "音乐随身份递进收紧。",
  payoff: "空街上的笑声兑现规则。",
  mainCarrier: "躲藏者的身份递进",
};

test("switching the primary path needs every new detail and becomes one change covering type and details", () => {
  const changes = [
    { key: "path.primaryType", value: "有料／感知", opinionIds: ["o1"] },
    ...Object.entries(PERCEPTION_DETAILS).map(([subKey, value]) => ({
      key: `path.primaryDetails.${subKey}`, value, opinionIds: subKey === "mainCarrier" ? ["o2"] : ["o1"],
    })),
    { key: "path.primaryDetails.reveal", value: "旧路径的细项", opinionIds: ["o1"] },
  ];
  const proposal = run(output(changes));
  assert.deepEqual(keys(proposal), ["path.primaryType"]);
  const change = proposal.changes[0];
  assert.equal(change.valueType, "PATH_PRIMARY");
  assert.equal(change.targetKey, "path.primaryType");
  assert.deepEqual(change.opinionIds, ["o1", "o2"]);
  assert.deepEqual(change.before, { primaryType: "FUN", primaryDetails: sample.snapshot.perceptionPath.primaryDetails });
  assert.deepEqual(change.after, { primaryType: "PERCEPTION", primaryDetails: PERCEPTION_DETAILS });
  assert.match(change.afterText, /^有料／感知\n感知规则／装置：同一个“躲”的动作被设成规则。/);
  assert.match(droppedReason(proposal, "path.primaryDetails.reveal"), /不属于新路径/);

  const { changes: v04, payload } = buildAudioReviewChangeSet(snapshot(), proposal.changes);
  assert.deepEqual(v04.map((item) => [item.targetKey, item.valueType]), [
    ["path.primaryType", "SINGLE_SELECT"],
    ["path.primaryDetails", "STRUCTURE"],
  ]);
  assert.equal(payload.perceptionPath.primaryType, "PERCEPTION");
  assert.deepEqual(payload.perceptionPath.primaryDetails, PERCEPTION_DETAILS);
  assertV04PayloadContract(payload);
});

test("a path switch with a missing detail, onto an auxiliary path, or with an unknown label is dropped together with its details", () => {
  const incomplete = run(output([
    { key: "path.primaryType", value: "PERCEPTION", opinionIds: ["o1"] },
    { key: "path.primaryDetails.perceptionRule", value: "规则", opinionIds: ["o1"] },
    { key: "path.primaryDetails.mainCarrier", value: "承重", opinionIds: ["o1"] },
  ]));
  assert.equal(incomplete.changes.length, 0);
  assert.match(droppedReason(incomplete, "path.primaryType"), /全部细项（缺「重复与变化」）/);
  assert.match(droppedReason(incomplete, "path.primaryDetails.mainCarrier"), /切换被丢弃/);

  const onAuxiliary = run(output([
    { key: "path.primaryType", value: "有爱／情感", opinionIds: ["o1"] },
    ...["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"].map((subKey) => ({
      key: `path.primaryDetails.${subKey}`, value: `新的${subKey}`, opinionIds: ["o1"],
    })),
  ]));
  assert.equal(onAuxiliary.changes.length, 0);
  assert.match(droppedReason(onAuxiliary, "path.primaryType"), /与辅助路径重复/);

  const unknown = run(output([
    { key: "path.primaryType", value: "搞笑", opinionIds: ["o1"] },
    { key: "path.primaryDetails.reveal", value: "x", opinionIds: ["o1"] },
  ]));
  assert.equal(unknown.changes.length, 0);
  assert.match(droppedReason(unknown, "path.primaryType"), /只能是/);
});

test("restating the current path keeps detail changes for that path", () => {
  const proposal = run(output([
    { key: "path.primaryType", value: "有趣", opinionIds: ["o1"] },
    { key: "path.primaryDetails.reveal", value: "原来全城都在陪孩子玩。", opinionIds: ["o1"] },
  ]));
  assert.deepEqual(keys(proposal), ["path.primaryDetails.reveal"]);
  assert.equal(droppedReason(proposal, "path.primaryType"), "与原值相同");
});

test("auxiliary path text can change only on an existing auxiliary path", () => {
  const proposal = run(output([
    { key: "path.auxiliaryTypes.LOVE.description", value: "大人陪孩子玩的善意。", opinionIds: ["o1"] },
    { key: "path.auxiliaryTypes.有爱／情感.creativeRole", value: "给荒诞一层温度。", opinionIds: ["o1"] },
    { key: "path.auxiliaryTypes.PERCEPTION.description", value: "新增辅助路径", opinionIds: ["o1"] },
  ]));
  assert.deepEqual(keys(proposal), ["path.auxiliaryTypes.LOVE.description", "path.auxiliaryTypes.LOVE.creativeRole"]);
  assert.equal(proposal.changes[0].label, "第三模块 · 辅助路径 · 有爱／情感 · 辅助路径说明");
  assert.equal(proposal.changes[0].subKey, "LOVE.description");
  assert.match(droppedReason(proposal, "path.auxiliaryTypes.PERCEPTION.description"), /不能新增辅助路径/);
  const { changes, payload } = buildAudioReviewChangeSet(snapshot(), proposal.changes);
  assert.deepEqual(changes.map((change) => change.targetKey), ["path.auxiliaryTypes"]);
  assert.deepEqual(payload.perceptionPath.auxiliaryTypes, [
    { type: "LOVE", description: "大人陪孩子玩的善意。", creativeRole: "给荒诞一层温度。" },
  ]);
});

test("the thinking chain is normalised to the nested-list storage format, even with top-level marks at column 0", () => {
  const proposal = run(output([
    { key: "facts.creativeThinkingChain", value: "体面的大人不被允许玩\n- 借孩子的数数\n      - 越正经越要躲\n- 大人重新当了一回孩子\n", opinionIds: ["o1"] },
  ]));
  assert.equal(proposal.changes[0].after, "体面的大人不被允许玩\n  - 借孩子的数数\n    - 越正经越要躲\n  - 大人重新当了一回孩子");
  // 已经是存储格式的原样保留（只规范空白）。
  assert.equal(
    normalizeModelThinkingChain("商业问题\n  - 问题：x\n    - 依据：y\n创意推导\n  - 第一步  "),
    "商业问题\n  - 问题：x\n    - 依据：y\n创意推导\n  - 第一步",
  );
  // 全是顶格记号、没有中心：保持为一列步骤（工作台按旧写法画成一条链）。
  assert.equal(normalizeModelThinkingChain("- 一\n- 二"), "一\n二");
});

test("opinions are ordered by their earliest cited segment and renumbered; model ids are remapped", () => {
  const proposal = run({
    speakers: { reviewer: "S0" },
    opinions: [
      { id: "late", kind: "specific", summary: "评价给高了", segmentIds: [12] },
      { id: "early", kind: "总体", summary: "母题看浅了", segmentIds: [6, 3, 99] },
      { id: "none", kind: "SPECIFIC", summary: "听到了但不需要改", segmentIds: [] },
      { id: "blank", kind: "GENERAL", summary: "  ", segmentIds: [4] },
    ],
    changes: [
      { key: "facts.overallCreativeRating", value: "A", opinionIds: ["late"] },
      { key: "facts.creativeMotif", value: "新母题", opinionIds: "early" },
      { key: "facts.tensionButton", value: "新张力", opinionIds: ["ghost"] },
    ],
  });
  assert.deepEqual(proposal.opinions.map((opinion) => [opinion.id, opinion.number, opinion.kind, opinion.summary, opinion.segmentIds]), [
    ["o1", 1, "GENERAL", "母题看浅了", [3, 6]],
    ["o2", 2, "SPECIFIC", "评价给高了", [12]],
    ["o3", 3, "SPECIFIC", "听到了但不需要改", []],
  ]);
  assert.deepEqual(proposal.opinions.map((opinion) => opinion.changeIds), [["c1"], ["c2"], []]);
  assert.deepEqual(proposal.changes.map((change) => change.opinionIds), [["o1"], ["o2"]]);
  assert.equal(droppedReason(proposal, "facts.tensionButton"), "没有对应的意见");
  assert.match(droppedReason(proposal, "opinion:blank"), /摘要/);
});

test("unaddressed: bad segment ids are filtered and the reviewer's uncovered substantive remarks are listed by the system", () => {
  const proposal = run(output([{ key: "facts.creativeMotif", value: "新母题", opinionIds: ["o1"] }], {
    unaddressed: [
      { segmentIds: [2, 404], reason: "肯定的部分，不需要改。" },
      { segmentIds: [404], reason: "不存在的片段" },
      { segmentIds: [5], reason: "" },
    ],
  }));
  const listed = proposal.unaddressed.map((entry) => [entry.segmentIds.join(","), entry.reason]);
  assert.deepEqual(listed.slice(0, 2), [["1", UNADDRESSED_FALLBACK_REASON], ["2", "肯定的部分，不需要改。"]]);
  assert.ok(listed.some(([ids, reason]) => ids === "5" && reason === "没有落到具体条目"));
  // 老孙的实质发言 7、9、11、12、13、14 都没被引用，系统补列；第 15 段太短，第 10 段不是老孙。
  for (const id of ["7", "9", "11", "12", "13", "14"]) {
    assert.ok(listed.some(([ids, reason]) => ids === id && reason === UNADDRESSED_FALLBACK_REASON), id);
  }
  assert.ok(!listed.some(([ids]) => ids === "15"));
  assert.ok(!listed.some(([ids]) => ids === "10"));
  // 按时间排
  const starts = proposal.unaddressed.map((entry) => Math.min(...entry.segmentIds));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

test("corrections must point at text that is really in the segment", () => {
  const proposal = run(output([{ key: "facts.creativeMotif", value: "新母题", opinionIds: ["o1"] }], {
    corrections: [
      { segmentId: 11, from: "对质生意", to: "对置生义" },
      { segmentId: 11, from: "对质生意", to: "对置生义" },
      { segmentId: 11, from: "不存在的词", to: "x" },
      { segmentId: 3, from: "母题", to: "母题" },
      { segmentId: 404, from: "a", to: "b" },
    ],
  }));
  assert.deepEqual(proposal.corrections, [{ segmentId: 11, from: "对质生意", to: "对置生义" }]);
});

test("speakers: an unknown reviewer id falls back to the dominant speaker; labels only for real non-reviewer speakers", () => {
  const proposal = run(output([{ key: "facts.creativeMotif", value: "新母题", opinionIds: ["o1"] }], {
    speakers: { reviewer: "S9", labels: { S0: "老孙", S1: "刘梦娜", S7: "幽灵", S2: "" } },
  }));
  assert.deepEqual(proposal.speakers, { reviewer: "S0", labels: { S1: "刘梦娜" }, others: null });
});

test("speakers judged by content on a real 16k_zh transcript (all labelled S0): others drive coverage and the view", () => {
  const data = JSON.parse(readFileSync(new URL("./fixtures/audio-review-asr-16k_zh.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const asr = interpretTaskStatus(data);
  assert.equal(asr.kind, "SUCCESS");
  const realSegments = asr.kind === "SUCCESS" ? asr.segments : [];
  const raw = {
    speakers: {
      reviewer: "S0",
      labels: {},
      others: [
        { segmentId: 11, speaker: "其他同事" },
        { segmentId: 6, speaker: "刘梦娜" },
        { segmentId: 6, speaker: "重复的" },
        { segmentId: 3, speaker: "老孙" },
        { segmentId: 99, speaker: "不存在" },
        { segmentId: 7 },
      ],
    },
    opinions: [{ id: "o1", kind: "GENERAL", summary: "母题看浅了", segmentIds: [3, 4, 5] }],
    changes: [{ key: "facts.creativeMotif", value: "让最体面的大人被允许重新当一回孩子", opinionIds: ["o1"] }],
    unaddressed: [{ segmentIds: [2], reason: "肯定的部分，不需要改。" }],
    corrections: [
      { segmentId: 2, from: "时间瓦", to: "时间码" },
      { segmentId: 12, from: "对质生利", to: "对置生义" },
      { segmentId: 5, from: "张韵，在这儿", to: "张力在这儿" },
    ],
  };
  const proposal = normalizeAudioReviewProposal(raw, { snapshot: snapshot(), segments: realSegments, reviewerName: "老孙" });
  assert.deepEqual(proposal.speakers.others, [
    { segmentId: 6, speaker: "刘梦娜" },
    { segmentId: 7, speaker: "其他同事" },
    { segmentId: 11, speaker: "其他同事" },
  ]);
  assert.equal(isReviewerSegment(realSegments[5], proposal.speakers), false);
  assert.equal(isReviewerSegment(realSegments[0], proposal.speakers), true);
  // 系统补列只补老孙的话：第 6、7、11 段不是老孙说的，不补。
  const fallback = proposal.unaddressed.filter((entry) => entry.reason === UNADDRESSED_FALLBACK_REASON).map((entry) => entry.segmentIds[0]);
  assert.ok(!fallback.includes(6) && !fallback.includes(7) && !fallback.includes(11));
  assert.ok(fallback.includes(8));
  assert.equal(proposal.corrections.length, 3);

  const view = toAudioReviewView({
    id: "arv_1", workspace_id: "ws", video_id: "video-1", base_version_id: "v1", base_version_number: 1, base_owner_name: "刘梦娜",
    base_payload_json: snapshot(), reviewer_user_id: "u", reviewer_name: "老孙", status: "PENDING_CONFIRM", failed_step: null,
    fail_reason: null, audio_object_key: "k", audio_file_name: "review.m4a", audio_content_type: "audio/mp4", audio_size_bytes: "1103513",
    audio_duration_ms: 143488, asr_engine: "16k_zh", asr_task_id: "1", asr_submitted_at: null, asr_checked_at: null,
    transcript_json: { segments: realSegments, durationMs: 143488, engine: "16k_zh" }, llm_model: "m", prompt_version: "p",
    llm_attempts: 1, llm_started_at: null, llm_finished_at: null, llm_usage_json: null, input_content_hash: null,
    proposal_json: proposal, selected_change_ids: null, review_version_id: null, lease_until: null,
    created_at: "2026-10-10T08:00:00.000Z", updated_at: "2026-10-10T08:00:00.000Z", uploaded_at: null, proposed_at: null,
    confirmed_at: null, abandoned_at: null,
  }, { viewerDisplayName: "老孙" });
  const segmentsView = view.transcript!.segments;
  assert.deepEqual(segmentsView.filter((segment) => !segment.isReviewer).map((segment) => [segment.id, segment.speaker]), [
    [6, "刘梦娜"], [7, "其他同事"], [11, "其他同事"],
  ]);
  assert.equal(segmentsView[0].speaker, "老孙");
  assert.match(segmentsView[1].text, /时间码也准/);
  assert.deepEqual(segmentsView[1].corrections, [{ from: "时间瓦", to: "时间码" }]);
  assert.match(segmentsView[4].text, /^张力在这儿不在城市变游乐场/);
});

test("garbage input yields an empty proposal rather than throwing", () => {
  for (const raw of [null, 42, "text", [], { opinions: "x", changes: {} }]) {
    const proposal = run(raw);
    assert.equal(proposal.changes.length, 0);
    assert.equal(proposal.opinions.length, 0);
  }
});

test("value formatting for the confirm panel", () => {
  assert.equal(formatAudioReviewValue("TEXT", ""), "（空）");
  assert.equal(formatAudioReviewValue("RATING", "A"), "A");
  assert.equal(formatAudioReviewValue("CARRIERS", ["STORY", "AUDIOVISUAL_RULE"]), "故事、视听规则");
  assert.equal(
    formatAudioReviewValue("CHOICE", { selectedOptionIds: ["EVERYDAY_LIFE_COMEDY"], customText: "城市游戏化概念片" }),
    "日常生活喜剧片 ＋ 自定义：城市游戏化概念片",
  );
  assert.equal(formatAudioReviewValue("MECHANISM", { selectedOptionIds: ["FORMAL_PLAY"], customText: "情境游戏化", advancedText: "" }), "形式游戏｜情境游戏化");
  assert.equal(formatAudioReviewValue("PATH_PRIMARY", { primaryType: "", primaryDetails: {} }), "（空）");
});
