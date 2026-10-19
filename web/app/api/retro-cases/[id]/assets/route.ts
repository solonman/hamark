// POST /api/retro-cases/[id]/assets：建附件行（需求凭证 roundId 为 null，回合附件带 roundId），
// 校验类型（图片、视频、音频、文档，其它 400）和每个归属 ≤12 个。上传链接随后逐个签。
import { getDbClient } from "@/db";
import { addRetroAssets } from "@/lib/retro/assets";
import { readRetroJsonBody, retroRoute } from "@/lib/retro/route";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id } = await context.params;
    return Response.json(await addRetroAssets(getDbClient(), viewer, id, await readRetroJsonBody(request)), { status: 201 });
  });
}
