import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { loadV04HistoryReadModel } from "@/lib/v04-read-models";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await v04Route(request, { mutation: false }, async (actor) => {
    const { id } = await context.params;
    return Response.json(await loadV04HistoryReadModel(getDbClient(), id, {
      actor,
      tabToken: request.headers.get("x-v04-tab-token"),
    }));
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
