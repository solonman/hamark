// GET   /api/retro-cases/[id]：案例详情（回合、附件签名缩略图、关联作品、点评录音含文字稿、在本月纪要里、viewerCapabilities）。
// PATCH /api/retro-cases/[id]：按字段改基本信息与收尾，带 revision 乐观锁，对不上回 409。
import { getDbClient } from "@/db";
import { loadRetroCaseDetail, patchRetroCase } from "@/lib/retro/cases";
import { retroNotFound } from "@/lib/retro/errors";
import { failStaleRetroRecordingUploads, withReviewerRemoval } from "@/lib/retro/recordings";
import {
  lazyRetroBucket,
  readRetroJsonBody,
  retroRoute,
  scheduleInFlightRetroTranscriptions,
  scheduleStaleRetroDerivatives,
} from "@/lib/retro/route";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Params) {
  return retroRoute(request, { mutation: false }, async ({ viewer, startedAt }) => {
    const { id } = await context.params;
    const db = getDbClient();
    await failStaleRetroRecordingUploads(db, { caseId: id });
    const detail = await loadRetroCaseDetail(db, lazyRetroBucket, id, viewer);
    if (!detail) throw retroNotFound("案例不存在或已进入回收站。");
    detail.recordings = withReviewerRemoval(detail.recordings, viewer);
    await scheduleInFlightRetroTranscriptions(db, startedAt, { caseId: id });
    scheduleStaleRetroDerivatives(db, { caseId: id });
    return Response.json({ case: detail });
  });
}

export async function PATCH(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id } = await context.params;
    return Response.json(await patchRetroCase(getDbClient(), viewer, id, await readRetroJsonBody(request)));
  });
}
