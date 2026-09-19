import { after } from "next/server";
import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isVisualFeatureEnabled, type VisualCreateRequest, type VisualSubdomain } from "@/lib/visual-contract";
import { isVisualDerivativeCiMode, runStaleVisualDerivatives } from "@/lib/visual-derivatives";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { createVisualCase, listVisualCases } from "@/lib/visual-server";

export async function GET(request: Request) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const db = getDbClient();
  const cases = await listVisualCases(db, {
    userId: user.id,
    identityKey: user.identityKey,
    isAdmin: await isAppAdmin(user),
  });
  // 兜底：PENDING 超过 60 秒（或从没提交过）的图片顺手再提交一次，只在 ci 模式下
  // 才有意义（script 模式靠离线脚本自己扫）。放在响应之后跑，不拖慢这个纯读接口。
  if (isVisualDerivativeCiMode()) {
    after(() => runStaleVisualDerivatives(db));
  }
  const response = Response.json({ cases });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const body = (await request.json()) as Partial<VisualCreateRequest>;
  try {
    const result = await createVisualCase(getDbClient(), {
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
      assets: body.assets ?? [],
      actor: { email: user.identityKey, displayName: user.displayName },
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "创建案例失败，请稍后重试。" },
      { status },
    );
  }
}
