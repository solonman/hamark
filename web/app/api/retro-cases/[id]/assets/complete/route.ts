// POST /api/retro-cases/[id]/assets/complete：用 head() 核对刚传上去的附件，缺的列在 missing 里（200）。
// 之后在响应发出后：图片派生图（ci 模式）、客户录音转写各推进一次。
import { getDbClient } from "@/db";
import { completeRetroAssets } from "@/lib/retro/assets";
import {
  lazyRetroBucket,
  readRetroJsonBody,
  retroRoute,
  scheduleRetroDerivativesForCase,
  scheduleRetroTranscription,
} from "@/lib/retro/route";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer, startedAt }) => {
    const { id } = await context.params;
    const db = getDbClient();
    const outcome = await completeRetroAssets(db, lazyRetroBucket, viewer, id, await readRetroJsonBody(request));
    if (outcome.hasPendingImages) scheduleRetroDerivativesForCase(db, id);
    for (const assetId of outcome.transcribingAssetIds) scheduleRetroTranscription("ASSET", assetId, "CLIENT", startedAt);
    return Response.json({ missing: outcome.missing });
  });
}
