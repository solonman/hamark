import { getDbClient } from "@/db";
import { requireV04Actor, v04IdempotencyKey, v04RequestId } from "@/lib/v04-api";
import {
  executeV04ContractLifecycle,
  type V04ContractLifecycleInput,
} from "@/lib/v04-contract-activation";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const requestId = v04RequestId(request);
  if (process.env.V04_CONTRACT_ACTIVATE_ENABLED !== "true") {
    return noStore(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "V0.4 合同生命周期操作默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: true, requireFeature: false });
  if (access instanceof Response) return noStore(access);
  try {
    const body = await request.json() as V04ContractLifecycleInput;
    const headerKey = v04IdempotencyKey(request);
    if (!headerKey || headerKey !== body.idempotencyKey) {
      throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键缺失或与请求正文不一致。", {}, access.requestId);
    }
    const result = await executeV04ContractLifecycle(getDbClient(), access.actor, body);
    return noStore(Response.json({ result, requestId: access.requestId }, {
      status: result.status === "APPLIED" ? 200 : 500,
    }));
  } catch (error) {
    return noStore(v04ErrorResponse(error, access.requestId));
  }
}
