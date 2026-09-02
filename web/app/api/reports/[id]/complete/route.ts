import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, ReportServiceError, reportFeatureDisabledResponse } from "@/lib/report-model";
import { completeReportUpload } from "@/lib/report-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  try {
    const result = await completeReportUpload(getDbClient(), {
      reportId: id,
      actorEmail: user.identityKey,
    });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof ReportServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "完成上传失败，请稍后重试。" },
      { status },
    );
  }
}
