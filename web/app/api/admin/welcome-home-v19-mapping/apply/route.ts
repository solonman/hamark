import { getDbClient } from "@/db";
import { getAuthServices } from "@/lib/auth/server";
import { requireV04Actor, v04IdempotencyKey, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import {
  applyWelcomeHomeV19Mapping,
  loadWelcomeHomeV19MappingConfig,
  type WelcomeHomeV19MappingApplyInput,
} from "@/lib/welcome-home-v19-mapping";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

export async function POST(request: Request) {
  const requestId = v04RequestId(request);
  if (!loadWelcomeHomeV19MappingConfig().applyEnabled) {
    return noStore(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "《欢迎回家》V1.9 映射 APPLY 默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: true, requireFeature: false });
  if (access instanceof Response) return noStore(access);
  try {
    const body = await request.json() as WelcomeHomeV19MappingApplyInput;
    const headerKey = v04IdempotencyKey(request);
    if (!headerKey || headerKey !== body.idempotencyKey) {
      throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键缺失或与请求正文不一致。");
    }
    const result = await applyWelcomeHomeV19Mapping(getDbClient(), access.actor, body, {
      tokenSecret: getAuthServices().config.authSecret,
    });
    return noStore(Response.json({ result, requestId: access.requestId }));
  } catch (error) {
    return noStore(v04ErrorResponse(error, access.requestId));
  }
}
