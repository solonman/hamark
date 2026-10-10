// GET /api/videos/[id]/audio-reviews/[reviewId]/audio：307 跳转到录音的预签名 GET（3 小时），
// 供 <audio src> 使用。可见性同任务详情：老孙任何状态；其他人只有已生成的（docs/25 4.2 第 4 条）。
// 检查顺序：登录（audioReviewRoute / v04Route）→ 可见性 → 业务。

import { getDbClient } from "@/db";
import { audioReviewRoute, lazyAudioReviewBucket } from "@/lib/audio-review/route";
import { AUDIO_REVIEW_AUDIO_URL_TTL_SECONDS, loadAudioReviewForViewer } from "@/lib/audio-review/service";

export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string; reviewId: string }> }) {
  return audioReviewRoute(request, { mutation: false }, async ({ actor }) => {
    const { id, reviewId } = await context.params;
    const row = await loadAudioReviewForViewer(getDbClient(), actor, id, reviewId);
    // 本机演示模式下 LocalVideoBucket 给的是 /api/local-assets 地址，照样跳转。
    const url = await lazyAudioReviewBucket.createPresignedGetUrl(row.audio_object_key, {
      expiresInSeconds: AUDIO_REVIEW_AUDIO_URL_TTL_SECONDS,
    });
    return new Response(null, { status: 307, headers: { Location: url, "Cache-Control": "no-store" } });
  });
}
