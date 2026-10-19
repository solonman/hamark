// 月度整理的运行配置（docs/26 十一）。读环境变量的地方只有这一个文件；判断逻辑是纯函数
// （显式传入 env 与是否本机演示），单测不用改 process.env。DeepSeek 的变量与录音点评共用。

import { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL } from "@/lib/audio-review/config";
import { isLocalDemoMode } from "@/lib/local-demo";

export type RetroAiProviderKind = "real" | "fake";

export type RetroAiConfig = {
  provider: RetroAiProviderKind;
  /** 真实提供方的必需配置都在（fake 恒为 true）。 */
  configured: boolean;
  missing: string[];
  deepseek: { apiKey: string; model: string; baseUrl: string };
  /** 接力令牌的密钥；null = 不接力（只靠月份页 GET 兜底推进）。 */
  relaySecret: string | null;
};

type Env = Record<string, string | undefined>;

const read = (env: Env, name: string) => env[name]?.trim() || "";

/** 本机演示模式下没配 RETRO_RELAY_SECRET 时用的固定密钥。只在本机演示模式下生效，线上绝不会用到。 */
export const RETRO_RELAY_DEV_SECRET = "retro-relay-local-demo-only-not-a-secret";

/** `RETRO_AI_PROVIDER=fake` 走本地假实现；本机演示模式下没写这个变量时默认就是 fake。写成其它非空值一律走真实提供方。 */
export function resolveRetroAiProvider(env: Env, localDemo: boolean): RetroAiProviderKind {
  const explicit = read(env, "RETRO_AI_PROVIDER").toLowerCase();
  if (explicit === "fake") return "fake";
  if (explicit) return "real";
  return localDemo ? "fake" : "real";
}

export function resolveRetroRelaySecret(env: Env, localDemo: boolean): string | null {
  const secret = read(env, "RETRO_RELAY_SECRET");
  if (secret) return secret;
  return localDemo ? RETRO_RELAY_DEV_SECRET : null;
}

export function readRetroAiConfig(env: Env = process.env, localDemo = isLocalDemoMode()): RetroAiConfig {
  const provider = resolveRetroAiProvider(env, localDemo);
  const deepseek = {
    apiKey: read(env, "DEEPSEEK_API_KEY"),
    model: read(env, "DEEPSEEK_MODEL") || DEFAULT_DEEPSEEK_MODEL,
    baseUrl: (read(env, "DEEPSEEK_BASE_URL") || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, ""),
  };
  const missing: string[] = [];
  if (provider === "real" && !deepseek.apiKey) missing.push("DEEPSEEK_API_KEY");
  return { provider, configured: missing.length === 0, missing, deepseek, relaySecret: resolveRetroRelaySecret(env, localDemo) };
}
