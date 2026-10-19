// 月度整理的运行配置（docs/26 十一）。读环境变量的地方只有这一个文件；判断逻辑是纯函数
// （显式传入 env 与是否本机演示），单测不用改 process.env。DeepSeek 的变量与录音点评共用。

import { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL } from "@/lib/audio-review/config";
import { isLocalDemoMode } from "@/lib/local-demo";
import type { RetroAiProviderKind } from "./asr";
import { RetroError } from "./errors";

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

export type { RetroAiProviderKind };

/**
 * 模型提供方（审查意见 7）：假实现只在本机演示模式下可用——生产上就算写了 RETRO_AI_PROVIDER=fake 也忽略，
 * 防止假内容被当成老孙的方法发布。本机演示模式下默认 fake，写 RETRO_AI_PROVIDER=real（或其它非 fake 的值）才走真实。
 */
export function resolveRetroLlmProvider(env: Env, localDemo: boolean): RetroAiProviderKind {
  if (!localDemo) return "real";
  const explicit = read(env, "RETRO_AI_PROVIDER").toLowerCase();
  return explicit && explicit !== "fake" ? "real" : "fake";
}

/**
 * 接力请求发往的同源地址（审查意见 6）：不从请求头推（Host 可被伪造）。优先 APP_URL，其次 https://VERCEL_URL；
 * 只有本机演示模式才退回请求自己的 origin。都没有时返回 null（不接力，靠月份页 GET 兜底）。
 */
export function resolveRetroRelayOrigin(env: Env, localDemo: boolean, requestUrl: string | null): string | null {
  const parse = (value: string) => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const appUrl = read(env, "APP_URL");
  if (appUrl && parse(appUrl)) return parse(appUrl);
  const vercel = read(env, "VERCEL_URL");
  if (vercel) return parse(`https://${vercel.replace(/^https?:\/\//, "")}`);
  return localDemo && requestUrl ? parse(requestUrl) : null;
}

/** 生产没配 RETRO_RELAY_SECRET 时，发起整理接口回 503 的文案（审查意见 3）。 */
export const RETRO_RELAY_SECRET_MISSING_MESSAGE = "还没有配置 RETRO_RELAY_SECRET：整理需要它在后台接着跑，请先在 Vercel 配置。";

export function resolveRetroRelaySecret(env: Env, localDemo: boolean): string | null {
  const secret = read(env, "RETRO_RELAY_SECRET");
  if (secret) return secret;
  return localDemo ? RETRO_RELAY_DEV_SECRET : null;
}

export function readRetroAiConfig(env: Env = process.env, localDemo = isLocalDemoMode()): RetroAiConfig {
  const provider = resolveRetroLlmProvider(env, localDemo);
  const deepseek = {
    apiKey: read(env, "DEEPSEEK_API_KEY"),
    model: read(env, "DEEPSEEK_MODEL") || DEFAULT_DEEPSEEK_MODEL,
    baseUrl: (read(env, "DEEPSEEK_BASE_URL") || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, ""),
  };
  const missing: string[] = [];
  if (provider === "real" && !deepseek.apiKey) missing.push("DEEPSEEK_API_KEY");
  const relaySecret = resolveRetroRelaySecret(env, localDemo);
  // 生产没有接力密钥，任务只能等有人打开月份页才往前走：算作没配好（本机演示模式有固定的开发密钥）。
  if (!relaySecret) missing.push("RETRO_RELAY_SECRET");
  return { provider, configured: missing.length === 0, missing, deepseek, relaySecret };
}

/** 发起整理（GENERATE / REVISE_PUBLISHED）前的配置检查：缺接力密钥回 503；GENERATE 另要模型密钥。 */
export function requireRetroMonthConfigured(config: RetroAiConfig, mode: unknown) {
  if (config.missing.includes("RETRO_RELAY_SECRET")) throw new RetroError(503, "RETRO_RELAY_NOT_CONFIGURED", RETRO_RELAY_SECRET_MISSING_MESSAGE);
  if (mode === "GENERATE" && !config.configured) {
    throw new RetroError(503, "RETRO_AI_NOT_CONFIGURED", "月度整理还没有配置好（缺少模型密钥），请联系管理员。");
  }
}
