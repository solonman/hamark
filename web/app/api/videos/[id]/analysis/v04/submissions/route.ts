import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { loadV04HistoryReadModel } from "@/lib/v04-read-models";
import { submitV04Draft, type V04LeaseProof } from "@/lib/v04-workspace-service";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await v04Route(request, { mutation: false }, async (actor) => {
    const { id } = await context.params;
    const history = await loadV04HistoryReadModel(getDbClient(), id, {
      actor,
      tabToken: request.headers.get("x-v04-tab-token"),
    });
    return Response.json({ submissions: history.events.filter((event) => event.eventType === "SUBMISSION") });
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as {
      expectedDraftRevision?: number;
      expectedDraftHash?: string;
      idempotencyKey?: string;
      lease?: V04LeaseProof;
    };
    const result = await submitV04Draft(getDbClient(), actor, {
      videoId: id,
      expectedDraftRevision: Number(body.expectedDraftRevision),
      expectedDraftHash: body.expectedDraftHash ?? "",
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
      lease: body.lease as V04LeaseProof,
    });
    return Response.json(result, { status: result.idempotentReplay ? 200 : 201 });
  });
}
