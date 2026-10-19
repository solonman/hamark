// 客户需求复盘库接口的统一外壳：同源 → 登录（沿用 v04Route 的会话校验，不要求 V0.4 灰度）→ 开关 → 业务。
// 业务错误翻成与录音点评相同的错误信封 `{ error: { code, message, requestId } }`；
// 迁移没执行回 503 并提示执行哪个文件；开关关着回 404。所有响应 `Cache-Control: no-store`。
// 后台推进（转写、图片派生图）用 after() 挂在响应之后。

import { after } from "next/server";
import { getDbClient, getVideoBucket, type DbClient } from "@/db";
import { defaultSleep } from "@/lib/audio-review/providers";
import { isRetroFeatureEnabled } from "@/lib/retro-model";
import { v04Route } from "@/lib/v04-api";
import { V04ServiceError } from "@/lib/v04-errors";
import type { V04Actor } from "@/lib/v04-workspace-service";
import type { VideoBucket } from "@/storage/types";
import { loadRetroViewer, type RetroViewer } from "./access";
import { createRetroAsrProvider, type RetroAsrKind } from "./asr";
import { isRetroDerivativeCiMode, runRetroDerivativesForCase, runStaleRetroDerivatives } from "./derivatives";
import {
  RETRO_MISSING_SCHEMA_MESSAGE,
  RetroError,
  isMissingRetroSchema,
  retroErrorBody,
} from "./errors";
import { retroStorageFailure } from "./storage-failure";
import {
  RETRO_TRANSCRIBE_DEADLINE_MS,
  advanceRetroTranscription,
  listAdvanceableRetroTranscriptions,
  type RetroTranscribeDeps,
  type RetroTranscribeTarget,
} from "./transcription";

export type RetroRouteContext = { actor: V04Actor; viewer: RetroViewer; requestId: string; startedAt: number };

export function retroFeatureDisabledBody(requestId: string) {
  return retroErrorBody("RETRO_DISABLED", "客户需求复盘库尚未开放。", requestId);
}

export async function retroRoute(
  request: Request,
  options: { mutation: boolean },
  operation: (context: RetroRouteContext) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  const response = await v04Route(request, { mutation: options.mutation, requireFeature: false }, async (actor, requestId) => {
    if (!isRetroFeatureEnabled()) return Response.json(retroFeatureDisabledBody(requestId), { status: 404 });
    try {
      return await operation({ actor, viewer: await loadRetroViewer(actor), requestId, startedAt });
    } catch (error) {
      if (error instanceof RetroError) {
        return Response.json(retroErrorBody(error.code, error.message, requestId), { status: error.status });
      }
      if (isMissingRetroSchema(error)) {
        return Response.json(retroErrorBody("RETRO_NOT_READY", RETRO_MISSING_SCHEMA_MESSAGE, requestId), { status: 503 });
      }
      const storage = retroStorageFailure("route", error);
      if (storage) return Response.json(retroErrorBody(storage.code, storage.message, requestId), { status: storage.status });
      if (!(error instanceof V04ServiceError)) console.error("[retro] 接口出错", error);
      throw error;
    }
  });
  try {
    response.headers.set("Cache-Control", "no-store");
  } catch {
    // 少数响应（如 Response.redirect）的头不可改；跳转路由自己带了缓存头。
  }
  return response;
}

export async function readRetroJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 存储桶按需取：不碰存储的动作，不因为存储配置而失败。 */
export const lazyRetroBucket: Pick<VideoBucket, "head" | "delete" | "createPresignedPutUrl" | "createPresignedGetUrl"> = {
  head: (key) => getVideoBucket().head(key),
  delete: (key) => getVideoBucket().delete(key),
  createPresignedPutUrl: (key, options) => getVideoBucket().createPresignedPutUrl(key, options),
  createPresignedGetUrl: (key, options) => getVideoBucket().createPresignedGetUrl(key, options),
};

export function createRetroTranscribeDeps(): RetroTranscribeDeps {
  return { asr: createRetroAsrProvider(), bucket: lazyRetroBucket, sleep: defaultSleep, clock: Date.now };
}

/**
 * 响应发出后推进一次转写。deadline = 请求开始 + 280 秒，配合路由的 maxDuration = 300。
 * 推进本身不往外抛；这里再兜一层，免得配置问题在 after() 里变成未处理的异常。
 */
export function scheduleRetroTranscription(target: RetroTranscribeTarget, id: string, kind: RetroAsrKind, startedAt: number) {
  after(async () => {
    try {
      await advanceRetroTranscription(getDbClient(), target, id, {
        deadline: startedAt + RETRO_TRANSCRIBE_DEADLINE_MS,
        deps: createRetroTranscribeDeps(),
        kind,
      });
    } catch (error) {
      console.error("[retro] 转写后台推进失败", error);
    }
  });
}

/** 详情、库首页 GET 的兜底：把在途且租约空闲的转写都顺手推进一次。 */
export async function scheduleInFlightRetroTranscriptions(db: DbClient, startedAt: number, options: { caseId?: string } = {}) {
  try {
    for (const item of await listAdvanceableRetroTranscriptions(db, options)) {
      scheduleRetroTranscription(item.target, item.id, item.kind, startedAt);
    }
  } catch (error) {
    console.error("[retro] 查找待推进的转写失败", error);
  }
}

/** 图片派生图（只在 ci 模式；script 模式靠 npm run retro:derivatives:local 离线跑）。 */
export function scheduleRetroDerivativesForCase(db: DbClient, caseId: string) {
  if (isRetroDerivativeCiMode()) after(() => runRetroDerivativesForCase(db, caseId));
}

export function scheduleStaleRetroDerivatives(db: DbClient, options: { caseId?: string } = {}) {
  if (isRetroDerivativeCiMode()) after(() => runStaleRetroDerivatives(db, options));
}
