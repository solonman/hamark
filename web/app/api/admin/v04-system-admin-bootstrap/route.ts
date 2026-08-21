import { getDbClient } from "@/db";
import { requireV04Actor, v04IdempotencyKey, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import {
  bootstrapV04SystemAdmin,
  type V04SystemAdminBootstrapInput,
} from "@/lib/v04-system-admin-bootstrap";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const requestId = v04RequestId(request);
  if (process.env.V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED !== "true") {
    return noStore(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW", "SYSTEM_ADMIN bootstrap 默认关闭。", {}, requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: true, requireFeature: false });
  if (access instanceof Response) return noStore(access);
  try {
    const body = await request.json() as V04SystemAdminBootstrapInput;
    const headerKey = v04IdempotencyKey(request);
    if (!headerKey || headerKey !== body.idempotencyKey) {
      throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键缺失或不一致。", {}, access.requestId);
    }
    const result = await bootstrapV04SystemAdmin(getDbClient(), access.actor, body);
    return noStore(Response.json({ result, requestId: access.requestId }));
  } catch (error) {
    return noStore(v04ErrorResponse(error, access.requestId));
  }
}
