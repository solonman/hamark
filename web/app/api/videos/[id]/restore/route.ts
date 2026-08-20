import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { restoreVideoWithSchemaCompatibility } from "@/lib/legacy-video-schema-compat";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true, requireFeature: false }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as { idempotencyKey?: string };
    return Response.json(await restoreVideoWithSchemaCompatibility(getDbClient(), id, actor, {
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
