import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { loadV04WorkspaceReadModel } from "@/lib/v04-read-models";
import { saveV04Draft, type V04LeaseProof } from "@/lib/v04-workspace-service";
import type { V04Change } from "@/lib/v04-contract";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await v04Route(request, { mutation: false }, async (actor) => {
    const { id } = await context.params;
    return Response.json(await loadV04WorkspaceReadModel(getDbClient(), id, {
      actor,
      tabToken: request.headers.get("x-v04-tab-token"),
    }));
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as {
      expectedRevision?: number;
      expectedHash?: string;
      changeSetId?: string;
      changes?: V04Change[];
      lease?: V04LeaseProof;
    };
    const result = await saveV04Draft(getDbClient(), actor, {
      videoId: id,
      expectedRevision: Number(body.expectedRevision),
      expectedHash: body.expectedHash ?? "",
      changeSetId: body.changeSetId ?? "",
      changes: Array.isArray(body.changes) ? body.changes : [],
      lease: body.lease as V04LeaseProof,
    });
    return Response.json(result);
  });
}
