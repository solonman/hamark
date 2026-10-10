// 提示词（docs/25 4.5）：规则写全、作业带稳定键、字段说明与词表齐全、文字稿形状、示例自洽。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listEditableItems, PRIMARY_DETAIL_KEYS } from "../lib/audio-review/fields";
import {
  AUDIO_REVIEW_EXAMPLE,
  AUDIO_REVIEW_FIELD_GUIDE,
  AUDIO_REVIEW_PROMPT_VERSION,
  AUDIO_REVIEW_SYSTEM_PROMPT,
  buildAudioReviewMessages,
  buildAudioReviewUserPayload,
  buildHomeworkForPrompt,
  hashAudioReviewInput,
} from "../lib/audio-review/prompt";
import { normalizeModelThinkingChain } from "../lib/audio-review/proposal";
import type { AudioReviewTranscriptSegment } from "../lib/audio-review/transcript";
import type { V04DraftPayloadV1 } from "../lib/v04-contract";
import { V04_VOCABULARY_OPTIONS } from "../lib/v04-vocabulary";

const sample = JSON.parse(readFileSync(new URL("../scripts/fixtures/audio-review-sample.json", import.meta.url), "utf8")) as {
  snapshot: V04DraftPayloadV1;
  transcript: AudioReviewTranscriptSegment[];
};
const context = {
  snapshot: sample.snapshot,
  segments: sample.transcript,
  reviewerName: "老孙",
  revieweeName: "刘梦娜",
  baseVersionNumber: 1,
  caseTitle: "捉迷藏",
};

test("the prompt version is pinned so task rows record which prompt produced them", () => {
  assert.equal(AUDIO_REVIEW_PROMPT_VERSION, "2026-10-10.1");
});

test("the system prompt spells out every non-negotiable rule", () => {
  for (const rule of [
    "老孙的话是改动的唯一依据",
    "总体意见绝不能只改老孙点名提到的那几处",
    "全部条目从头到尾逐个检查一遍",
    "rationale",
    "保留作者原有的",
    "书面体",
    "不增删桥段和镜头",
    "不改时间码",
    "「词表」里的标签原文",
    "主导机制与辅助机制不能选同一项",
    "必须同时给出新路径的全部五个细项",
    "同音",
    "corrections",
    "要么被某条意见的 segmentIds 引用，要么写进 unaddressed",
    "需要人工补／删镜头",
    "只输出一个 JSON 对象",
    "GENERAL",
    "SPECIFIC",
    "Markdown 嵌套列表",
  ]) {
    assert.ok(AUDIO_REVIEW_SYSTEM_PROMPT.includes(rule), rule);
  }
});

test("the user message is JSON with the task, field guide, vocabulary, homework, transcript, format and example", () => {
  const messages = buildAudioReviewMessages(context);
  assert.equal(messages.system, AUDIO_REVIEW_SYSTEM_PROMPT);
  const user = JSON.parse(messages.user) as Record<string, unknown>;
  assert.deepEqual(Object.keys(user), ["任务", "字段说明", "词表", "作业", "文字稿", "输出格式", "输出示例"]);
  const task = user.任务 as Record<string, string>;
  assert.equal(task.被点评人, "刘梦娜");
  assert.equal(task.录音者, "老孙");
  assert.equal(task.被点评版本, "v1");
  assert.match(task.说明, /其他同事的提问/);
  assert.deepEqual((user.文字稿 as unknown[])[10], { id: 11, t: "07:09", speaker: "S0", text: sample.transcript[10].text });
});

