import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, ReportServiceError, reportFeatureDisabledResponse } from "@/lib/report-model";
import { removeReportFile } from "@/lib/report-server";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; fileId: string }> },
) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id, fileId } = await context.params;
  try {
    const result = await removeReportFile(getDbClient(), {
      reportId: id,
      fileId,
      actor: {
        identityKey: user.identityKey,
        isAdmin: await isAppAdmin(user),
        userId: user.id,
      },
    });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof ReportServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "移除相关资料失败，请稍后重试。" },
      { status },
    );
  }
}
