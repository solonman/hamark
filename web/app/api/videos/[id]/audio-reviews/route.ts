// POST /api/videos/[id]/audio-reviews：上传名单里的人（老孙，或替他上传的秦欣欣）给一版作业建点评任务（录音或文档，
// docs/25 二之二），拿预签名上传地址。
// 检查顺序：同源 → 登录（audioReviewRoute / v04Route）→ 上传名单 → 已配置 → 业务（docs/25 4.2 第 1 条）。

import { getDbClient } from "@/db";
import type { CreateAudioReviewResponseBody } from "@/lib/audio-review-model";
import { readAudioReviewConfig } from "@/lib/audio-review/config";
import { AudioReviewError } from "@/lib/audio-review/errors";
import { audioReviewRoute, lazyAudioReviewBucket, readJsonBody } from "@/lib/audio-review/route";
import { createAudioReview } from "@/lib/audio-review/service";
import { toAudioReviewView } from "@/lib/audio-review/view";
import { isAudioReviewUploader } from "@/lib/audio-review/access";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return audioReviewRoute(request, { mutation: true }, async ({ actor }) => {
    if (!isAudioReviewUploader(actor.displayName)) {
      throw new AudioReviewError(403, "FORBIDDEN", "只有上传名单里的人（老孙、秦欣欣）可以上传点评。");
    }
    if (!readAudioReviewConfig().configured) {
      throw new AudioReviewError(503, "AUDIO_REVIEW_NOT_CONFIGURED", "点评改写还没有配置好（缺少转写、模型或存储的密钥），请联系管理员。");
    }
    const { id } = await context.params;
    const body = await readJsonBody(request);
    const { row, uploadUrl } = await createAudioReview(
      getDbClient(),
      actor,
      { videoId: id, body },
      { bucket: lazyAudioReviewBucket },
    );
    const response: CreateAudioReviewResponseBody = {
      review: toAudioReviewView(row, { viewerDisplayName: actor.displayName }),
      uploadUrl,
    };
    return Response.json(response, { status: 201 });
  });
}
