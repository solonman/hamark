// 月度整理的模型提供方：真实（DeepSeek）或本地假实现，按 month-config.ts 的判断二选一。
// 服务层只认这里的接口，测试直接注入自己的假提供方。

import {
  callDeepseekChat,
  type DeepseekFetch,
  type DeepseekReasoningEffort,
  type LlmOutcome,
} from "@/lib/audio-review/deepseek";
import { readRetroAiConfig, type RetroAiConfig, type RetroAiProviderKind } from "./month-config";
import { createFakeRetroLlm } from "./month-fake";
import type { RetroSpeakers } from "./extraction";
import type { RetroSnapshotCase } from "./month-snapshot";
import type { RetroLlmMessages } from "./prompt";
import type { RetroSynthesisContext } from "./synthesis";

/** 每一步调用时交给提供方的结构化输入（假实现据此确定性地产出结果；真实实现只用 messages）。 */
export type RetroStepContext =
  | { step: "EXTRACT"; item: RetroSnapshotCase }
  | { step: "SUMMARIZE"; synthesis: RetroSynthesisContext }
  | { step: "DISTILL"; synthesis: RetroSynthesisContext; summarySpeakers: RetroSpeakers | null };

export type RetroLlmProvider = {
  kind: RetroAiProviderKind;
  model: string;
  complete(
    messages: RetroLlmMessages,
    context: RetroStepContext,
    options: { timeoutMs: number; reasoningEffort: DeepseekReasoningEffort },
  ): Promise<LlmOutcome>;
};

export const defaultRetroSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRetroLlmProvider(
  config: RetroAiConfig = readRetroAiConfig(),
  options: { fetchImpl?: DeepseekFetch; sleep?: (ms: number) => Promise<void>; clock?: () => number } = {},
): RetroLlmProvider {
  const clock = options.clock ?? Date.now;
  if (config.provider === "fake") return createFakeRetroLlm(options.sleep ?? defaultRetroSleep, clock);
  return {
    kind: "real",
    model: config.deepseek.model,
    complete: (messages, _context, { timeoutMs, reasoningEffort }) => callDeepseekChat(messages, {
      apiKey: config.deepseek.apiKey,
      model: config.deepseek.model,
      baseUrl: config.deepseek.baseUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs,
      reasoningEffort,
      clock,
    }),
  };
}
