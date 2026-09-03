// 报告标注的版本列表（GET）与「从某版创建自己的版本」（POST，每人一版，重复则 409）。
// 见 docs/19_报告逆向工程_实施规格_V0.1.md 五、接口；服务层在 lib/report-version-chain.ts。

import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import {
  createReportVersionFrom,
  loadReportVersionChain,
  reportVersionErrorResponse,
} from "@/lib/report-version-chain";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id: reportId } = await context.params;

  try {
    const chain = await loadReportVersionChain(getDbClient(), reportId, {
      userId: user.id,
      displayName: user.displayName,
    });
    const response = Response.json({
      versions: chain.versions,
      latestId: chain.latestId,
      mineId: chain.mineId,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return reportVersionErrorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id: reportId } = await context.params;

  const body = (await request.json().catch(() => null)) as { fromVersionId?: unknown } | null;
  const fromVersionId = typeof body?.fromVersionId === "string" ? body.fromVersionId.trim() : "";

  try {
    const result = await createReportVersionFrom(
      getDbClient(),
      reportId,
      { userId: user.id, displayName: user.displayName, email: user.email },
      { fromVersionId },
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return reportVersionErrorResponse(error);
  }
}
