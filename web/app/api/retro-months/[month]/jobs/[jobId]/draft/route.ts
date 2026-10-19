// PATCH /api/retro-months/[month]/jobs/[jobId]/draft：老孙改草稿（docs/26 6.6）。
//   { section, caseId?, itemId?, op: "UPDATE" | "DELETE" | "ADD", value, revision }
// 各节能做什么照 RETRO_DRAFT_SECTIONS；revision 对不上回 409。返回改后的任务视图和（新增/修改的）itemId。
// 检查顺序：共用外壳（同源 → 登录 → 开关）→ 老孙 → 业务。

import { getDbClient } from "@/db";
import { retroNotFound } from "@/lib/retro/errors";
import { requireRetroMonthKey, requireRetroReviewer } from "@/lib/retro/month-route";
import { loadRetroJob, patchRetroDraft } from "@/lib/retro/month-service";
import { loadRetroJobView } from "@/lib/retro/month-view";
import { readRetroJsonBody, retroRoute } from "@/lib/retro/route";

type Params = { params: Promise<{ month: string; jobId: string }> };

export async function PATCH(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ actor, viewer }) => {
    requireRetroReviewer(viewer);
    const params = await context.params;
    const monthKey = requireRetroMonthKey(params.month);
    const body = await readRetroJsonBody(request);
    const db = getDbClient();
    const result = await patchRetroDraft(db, actor, { monthKey, jobId: params.jobId, body });
    const row = await loadRetroJob(db, params.jobId);
    if (!row) throw retroNotFound("整理任务不存在。");
    return Response.json({ job: await loadRetroJobView(db, row, { isReviewer: true }), itemId: result.itemId });
  });
}
