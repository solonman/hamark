// 录音点评接口的业务错误与「迁移没执行」识别。路由把它们翻成与 v04Route 相同的错误信封
// `{ error: { code, message, requestId } }`。

export class AudioReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AudioReviewError";
  }
}

export const AUDIO_REVIEW_MISSING_SCHEMA_MESSAGE =
  "录音点评的数据表尚未建立：请先在 Supabase 执行 web/db/migrations/2026-10-10-audio-review.sql";

/**
 * 迁移没执行时的两种报错：audio_reviews 表不存在（42P01），或 analysis_versions 上还没有
 * version_kind / audio_review_id 列（42703）。参照 lib/agent-api/tokens.ts 的 isMissingTokenTable。
 */
export function isMissingAudioReviewSchema(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");
  if (code === "42P01") return message.includes("audio_reviews");
  if (code === "42703") return message.includes("version_kind") || message.includes("audio_review_id");
  return false;
}

export function audioReviewErrorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}
