import { getDbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isReportFeatureEnabled, reportFeatureDisabledResponse } from "@/lib/report-model";
import { toggleReportFavorite } from "@/lib/report-engagement-server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) return reportFeatureDisabledResponse();
  const forbidden = requireSameOriginMutation(request);
  if (forbidden) return forbidden;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  try {
    return Response.json(
      await toggleReportFavorite(getDbClient(), {
        reportId: id,
        userId: user.id,
      }),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "收藏失败，请稍后重试。" },
      { status: 400 },
    );
  }
}
