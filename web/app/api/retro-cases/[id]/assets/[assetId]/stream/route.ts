// GET /api/retro-cases/[id]/assets/[assetId]/stream：站内播放视频、音频，302 到新签的地址（15 分钟）。
import { getDbClient } from "@/db";
import { resolveRetroAssetUrl } from "@/lib/retro/assets";
import { lazyRetroBucket, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  return retroRoute(request, { mutation: false }, async ({ viewer }) => {
    const { id, assetId } = await context.params;
    const location = await resolveRetroAssetUrl(getDbClient(), lazyRetroBucket, { caseId: id, assetId, viewer });
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Cache-Control": "private, max-age=300, no-transform",
        "Content-Disposition": "inline",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
