// GET /api/retro-cases/[id]/assets/[assetId]/original：图片原图、PDF（内联，新标签页打开）、
// Word／Excel／PPT（以附件下载）。只对能看这个案例的人放行，302 到新签的地址。
import { getDbClient } from "@/db";
import { resolveRetroAssetUrl } from "@/lib/retro/assets";
import { lazyRetroBucket, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  return retroRoute(request, { mutation: false }, async ({ viewer }) => {
    const { id, assetId } = await context.params;
    const location = await resolveRetroAssetUrl(getDbClient(), lazyRetroBucket, { caseId: id, assetId, viewer, mode: "original" });
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Cache-Control": "private, max-age=300, no-transform",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
