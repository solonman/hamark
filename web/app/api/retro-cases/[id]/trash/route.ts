// POST /api/retro-cases/[id]/trash：删除案例（软删除，进回收站，可以恢复；文件不清理）。
import { getDbClient } from "@/db";
import { trashRetroCase } from "@/lib/retro/cases";
import { retroRoute } from "@/lib/retro/route";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id } = await context.params;
    return Response.json(await trashRetroCase(getDbClient(), viewer, id));
  });
}
