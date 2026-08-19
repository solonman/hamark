import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { grantV04ExpertPreference } from "@/lib/v04-workspace-service";
import { V04ServiceError } from "@/lib/v04-errors";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; submissionId: string }> },
) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id, submissionId } = await context.params;
    const body = await request.json() as {
      grade?: "S" | "A" | "B" | "C";
      reason?: string;
      idempotencyKey?: string;
    };
    const grade = body.grade;
    if (!grade || !["S", "A", "B", "C"].includes(grade)) {
      throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "专家评价等级无效。");
    }
    return Response.json(await grantV04ExpertPreference(getDbClient(), id, submissionId, actor, {
      grade,
      reason: body.reason,
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
