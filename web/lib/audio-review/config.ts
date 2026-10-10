// 录音点评改写的运行配置（docs/25 4.7）。读环境变量的地方只有这一个文件；
// 判断逻辑是纯函数（显式传入 env 与是否本机演示），单测不用改 process.env。

import { isCaseReviewer } from "@/lib/case-review";
import { isLocalDemoMode } from "@/lib/local-demo";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_TENCENT_ASR_ENGINE = "16k_zh_en_2.0";

export type AudioReviewProviderKind = "real" | "fake";

export type AudioReviewConfig = {
  provider: AudioReviewProviderKind;
  /** 真实提供方的必需配置都在（fake 恒为 true）。 */
  configured: boolean;
  /** 缺了哪些变量；只给日志和管理员排查看，不展示给普通成员。 */
  missing: string[];
  deepseek: { apiKey: string; model: string; baseUrl: string };
  asr: { secretId: string; secretKey: string; engine: string };
};

type Env = Record<string, string | undefined>;

const read = (env: Env, name: string) => env[name]?.trim() || "";

/**
 * `AUDIO_REVIEW_PROVIDER=fake` 走本地假实现；本机演示模式下没写这个变量时默认就是 fake
 * （本机没有 COS，腾讯云也下载不到 localhost 上的录音）。写成其它非空值（如 `real`）一律走真实提供方。
 */
export function resolveAudioReviewProvider(env: Env, localDemo: boolean): AudioReviewProviderKind {
  const explicit = read(env, "AUDIO_REVIEW_PROVIDER").toLowerCase();
  if (explicit === "fake") return "fake";
  if (explicit) return "real";
  return localDemo ? "fake" : "real";
}

export function readAudioReviewConfig(env: Env = process.env, localDemo = isLocalDemoMode()): AudioReviewConfig {
  const provider = resolveAudioReviewProvider(env, localDemo);
  const cosSecretId = read(env, "COS_SECRET_ID");
  const cosSecretKey = read(env, "COS_SECRET_KEY");
  const asrSecretId = read(env, "TENCENT_ASR_SECRET_ID");
  const asrSecretKey = read(env, "TENCENT_ASR_SECRET_KEY");
  // 两个都配了才用专用子账号；只配一半时退回 COS 那一对，避免拼出一对不匹配的密钥。
  const useDedicatedAsr = Boolean(asrSecretId && asrSecretKey);
  const deepseek = {
    apiKey: read(env, "DEEPSEEK_API_KEY"),
    model: read(env, "DEEPSEEK_MODEL") || DEFAULT_DEEPSEEK_MODEL,
    baseUrl: (read(env, "DEEPSEEK_BASE_URL") || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, ""),
  };
  const asr = {
    secretId: useDedicatedAsr ? asrSecretId : cosSecretId,
    secretKey: useDedicatedAsr ? asrSecretKey : cosSecretKey,
    engine: read(env, "TENCENT_ASR_ENGINE") || DEFAULT_TENCENT_ASR_ENGINE,
  };
  const missing: string[] = [];
  if (provider === "real") {
    if (!deepseek.apiKey) missing.push("DEEPSEEK_API_KEY");
    for (const name of ["COS_REGION", "COS_BUCKET", "COS_SECRET_ID", "COS_SECRET_KEY"]) {
      if (!read(env, name)) missing.push(name);
    }
  }
  return { provider, configured: missing.length === 0, missing, deepseek, asr };
}

/** 入口开关（docs/25 4.7）：老孙，且（DeepSeek 密钥和 COS 齐全，或走 fake）。 */
export function isAudioReviewAvailable(displayName: string | null | undefined, config: AudioReviewConfig) {
  return isCaseReviewer(displayName) && config.configured;
}
