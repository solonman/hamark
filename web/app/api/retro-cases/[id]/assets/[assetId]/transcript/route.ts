// GET  /api/retro-cases/[id]/assets/[assetId]/transcript：客户录音的转写状态与文字稿（全员可见）。
//      在途且租约空闲时，响应发出后用 after() 推进一次（案例页可见时每 4 秒拉一次）。
// POST /api/retro-cases/[id]/assets/[assetId]/transcript：{ action: "RETRY" }，转写失败后重试（案例上传者或管理员）。
import { getDbClient } from "@/db";
import { loadRetroAssetTranscript, retryRetroAssetTranscription } from "@/lib/retro/assets";
import { retroInvalid } from "@/lib/retro/errors";
import { readRetroJsonBody, retroRoute, scheduleRetroTranscription } from "@/lib/retro/route";
import { shouldAdvanceRetroTranscription } from "@/lib/retro/transcription";

export const maxDuration = 300;

type Params = { params: Promise<{ id: string; assetId: string }> };

export async function GET(request: Request, context: Params) {
  return retroRoute(request, { mutation: false }, async ({ viewer, startedAt }) => {
    const { id, assetId } = await context.params;
    const state = await loadRetroAssetTranscript(getDbClient(), { caseId: id, assetId, viewer });
    if (shouldAdvanceRetroTranscription({ status: state.status, lease_until: state.leaseUntil }, Date.now())) {
      scheduleRetroTranscription("ASSET", assetId, "CLIENT", startedAt);
    }
    return Response.json(state.response);
  });
}

export async function POST(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ viewer, startedAt }) => {
    const { id, assetId } = await context.params;
    const body = await readRetroJsonBody(request);
    if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "RETRY") {
      throw retroInvalid("不支持的操作。");
    }
    const db = getDbClient();
    const started = await retryRetroAssetTranscription(db, viewer, id, assetId);
    if (started) scheduleRetroTranscription("ASSET", assetId, "CLIENT", startedAt);
    const state = await loadRetroAssetTranscript(db, { caseId: id, assetId, viewer });
    return Response.json(state.response);
  });
}
