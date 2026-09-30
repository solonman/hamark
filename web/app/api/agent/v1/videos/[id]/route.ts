import { agentRoute } from "@/lib/agent-api/route";
import { getAgentVideo } from "@/lib/agent-api/video-read";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return agentRoute(request, {}, async ({ db }) => {
    const { id } = await context.params;
    return getAgentVideo(db, id);
  });
}
