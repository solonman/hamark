import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser } from "@/lib/current-user";
import { isVisualFeatureEnabled } from "@/lib/visual-contract";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { resolveVisualAssetOriginalUrl } from "@/lib/visual-server";

// 「查看原图」时才签名：302 跳过去，链接写在页面上不会过期（3 小时）。
// HEIC 在打不开它的浏览器里会直接下载——那是浏览器按 content-type 的原生行为，
// 这里只管把请求转到真实对象，不做额外处理。
export async function GET(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id, assetId } = await context.params;
  try {
    const location = await resolveVisualAssetOriginalUrl(getDbClient(), {
      caseId: id,
      assetId,
      viewer: { userId: user.id, identityKey: user.identityKey, isAdmin: await isAppAdmin(user) },
    });
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
  } catch (error) {
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "图片不存在。" },
      { status },
    );
  }
}
