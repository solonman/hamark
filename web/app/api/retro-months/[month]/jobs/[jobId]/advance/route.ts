// POST /api/retro-months/[month]/jobs/[jobId]/advance：内部接力（docs/26 6.3）。
// 不认登录态，只认 HMAC 令牌（请求头 x-retro-relay-token，内容 = 任务 id + relay_seq，密钥
// RETRO_RELAY_SECRET）；令牌用一次作废，无效一律 404。核对通过后立即回 202，推进放在 after() 里。
// 检查顺序：开关 → 令牌 → 业务。

import { getDbClient } from "@/db";
import { isRetroFeatureEnabled } from "@/lib/retro-model";
import { readRetroAiConfig } from "@/lib/retro/month-config";
import {
  requireRetroMonthKey,
  retroFeatureDisabledResponse,
  retroMonthHandle,
  scheduleRetroMonthAdvance,
} from "@/lib/retro/month-route";
import { consumeRetroRelayToken, RETRO_RELAY_HEADER } from "@/lib/retro/month-relay";

export const maxDuration = 300;

type Params = { params: Promise<{ month: string; jobId: string }> };

const notFound = () => Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });

export async function POST(request: Request, context: Params) {
  if (!isRetroFeatureEnabled()) return retroFeatureDisabledResponse();
  const startedAt = Date.now();
  const token = request.headers.get(RETRO_RELAY_HEADER);
  if (!token) return notFound();
  return retroMonthHandle(async () => {
    const params = await context.params;
    const monthKey = requireRetroMonthKey(params.month);
    const consumed = await consumeRetroRelayToken(getDbClient(), { monthKey, jobId: params.jobId, token, secret: readRetroAiConfig().relaySecret });
    if (!consumed) return notFound();
    scheduleRetroMonthAdvance({ request, monthKey, jobId: params.jobId, startedAt });
    return Response.json({ ok: true }, { status: 202 });
  });
}
