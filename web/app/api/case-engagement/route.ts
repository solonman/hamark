import { getDbClient } from "@/db";
import { loadCaseEngagement } from "@/lib/case-engagement-server";
import { requireApiUser } from "@/lib/current-user";

export async function GET(request: Request) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const videoIds = new URL(request.url).searchParams.getAll("videoId");
  if (videoIds.length > 200) {
    return Response.json({ error: "单次最多查询 200 个案例。" }, { status: 400 });
  }
  const engagement = await loadCaseEngagement(getDbClient(), videoIds, user.id);
  const response = Response.json({ engagement });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
