import { getDbClient } from "@/db";
import { getAuthServices } from "@/lib/auth/server";
import { requireV04Actor, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import {
  isV04PreviewSameOrigin,
  previewV04Migration,
} from "@/lib/v04-migration-preview";

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

function noStoreResponse(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function GET(request: Request) {
  const requestId = v04RequestId(request);
  if (process.env.V04_MIGRATION_PREVIEW_ENABLED !== "true") {
    return noStoreResponse(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "V0.4 迁移 PREVIEW 默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  if (!isV04PreviewSameOrigin(request, getAuthServices().config.appUrl)) {
    return noStoreResponse(v04ErrorResponse(new V04ServiceError(
      "FORBIDDEN",
      "PREVIEW 请求来源不被允许。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: false, requireFeature: false });
  if (access instanceof Response) return noStoreResponse(access);
  try {
    const preview = await previewV04Migration(getDbClient(), access.actor);
    return noStoreJson({ preview, requestId: access.requestId });
  } catch (error) {
    return noStoreResponse(v04ErrorResponse(error, access.requestId));
  }
}
