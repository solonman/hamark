import { agentRoute } from "@/lib/agent-api/route";
import { parseAgentListQuery } from "@/lib/agent-api/params";
import { listAgentVideos } from "@/lib/agent-api/video-read";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return agentRoute(request, {}, ({ db, url }) => listAgentVideos(db, parseAgentListQuery(url.searchParams)));
}
