import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import { createReportUpload, listReports } from "@/lib/report-server";

export async function GET(request: Request) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  // 每条报告是否能重试/改传/删除交给 listReports 按 canManageReport 算好再吐出来，
  // 前端不用（也不该）再拿显示名去猜是不是本人上传的。
  const reports = await listReports(getDbClient(), {
    identityKey: user.identityKey,
    isAdmin: await isAppAdmin(user),
  });
  const response = Response.json({ reports });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    title?: string;
    originalName?: string;
    contentType?: string;
    fileSize?: number;
    taskType?: string;
    tags?: string[];
  };

  try {
    const result = await createReportUpload(getDbClient(), {
      title: body.title ?? "",
      originalName: body.originalName ?? "",
      contentType: body.contentType,
      fileSize: Number(body.fileSize) || 0,
      taskType: body.taskType ?? "",
      tags: body.tags,
      actor: { email: user.identityKey, displayName: user.displayName },
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "创建报告失败，请稍后重试。" },
      { status: 400 },
    );
  }
}
