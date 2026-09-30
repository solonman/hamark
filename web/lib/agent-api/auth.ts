// 外部 Agent 只读接口的身份校验。见 docs/23_外部Agent只读API_V0.1.md 二、鉴权。
//
// 站内接口一律靠企业微信登录后的会话 Cookie；外部 Agent 没有浏览器会话，改用
// `Authorization: Bearer <token>`。令牌由名单内成员在站内 /agent-tokens 自己生成，
// 明文只返回一次，库里只存 SHA-256（agent_api_tokens.token_hash）。

import { createHash, randomBytes } from "node:crypto";
import { canManageAgentTokens } from "./access";

export const AGENT_TOKEN_PREFIX = "hmk_agent_";

export type AgentTokenRecord = {
  id: string;
  name: string;
  ownerName: string;
  ownerStatus: string;
};

export type AgentAuthResult =
  | { ok: true; tokenId: string; tokenName: string; ownerName: string }
  | { ok: false; status: 401; code: string; error: string };

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 新令牌明文、库里存的哈希，以及列表里给人认的尾巴（明文最后 4 位）。 */
export function mintAgentToken(): { token: string; hash: string; hint: string } {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashAgentToken(token), hint: `${AGENT_TOKEN_PREFIX}…${token.slice(-4)}` };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * `lookup` 按哈希查未停用的令牌及其主人（生产里是 agent-tokens.ts 的
 * findActiveAgentToken）；注入进来是为了不连库也能测判定逻辑。
 */
export async function authenticateAgentRequest(
  request: Request,
  lookup: (tokenHash: string) => Promise<AgentTokenRecord | null>,
): Promise<AgentAuthResult> {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "缺少 Authorization: Bearer 令牌。" };
  }
  // 格式不对的直接拒，不拿去查库。
  if (!token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) {
    return { ok: false, status: 401, code: "INVALID_TOKEN", error: "令牌无效或已停用。" };
  }
  const record = await lookup(hashAgentToken(token));
  // 主人离职停用、或不在名单里了，令牌跟着失效——不必等人记得去点停用。
  if (!record || record.ownerStatus !== "ACTIVE" || !canManageAgentTokens(record.ownerName)) {
    return { ok: false, status: 401, code: "INVALID_TOKEN", error: "令牌无效或已停用。" };
  }
  return { ok: true, tokenId: record.id, tokenName: record.name, ownerName: record.ownerName };
}
