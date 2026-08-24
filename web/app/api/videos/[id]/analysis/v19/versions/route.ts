import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { createV19VersionFrom } from "@/lib/v19-version-chain";
import type { V19CreateVersionRequestBody } from "@/lib/v19-ui-model";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as V19CreateVersionRequestBody;
    const result = await createV19VersionFrom(getDbClient(), actor, {
      videoId: id,
      baseVersionId: body.baseVersionId ?? "",
    });
    return Response.json(result, { status: 201 });
  });
}
