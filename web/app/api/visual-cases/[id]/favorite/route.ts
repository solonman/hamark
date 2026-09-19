import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isVisualFeatureEnabled } from "@/lib/visual-contract";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { toggleVisualFavorite } from "@/lib/visual-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  try {
    const result = await toggleVisualFavorite(getDbClient(), { caseId: id, userId: user.id });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "收藏失败，请稍后重试。" },
      { status },
    );
  }
}
