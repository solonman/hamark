// 录音点评提示词核对脚本：读一个样例（快照 + 文字稿），用 DEEPSEEK_API_KEY 真调一次 DeepSeek，
// 打印校验后的提案摘要、耗时和 token 用量。用来在上线前、改提示词之后看模型的实际表现。
//
// ⚠ 会产生 DeepSeek 费用（思考模式、最多 32000 输出 token）。运行前须经项目负责人同意。
// 不读写数据库、不碰对象存储、不调用腾讯云。
//
// 用法：
//   node --env-file=.env.local --import tsx scripts/audio-review-prompt-check.ts [样例.json] [--out 结果.json] [--dry-run]
//     样例默认 scripts/fixtures/audio-review-sample.json；
//     --out     把模型原始输出与校验后的提案写到文件，便于逐条比对；
//     --dry-run 只组装提示词、打印长度，不调用模型（不产生费用）。
// 环境变量：DEEPSEEK_API_KEY（必填），DEEPSEEK_MODEL、DEEPSEEK_BASE_URL（可选）。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAudioReviewConfig } from "../lib/audio-review/config.ts";
import { callDeepseekChat, parseModelJsonContent } from "../lib/audio-review/deepseek.ts";
import {
  AUDIO_REVIEW_PROMPT_VERSION,
  buildAudioReviewMessages,
  hashAudioReviewInput,
  type AudioReviewPromptContext,
} from "../lib/audio-review/prompt.ts";
import { normalizeAudioReviewProposal } from "../lib/audio-review/proposal.ts";
import { parseStoredTranscript } from "../lib/audio-review/transcript.ts";
import { assertV04PayloadContract } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1 } from "../lib/v04-contract.ts";

type Sample = {
  caseTitle?: string;
  reviewerName?: string;
  revieweeName?: string;
  baseVersionNumber?: number;
  snapshot: V04DraftPayloadV1;
  transcript: unknown[];
};

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const samplePath = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--out")
    ?? path.join(here, "fixtures", "audio-review-sample.json");
  const outPath = argValue(args, "--out");
  const dryRun = args.includes("--dry-run");

  const sample = JSON.parse(await readFile(samplePath, "utf8")) as Sample;
  assertV04PayloadContract(sample.snapshot);
  const transcript = parseStoredTranscript({ segments: sample.transcript, durationMs: null, engine: "sample" });
  if (!transcript || transcript.segments.length === 0) throw new Error("样例里没有文字稿。");

  const context: AudioReviewPromptContext = {
    snapshot: sample.snapshot,
    segments: transcript.segments,
    reviewerName: sample.reviewerName ?? "老孙",
    revieweeName: sample.revieweeName ?? "被点评人",
    baseVersionNumber: sample.baseVersionNumber ?? 1,
    caseTitle: sample.caseTitle ?? null,
  };
  const messages = buildAudioReviewMessages(context);
  const config = readAudioReviewConfig(process.env, false);
  console.log(`样例：${samplePath}`);
  console.log(`提示词版本：${AUDIO_REVIEW_PROMPT_VERSION}；模型：${config.deepseek.model}；地址：${config.deepseek.baseUrl}`);
  console.log(`system ${messages.system.length} 字；user ${messages.user.length} 字；片段 ${transcript.segments.length} 段`);
  console.log(`输入哈希：${hashAudioReviewInput(config.deepseek.model, messages)}`);
  if (dryRun) return;
  if (!config.deepseek.apiKey) throw new Error("缺少 DEEPSEEK_API_KEY。");

  console.log("调用 DeepSeek 中（最长 240 秒）……");
  const outcome = await callDeepseekChat(messages, {
    apiKey: config.deepseek.apiKey,
    model: config.deepseek.model,
    baseUrl: config.deepseek.baseUrl,
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT === "low" ? "low" : "high",
  });
  console.log(`耗时：${(outcome.durationMs / 1000).toFixed(1)} 秒`);
  console.log(`用量：${JSON.stringify(outcome.usage ?? null)}`);
  if (!outcome.ok) {
    console.error(`调用失败：${outcome.reason}（HTTP ${outcome.status ?? "-"}，${outcome.retryable ? "可重试" : "不可重试"}）`);
    process.exitCode = 1;
    return;
  }
  console.log(`结束原因：${outcome.finishReason ?? "-"}；输出 ${outcome.content.length} 字`);
  const parsed = parseModelJsonContent(outcome.content, outcome.finishReason);
  if (!parsed.ok) {
    console.error(`输出不是合法 JSON：${parsed.reason}`);
    if (outPath) await writeFile(outPath, outcome.content, "utf8");
    process.exitCode = 1;
    return;
  }
  const proposal = normalizeAudioReviewProposal(parsed.value, {
    snapshot: sample.snapshot,
    segments: transcript.segments,
    reviewerName: context.reviewerName,
  });

  console.log(`\n说话人：老孙的标签＝${proposal.speakers.reviewer}；标签名：${JSON.stringify(proposal.speakers.labels)}`);
  console.log(`  不是老孙说的段落：${proposal.speakers.others
    ? proposal.speakers.others.map((entry) => `${entry.segmentId}（${entry.speaker}）`).join("、") || "无"
    : "模型没给逐段判断，按标签"}`);
  console.log(`意见 ${proposal.opinions.length} 条，可用改动 ${proposal.changes.length} 处，丢弃 ${proposal.dropped.length} 处`);
  for (const opinion of proposal.opinions) {
    console.log(`\n意见 ${opinion.number}（${opinion.kind === "GENERAL" ? "总体" : "具体"}）${opinion.summary}`);
    console.log(`  依据片段：${opinion.segmentIds.join("、") || "-"}`);
    console.log(`  落实说明：${opinion.rationale || "-"}`);
    for (const change of proposal.changes.filter((item) => opinion.changeIds.includes(item.id))) {
      const also = change.opinionIds.length > 1 ? `（同时依据 ${change.opinionIds.join("、")}）` : "";
      console.log(`  · ${change.label}${also}`);
      console.log(`      原：${change.beforeText.replace(/\n/g, " ⏎ ")}`);
      console.log(`      改：${change.afterText.replace(/\n/g, " ⏎ ")}`);
    }
  }
  console.log("\n没落到条目的话：");
  for (const entry of proposal.unaddressed) console.log(`  · 片段 ${entry.segmentIds.join("、")}：${entry.reason}`);
  console.log("\n同音校正：");
  for (const correction of proposal.corrections) console.log(`  · 片段 ${correction.segmentId}：${correction.from} → ${correction.to}`);
  if (proposal.dropped.length) {
    console.log("\n被丢弃的改动（不展示给老孙）：");
    for (const entry of proposal.dropped) console.log(`  · ${entry.key}：${entry.reason}`);
  }
  if (outPath) {
    await writeFile(outPath, JSON.stringify({ raw: parsed.value, proposal, usage: outcome.usage }, null, 2), "utf8");
    console.log(`\n已写出：${outPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
