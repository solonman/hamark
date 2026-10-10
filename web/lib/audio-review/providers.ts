// 转写与理解的提供方：真实（腾讯云 + DeepSeek）或本地假实现，按 config.ts 的判断二选一。
// 服务层只认这里的接口，测试直接注入自己的假提供方。

import { readAudioReviewConfig, type AudioReviewConfig, type AudioReviewProviderKind } from "./config";
import {
  callDeepseekChat,
  type DeepseekFetch,
  type DeepseekReasoningEffort,
  type LlmMessages,
  type LlmOutcome,
} from "./deepseek";
import { createFakeAsr, createFakeLlm } from "./fake";
import type { AudioReviewPromptContext } from "./prompt";
import {
  createRecTask,
  describeTaskStatus,
  type AsrDescribeOutcome,
  type AsrFetch,
  type AsrSubmitOutcome,
} from "./tencent-asr";

export const REAL_ASR_POLL_INTERVAL_MS = 4_000;

export type AudioReviewAsrProvider = {
  engine: string;
  pollIntervalMs: number;
  submit(input: { audioUrl: string; hotwordList: string }): Promise<AsrSubmitOutcome>;
  describe(taskId: string): Promise<AsrDescribeOutcome>;
};

export type AudioReviewLlmProvider = {
  model: string;
  complete(
    messages: LlmMessages,
    context: AudioReviewPromptContext,
    options: { timeoutMs: number; reasoningEffort: DeepseekReasoningEffort },
  ): Promise<LlmOutcome>;
};

export type AudioReviewProviders = {
  kind: AudioReviewProviderKind;
  asr: AudioReviewAsrProvider;
  llm: AudioReviewLlmProvider;
};

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAudioReviewProviders(
  config: AudioReviewConfig = readAudioReviewConfig(),
  options: { asrFetch?: AsrFetch; llmFetch?: DeepseekFetch; sleep?: (ms: number) => Promise<void>; clock?: () => number } = {},
): AudioReviewProviders {
  const clock = options.clock ?? Date.now;
  if (config.provider === "fake") {
    return {
      kind: "fake",
      asr: createFakeAsr(clock),
      llm: createFakeLlm(options.sleep ?? defaultSleep, clock),
    };
  }
  const asrOptions = { credentials: { secretId: config.asr.secretId, secretKey: config.asr.secretKey }, fetchImpl: options.asrFetch };
  return {
    kind: "real",
    asr: {
      engine: config.asr.engine,
      pollIntervalMs: REAL_ASR_POLL_INTERVAL_MS,
      submit: ({ audioUrl, hotwordList }) => createRecTask({ engine: config.asr.engine, audioUrl, hotwordList }, asrOptions),
      describe: (taskId) => describeTaskStatus(taskId, asrOptions),
    },
    llm: {
      model: config.deepseek.model,
      complete: (messages, _context, { timeoutMs, reasoningEffort }) => callDeepseekChat(messages, {
        apiKey: config.deepseek.apiKey,
        model: config.deepseek.model,
        baseUrl: config.deepseek.baseUrl,
        fetchImpl: options.llmFetch,
        timeoutMs,
        reasoningEffort,
        clock,
      }),
    },
  };
}
