// POST /api/retro-cases/[id]/assets/[assetId]/upload-url：用到哪个签哪个（600 秒）；视频另带封面 PUT。
import { getDbClient } from "@/db";
import { signRetroAssetUpload } from "@/lib/retro/assets";
import { lazyRetroBucket, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id, assetId } = await context.params;
    return Response.json(await signRetroAssetUpload(getDbClient(), lazyRetroBucket, viewer, id, assetId));
  });
}
