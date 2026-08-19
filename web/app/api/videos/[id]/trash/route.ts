import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { trashVideo } from "@/lib/v04-video-lifecycle";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true, requireFeature: false }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as { reason?: string; idempotencyKey?: string };
    return Response.json(await trashVideo(getDbClient(), id, actor, {
      reason: body.reason?.trim() || "用户移入回收站",
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
