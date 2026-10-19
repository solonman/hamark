// GET  /api/retro-cases：库首页全量列表（卡片字段、回合轨迹、录音概况、canManage）和各月份成果状态。
// POST /api/retro-cases：新建案例（基本信息五项 + 同事务建一张空的「第 1 版」回合）。
// 检查顺序：同源（写操作）→ 登录 → 开关 → 业务，见 lib/retro/route.ts。
import { getDbClient } from "@/db";
import { createRetroCase, listRetroLibrary } from "@/lib/retro/cases";
import {
  readRetroJsonBody,
  retroRoute,
  scheduleInFlightRetroTranscriptions,
  scheduleStaleRetroDerivatives,
} from "@/lib/retro/route";

export const maxDuration = 300;

export async function GET(request: Request) {
  return retroRoute(request, { mutation: false }, async ({ viewer, startedAt }) => {
    const db = getDbClient();
    const library = await listRetroLibrary(db, viewer);
    // 兜底：转写中的录音、PENDING 超过 60 秒的图片顺手推进一次，放在响应之后，不拖慢这个纯读接口。
    await scheduleInFlightRetroTranscriptions(db, startedAt);
    scheduleStaleRetroDerivatives(db);
    return Response.json(library);
  });
}

export async function POST(request: Request) {
  return retroRoute(request, { mutation: true }, async ({ viewer }) => {
    const result = await createRetroCase(getDbClient(), viewer, await readRetroJsonBody(request));
    return Response.json(result, { status: 201 });
  });
}
