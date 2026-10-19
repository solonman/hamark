// /api/retro-months/** 在共用外壳 lib/retro/route.ts（同源 → 登录 → 开关 → 业务、错误信封、503、no-store）
// 之外需要的部分：月份参数、模型提供方、后台推进与接力的调度。

import { after } from "next/server";
import { getDbClient } from "@/db";
import { isRetroMonthKey } from "@/lib/retro-model";
import { retroForbidden, retroNotFound } from "./errors";
import { isLocalDemoMode } from "@/lib/local-demo";
import { readRetroAiConfig, resolveRetroRelayOrigin, type RetroAiConfig } from "./month-config";
import { createRetroLlmProvider } from "./month-providers";
import { advanceAndRelay } from "./month-relay";
import { RETRO_MONTH_DEADLINE_MS, RETRO_REVIEWER_ONLY, type RetroMonthDeps } from "./month-service";

export function requireRetroMonthKey(value: string): string {
  if (!isRetroMonthKey(value)) throw retroNotFound("月份格式不对。");
  return value;
}

/** 生成、审阅、发布类接口：只有老孙（服务层还会再查一次）。 */
export function requireRetroReviewer(viewer: { isReviewer: boolean }) {
  if (!viewer.isReviewer) throw retroForbidden(RETRO_REVIEWER_ONLY);
}

export function createRetroMonthDeps(config: RetroAiConfig = readRetroAiConfig()): RetroMonthDeps {
  return { llm: createRetroLlmProvider(config), clock: Date.now };
}

/**
 * 响应发出后推进一次（规格 6.3），deadline = 请求开始 + 280 秒，配合路由的 maxDuration = 300；
 * 任务还在途就向自己的 advance 接口接力。地址取 APP_URL / VERCEL_URL，本机演示模式才用请求自己的 origin。
 */
export function scheduleRetroMonthAdvance(input: { request: Request; monthKey: string; jobId: string; startedAt: number }) {
  const origin = resolveRetroRelayOrigin(process.env, isLocalDemoMode(), input.request.url);
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
