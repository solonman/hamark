import { getDbClient } from "@/db";
import { getAuthServices } from "@/lib/auth/server";
import { requireV04Actor, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import { isV04PreviewSameOrigin } from "@/lib/v04-migration-preview";
import {
  auditWelcomeHomeV19Conflict,
  loadWelcomeHomeV19AuditConfig,
} from "@/lib/welcome-home-v19-conflict-audit";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Cookie");
  return Response.json(body, { ...init, headers });
}

function noStoreResponse(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

export async function GET(request: Request) {
  const requestId = v04RequestId(request);
  if (!loadWelcomeHomeV19AuditConfig().enabled) {
    return noStoreResponse(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "《欢迎回家》V1.9 只读冲突审计默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  const url = new URL(request.url);
  if (url.search || !isV04PreviewSameOrigin(request, getAuthServices().config.appUrl)) {
    return noStoreResponse(v04ErrorResponse(new V04ServiceError(
      "FORBIDDEN",
      "只读审计请求来源或作用域不被允许。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: false, requireFeature: false });
  if (access instanceof Response) return noStoreResponse(access);
  try {
    const audit = await auditWelcomeHomeV19Conflict(getDbClient(), access.actor);
    return noStoreJson({ audit, requestId: access.requestId });
  } catch (error) {
    return noStoreResponse(v04ErrorResponse(error, access.requestId));
  }
}
