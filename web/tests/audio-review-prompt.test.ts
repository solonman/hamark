// 提示词（docs/25 4.5）：规则写全、作业带稳定键、字段说明与词表齐全、文字稿形状、示例自洽。
// 文字点评（二之二）：录音版逐字不变（钉了哈希）；文字版只换与来源有关的几处，其余规则一字不差。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { audioReviewDocumentSegments } from "../lib/audio-review/document";
import { listEditableItems, PRIMARY_DETAIL_KEYS } from "../lib/audio-review/fields";
import {
  AUDIO_REVIEW_DOCUMENT_EXAMPLE,
  AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT,
  AUDIO_REVIEW_EXAMPLE,
  AUDIO_REVIEW_FIELD_GUIDE,
  AUDIO_REVIEW_PROMPT_VERSION,
  AUDIO_REVIEW_SYSTEM_PROMPT,
  buildAudioReviewMessages,
  buildAudioReviewSystemPrompt,
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
  assert.equal(AUDIO_REVIEW_PROMPT_VERSION, "2026-10-21.1");
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

// ---------------------------------------------------------------------------
// 文字点评（docs/25 二之二）
// ---------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("recording prompts are word for word what prompt 2026-10-10.2 produced — only the version constant changed", () => {
  // 这两个哈希是改动前（2026-10-10.2）对同一份样例算出来的。改了录音版的提示词（含字段说明、词表、示例），
  // 就要同时把 AUDIO_REVIEW_PROMPT_VERSION 加一并更新这里。
  for (const messages of [buildAudioReviewMessages(context), buildAudioReviewMessages({ ...context, sourceKind: "AUDIO" })]) {
    assert.equal(sha256(messages.system), "4ef6e9fb46dc26754126a3f9fd9a5701006f52b1698eefa3ab3ad7541780b04a");
    assert.equal(sha256(messages.user), "de6738a4a7d0dc233de785a4876d36b6c0ae02451e28b0da20c8deab18a56596");
  }
  assert.equal(buildAudioReviewSystemPrompt(), AUDIO_REVIEW_SYSTEM_PROMPT);
  assert.equal(buildAudioReviewSystemPrompt("AUDIO"), AUDIO_REVIEW_SYSTEM_PROMPT);
  assert.equal(buildAudioReviewSystemPrompt("DOCUMENT"), AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT);
});

test("the document system prompt swaps only the speaker, misspelling and source lines; every other rule is identical", () => {
  const documentLines = new Set(AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT.split("\n"));
  const changed = AUDIO_REVIEW_SYSTEM_PROMPT.split("\n").filter((line) => !documentLines.has(line));
  const expected = [
    /^学员各自对一支广告片做「逆向拆解作业」.*并现场录了音。.*这段录音的转写文字稿/,
    /^1\. 认人——按内容逐段判断，不要相信说话人标签。/,
    /^ {3}- 老孙是录音者/,
    /^ {3}- 被点评人会为自己的写法解释或辩护/,
    /^ {3}- 现场其他人通常是提问或插话/,
    /^ {3}把不是老孙说的每一段都写进 speakers\.others/,
    /^3\. 归纳意见。.*（引用时用还原错字后的写法）/,
    /^ {3}- 你看不到视频：.*老孙口头说出的画面信息/,
    /^8\. 同音错字——务必先还原再理解。/,
    /^ {3}- 一律按「词表」里的标签/,
    /^ {3}- 凡是影响理解的错字都写进 corrections/,
    /^ {3}- corrections 会原样展示给所有人看，只记有把握的还原/,
    /^ {3}- 听写残缺到实在无法确定原意的/,
    /^9\. 不遗漏。老孙的每一段实质性发言/,
    /^ {3}- 听不清，无法判断；$/,
    /^ {3}- 开场或过渡语，没有点评内容/,
    /^ {3}老孙的话只要没被意见引用，就都要写进 unaddressed，开场、过渡、点名也一样/,
  ];
  assert.equal(changed.length, expected.length, changed.join("\n"));
  changed.forEach((line, index) => assert.match(line, expected[index]));

  // 其余规则一字不差（总体意见落实全部条目、不增删镜头不改时间码、只用给定标签、每段实质内容都有着落……）。
  for (const rule of [
    "老孙的话是改动的唯一依据",
    "总体意见绝不能只改老孙点名提到的那几处",
    "全部条目从头到尾逐个检查一遍",
    "保留作者原有的",
    "不增删桥段和镜头，不调桥段和镜头的顺序，不改时间码",
    "「词表」里的标签原文",
    "主导机制与辅助机制不能选同一项",
    "必须同时给出新路径的全部五个细项",
    "要么被某条意见的 segmentIds 引用，要么写进 unaddressed",
    "需要人工补／删镜头",
    "只输出一个 JSON 对象",
    "没列进 others 的段落一律视为老孙说的",
  ]) {
    assert.ok(AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT.includes(rule), rule);
  }
  // 文字的写法。
  for (const rule of [
    "默认每一段都是老孙的意见",
    "只有文字里明确写出是别人说的段落，才不是老孙的话",
    "可能由秦欣欣替他整理",
    "这份点评文字（按段落编号）",
    "「片段编号」都指它",
    "speakers.reviewer 固定写 \"S0\"",
    "文字是打出来的，不做同音纠错",
    "只有明显的错别字才写进 corrections",
    "必须与原文一字不差",
    "意思不明确，无法判断",
  ]) {
    assert.ok(AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT.includes(rule), rule);
  }
  // 录音特有的说法一条不留。
  for (const text of ["录了音", "录音", "不要相信说话人标签", "时间瓦", "听不清", "还原错字", "口头说出"]) {
    assert.ok(!AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT.includes(text), text);
  }
});

