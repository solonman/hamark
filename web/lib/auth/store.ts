import { randomUUID } from "node:crypto";
import { getDbClient, type DbClient, type QueryResultRow } from "@/db";
import type { EncryptedSecret } from "./security.ts";
import type { AuthFlow, CurrentUser, WeComMember } from "./types.ts";

export type { CurrentUser, WeComMember } from "./types.ts";

export type NewOAuthState = {
  id: string;
  stateHash: string;
  browserNonceHash: string;
  returnTo: string;
  flowType: AuthFlow;
  expiresAt: string;
  createdAt: string;
};

export type OAuthStateRecord = NewOAuthState & {
  consumedAt: string | null;
};

export type NewSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
};

export type EncryptedAppToken = {
  corpId: string;
  agentId: string;
  token: EncryptedSecret;
  expiresAt: string;
  updatedAt: string;
};

export interface AuthStore {
  createOAuthState(input: NewOAuthState): Promise<void>;
  consumeOAuthState(stateHash: string, nonceHash: string, now: string): Promise<OAuthStateRecord | null>;
  syncUser(corpId: string, member: WeComMember, identityKey: string, now: string): Promise<CurrentUser>;
  createSession(input: NewSession): Promise<void>;
  getSession(tokenHash: string, now: string): Promise<CurrentUser | null>;
  revokeSession(tokenHash: string, now: string): Promise<void>;
  getAppToken(corpId: string, agentId: string, now: string): Promise<EncryptedAppToken | null>;
  putAppToken(input: EncryptedAppToken): Promise<void>;
  withAppTokenRefreshLock<T>(corpId: string, agentId: string, operation: () => Promise<T>): Promise<T>;
}

type OAuthStateRow = QueryResultRow & {
  id: string;
  state_hash: string;
  browser_nonce_hash: string;
  return_to: string;
  flow_type: AuthFlow;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type UserRow = QueryResultRow & {
  id: string;
  identity_key: string;
  display_name: string;
  avatar_url: string | null;
  email: string | null;
};

type UserWithDepartmentRow = UserRow & {
  department_id: string | null;
  department_name: string | null;
  is_primary: number | string | boolean | null;
};

type AppTokenRow = QueryResultRow & {
  corp_id: string;
  agent_id: string;
  token_ciphertext: string;
  token_iv: string;
  expires_at: string;
  updated_at: string;
};

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: DbClient = getDbClient()) {}

  async createOAuthState(input: NewOAuthState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_states (
          id, state_hash, browser_nonce_hash, return_to, flow_type, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.stateHash,
        input.browserNonceHash,
        input.returnTo,
        input.flowType,
        input.expiresAt,
        input.createdAt,
      )
      .run();
  }

  async consumeOAuthState(
    stateHash: string,
    nonceHash: string,
    now: string,
  ): Promise<OAuthStateRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE oauth_states
        SET consumed_at = ?
        WHERE state_hash = ?
          AND browser_nonce_hash = ?
          AND consumed_at IS NULL
          AND expires_at > ?
        RETURNING id, state_hash, browser_nonce_hash, return_to, flow_type, expires_at, consumed_at, created_at`,
      )
      .bind(now, stateHash, nonceHash, now)
      .first<OAuthStateRow>();

    return row ? mapOAuthState(row) : null;
  }

  async syncUser(
    corpId: string,
    member: WeComMember,
    identityKey: string,
    now: string,
  ): Promise<CurrentUser> {
    return this.db.withTransaction(async (db) => {
      await acquireAdvisoryLock(db, `wecom-user:${corpId}:${member.userId}`);
      await acquireAdvisoryLock(db, `identity:${identityKey}`);

      const existingRows = (
        await db
          .prepare(
            `SELECT id
            FROM users
            WHERE (wecom_corp_id = ? AND wecom_user_id = ?) OR identity_key = ?
            FOR UPDATE`,
          )
          .bind(corpId, member.userId, identityKey)
          .all<{ id: string } & QueryResultRow>()
      ).results;
      const existingIds = Array.from(new Set(existingRows.map((row) => row.id)));
      if (existingIds.length > 1) {
        throw new Error(
          `Auth identity conflict for corp/user ${corpId}/${member.userId} and ${identityKey}`,
        );
      }
      const userId = existingIds[0] ?? randomUUID();

      if (existingIds.length > 0) {
        await db
          .prepare(
            `UPDATE users
            SET wecom_corp_id = ?,
              wecom_user_id = ?,
              identity_key = ?,
              display_name = ?,
              avatar_url = ?,
              email = ?,
              status = 'ACTIVE',
              last_login_at = ?,
              last_synced_at = ?,
              updated_at = ?
            WHERE id = ?`,
          )
          .bind(
            corpId,
            member.userId,
            identityKey,
            member.displayName,
            member.avatarUrl,
            member.email,
            now,
            now,
            now,
            userId,
          )
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO users (
              id, wecom_corp_id, wecom_user_id, identity_key, display_name, avatar_url, email,
              status, last_login_at, last_synced_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
          )
          .bind(
            userId,
            corpId,
            member.userId,
            identityKey,
            member.displayName,
            member.avatarUrl,
            member.email,
            now,
            now,
            now,
            now,
          )
          .run();
      }

      await db.prepare(`DELETE FROM user_departments WHERE user_id = ?`).bind(userId).run();
      await db.batch(
        dedupeDepartments(member.departments).map((department) =>
          db
            .prepare(
              `INSERT INTO user_departments (
                user_id, wecom_department_id, department_name, is_primary, synced_at
              ) VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(userId, department.id, department.name, department.isPrimary ? 1 : 0, now),
        ),
      );

      const user = await readCurrentUser(db, userId);
      if (!user) {
        throw new Error(`Unable to read synced user ${userId}`);
      }
      return user;
    });
  }

  async createSession(input: NewSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO auth_sessions (
          id, user_id, token_hash, expires_at, last_seen_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.id, input.userId, input.tokenHash, input.expiresAt, input.lastSeenAt, input.createdAt)
      .run();
  }

  async getSession(tokenHash: string, now: string): Promise<CurrentUser | null> {
    const rows = (
      await this.db
        .prepare(
          `WITH touched_session AS (
            UPDATE auth_sessions
            SET last_seen_at = ?
            WHERE token_hash = ?
              AND revoked_at IS NULL
              AND expires_at > ?
            RETURNING user_id
          )
          SELECT
            u.id,
            u.identity_key,
            u.display_name,
            u.avatar_url,
            u.email,
            ud.wecom_department_id AS department_id,
            ud.department_name,
            ud.is_primary
          FROM touched_session s
          JOIN users u ON u.id = s.user_id
          LEFT JOIN user_departments ud ON ud.user_id = u.id
          WHERE u.status = 'ACTIVE'
          ORDER BY ud.is_primary DESC, ud.department_name, ud.wecom_department_id`,
        )
        .bind(now, tokenHash, now)
        .all<UserWithDepartmentRow>()
    ).results;

    if (rows.length === 0) {
      return null;
    }

    return rowsToCurrentUser(rows);
  }

  async revokeSession(tokenHash: string, now: string): Promise<void> {
    await this.db
      .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .bind(now, tokenHash)
      .run();
  }

  async getAppToken(corpId: string, agentId: string, now: string): Promise<EncryptedAppToken | null> {
    const row = await this.db
      .prepare(
        `SELECT corp_id, agent_id, token_ciphertext, token_iv, expires_at, updated_at
        FROM wecom_app_tokens
        WHERE corp_id = ? AND agent_id = ? AND expires_at > ?`,
      )
      .bind(corpId, agentId, now)
      .first<AppTokenRow>();

    return row ? mapAppToken(row) : null;
  }

  async putAppToken(input: EncryptedAppToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO wecom_app_tokens (
          corp_id, agent_id, token_ciphertext, token_iv, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (corp_id, agent_id) DO UPDATE SET
          token_ciphertext = excluded.token_ciphertext,
          token_iv = excluded.token_iv,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        input.corpId,
        input.agentId,
        input.token.ciphertext,
        input.token.iv,
        input.expiresAt,
        input.updatedAt,
      )
      .run();
  }

  async withAppTokenRefreshLock<T>(
    corpId: string,
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.db.withTransaction(async (db) => {
      await acquireAdvisoryLock(db, `wecom-app-token:${corpId}:${agentId}`);
      return operation();
    });
  }
}

