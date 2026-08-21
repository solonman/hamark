import { getDbClient, getVideoBucket } from "@/db";
import { getAuthServices } from "@/lib/auth/server";
import { requireV04Actor, v04RequestId } from "@/lib/v04-api";
import { V04ServiceError, v04ErrorResponse } from "@/lib/v04-errors";
import { previewV04GrayTestObject } from "@/lib/v04-gray-test-object";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
export async function POST(request: Request) {
  const requestId = v04RequestId(request);
  if (process.env.V04_GRAY_TEST_OBJECT_ENABLED !== "true") {
    return noStore(v04ErrorResponse(new V04ServiceError(
      "UNSUPPORTED_WORKFLOW",
      "V0.4 TEST_ONLY 媒体对象工具默认关闭。",
      {},
      requestId,
    ), requestId));
  }
  const access = await requireV04Actor(request, { mutation: true, requireFeature: false });
  if (access instanceof Response) return noStore(access);
  try {
    const preview = await previewV04GrayTestObject(
      getDbClient(),
      getVideoBucket(),
      access.actor,
      { tokenSecret: getAuthServices().config.authSecret },
    );
    return noStore(Response.json({ preview, requestId: access.requestId }));
  } catch (error) {
    return noStore(v04ErrorResponse(error, access.requestId));
  }
}
