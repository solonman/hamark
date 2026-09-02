import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, ReportServiceError, reportFeatureDisabledResponse } from "@/lib/report-model";
import { retryReport } from "@/lib/report-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  try {
    const result = await retryReport(getDbClient(), {
      reportId: id,
      actor: { identityKey: user.identityKey, isAdmin: await isAppAdmin(user) },
    });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof ReportServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "重试失败，请稍后重试。" },
      { status },
    );
  }
}
