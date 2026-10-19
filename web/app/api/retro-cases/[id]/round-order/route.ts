// PATCH /api/retro-cases/[id]/round-order：整体重写回合顺序（必须恰好是现有未删除回合的全部 id）。
import { getDbClient } from "@/db";
import { reorderRetroRounds } from "@/lib/retro/rounds";
import { readRetroJsonBody, retroRoute } from "@/lib/retro/route";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id } = await context.params;
    return Response.json(await reorderRetroRounds(getDbClient(), viewer, id, await readRetroJsonBody(request)));
  });
}
