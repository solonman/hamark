// 外部 Agent 只读接口的令牌表。见 docs/23_外部Agent只读API_V0.1.md 二、鉴权。
// 附加式：只新增 agent_api_tokens 一张表，不动任何既有表。
//
// 令牌由老孙在站内自己生成（/agent-tokens），明文只在生成那一刻返回一次，
// 库里只存 SHA-256；停用是写 revoked_at，不删行，调用记录可追溯。

export const AGENT_TOKEN_SCHEMA_TABLES = ["agent_api_tokens"] as const;

export const AGENT_TOKEN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_api_tokens (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS agent_api_tokens_owner_idx ON agent_api_tokens (owner_user_id, created_at DESC)`,
  `ALTER TABLE agent_api_tokens ENABLE ROW LEVEL SECURITY`,
  // 运行时只走服务端 BYPASSRLS 连接；开启 RLS 且不建策略，等于关掉
  // anon/authenticated 的 PostgREST 通道。与 db/visual-schema.ts 末尾的守卫一致。
  `DO $agent_token_schema_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${AGENT_TOKEN_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${AGENT_TOKEN_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $agent_token_schema_revoke_public_roles$`,
] as const;
