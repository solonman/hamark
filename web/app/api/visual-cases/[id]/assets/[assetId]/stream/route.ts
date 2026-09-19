import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser } from "@/lib/current-user";
import { isVisualFeatureEnabled } from "@/lib/visual-contract";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { resolveVisualAssetStreamUrl } from "@/lib/visual-server";

// 视频站内播放：只对能看这条案例的人放行，302 到新签的地址（15 分钟），
// 同 app/api/videos/[id]/stream/route.ts 的做法。
export async function GET(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id, assetId } = await context.params;
  try {
    const location = await resolveVisualAssetStreamUrl(getDbClient(), {
      caseId: id,
      assetId,
      viewer: { userId: user.id, identityKey: user.identityKey, isAdmin: await isAppAdmin(user) },
    });
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
  } catch (error) {
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "视频不存在或尚未准备好。" },
      { status },
    );
  }
}
