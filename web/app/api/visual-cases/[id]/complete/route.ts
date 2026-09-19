import { after } from "next/server";
import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isVisualFeatureEnabled } from "@/lib/visual-contract";
import { isVisualDerivativeCiMode, runVisualDerivativesForCase } from "@/lib/visual-derivatives";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { completeVisualCase, VisualCompleteIncompleteError } from "@/lib/visual-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDbClient();
  try {
    const result = await completeVisualCase(db, {
      caseId: id,
      actor: { identityKey: user.identityKey, isAdmin: await isAppAdmin(user) },
    });
    // 案例整体到位之后，顺手把这条案例里等待处理的图片派生图跑一遍（只在 ci 模式；
    // script 模式靠 npm run visual:derivatives 离线跑）。放在响应之后，不拖慢 complete。
    if (isVisualDerivativeCiMode()) {
      after(() => runVisualDerivativesForCase(db, id));
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof VisualCompleteIncompleteError) {
      return Response.json(
        { error: error.message, status: "UPLOADING", missing: error.missing },
        { status: error.status },
      );
    }
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "完成上传失败，请稍后重试。" },
      { status },
    );
  }
}
