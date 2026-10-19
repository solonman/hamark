// 月度整理（/api/retro-months/**）的业务错误与「迁移没执行」识别。
// 最小实现：合并时与案例那边（lib/retro/errors.ts）统一成一份。

export class RetroMonthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetroMonthError";
  }
}

export const RETRO_MISSING_SCHEMA_MESSAGE =
  "客户需求复盘库的数据表尚未建立：请先在 Supabase 执行 web/db/migrations/2026-10-19-retro-library.sql";

/** retro_* 表不存在（42P01）或缺列（42703）：迁移没执行。 */
export function isMissingRetroSchema(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");
  if (code === "42P01" || code === "42703") return message.includes("retro_") || message.includes("draft_revision") || message.includes("case_ids_json");
  return false;
}

export const retroMonthForbidden = (message = "只有老孙可以生成、审阅和发布本月纪要。") =>
  new RetroMonthError(403, "FORBIDDEN", message);

export const retroMonthNotFound = (message = "整理任务不存在。") => new RetroMonthError(404, "NOT_FOUND", message);

export const retroMonthConflict = (message: string, code = "INVALID_STATE") => new RetroMonthError(409, code, message);

export const retroMonthBadRequest = (message: string, code = "INVALID_INPUT") => new RetroMonthError(400, code, message);
