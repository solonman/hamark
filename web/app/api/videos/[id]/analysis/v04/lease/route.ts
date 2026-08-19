import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import {
  acquireV04Lease,
  heartbeatV04Lease,
  releaseV04Lease,
  type V04LeaseProof,
} from "@/lib/v04-workspace-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as {
      tabToken?: string;
      existingLeaseToken?: string;
      existingLeaseVersion?: number;
    };
    const result = await acquireV04Lease(getDbClient(), id, actor, {
      tabToken: body.tabToken ?? "",
      existingLeaseToken: body.existingLeaseToken,
      existingLeaseVersion: body.existingLeaseVersion,
    });
    return Response.json(result, { status: result.reused ? 200 : 201 });
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const proof = await request.json() as V04LeaseProof;
    return Response.json(await heartbeatV04Lease(getDbClient(), id, actor, proof));
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const proof = await request.json() as V04LeaseProof;
    return Response.json(await releaseV04Lease(getDbClient(), id, actor, proof));
  });
}
