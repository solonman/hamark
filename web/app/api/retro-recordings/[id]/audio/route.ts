// GET /api/retro-recordings/[id]/audio：307 跳转到录音的预签名 GET（3 小时），供 <audio src> 使用。
// 被移除的录音照样能播：已发布成果里引用它的片段要能听原声。
import { getDbClient } from "@/db";
import { resolveRetroRecordingAudioUrl } from "@/lib/retro/recordings";
import { lazyRetroBucket, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: false }, async () => {
    const { id } = await context.params;
    const url = await resolveRetroRecordingAudioUrl(getDbClient(), lazyRetroBucket, id);
    // 本机演示模式下 LocalVideoBucket 给的是 /api/local-assets 地址，照样跳转。
    return new Response(null, { status: 307, headers: { Location: url, "Cache-Control": "no-store" } });
  });
}
