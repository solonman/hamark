// 报告标注：当前版本链（GET，默认展示集成版——报告已有真实版本时，见
// docs/21_报告集成版_实施规格_V0.1.md 四、4.1）与保存自己那一版／集成版（PUT）。
// 见 docs/19_报告逆向工程_实施规格_V0.1.md 五、接口。服务层在
// lib/report-version-chain.ts / lib/report-final-version.ts；这里只做鉴权、
// 功能开关、请求体解析与错误到状态码的映射，不拼评审数据（评论/评分由另一层
// lib/report-review-server.ts 负责，不在本路由返回）。

import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import { saveReportFinalVersionDirect } from "@/lib/report-final-version";
import {
  loadReportVersionChain,
  reportVersionErrorResponse,
  saveReportVersion,
  type ReportSaveInput,
} from "@/lib/report-version-chain";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id: reportId } = await context.params;
  const versionId = new URL(request.url).searchParams.get("version")?.trim() || undefined;

  try {
    const chain = await loadReportVersionChain(
      getDbClient(),
      reportId,
      { userId: user.id, displayName: user.displayName },
      {
        ...(versionId ? { versionId } : {}),
        // 不带 ?version（默认展示集成版）或显式 ?version=final 时才需要溯源数据；
        // 看某个具体真实版本时不需要，省一次查询。同视频侧
        // app/api/videos/[id]/analysis/v19/route.ts 的 includeFinalTrace 判定。
        includeFinalTrace: versionId === undefined || versionId === "final",
      },
    );
    const response = Response.json(chain);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return reportVersionErrorResponse(error);
  }
}

type SaveRequestBody = {
  versionId?: unknown;
  baseVersionId?: unknown;
  revision?: unknown;
  payload?: unknown;
};

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id: reportId } = await context.params;

  const body = (await request.json().catch(() => null)) as SaveRequestBody | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "请求体格式不正确。" }, { status: 400 });
  }
  const revision = typeof body.revision === "number" ? body.revision : Number(body.revision);
  if (!Number.isFinite(revision)) {
    return Response.json({ error: "缺少有效的 revision。" }, { status: 400 });
  }
  const actor = { userId: user.id, displayName: user.displayName, email: user.email };

  try {
    // spec 四、4.2：body.versionId === "final" 直接编辑集成版（3.5），
    // 不改变请求体形状——versionId 只是多接受这一个哨兵值。
    if (typeof body.versionId === "string" && body.versionId.trim() === "final") {
      const result = await saveReportFinalVersionDirect(getDbClient(), actor, {
        reportId, revision, payload: body.payload,
      });
      return Response.json(result);
    }
    const input: ReportSaveInput = {
      versionId: typeof body.versionId === "string" && body.versionId.trim() ? body.versionId : null,
      baseVersionId:
        typeof body.baseVersionId === "string" && body.baseVersionId.trim() ? body.baseVersionId : null,
      revision,
      payload: body.payload,
    };
    const result = await saveReportVersion(getDbClient(), reportId, actor, input);
    return Response.json(result);
  } catch (error) {
    return reportVersionErrorResponse(error);
  }
}
