// POST /api/retro-cases/[id]/restore：从回收站恢复案例。
import { getDbClient } from "@/db";
import { restoreRetroCase } from "@/lib/retro/cases";
import { retroRoute } from "@/lib/retro/route";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id } = await context.params;
    return Response.json(await restoreRetroCase(getDbClient(), viewer, id));
  });
}
