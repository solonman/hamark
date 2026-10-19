// GET /api/retro-months/[month]：月份页（docs/26 九、10.5）。案例清单与录音概况、整场总结录音、
// 最新发布版与历史版本号、整理任务（草稿内容只给老孙）、生成前提。有在途任务且租约空闲时，
// 响应发出后用 after() 推进一次（接力链断了也能接上）。
// 检查顺序：共用外壳（同源 → 登录 → 开关）→ 业务。

import { getDbClient } from "@/db";
import { retroRoute } from "@/lib/retro/route";
import { requireRetroMonthKey, scheduleRetroMonthAdvance } from "@/lib/retro/month-route";
import { loadRetroMonthView } from "@/lib/retro/month-view";

export const maxDuration = 300;

type Params = { params: Promise<{ month: string }> };

export async function GET(request: Request, context: Params) {
  return retroRoute(request, { mutation: false }, async ({ viewer, startedAt }) => {
    const monthKey = requireRetroMonthKey((await context.params).month);
    const { view, advanceJobId } = await loadRetroMonthView(getDbClient(), monthKey, viewer);
    if (advanceJobId) scheduleRetroMonthAdvance({ request, monthKey, jobId: advanceJobId, startedAt });
    return Response.json(view);
  });
}
