// PATCH /api/retro-months/[month]/jobs/[jobId]/draft：老孙改草稿（docs/26 6.6）。
//   { section, caseId?, itemId?, op: "UPDATE" | "DELETE" | "ADD", value, revision }
// 各节能做什么照 RETRO_DRAFT_SECTIONS；revision 对不上回 409。返回改后的任务视图和（新增/修改的）itemId。
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
} from "@/lib/retro/month-route";
import { loadRetroJob, patchRetroDraft } from "@/lib/retro/month-service";
import { loadRetroJobView } from "@/lib/retro/month-view";

type Params = { params: Promise<{ month: string; jobId: string }> };

export async function PATCH(request: Request, context: Params) {
  if (!isRetroFeatureEnabled()) return retroFeatureDisabledResponse();
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
    const result = await patchRetroDraft(db, retroMonthActor(user), { monthKey, jobId: params.jobId, body });
    const row = await loadRetroJob(db, params.jobId);
    if (!row) throw new RetroMonthError(404, "NOT_FOUND", "整理任务不存在。");
    return Response.json({ job: await loadRetroJobView(db, row, { isReviewer: true }), itemId: result.itemId });
  });
}
