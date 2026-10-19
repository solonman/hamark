// PUT /api/retro-cases/[id]/rounds/[roundId]/links：整体写回这一回合的关联作品（≤6）。
import { getDbClient } from "@/db";
import { putRetroRoundLinks } from "@/lib/retro/rounds";
import { lazyRetroBucket, readRetroJsonBody, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function PUT(request: Request, context: { params: Promise<{ id: string; roundId: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id, roundId } = await context.params;
    const links = await putRetroRoundLinks(getDbClient(), lazyRetroBucket, viewer, id, roundId, await readRetroJsonBody(request));
    return Response.json({ links });
  });
}
