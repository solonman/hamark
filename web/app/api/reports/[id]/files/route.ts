import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, ReportServiceError, reportFeatureDisabledResponse } from "@/lib/report-model";
import { createReportFileUpload } from "@/lib/report-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const body = (await request.json()) as {
    originalName?: string;
    contentType?: string;
    fileSize?: number;
  };
  try {
    const result = await createReportFileUpload(getDbClient(), {
      reportId: id,
      originalName: body.originalName ?? "",
      contentType: body.contentType,
      fileSize: Number(body.fileSize) || 0,
      uploadedByUserId: user.id,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    const status = error instanceof ReportServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "上传相关资料失败，请稍后重试。" },
      { status },
    );
  }
}
