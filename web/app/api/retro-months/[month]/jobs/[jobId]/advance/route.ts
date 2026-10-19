// POST /api/retro-months/[month]/jobs/[jobId]/advance：内部接力（docs/26 6.3）。
// 不认登录态（所以不走 retroRoute 外壳），只认 HMAC 令牌：请求头 x-retro-relay-token，内容 = 任务 id + relay_seq，
// 密钥 RETRO_RELAY_SECRET；令牌用一次作废。令牌缺失、无效、开关关着，一律 404。核对通过后立即回 202，
// 推进放在 after() 里。
// 检查顺序：令牌在不在 → 开关 → 核对并作废令牌 → 业务。

import { getDbClient } from "@/db";
import { isRetroFeatureEnabled, isRetroMonthKey } from "@/lib/retro-model";
import { isMissingRetroSchema } from "@/lib/retro/errors";
import { readRetroAiConfig } from "@/lib/retro/month-config";
import { scheduleRetroMonthAdvance } from "@/lib/retro/month-route";
import { consumeRetroRelayToken, RETRO_RELAY_HEADER } from "@/lib/retro/month-relay";

export const maxDuration = 300;

type Params = { params: Promise<{ month: string; jobId: string }> };

const notFound = () => Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, context: Params) {
  const startedAt = Date.now();
  const token = request.headers.get(RETRO_RELAY_HEADER);
  if (!token) return notFound();
  if (!isRetroFeatureEnabled()) return notFound();
  const params = await context.params;
  if (!isRetroMonthKey(params.month)) return notFound();
  try {
    const consumed = await consumeRetroRelayToken(getDbClient(), { monthKey: params.month, jobId: params.jobId, token, secret: readRetroAiConfig().relaySecret });
    if (!consumed) return notFound();
  } catch (error) {
    if (!isMissingRetroSchema(error)) console.error("[retro-month] 接力令牌核对失败", error);
    return notFound();
  }
  scheduleRetroMonthAdvance({ request, monthKey: params.month, jobId: params.jobId, startedAt });
  return Response.json({ ok: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
