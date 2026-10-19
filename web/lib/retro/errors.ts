// 客户需求复盘库接口的业务错误与「迁移没执行」识别。路由把它们翻成与录音点评相同的错误信封
// `{ error: { code, message, requestId } }`（docs/26 九）。

export class RetroError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetroError";
  }
}

export const RETRO_MISSING_SCHEMA_MESSAGE =
  "客户需求复盘库的数据表尚未建立：请先在 Supabase 执行 web/db/migrations/2026-10-19-retro-library.sql";

/** 400：请求本身有问题（校验不过），message 是写给人看的中文原因。 */
export function retroInvalid(message: string) {
  return new RetroError(400, "INVALID_INPUT", message);
}

export function retroForbidden(message: string) {
  return new RetroError(403, "FORBIDDEN", message);
}

export function retroNotFound(message: string) {
  return new RetroError(404, "NOT_FOUND", message);
}

export function retroConflict(code: string, message: string) {
  return new RetroError(409, code, message);
}

/**
 * 迁移没执行时：retro_* 表不存在（Postgres 42P01，消息里带关系名）。
 * 只认以 retro_ 开头的关系名，别的表缺了不算（参照 lib/audio-review/errors.ts）。
 */
export function isMissingRetroSchema(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code !== "42P01") return false;
  const message = String((error as { message?: unknown }).message ?? "");
  return /relation "(?:[A-Za-z0-9_]+\.)?retro_[A-Za-z0-9_]*"/.test(message);
}

export function retroErrorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

/** Postgres 唯一约束冲突（23505）。 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
