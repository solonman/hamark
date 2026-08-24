-- V1.9 二合一工作台重构：每人一个版本的版本链。
-- 与 db/v19-version-chain-schema.ts 中的 V19_VERSION_CHAIN_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 “V0.4 taxonomy contract drift” 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 本迁移是附加式的：只新增一张表、一个索引、一列，以及该表的 RLS 收口。
-- 不修改、不删除任何既有表、约束或触发器。可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS analysis_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  owner_name_snapshot TEXT NOT NULL,
  base_version_id TEXT REFERENCES analysis_versions(id),
  base_version_number INTEGER,
  base_payload_json JSONB,            -- 创建时固化的基版快照，用于「对比基版」
  base_captured_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  taxonomy_version TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  vocabulary_version TEXT NOT NULL,
  payload_schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, version_number),
  UNIQUE (workspace_id, owner_user_id),          -- 每人一个版本，由数据库兜底
  CHECK ((base_version_id IS NULL) = (base_version_number IS NULL))
);

CREATE INDEX IF NOT EXISTS analysis_versions_workspace_updated_idx
  ON analysis_versions (workspace_id, updated_at DESC);

-- 让审计记录能指出这次修订落在哪个版本上。
-- 可空，使迁移前已有的历史修订记录继续有效。
ALTER TABLE collaboration_revision_events
  ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES analysis_versions(id);

ALTER TABLE analysis_versions ENABLE ROW LEVEL SECURITY;

-- 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
-- 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
-- 与 db/v04-schema.ts 末尾的收口方式一致。
DO $v19_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE analysis_versions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE analysis_versions FROM authenticated';
  END IF;
END
$v19_revoke_public_roles$;

COMMIT;
