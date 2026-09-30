import { agentRoute } from "@/lib/agent-api/route";
import { parseAgentPayloadFormat, parseAgentVersionSelector } from "@/lib/agent-api/params";
import { getAgentReportAnalysis } from "@/lib/agent-api/report-read";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return agentRoute(request, { requireReportFeature: true }, async ({ db, url }) => {
    const { id } = await context.params;
    return getAgentReportAnalysis(
      db,
      id,
      parseAgentVersionSelector(url.searchParams),
      parseAgentPayloadFormat(url.searchParams),
    );
  });
}
