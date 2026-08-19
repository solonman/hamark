import { getDbClient } from "@/db";
import { loadV04CaseCardReadModel, loadV04CaseDetailReadModel } from "@/lib/v04-read-models";
import { v04Route } from "@/lib/v04-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: false }, async () => {
    const { id } = await context.params;
    const view = new URL(request.url).searchParams.get("view");
    const model = view === "card"
      ? await loadV04CaseCardReadModel(getDbClient(), id)
      : await loadV04CaseDetailReadModel(getDbClient(), id);
    return Response.json(model);
  });
}
