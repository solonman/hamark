import { getDbClient } from "@/db";
import { requireApiUser } from "@/lib/current-user";
import { loadReportEngagement } from "@/lib/report-engagement-server";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";

export async function GET(request: Request) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const reportIds = new URL(request.url).searchParams.getAll("reportId");
  if (reportIds.length > 200) {
    return Response.json({ error: "单次最多查询 200 个报告。" }, { status: 400 });
  }
  const engagement = await loadReportEngagement(getDbClient(), reportIds, user.id);
  const response = Response.json({ engagement });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
