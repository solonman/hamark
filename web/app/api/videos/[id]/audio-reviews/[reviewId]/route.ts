// GET  /api/videos/[id]/audio-reviews/[reviewId]：任务详情（老孙看任何状态；其他人只看已生成的，否则 404）。
//      在途且租约空闲时，响应发出后用 after() 推进一次。
// POST /api/videos/[id]/audio-reviews/[reviewId]：{ action: UPLOADED | RETRY | ABANDON | CONFIRM }，只有老孙能调。
// 检查顺序：同源 → 登录（audioReviewRoute / v04Route）→ 老孙 → 业务（docs/25 4.2 第 2、3 条）。

import { getDbClient } from "@/db";
import type { AudioReviewActionResponseBody } from "@/lib/audio-review-model";
import { AudioReviewError } from "@/lib/audio-review/errors";
import {
  audioReviewRoute,
  lazyAudioReviewBucket,
  readJsonBody,
  scheduleAudioReviewAdvance,
} from "@/lib/audio-review/route";
import {
  loadAudioReviewForViewer,
  runAudioReviewAction,
  shouldAdvanceAudioReview,
} from "@/lib/audio-review/service";
import { toAudioReviewView } from "@/lib/audio-review/view";
import { isCaseReviewer } from "@/lib/case-review";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string; reviewId: string }> };

export async function GET(request: Request, context: Params) {
  return audioReviewRoute(request, { mutation: false }, async ({ actor, startedAt }) => {
    const { id, reviewId } = await context.params;
    const row = await loadAudioReviewForViewer(getDbClient(), actor, id, reviewId);
    if (shouldAdvanceAudioReview(row, Date.now())) scheduleAudioReviewAdvance(row.id, startedAt);
    return Response.json({ review: toAudioReviewView(row, { viewerDisplayName: actor.displayName }) });
  });
}

export async function POST(request: Request, context: Params) {
  return audioReviewRoute(request, { mutation: true }, async ({ actor, startedAt }) => {
    if (!isCaseReviewer(actor.displayName)) {
      throw new AudioReviewError(403, "FORBIDDEN", "只有老孙可以处理点评录音。");
    }
    const { id, reviewId } = await context.params;
    const body = await readJsonBody(request);
    const result = await runAudioReviewAction(
      getDbClient(),
      actor,
      { videoId: id, reviewId, body },
      { bucket: lazyAudioReviewBucket },
    );
    if (result.advance) scheduleAudioReviewAdvance(result.row.id, startedAt);
    const response: AudioReviewActionResponseBody = {
      review: toAudioReviewView(result.row, { viewerDisplayName: actor.displayName }),
      ...(result.reviewVersionId ? { reviewVersionId: result.reviewVersionId } : {}),
    };
    return Response.json(response);
  });
}
