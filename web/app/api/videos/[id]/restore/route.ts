import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { restoreVideo } from "@/lib/v04-video-lifecycle";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true, requireFeature: false }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as { idempotencyKey?: string };
    return Response.json(await restoreVideo(getDbClient(), id, actor, {
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
