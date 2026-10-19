// POST /api/retro-cases/[id]/rounds：新增回合（接在最后，默认标题「第 N 版」，最多 20 个）。
import { getDbClient } from "@/db";
import { addRetroRound } from "@/lib/retro/rounds";
import { readRetroJsonBody, retroRoute } from "@/lib/retro/route";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id } = await context.params;
    const round = await addRetroRound(getDbClient(), viewer, id, await readRetroJsonBody(request));
    return Response.json({ round }, { status: 201 });
  });
}
