import { getDbClient } from "@/db";
import { getAuthServices } from "@/lib/auth/server";
import { requireV04Actor, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import {
  loadWelcomeHomeV19MappingConfig,
  previewWelcomeHomeV19Mapping,
} from "@/lib/welcome-home-v19-mapping";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Vary", "Cookie");
  return response;
}

export async function POST(request: Request) {
  const requestId = v04RequestId(request);
  if (!loadWelcomeHomeV19MappingConfig().previewEnabled) {
    return noStore(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "《欢迎回家》V1.9 映射 PREVIEW 默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: true, requireFeature: false });
  if (access instanceof Response) return noStore(access);
  try {
    const preview = await previewWelcomeHomeV19Mapping(getDbClient(), access.actor, {
      tokenSecret: getAuthServices().config.authSecret,
    });
    return noStore(Response.json({ preview, requestId: access.requestId }));
  } catch (error) {
    return noStore(v04ErrorResponse(error, access.requestId));
  }
}