test("the homework lists every editable position with its stable key; shots show read-only time codes, never time keys", () => {
  const homework = buildHomeworkForPrompt(sample.snapshot);
  const text = JSON.stringify(homework);
  for (const item of listEditableItems(sample.snapshot)) {
    if (item.key.startsWith("shot:")) continue;
    assert.ok(text.includes(`"${item.key}"`), item.key);
  }
  assert.ok(text.includes("\"shot:shot-hide-05.visualContent\""));
  assert.ok(text.includes("井盖被顶起，一个人探出头。"));
  assert.ok(!/shot:[^"]+\.(startTime|endTime)/.test(text));
  const bridge = homework["第二模块｜脚本反写"][1];
  assert.equal(bridge.桥段, "桥段 02");
  assert.equal(bridge.镜头[2].镜号, "2-3");
  assert.equal(bridge.镜头[2]["时间码（只读）"], "00:12–00:15");
  // 选项字段用的是输出时的 value 形状，标签而不是 optionId。
  const module1 = homework["第一模块｜全片事实与核心判断"];
  assert.deepEqual(module1.find((item) => item.键 === "facts.mainMechanism")!.当前内容, { options: ["形式游戏"], custom: "情境游戏化", advanced: "" });
  assert.deepEqual(module1.find((item) => item.键 === "facts.creativeCarriers")!.当前内容, ["故事", "视听规则"]);
  const module3 = homework["第三模块｜主导感知类型发生路径与整体评价"];
  assert.equal(module3[0].当前内容, "有趣／预期");
  assert.ok(module3.some((item) => item.键 === "path.primaryDetails.reveal"));
  assert.ok(module3.some((item) => item.键 === "path.auxiliaryTypes.LOVE.description"));
});

test("the field guide covers every editable field, every path detail of all three paths, and the chain format", () => {
  const guideKeys = AUDIO_REVIEW_FIELD_GUIDE.map((entry) => entry.键);
  for (const key of [
    "facts.commercialIntent", "facts.storySynopsis", "facts.creativeMotif", "facts.tensionButton",
    "facts.mainMechanism", "facts.auxiliaryMechanism", "facts.creativeThinkingChain", "facts.storyReference",
    "facts.creativeCarriers", "facts.carrierExplanation", "facts.acceptanceContract",
    "facts.overallCreativeRating", "facts.ratingReason",
    "shotGroup:<桥段id>.bridgeName", "shotGroup:<桥段id>.primaryCreativeRole",
    "shotGroup:<桥段id>.auxiliaryCreativeRole", "shotGroup:<桥段id>.keyCreativeDescription",
    "shot:<镜头id>.<字段键>", "path.primaryType",
    "path.auxiliaryTypes.<路径代码>.description", "path.auxiliaryTypes.<路径代码>.creativeRole",
  ]) {
    assert.ok(guideKeys.includes(key), key);
  }
  for (const keys of Object.values(PRIMARY_DETAIL_KEYS)) {
    for (const subKey of keys) assert.ok(guideKeys.includes(`path.primaryDetails.${subKey}`), subKey);
  }
  for (const entry of AUDIO_REVIEW_FIELD_GUIDE) {
    assert.ok(entry.含义 && entry.写法 && entry.取值, entry.键);
  }
  const chain = AUDIO_REVIEW_FIELD_GUIDE.find((entry) => entry.键 === "facts.creativeThinkingChain")!;
  assert.match(chain.写法, /两个空格加「- 」/);
  assert.match(chain.写法, /不要用「→」/);
  const shot = AUDIO_REVIEW_FIELD_GUIDE.find((entry) => entry.键 === "shot:<镜头id>.<字段键>")!;
  assert.match(shot.含义, /visualContent（画面内容（镜头故事））/);
  assert.match(shot.含义, /startTime、endTime（时间码）只读/);
});

test("the vocabulary lists every option label", () => {
  const user = buildAudioReviewUserPayload(context);
  const text = JSON.stringify(user.词表);
  for (const option of V04_VOCABULARY_OPTIONS) assert.ok(text.includes(`"${option.labelZhCn}"`), option.labelZhCn);
  assert.equal(user.词表.通用机制.length, 15);
  assert.ok(user.词表.通用机制.every((item) => item.说明));
  assert.deepEqual(user.词表.创意承重载体, ["故事", "文案", "视听规则"]);
  assert.deepEqual(user.词表.主导路径, ["有爱／情感", "有趣／预期", "有料／感知"]);
});

test("the worked example is self-consistent: keys exist in its homework excerpt, ids resolve, the chain is in storage format", () => {
  const example = AUDIO_REVIEW_EXAMPLE;
  const excerptKeys = new Set(example.示例作业片段.map((item) => item.键));
  const opinionIds = new Set(example.示例输出.opinions.map((opinion) => opinion.id));
  const segmentIds = new Set(example.示例文字稿.map((segment) => segment.id));
  for (const change of example.示例输出.changes) {
    assert.ok(excerptKeys.has(change.key), change.key);
    for (const id of change.opinionIds) assert.ok(opinionIds.has(id), id);
  }
  for (const opinion of example.示例输出.opinions) {
    for (const id of opinion.segmentIds) assert.ok(segmentIds.has(id));
  }
  const general = example.示例输出.opinions.find((opinion) => opinion.kind === "GENERAL")!;
  assert.ok(example.示例输出.changes.filter((change) => change.opinionIds.includes(general.id)).length >= 4);
  assert.ok(example.示例输出.changes.some((change) => change.opinionIds.length > 1));
  const chain = example.示例输出.changes.find((change) => change.key === "facts.creativeThinkingChain")!.value as string;
  assert.equal(normalizeModelThinkingChain(chain), chain);
  for (const correction of example.示例输出.corrections) {
    assert.ok(example.示例文字稿.find((segment) => segment.id === correction.segmentId)!.text.includes(correction.from));
  }
  assert.ok(example.示例输出.unaddressed.some((entry) => entry.reason.startsWith("需要人工补／删镜头")));
  // 示例故意让说话人标签全是 S0，靠内容认出同事的提问。
  assert.deepEqual([...new Set(example.示例文字稿.map((segment) => segment.speaker))], ["S0"]);
  assert.deepEqual(example.示例输出.speakers.others, [{ segmentId: 3, speaker: "其他同事" }]);
  // 每段老孙的话（没列进 others 的）要么被意见引用、要么进了 unaddressed。
  const others = new Set(example.示例输出.speakers.others.map((entry) => entry.segmentId));
  const covered = new Set([
    ...example.示例输出.opinions.flatMap((opinion) => opinion.segmentIds),
    ...example.示例输出.unaddressed.flatMap((entry) => entry.segmentIds),
  ]);
  for (const segment of example.示例文字稿.filter((item) => !others.has(item.id))) assert.ok(covered.has(segment.id), String(segment.id));
});

test("the prompt does not trust speaker labels and insists on restoring homophones from the vocabulary", () => {
  for (const rule of [
    "不要相信说话人标签",
    "经常全部相同",
    "speakers.others",
    "没列进 others 的段落一律视为老孙说的",
    "「时间码」听成「时间瓦」",
    "「对置生义」听成「对质生利」",
    "必须与原文一字不差",
    "听不清，无法判断",
  ]) {
    assert.ok(AUDIO_REVIEW_SYSTEM_PROMPT.includes(rule), rule);
  }
  const task = buildAudioReviewUserPayload(context).任务;
  assert.match(task.说明, /说话人标签可能全部相同或分错/);
  assert.match(task.说明, /错别字可能很多/);
});

test("the input hash is stable and covers model and messages", () => {
  const messages = buildAudioReviewMessages(context);
  const a = hashAudioReviewInput("deepseek-v4-pro", messages);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, hashAudioReviewInput("deepseek-v4-pro", buildAudioReviewMessages(context)));
  assert.notEqual(a, hashAudioReviewInput("other-model", messages));
  assert.notEqual(a, hashAudioReviewInput("deepseek-v4-pro", { ...messages, user: `${messages.user} ` }));
});
