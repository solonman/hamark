import { getDbClient } from "@/db";
import { requireV04Actor, v04IdempotencyKey, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import {
  applyV04Schema,
  type V04SchemaApplyInput,
} from "@/lib/v04-schema-apply";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

function noStoreResponse(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const requestId = v04RequestId(request);
  if (process.env.V04_SCHEMA_APPLY_ENABLED !== "true") {
    return noStoreResponse(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "V0.4 schema APPLY 默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: true, requireFeature: false });
  if (access instanceof Response) return noStoreResponse(access);
  try {
    const body = await request.json() as Partial<V04SchemaApplyInput>;
    const headerKey = v04IdempotencyKey(request);
    if (!headerKey || headerKey !== body.idempotencyKey) {
      throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键缺失或与请求正文不一致。", {}, access.requestId);
    }
    const result = await applyV04Schema(getDbClient(), access.actor, body as V04SchemaApplyInput);
    return noStoreJson({ result, requestId: access.requestId }, {
      status: result.status === "APPLIED" ? 200 : 500,
    });
  } catch (error) {
    return noStoreResponse(v04ErrorResponse(error, access.requestId));
  }
}
