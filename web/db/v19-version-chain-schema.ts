// V1.9 二合一工作台重构：每人一个版本的版本链表。附加式迁移，不修改既有表。
// 见 docs/18_V1.9_二合一工作台重构实施规格_V0.1.md 三、数据架构。

export const V19_VERSION_CHAIN_SCHEMA_TABLES = ["analysis_versions"] as const;

export const V19_VERSION_CHAIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS analysis_versions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS analysis_versions_workspace_updated_idx
    ON analysis_versions (workspace_id, updated_at DESC)`,
  // Lets the audit trail record which version a revision event landed in.
  // Nullable so pre-existing rows (recorded before this migration) stay valid.
  `ALTER TABLE collaboration_revision_events
    ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES analysis_versions(id)`,
  `ALTER TABLE analysis_versions ENABLE ROW LEVEL SECURITY`,
  // Runtime access only happens server-side through the BYPASSRLS pooler role;
  // RLS with no policies closes the anon/authenticated PostgREST path without
  // affecting any query. Mirrors the guard at the end of db/v04-schema.ts.
  `DO $v19_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${V19_VERSION_CHAIN_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${V19_VERSION_CHAIN_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $v19_revoke_public_roles$`,
] as const;
