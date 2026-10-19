// GET /api/retro-months/[month]/publications/[n]：历史版本（docs/26 6.6），全员可见、只读。
// 检查顺序：开关 → 登录 → 业务。

import { getDbClient } from "@/db";
import { requireApiUser } from "@/lib/current-user";
import { isRetroFeatureEnabled } from "@/lib/retro-model";
import { RetroMonthError } from "@/lib/retro/month-errors";
import { requireRetroMonthKey, retroFeatureDisabledResponse, retroMonthHandle } from "@/lib/retro/month-route";
import { loadRetroPublication } from "@/lib/retro/month-view";

type Params = { params: Promise<{ month: string; n: string }> };

export async function GET(request: Request, context: Params) {
  if (!isRetroFeatureEnabled()) return retroFeatureDisabledResponse();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  return retroMonthHandle(async () => {
    const params = await context.params;
    const monthKey = requireRetroMonthKey(params.month);
    const versionNumber = /^\d{1,6}$/.test(params.n) ? Number(params.n) : NaN;
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw new RetroMonthError(404, "NOT_FOUND", "没有这个版本。");
    const publication = await loadRetroPublication(getDbClient(), monthKey, versionNumber);
    if (!publication) throw new RetroMonthError(404, "NOT_FOUND", "没有这个版本。");
    return Response.json(publication);
  });
}
