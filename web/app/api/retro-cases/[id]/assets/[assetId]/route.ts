// DELETE /api/retro-cases/[id]/assets/[assetId]：移除附件。是真删：行和对象一并删除。
import { getDbClient } from "@/db";
import { removeRetroAsset } from "@/lib/retro/assets";
import { lazyRetroBucket, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

export async function DELETE(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const { id, assetId } = await context.params;
    return Response.json(await removeRetroAsset(getDbClient(), lazyRetroBucket, viewer, id, assetId));
  });
}
