import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { restoreV04Draft, type V04LeaseProof } from "@/lib/v04-workspace-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as {
      sourceType?: "BASELINE" | "WORKING" | "SUBMISSION";
      sourceId?: string;
      reason?: string;
      idempotencyKey?: string;
      lease?: V04LeaseProof;
    };
    return Response.json(await restoreV04Draft(getDbClient(), id, actor, {
      sourceType: body.sourceType ?? "WORKING",
      sourceId: body.sourceId ?? "",
      reason: body.reason,
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
      lease: body.lease as V04LeaseProof,
    }));
  });
}
