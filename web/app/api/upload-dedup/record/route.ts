// POST /api/upload-dedup/record：上传入库后登记这份文件的指纹（docs/28 五）。
// 只有该行的上传人能登记；登记失败不影响上传本身，前端也不等它。
import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { parseUploadRecordInput } from "@/lib/upload-dedup/model";
import { recordUploadFingerprint } from "@/lib/upload-dedup/server";

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const input = parseUploadRecordInput(await request.json().catch(() => null));
  if (!input) return Response.json({ error: "指纹参数不完整。" }, { status: 400 });
  try {
    const result = await recordUploadFingerprint(getDbClient(), input, user);
    if (result.reason === "NOT_FOUND") return Response.json({ error: "找不到这份上传。" }, { status: 404 });
    if (result.reason === "FORBIDDEN") return Response.json({ error: "只有上传人能登记这份文件的指纹。" }, { status: 403 });
    return Response.json(result);
  } catch (error) {
    console.error("[upload-dedup] record failed", error);
    return Response.json({ error: "登记指纹失败。" }, { status: 500 });
  }
}
