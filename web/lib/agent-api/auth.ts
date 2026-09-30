// 外部 Agent 只读接口的身份校验。见 docs/23_外部Agent只读API_V0.1.md 二、鉴权。
//
// 站内接口一律靠企业微信登录后的会话 Cookie；外部 Agent 没有浏览器会话，改用
// `Authorization: Bearer <token>`。令牌只在生成时出现一次，服务端环境变量
// `AGENT_API_KEYS` 里只存它的 SHA-256，所以 Vercel 配置泄露也拿不到可用令牌。
//
//   AGENT_API_KEYS="research-bot:<64位hex>,copy-bot:<64位hex>"
//
// 没配置任何令牌时整组接口按 404 处理——默认关闭，跟站内其他开关的做法一致。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AGENT_TOKEN_PREFIX = "hmk_agent_";

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type AgentApiKey = { name: string; hash: string };

export type AgentAuthResult =
  | { ok: true; agent: string }
  | { ok: false; status: 401 | 404; code: string; error: string };

/** 逗号或换行分隔的 `name:sha256hex`；格式不对的条目直接丢弃，不让一条笔误放开口子。 */
export function parseAgentApiKeys(raw: string | undefined): AgentApiKey[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const sep = entry.lastIndexOf(":");
      if (sep <= 0) return [];
      const name = entry.slice(0, sep).trim();
      const hash = entry.slice(sep + 1).trim().toLowerCase();
      return NAME_PATTERN.test(name) && HASH_PATTERN.test(hash) ? [{ name, hash }] : [];
    });
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 生成一条新令牌与对应的环境变量条目；只给 scripts/create-agent-key.ts 用。 */
export function mintAgentToken(name: string): { token: string; entry: string } {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("Agent 名称只能用字母、数字、_ . -，最长 40 个字符。");
  }
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, entry: `${name}:${hashAgentToken(token)}` };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function authenticateAgentRequest(
  request: Request,
  rawKeys: string | undefined = process.env.AGENT_API_KEYS,
): AgentAuthResult {
  const keys = parseAgentApiKeys(rawKeys);
  if (keys.length === 0) {
    return { ok: false, status: 404, code: "AGENT_API_DISABLED", error: "接口未开放。" };
  }
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "缺少 Authorization: Bearer 令牌。" };
  }
  const presented = Buffer.from(hashAgentToken(token), "hex");
  // 逐条比较、不提前退出：命中哪一条都花同样的时间。
  let matched: string | null = null;
  for (const key of keys) {
    if (timingSafeEqual(presented, Buffer.from(key.hash, "hex")) && matched === null) {
      matched = key.name;
    }
  }
  if (!matched) {
    return { ok: false, status: 401, code: "INVALID_TOKEN", error: "令牌无效或已停用。" };
  }
  return { ok: true, agent: matched };
}