async function acquireAdvisoryLock(db: DbClient, key: string): Promise<void> {
  await db.prepare(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`).bind(key).run();
}

async function readCurrentUser(db: DbClient, userId: string): Promise<CurrentUser | null> {
  const rows = (
    await db
      .prepare(
        `SELECT
          u.id,
          u.identity_key,
          u.display_name,
          u.avatar_url,
          u.email,
          ud.wecom_department_id AS department_id,
          ud.department_name,
          ud.is_primary
        FROM users u
        LEFT JOIN user_departments ud ON ud.user_id = u.id
        WHERE u.id = ?
        ORDER BY ud.is_primary DESC, ud.department_name, ud.wecom_department_id`,
      )
      .bind(userId)
      .all<UserWithDepartmentRow>()
  ).results;

  return rows.length > 0 ? rowsToCurrentUser(rows) : null;
}

function rowsToCurrentUser(rows: UserWithDepartmentRow[]): CurrentUser {
  const first = rows[0];
  const departmentsById = new Map<string, { id: string; name: string; isPrimary: boolean }>();
  for (const row of rows) {
    if (!row.department_id || !row.department_name || departmentsById.has(row.department_id)) {
      continue;
    }
    departmentsById.set(row.department_id, {
      id: row.department_id,
      name: row.department_name,
      isPrimary: row.is_primary === 1 || row.is_primary === "1" || row.is_primary === true,
    });
  }

  return {
    id: first.id,
    identityKey: first.identity_key,
    displayName: first.display_name,
    avatarUrl: first.avatar_url,
    email: first.email,
    departments: Array.from(departmentsById.values()),
  };
}

function dedupeDepartments(departments: WeComMember["departments"]) {
  const byId = new Map<string, WeComMember["departments"][number]>();
  for (const department of departments) {
    byId.set(department.id, department);
  }
  return Array.from(byId.values());
}

function mapOAuthState(row: OAuthStateRow): OAuthStateRecord {
  return {
    id: row.id,
    stateHash: row.state_hash,
    browserNonceHash: row.browser_nonce_hash,
    returnTo: row.return_to,
    flowType: row.flow_type,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapAppToken(row: AppTokenRow): EncryptedAppToken {
  return {
    corpId: row.corp_id,
    agentId: row.agent_id,
    token: {
      ciphertext: row.token_ciphertext,
      iv: row.token_iv,
    },
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}
