import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { loadV04HistoryReadModel } from "@/lib/v04-read-models";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: false }, async () => {
    const { id } = await context.params;
    return Response.json(await loadV04HistoryReadModel(getDbClient(), id));
  });
}
