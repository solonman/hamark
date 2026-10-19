// PATCH  /api/retro-cases/[id]/rounds/[roundId]：改回合（revision 乐观锁，对不上回 409）。
// DELETE /api/retro-cases/[id]/rounds/[roundId]：软删回合（已发布成果里的「第 N 版」标记仍能找到它）。
import { getDbClient } from "@/db";
import { deleteRetroRound, patchRetroRound } from "@/lib/retro/rounds";
import { readRetroJsonBody, retroRoute } from "@/lib/retro/route";

type Params = { params: Promise<{ id: string; roundId: string }> };

export async function PATCH(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id, roundId } = await context.params;
    return Response.json(await patchRetroRound(getDbClient(), viewer, id, roundId, await readRetroJsonBody(request)));
  });
}

export async function DELETE(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id, roundId } = await context.params;
    return Response.json(await deleteRetroRound(getDbClient(), viewer, id, roundId));
  });
}
