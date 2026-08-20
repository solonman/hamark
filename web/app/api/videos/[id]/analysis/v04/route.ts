import { getDbClient } from "@/db";
import { loadV04CaseCardReadModel, loadV04CaseDetailReadModel } from "@/lib/v04-read-models";
import { v04Route } from "@/lib/v04-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await v04Route(request, { mutation: false }, async (actor) => {
    const { id } = await context.params;
    const view = new URL(request.url).searchParams.get("view");
    const viewer = { actor, tabToken: request.headers.get("x-v04-tab-token") };
    const model = view === "card"
      ? await loadV04CaseCardReadModel(getDbClient(), id, viewer)
      : await loadV04CaseDetailReadModel(getDbClient(), id, viewer);
    return Response.json(model);
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
