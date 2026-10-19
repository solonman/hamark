// /api/retro-months/** 的公共部分：开关关闭时的 404、错误翻译（业务错误、迁移没执行回 503）、
// 身份换算、后台推进与接力的调度。每个路由自己按「开关 → 同源 → 登录 → 老孙 → 业务」写检查顺序
// （同公共视觉库，tests/retro-month-routes.test.ts 读源码断言）。

import { after } from "next/server";
import { getDbClient } from "@/db";
import type { CurrentUser } from "@/lib/current-user";
import { isRetroMonthKey } from "@/lib/retro-model";
import { readRetroAiConfig, type RetroAiConfig } from "./month-config";
import { isMissingRetroSchema, RETRO_MISSING_SCHEMA_MESSAGE, RetroMonthError } from "./month-errors";
import { createRetroLlmProvider } from "./month-providers";
import { advanceAndRelay } from "./month-relay";
import { RETRO_MONTH_DEADLINE_MS, type RetroMonthActor, type RetroMonthDeps } from "./month-service";

export function retroFeatureDisabledResponse() {
  return Response.json({ error: "客户需求复盘库建设中。", code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function retroMonthErrorResponse(error: RetroMonthError) {
  return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
}

/** 业务代码的外壳：翻译错误、加 no-store。 */
export async function retroMonthHandle(operation: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try {
    response = await operation();
  } catch (error) {
    if (error instanceof RetroMonthError) return retroMonthErrorResponse(error);
    if (isMissingRetroSchema(error)) {
      return Response.json({ error: RETRO_MISSING_SCHEMA_MESSAGE, code: "RETRO_NOT_READY" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[retro-month] 接口出错", error);
    return Response.json({ error: "服务暂时出错，请稍后重试。", code: "INTERNAL" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  try {
    response.headers.set("Cache-Control", "no-store");
  } catch {
    // 个别响应的头不可改。
  }
  return response;
}

export function requireRetroMonthKey(value: string): string {
  if (!isRetroMonthKey(value)) throw new RetroMonthError(404, "NOT_FOUND", "月份格式不对。");
  return value;
}

export function retroMonthActor(user: CurrentUser): RetroMonthActor {
  return { userId: user.id, displayName: user.displayName, identityKey: user.identityKey, email: user.email };
}

export async function readRetroJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function createRetroMonthDeps(config: RetroAiConfig = readRetroAiConfig()): RetroMonthDeps {
  return { llm: createRetroLlmProvider(config), clock: Date.now };
}

/**
 * 响应发出后推进一次（规格 6.3），deadline = 请求开始 + 280 秒，配合路由的 maxDuration = 300；
 * 任务还在途就向自己的 advance 接口接力。同源绝对地址从请求推出。
 */
export function scheduleRetroMonthAdvance(input: { request: Request; monthKey: string; jobId: string; startedAt: number }) {
  const origin = (() => {
    try {
      return new URL(input.request.url).origin;
    } catch {
      return null;
    }
  })();
  after(async () => {
    try {
      const config = readRetroAiConfig();
      await advanceAndRelay(getDbClient(), {
        jobId: input.jobId,
        monthKey: input.monthKey,
        deadline: input.startedAt + RETRO_MONTH_DEADLINE_MS,
        origin,
        secret: config.relaySecret,
        deps: createRetroMonthDeps(config),
      });
    } catch (error) {
      console.error("[retro-month] 后台推进失败", error);
    }
  });
}