test("the document user message: 点评人 instead of 录音者, paragraphs as { id, 段, text } without times, same guide/vocabulary/homework", () => {
  const segments = audioReviewDocumentSegments(["母题看浅了。", "小周问：主导机制要改吗？", "辅助机制是对置生义。"]);
  const messages = buildAudioReviewMessages({ ...context, segments, sourceKind: "DOCUMENT" });
  assert.equal(messages.system, AUDIO_REVIEW_DOCUMENT_SYSTEM_PROMPT);
  type UserJson = {
    任务: Record<string, string>;
    文字稿: unknown[];
    字段说明: unknown;
    词表: unknown;
    作业: unknown;
    输出格式: Record<string, unknown> & { speakers: { reviewer: string }; corrections: Array<{ from: string }> };
  };
  const user = JSON.parse(messages.user) as UserJson;
  const audioUser = JSON.parse(buildAudioReviewMessages(context).user) as UserJson;
  assert.deepEqual(Object.keys(user), ["任务", "字段说明", "词表", "作业", "文字稿", "输出格式", "输出示例"]);
  assert.deepEqual(Object.keys(user.任务), ["案例", "被点评版本", "被点评人", "点评人", "说明"]);
  assert.equal(user.任务.点评人, "老孙");
  assert.equal(user.任务.被点评人, "刘梦娜");
  for (const phrase of [
    "这是老孙对刘梦娜这一版作业的点评文字，可能由秦欣欣整理",
    "默认每一段都是老孙的意见，只有明确写出是别人说的",
    "id 和「段」都是段落号",
    "文字是打出来的，不做同音纠错，corrections 只记明显的错别字",
  ]) {
    assert.ok(user.任务.说明.includes(phrase), phrase);
  }
  assert.deepEqual(user.文字稿, [
    { id: 1, 段: 1, text: "母题看浅了。" },
    { id: 2, 段: 2, text: "小周问：主导机制要改吗？" },
    { id: 3, 段: 3, text: "辅助机制是对置生义。" },
  ]);
  assert.deepEqual(user.字段说明, audioUser.字段说明);
  assert.deepEqual(user.词表, audioUser.词表);
  assert.deepEqual(user.作业, audioUser.作业);
  // 输出格式：只有说话人和错别字两项换了说法。
  assert.deepEqual(Object.keys(user.输出格式), Object.keys(audioUser.输出格式));
  for (const key of ["opinions", "changes", "unaddressed"]) assert.deepEqual(user.输出格式[key], audioUser.输出格式[key], key);
  assert.equal(user.输出格式.speakers.reviewer, "固定写 \"S0\"");
  assert.match(user.输出格式.corrections[0].from, /明显的错别字/);
  assert.notEqual(hashAudioReviewInput("m", messages), hashAudioReviewInput("m", buildAudioReviewMessages(context)));
});

test("the document worked example is self-consistent: paragraphs without times, an explicit question, one obvious misspelling", () => {
  const example = AUDIO_REVIEW_DOCUMENT_EXAMPLE;
  assert.ok(example.示例文字稿.every((segment) => JSON.stringify(Object.keys(segment)) === JSON.stringify(["id", "段", "text"])));
  assert.ok(example.示例文字稿.every((segment) => segment.id === segment.段));
  assert.deepEqual(example.示例作业片段, AUDIO_REVIEW_EXAMPLE.示例作业片段);
  assert.deepEqual(example.示例输出.opinions, AUDIO_REVIEW_EXAMPLE.示例输出.opinions);
  assert.deepEqual(example.示例输出.changes, AUDIO_REVIEW_EXAMPLE.示例输出.changes);
  const segmentIds = new Set(example.示例文字稿.map((segment) => segment.id));
  for (const opinion of example.示例输出.opinions) for (const id of opinion.segmentIds) assert.ok(segmentIds.has(id));
  // 第 3 段明确写了是别人问的，这才列进 others。
  assert.deepEqual(example.示例输出.speakers.others, [{ segmentId: 3, speaker: "小周" }]);
  assert.match(example.示例文字稿[2].text, /^小周问：/);
  for (const correction of example.示例输出.corrections) {
    assert.ok(example.示例文字稿.find((segment) => segment.id === correction.segmentId)!.text.includes(correction.from));
  }
  assert.deepEqual(example.示例输出.corrections, [{ segmentId: 4, from: "对置生意", to: "对置生义" }]);
  // 打出来的文字没有听写错字。
  assert.ok(!example.示例文字稿.some((segment) => /张韵|对质生意/.test(segment.text)));
  const others = new Set(example.示例输出.speakers.others.map((entry) => entry.segmentId));
  const covered = new Set([
    ...example.示例输出.opinions.flatMap((opinion) => opinion.segmentIds),
    ...example.示例输出.unaddressed.flatMap((entry) => entry.segmentIds),
  ]);
  for (const segment of example.示例文字稿.filter((item) => !others.has(item.id))) assert.ok(covered.has(segment.id), String(segment.id));
});
