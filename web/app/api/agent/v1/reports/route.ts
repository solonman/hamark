import { agentRoute } from "@/lib/agent-api/route";
import { parseAgentListQuery } from "@/lib/agent-api/params";
import { listAgentReports } from "@/lib/agent-api/report-read";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return agentRoute(request, { requireReportFeature: true }, ({ db, url }) =>
    listAgentReports(db, parseAgentListQuery(url.searchParams)));
}
