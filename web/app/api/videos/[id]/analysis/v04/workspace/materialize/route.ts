import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { materializeV04Workspace } from "@/lib/v04-workspace-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const result = await materializeV04Workspace(getDbClient(), id, actor);
    return Response.json(result, { status: result.created ? 201 : 200 });
  });
}
