-- 外部 Agent 只读接口的令牌表（docs/23_外部Agent只读API_V0.1.md）。
-- 与 db/agent-token-schema.ts 中的 AGENT_TOKEN_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产（会被 V0.4 契约漂移守卫中止）。
--
-- 本迁移是附加式的：只新增 agent_api_tokens 一张表、一个索引及其 RLS 收口。
-- 不修改、不删除任何既有表、约束或触发器。可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS agent_api_tokens (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_api_tokens_owner_idx ON agent_api_tokens (owner_user_id, created_at DESC);

ALTER TABLE agent_api_tokens ENABLE ROW LEVEL SECURITY;

DO $agent_token_schema_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE agent_api_tokens FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE agent_api_tokens FROM authenticated';
  END IF;
END
$agent_token_schema_revoke_public_roles$;

COMMIT;
