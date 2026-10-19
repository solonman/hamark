// GET /api/retro-months/[month]/publications/[n]：历史版本（docs/26 6.6），全员可见、只读。
// 检查顺序：共用外壳（同源 → 登录 → 开关）→ 业务。

import { getDbClient } from "@/db";
import { retroNotFound } from "@/lib/retro/errors";
import { requireRetroMonthKey } from "@/lib/retro/month-route";
import { loadRetroPublication } from "@/lib/retro/month-view";
import { retroRoute } from "@/lib/retro/route";

type Params = { params: Promise<{ month: string; n: string }> };

export async function GET(request: Request, context: Params) {
  return retroRoute(request, { mutation: false }, async () => {
    const params = await context.params;
    const monthKey = requireRetroMonthKey(params.month);
    const versionNumber = /^\d{1,6}$/.test(params.n) ? Number(params.n) : NaN;
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw retroNotFound("没有这个版本。");
    const publication = await loadRetroPublication(getDbClient(), monthKey, versionNumber);
    if (!publication) throw retroNotFound("没有这个版本。");
    return Response.json(publication);
  });
}
