// 谁能生成、使用外部 Agent 只读接口的令牌。浏览器和服务端共用（用户菜单据此显示入口）。
// 与 app_admins / 评审身份的做法一致，用企微显示名判定。
// 生成时校验一次，Agent 每次调用时再按令牌主人的当前显示名校验一次：
// 名单里去掉某人，他生成过的令牌立即全部失效。

export const AGENT_TOKEN_OWNER_NAMES = ["老孙", "晏恩华"] as const;

export function canManageAgentTokens(displayName: string | null | undefined): boolean {
  const name = (displayName ?? "").trim();
  return (AGENT_TOKEN_OWNER_NAMES as readonly string[]).includes(name);
}
