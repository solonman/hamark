import { getDbClient } from "@/db";
import { requireApiUser } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import { loadReportDetail } from "@/lib/report-server";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const report = await loadReportDetail(getDbClient(), id);
  if (!report) {
    return Response.json({ error: "报告不存在或已进入回收站。" }, { status: 404 });
  }
  const response = Response.json({ report });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
