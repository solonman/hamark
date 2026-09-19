import { after } from "next/server";
import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isVisualFeatureEnabled, type VisualPatchRequest, type VisualSubdomain } from "@/lib/visual-contract";
import { isVisualDerivativeCiMode, runStaleVisualDerivatives } from "@/lib/visual-derivatives";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { loadVisualCaseDetail, patchVisualCase } from "@/lib/visual-server";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDbClient();
  const viewer = { userId: user.id, identityKey: user.identityKey, isAdmin: await isAppAdmin(user) };
  const detail = await loadVisualCaseDetail(db, id, viewer);
  if (!detail) {
    return Response.json({ error: "案例不存在或已进入回收站。" }, { status: 404 });
  }
  // 兜底：这条案例里 PENDING 超过 60 秒的图片顺手再提交一次（只在 ci 模式）。
  if (isVisualDerivativeCiMode()) {
    after(() => runStaleVisualDerivatives(db, { caseId: id }));
  }
  const response = Response.json({ case: detail });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const body = (await request.json()) as Partial<VisualPatchRequest>;
  try {
    const detail = await patchVisualCase(getDbClient(), {
      caseId: id,
      subdomain: body.subdomain as VisualSubdomain,
      title: body.title ?? "",
      location: body.location ?? "",
      tags: body.tags ?? [],
      textBody: body.textBody,
      summary: body.summary,
      creator: body.creator,
      occurredAt: body.occurredAt,
      sourceUrl: body.sourceUrl,
      rightsNote: body.rightsNote,
      metadata: body.metadata ?? {},
      updatedAt: body.updatedAt ?? "",
      assetOrder: body.assetOrder ?? [],
      viewer: { userId: user.id, identityKey: user.identityKey, isAdmin: await isAppAdmin(user) },
    });
    return Response.json({ case: detail });
  } catch (error) {
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "保存失败，请稍后重试。" },
      { status },
    );
  }
}
