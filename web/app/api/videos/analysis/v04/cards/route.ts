import { getDbClient } from "@/db";
import { v04Route } from "@/lib/v04-api";
import { filterV04AccessibleVideoIds } from "@/lib/v04-gray-access";
import { loadV04CaseCardsReadModel } from "@/lib/v04-read-models";

export async function GET(request: Request) {
  const response = await v04Route(request, { mutation: false, grayCollection: true }, async (actor) => {
    const videoIds = new URL(request.url).searchParams.getAll("videoId");
    if (videoIds.length > 200) {
      return Response.json({ error: { code: "INVALID_PAYLOAD_SCHEMA", message: "单次最多查询 200 个视频状态。" } }, { status: 400 });
    }
    const db = getDbClient();
    const allowedVideoIds = await filterV04AccessibleVideoIds(db, videoIds);
    const model = await loadV04CaseCardsReadModel(db, allowedVideoIds, {
      actor,
      tabToken: request.headers.get("x-v04-tab-token"),
    });
    return Response.json(model);
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
