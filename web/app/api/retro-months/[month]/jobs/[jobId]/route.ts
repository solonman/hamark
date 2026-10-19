// POST /api/retro-months/[month]/jobs/[jobId]：老孙操作整理任务（docs/26 6.2、6.6）。
//   { action: "RETRY" }：从失败的那一步（逐案提炼从失败的那个案例）继续；
//   { action: "ABANDON" }：放弃（含放弃草稿）；
//   { action: "PUBLISH" }：一个事务写入发布版本 vN、方法候选、说话人称呼与审计。
// 检查顺序：开关 → 同源 → 登录 → 老孙 → 业务。

import { getDbClient } from "@/db";
import { isCaseReviewer } from "@/lib/case-review";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isRetroFeatureEnabled } from "@/lib/retro-model";
import { RetroMonthError, retroMonthForbidden } from "@/lib/retro/month-errors";
import {
  readRetroJsonBody,
  requireRetroMonthKey,
  retroFeatureDisabledResponse,
  retroMonthActor,
  retroMonthErrorResponse,
  retroMonthHandle,
  scheduleRetroMonthAdvance,
} from "@/lib/retro/month-route";
import { loadRetroJob, runRetroMonthJobAction } from "@/lib/retro/month-service";
import { loadRetroJobView } from "@/lib/retro/month-view";

export const maxDuration = 300;

type Params = { params: Promise<{ month: string; jobId: string }> };

export async function POST(request: Request, context: Params) {
  if (!isRetroFeatureEnabled()) return retroFeatureDisabledResponse();
  const startedAt = Date.now();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!isCaseReviewer(user.displayName)) return retroMonthErrorResponse(retroMonthForbidden());
  return retroMonthHandle(async () => {
    const params = await context.params;
    const monthKey = requireRetroMonthKey(params.month);
    const body = await readRetroJsonBody(request);
    const db = getDbClient();
    const result = await runRetroMonthJobAction(db, retroMonthActor(user), { monthKey, jobId: params.jobId, body });
    if (result.advance) scheduleRetroMonthAdvance({ request, monthKey, jobId: result.jobId, startedAt });
    const row = await loadRetroJob(db, result.jobId);
    if (!row) throw new RetroMonthError(404, "NOT_FOUND", "整理任务不存在。");
    return Response.json({
      job: await loadRetroJobView(db, row, { isReviewer: true }),
      ...(result.publicationVersion != null ? { publicationVersion: result.publicationVersion } : {}),
    });
  });
}
