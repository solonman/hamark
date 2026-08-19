import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { forceReleaseV04Lease } from "@/lib/v04-workspace-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as {
      reason?: string;
      confirmed?: boolean;
      idempotencyKey?: string;
    };
    return Response.json(await forceReleaseV04Lease(getDbClient(), id, actor, {
      reason: body.reason ?? "",
      confirmed: body.confirmed === true,
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
