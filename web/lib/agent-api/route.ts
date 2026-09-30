// 外部 Agent 只读接口的统一外壳：鉴权 → 执行只读查询 → 统一错误格式与缓存头。
// 路由文件只导出 GET，并且第一句就进这里；写操作在这组接口里不存在。

import { getDbClient, type DbClient } from "@/db";
import { isReportFeatureEnabled } from "@/lib/report-model";
import { ReportVersionError } from "@/lib/report-version-chain";
import { V04ServiceError } from "@/lib/v04-errors";
import { authenticateAgentRequest } from "./auth";
import { AgentApiError } from "./params";
import {
  findActiveAgentToken,
  isMissingTokenTable,
  MISSING_TOKEN_TABLE_MESSAGE,
  touchAgentToken,
} from "./tokens";

export type AgentRouteContext = { agent: string; owner: string; db: DbClient; url: URL };

const NO_STORE = { "Cache-Control": "no-store" };

function errorResponse(status: number, code: string, error: string, extraHeaders: Record<string, string> = {}) {
  return Response.json({ error, code }, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

/** 把各服务层抛出的已知错误翻成对外错误码；未知错误一律 500，不泄露内部信息。 */
export function agentErrorResponse(error: unknown): Response {
  if (error instanceof AgentApiError) return errorResponse(error.status, error.code, error.message);
  if (error instanceof V04ServiceError) {
    if (error.code === "CASE_NOT_FOUND" || error.code === "CASE_IN_TRASH" || error.code === "ASSET_PURGED") {
      return errorResponse(404, "CASE_NOT_FOUND", "案例不存在。");
    }
    if (error.code === "VERSION_NOT_FOUND") return errorResponse(404, "VERSION_NOT_FOUND", error.message);
  }
  if (error instanceof ReportVersionError) {
    if (error.code === "REPORT_NOT_FOUND" || error.code === "REPORT_NOT_READY") {
      return errorResponse(404, "REPORT_NOT_FOUND", "报告不存在或尚未就绪。");
    }
    if (error.code === "VERSION_NOT_FOUND") return errorResponse(404, "VERSION_NOT_FOUND", error.message);
  }
  console.error("[agent-api] 读取失败", error);
  return errorResponse(500, "INTERNAL_ERROR", "读取失败，请稍后重试。");
}

export async function agentRoute(
  request: Request,
  options: { requireReportFeature?: boolean },
  op: (ctx: AgentRouteContext) => Promise<unknown>,
): Promise<Response> {
  const db = getDbClient();
  let auth: Awaited<ReturnType<typeof authenticateAgentRequest>>;
  try {
    auth = await authenticateAgentRequest(request, (hash) => findActiveAgentToken(db, hash));
  } catch (error) {
    if (isMissingTokenTable(error)) return errorResponse(503, "AGENT_API_NOT_READY", MISSING_TOKEN_TABLE_MESSAGE);
    return agentErrorResponse(error);
  }
  if (!auth.ok) {
    return errorResponse(auth.status, auth.code, auth.error, { "WWW-Authenticate": 'Bearer realm="hamark-agent"' });
  }
  // 记使用时间只是给主人看的旁注，写不进去也不耽误这次读取。要 await：
  // Vercel 函数在响应发出后可能直接被冻结，不等的话这笔写入会丢。
  await touchAgentToken(db, auth.tokenId).catch((error) => console.error("[agent-api] 记录令牌使用时间失败", error));
  const url = new URL(request.url);
  // 报告库总开关关着时，报告数据对 Agent 同样不存在（与站内 /api/reports 一致）。
  if (options.requireReportFeature && !isReportFeatureEnabled()) {
    return errorResponse(404, "REPORT_FEATURE_DISABLED", "报告库尚未开放。");
  }
  const started = Date.now();
  let status = 200;
  try {
    const body = await op({ agent: auth.tokenName, owner: auth.ownerName, db, url });
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    const response = agentErrorResponse(error);
    status = response.status;
    return response;
  } finally {
    console.info(`[agent-api] token=${auth.tokenId} agent=${JSON.stringify(auth.tokenName)} owner=${auth.ownerName} GET ${url.pathname}${url.search} ${status} ${Date.now() - started}ms`);
  }
}
