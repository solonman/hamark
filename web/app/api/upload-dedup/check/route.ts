// POST /api/upload-dedup/check：选好文件后比对是否已传过（docs/28 五）。
// 只提醒、不拦截，所以这里出任何错都回「没发现」，不让查重挡住上传。
import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { parseUploadCheckInput } from "@/lib/upload-dedup/model";
import { checkUploadDuplicates } from "@/lib/upload-dedup/server";

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const input = parseUploadCheckInput(await request.json().catch(() => null));
  if (!input) return Response.json({ error: "查重参数不完整。" }, { status: 400 });
  try {
    const results = await checkUploadDuplicates(getDbClient(), input);
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[upload-dedup] check failed", error);
    return Response.json({ results: {}, degraded: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
