import { agentRoute } from "@/lib/agent-api/route";
import { parseAgentPayloadFormat, parseAgentVersionSelector } from "@/lib/agent-api/params";
import { getAgentVideoAnalysis } from "@/lib/agent-api/video-read";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return agentRoute(request, {}, async ({ db, url }) => {
    const { id } = await context.params;
    return getAgentVideoAnalysis(
      db,
      id,
      parseAgentVersionSelector(url.searchParams),
      parseAgentPayloadFormat(url.searchParams),
    );
  });
}
