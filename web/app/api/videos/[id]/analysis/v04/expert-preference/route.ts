import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { withdrawV04ExpertPreference } from "@/lib/v04-workspace-service";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as { reason?: string; idempotencyKey?: string };
    return Response.json(await withdrawV04ExpertPreference(getDbClient(), id, actor, {
      reason: body.reason,
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
