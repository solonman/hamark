// 录音点评接口的统一外壳：沿用 v04Route（同源 → 登录 → 会话 → 灰度访问），业务错误翻成同一个
// 错误信封 `{ error: { code, message, requestId } }`，迁移没执行时回 503 并提示执行哪个文件。
// 所有响应 `Cache-Control: no-store`。后台推进用 after() 挂在响应之后。

import { after } from "next/server";
import { getDbClient, getVideoBucket } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { V04ServiceError } from "@/lib/v04-errors";
import type { V04Actor } from "@/lib/v04-workspace-service";
import { readAudioReviewConfig } from "./config";
import {
  AUDIO_REVIEW_MISSING_SCHEMA_MESSAGE,
  AudioReviewError,
  audioReviewErrorBody,
  isMissingAudioReviewSchema,
} from "./errors";
import { createAudioReviewProviders, defaultSleep } from "./providers";
import { AUDIO_REVIEW_DEADLINE_MS, advanceAudioReview, type AudioReviewDeps } from "./service";

export type AudioReviewRouteContext = { actor: V04Actor; requestId: string; startedAt: number };

export async function audioReviewRoute(
  request: Request,
  options: { mutation: boolean },
  operation: (context: AudioReviewRouteContext) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  const response = await v04Route(request, { mutation: options.mutation }, async (actor, requestId) => {
    try {
      return await operation({ actor, requestId, startedAt });
    } catch (error) {
      if (error instanceof AudioReviewError) {
        return Response.json(audioReviewErrorBody(error.code, error.message, requestId), { status: error.status });
      }
      if (isMissingAudioReviewSchema(error)) {
        return Response.json(
          audioReviewErrorBody("AUDIO_REVIEW_NOT_READY", AUDIO_REVIEW_MISSING_SCHEMA_MESSAGE, requestId),
          { status: 503 },
        );
      }
      if (!(error instanceof V04ServiceError)) {
        console.error("[audio-review] 接口出错", error);
      }
      throw error;
    }
  });
  try {
    response.headers.set("Cache-Control", "no-store");
  } catch {
    // 少数响应（如 Response.redirect）的头不可改；本模块的跳转自己带了 no-store。
  }
  return response;
}

/** 存储桶按需取：确认生成这类不碰存储的动作，不因为存储配置而失败。 */
export const lazyAudioReviewBucket: AudioReviewDeps["bucket"] = {
  head: (key) => getVideoBucket().head(key),
  createPresignedPutUrl: (key, options) => getVideoBucket().createPresignedPutUrl(key, options),
  createPresignedGetUrl: (key, options) => getVideoBucket().createPresignedGetUrl(key, options),
};

export function createAudioReviewDeps(config = readAudioReviewConfig()): AudioReviewDeps {
  return {
    providers: createAudioReviewProviders(config),
    bucket: lazyAudioReviewBucket,
    sleep: defaultSleep,
    clock: Date.now,
  };
}

/**
 * 响应发出后推进一次（docs/25 4.3）。deadline = 请求开始 + 280 秒，配合路由的 maxDuration = 300。
 * 推进本身不往外抛；这里再兜一层，免得配置问题在 after() 里变成未处理的异常。
 */
export function scheduleAudioReviewAdvance(reviewId: string, startedAt: number) {
  after(async () => {
    try {
      await advanceAudioReview(getDbClient(), reviewId, {
        deadline: startedAt + AUDIO_REVIEW_DEADLINE_MS,
        deps: createAudioReviewDeps(),
      });
    } catch (error) {
      console.error("[audio-review] 后台推进失败", error);
    }
  });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
