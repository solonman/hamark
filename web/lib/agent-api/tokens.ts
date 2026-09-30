// 外部 Agent 令牌的增、查、停用。每个人只看得到、只停得了自己生成的令牌。
// 见 docs/23_外部Agent只读API_V0.1.md 二、鉴权。

import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import type { AgentTokenRecord } from "./auth";
import { mintAgentToken } from "./auth";
import { AgentApiError, isoOrNull } from "./params";

/** 一个人同时有效的令牌上限：够给几个 Agent 各发一枚，又不至于散落一地。 */
export const AGENT_TOKEN_ACTIVE_LIMIT = 10;
export const AGENT_TOKEN_NAME_MAX_LENGTH = 40;

export type AgentTokenView = {
  id: string;
  name: string;
  hint: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type TokenRow = QueryResultRow & {
  id: string;
  name: string;
  token_hint: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
};

function toView(row: TokenRow): AgentTokenView {
  return {
    id: row.id,
    name: row.name,
    hint: row.token_hint,
    createdAt: isoOrNull(row.created_at),
    lastUsedAt: isoOrNull(row.last_used_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

/** 令牌表还没建（迁移没执行）时，给一句人能看懂的话，而不是 500。 */
export function isMissingTokenTable(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "42P01"
    && String((error as { message?: unknown }).message ?? "").includes("agent_api_tokens");
}

export const MISSING_TOKEN_TABLE_MESSAGE =
  "令牌表尚未建立：请先在 Supabase 执行 web/db/migrations/2026-09-30-agent-api-tokens.sql。";

export function normalizeAgentTokenName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new AgentApiError(400, "INVALID_INPUT", "请给令牌起个名字，说明给哪个 Agent 用。");
  if ([...name].length > AGENT_TOKEN_NAME_MAX_LENGTH) {
    throw new AgentApiError(400, "INVALID_INPUT", `名字最多 ${AGENT_TOKEN_NAME_MAX_LENGTH} 个字。`);
  }
  return name;
}

export async function listAgentTokens(db: DbClient, ownerUserId: string): Promise<AgentTokenView[]> {
  const { results } = await db.prepare(
    `SELECT id, name, token_hint, created_at, last_used_at, revoked_at
    FROM agent_api_tokens WHERE owner_user_id = ?
    ORDER BY revoked_at IS NOT NULL, created_at DESC`,
  ).bind(ownerUserId).all<TokenRow>();
  return results.map(toView);
}

export async function createAgentToken(db: DbClient, ownerUserId: string, rawName: unknown) {
  const name = normalizeAgentTokenName(rawName);
  return db.withTransaction(async (tx) => {
    // 锁住主人那一行，两个并发的「生成」不会一起越过上限。
    await tx.prepare(`SELECT id FROM users WHERE id = ? FOR UPDATE`).bind(ownerUserId).first();
    const active = await tx.prepare(
      `SELECT COUNT(*)::int AS n FROM agent_api_tokens WHERE owner_user_id = ? AND revoked_at IS NULL`,
    ).bind(ownerUserId).first<{ n: number } & QueryResultRow>();
    if (Number(active?.n ?? 0) >= AGENT_TOKEN_ACTIVE_LIMIT) {
      throw new AgentApiError(409, "TOKEN_LIMIT", `同时有效的令牌最多 ${AGENT_TOKEN_ACTIVE_LIMIT} 枚，请先停用不用的。`);
    }
    const { token, hash, hint } = mintAgentToken();
    const row = await tx.prepare(
      `INSERT INTO agent_api_tokens (id, owner_user_id, name, token_hash, token_hint)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id, name, token_hint, created_at, last_used_at, revoked_at`,
    ).bind(`agent_token_${randomUUID()}`, ownerUserId, name, hash, hint).first<TokenRow>();
    return { token, view: toView(row!) };
  });
}

export async function revokeAgentToken(db: DbClient, ownerUserId: string, tokenId: string): Promise<AgentTokenView> {
  // 只认自己的：别人的令牌 id 在这里等同于不存在。已停用的再点一次按幂等处理。
  const row = await db.prepare(
    `UPDATE agent_api_tokens SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ? AND owner_user_id = ?
    RETURNING id, name, token_hint, created_at, last_used_at, revoked_at`,
  ).bind(tokenId, ownerUserId).first<TokenRow>();
  if (!row) throw new AgentApiError(404, "TOKEN_NOT_FOUND", "令牌不存在。");
  return toView(row);
}

/** Agent 调用时按哈希找未停用的令牌与主人当前的名字、状态。 */
export async function findActiveAgentToken(db: DbClient, tokenHash: string): Promise<AgentTokenRecord | null> {
  const row = await db.prepare(
    `SELECT t.id, t.name, u.display_name, u.status
    FROM agent_api_tokens t JOIN users u ON u.id = t.owner_user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
  ).bind(tokenHash).first<QueryResultRow & { id: string; name: string; display_name: string; status: string }>();
  return row ? { id: row.id, name: row.name, ownerName: row.display_name, ownerStatus: row.status } : null;
}

/** 记最近一次使用时间，给主人看「这枚还在不在用」。五分钟内不重复写，免得每次调用都落一笔。 */
export async function touchAgentToken(db: DbClient, tokenId: string): Promise<void> {
  await db.prepare(
    `UPDATE agent_api_tokens SET last_used_at = now()
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
  ).bind(tokenId).run();
}
