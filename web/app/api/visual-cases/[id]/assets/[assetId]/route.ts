import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isVisualFeatureEnabled } from "@/lib/visual-contract";
import { visualFeatureDisabledResponse, VisualServiceError } from "@/lib/visual-model";
import { removeVisualAsset } from "@/lib/visual-server";
import { visualStorageFailureResponse } from "@/lib/visual-storage-failure";

export async function DELETE(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  if (!isVisualFeatureEnabled()) return visualFeatureDisabledResponse();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id, assetId } = await context.params;
  try {
    const result = await removeVisualAsset(getDbClient(), {
      caseId: id,
      assetId,
      actor: { identityKey: user.identityKey, isAdmin: await isAppAdmin(user) },
    });
    return Response.json(result);
  } catch (error) {
    const storageFailure = visualStorageFailureResponse("remove-asset", error);
    if (storageFailure) return storageFailure;
    const status = error instanceof VisualServiceError ? error.status : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "移除素材失败，请稍后重试。" },
      { status },
    );
  }
}
