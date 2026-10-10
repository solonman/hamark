-- 录音点评改写（docs/25_录音点评改写_实施规格_V0.1.md 三、数据）。
-- 与 db/audio-review-schema.ts 中的 AUDIO_REVIEW_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件；执行成功后再推送代码。
-- 不要用 `npm run db:migrate` 应用到生产（会被 V0.4 契约漂移守卫中止）。
--
-- 改动：
--   1. 新增 audio_reviews 表（点评任务）及索引、RLS 收口；
--   2. analysis_versions 新增 version_kind（默认 'PERSONAL'，现有行全部是个人版本）与 audio_review_id 两列；
--   3. 「每人一个版本」改为只约束个人版本：先建部分唯一索引，再删旧的整表唯一约束（同一事务内，不留空档）。
-- 不删除、不改写任何既有数据。可重复执行。迁移后旧代码照常工作（此时还没有点评版行）。

BEGIN;

CREATE TABLE IF NOT EXISTS audio_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  base_version_id TEXT NOT NULL REFERENCES analysis_versions(id),
  base_version_number INTEGER NOT NULL,
  base_owner_name TEXT NOT NULL,
  base_payload_json JSONB NOT NULL,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id),
  reviewer_name TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT audio_reviews_status_check CHECK (status IN ('UPLOADING', 'TRANSCRIBING', 'UNDERSTANDING', 'PENDING_CONFIRM', 'GENERATED', 'FAILED', 'ABANDONED')),
  failed_step TEXT CONSTRAINT audio_reviews_failed_step_check CHECK (failed_step IS NULL OR failed_step IN ('UPLOAD', 'TRANSCRIBE', 'UNDERSTAND')),
  fail_reason TEXT,
  audio_object_key TEXT NOT NULL,
  audio_file_name TEXT NOT NULL,
  audio_content_type TEXT NOT NULL,
  audio_size_bytes BIGINT NOT NULL CHECK (audio_size_bytes > 0),
  audio_duration_ms INTEGER,
  asr_engine TEXT,
  asr_task_id TEXT,
  asr_submitted_at TIMESTAMPTZ,
  asr_checked_at TIMESTAMPTZ,
  transcript_json JSONB,
  llm_model TEXT,
  prompt_version TEXT,
  llm_attempts INTEGER NOT NULL DEFAULT 0,
  llm_started_at TIMESTAMPTZ,
  llm_finished_at TIMESTAMPTZ,
  llm_usage_json JSONB,
  input_content_hash TEXT,
  proposal_json JSONB,
  selected_change_ids JSONB,
  review_version_id TEXT REFERENCES analysis_versions(id),
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_at TIMESTAMPTZ,
  proposed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS audio_reviews_live_base_uidx ON audio_reviews (base_version_id) WHERE status <> 'ABANDONED';

CREATE INDEX IF NOT EXISTS audio_reviews_workspace_idx ON audio_reviews (workspace_id, created_at DESC);

ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS version_kind TEXT NOT NULL DEFAULT 'PERSONAL';

DO $audio_review_version_kind_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'analysis_versions'::regclass AND conname = 'analysis_versions_version_kind_check'
  ) THEN
    ALTER TABLE analysis_versions ADD CONSTRAINT analysis_versions_version_kind_check
      CHECK (version_kind IN ('PERSONAL', 'AUDIO_REVIEW'));
  END IF;
END
$audio_review_version_kind_check$;

ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS audio_review_id TEXT REFERENCES audio_reviews(id);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_versions_personal_owner_uidx ON analysis_versions (workspace_id, owner_user_id) WHERE version_kind = 'PERSONAL';

CREATE UNIQUE INDEX IF NOT EXISTS analysis_versions_audio_review_base_uidx ON analysis_versions (base_version_id) WHERE version_kind = 'AUDIO_REVIEW';

DO $audio_review_drop_owner_unique$
DECLARE
  owner_unique_name TEXT;
BEGIN
  SELECT c.conname INTO owner_unique_name
  FROM pg_constraint c
  WHERE c.conrelid = 'analysis_versions'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname::text)
      FROM unnest(c.conkey) AS k(attnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    ) = ARRAY['owner_user_id', 'workspace_id']::text[];
  IF owner_unique_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE analysis_versions DROP CONSTRAINT %I', owner_unique_name);
  END IF;
END
$audio_review_drop_owner_unique$;

ALTER TABLE audio_reviews ENABLE ROW LEVEL SECURITY;

DO $audio_review_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE audio_reviews FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE audio_reviews FROM authenticated';
  END IF;
END
$audio_review_revoke_public_roles$;

COMMIT;
