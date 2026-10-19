// POST /api/retro-months/[month]/jobs/[jobId]：老孙操作整理任务（docs/26 6.2、6.6）。
//   { action: "RETRY" }：从失败的那一步（逐案提炼从失败的那个案例）继续；
//   { action: "ABANDON" }：放弃（含放弃草稿）；
//   { action: "PUBLISH" }：一个事务写入发布版本 vN、方法候选、说话人称呼与审计。
// 检查顺序：共用外壳（同源 → 登录 → 开关）→ 老孙 → 业务。

import { getDbClient } from "@/db";
import { retroNotFound } from "@/lib/retro/errors";
import { requireRetroMonthKey, requireRetroReviewer, scheduleRetroMonthAdvance } from "@/lib/retro/month-route";
import { loadRetroJob, runRetroMonthJobAction } from "@/lib/retro/month-service";
import { loadRetroJobView } from "@/lib/retro/month-view";
import { readRetroJsonBody, retroRoute } from "@/lib/retro/route";

export const maxDuration = 300;

type Params = { params: Promise<{ month: string; jobId: string }> };

export async function POST(request: Request, context: Params) {
  return retroRoute(request, { mutation: true }, async ({ actor, viewer, startedAt }) => {
    requireRetroReviewer(viewer);
    const params = await context.params;
    const monthKey = requireRetroMonthKey(params.month);
    const body = await readRetroJsonBody(request);
    const db = getDbClient();
    const result = await runRetroMonthJobAction(db, actor, { monthKey, jobId: params.jobId, body });
    if (result.advance) scheduleRetroMonthAdvance({ request, monthKey, jobId: result.jobId, startedAt });
    const row = await loadRetroJob(db, result.jobId);
    if (!row) throw retroNotFound("整理任务不存在。");
    return Response.json({
      job: await loadRetroJobView(db, row, { isReviewer: true }),
      ...(result.publicationVersion != null ? { publicationVersion: result.publicationVersion } : {}),
    });
  });
}
