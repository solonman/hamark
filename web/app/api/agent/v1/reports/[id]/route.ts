import { agentRoute } from "@/lib/agent-api/route";
import { getAgentReport } from "@/lib/agent-api/report-read";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return agentRoute(request, { requireReportFeature: true }, async ({ db }) => {
    const { id } = await context.params;
    return getAgentReport(db, id);
  });
}
