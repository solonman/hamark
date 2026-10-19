// POST /api/retro-months/[month]/jobs：老孙发起整理（docs/26 6.1、6.6）。
//   { mode: "GENERATE" }：冻结输入快照、按案例输入哈希复用缓存，响应后开始推进；
//   { mode: "REVISE_PUBLISHED" }：基于当前发布版复制出新草稿，不调模型。
// 检查顺序：开关 → 同源 → 登录 → 老孙 → 业务（GENERATE 另要求模型已配置）。

import { getDbClient } from "@/db";
import { isCaseReviewer } from "@/lib/case-review";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isRetroFeatureEnabled } from "@/lib/retro-model";
import { readRetroAiConfig } from "@/lib/retro/month-config";
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
import { loadRetroJob, startRetroMonthJob } from "@/lib/retro/month-service";
import { createRetroLlmProvider } from "@/lib/retro/month-providers";
import { loadRetroJobView } from "@/lib/retro/month-view";

export const maxDuration = 300;

type Params = { params: Promise<{ month: string }> };

export async function POST(request: Request, context: Params) {
  if (!isRetroFeatureEnabled()) return retroFeatureDisabledResponse();
  const startedAt = Date.now();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!isCaseReviewer(user.displayName)) return retroMonthErrorResponse(retroMonthForbidden());
  return retroMonthHandle(async () => {
    const monthKey = requireRetroMonthKey((await context.params).month);
    const body = await readRetroJsonBody(request);
    const config = readRetroAiConfig();
    const mode = body && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
    if (mode === "GENERATE" && !config.configured) {
      throw new RetroMonthError(503, "RETRO_AI_NOT_CONFIGURED", "月度整理还没有配置好（缺少模型密钥），请联系管理员。");
    }
    const db = getDbClient();
    const result = await startRetroMonthJob(db, retroMonthActor(user), { monthKey, body, llmModel: createRetroLlmProvider(config).model });
    if (result.advance) scheduleRetroMonthAdvance({ request, monthKey, jobId: result.jobId, startedAt });
    const row = await loadRetroJob(db, result.jobId);
    if (!row) throw new RetroMonthError(500, "INTERNAL", "任务创建后没有读到。");
    return Response.json({ job: await loadRetroJobView(db, row, { isReviewer: true }) }, { status: 201 });
  });
}
