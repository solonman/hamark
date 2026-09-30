// 站内令牌管理接口（/api/agent-tokens）的外壳：登录会话 → 写操作同源校验 → 名单校验。
// 和 /api/agent/v1 不同，这里是给人在浏览器里用的，走企微登录，不认 Bearer 令牌。

import { getDbClient, type DbClient } from "@/db";
import { requireApiUser, requireSameOriginMutation, type CurrentUser } from "@/lib/current-user";
import { canManageAgentTokens } from "./access";
import { AgentApiError } from "./params";
import { isMissingTokenTable, MISSING_TOKEN_TABLE_MESSAGE } from "./tokens";

const NO_STORE = { "Cache-Control": "no-store" };

export async function agentTokenRoute(
  request: Request,
  options: { mutation: boolean },
  op: (ctx: { user: CurrentUser; db: DbClient }) => Promise<unknown>,
  successStatus = 200,
): Promise<Response> {
  if (options.mutation) {
    const originError = requireSameOriginMutation(request);
    if (originError) return originError;
  }
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!canManageAgentTokens(user.displayName)) {
    return Response.json({ error: "外部 Agent 令牌只对指定成员开放。", code: "FORBIDDEN" }, { status: 403, headers: NO_STORE });
  }
  try {
    return Response.json(await op({ user, db: getDbClient() }), { status: successStatus, headers: NO_STORE });
  } catch (error) {
    if (error instanceof AgentApiError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
    }
    if (isMissingTokenTable(error)) {
      return Response.json({ error: MISSING_TOKEN_TABLE_MESSAGE, code: "AGENT_API_NOT_READY" }, { status: 503, headers: NO_STORE });
    }
    console.error("[agent-tokens] 操作失败", error);
    return Response.json({ error: "操作未完成，请稍后重试。", code: "INTERNAL_ERROR" }, { status: 500, headers: NO_STORE });
  }
}
