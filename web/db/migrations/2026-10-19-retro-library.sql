-- 客户需求复盘库（docs/26_客户需求复盘库_实施规格_V0.1.md 八、数据）。
-- 与 db/retro-schema.ts 中的 RETRO_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件；执行成功后再推送代码。
-- 不要用 `npm run db:migrate` 应用到生产（会被 V0.4 契约漂移守卫中止）。
--
-- 改动：只新增 8 张 retro_* 表及其索引、RLS 收口；不碰任何既有表和数据。可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS retro_cases (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL CONSTRAINT retro_cases_month_key_check CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  department TEXT NOT NULL,
  client_name TEXT NOT NULL,
  title TEXT NOT NULL,
  scene_tags_json JSONB NOT NULL DEFAULT '[]',
  background TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  turning_points TEXT NOT NULL DEFAULT '',
  discussion_questions TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS retro_case_rounds (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES retro_cases(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  occurred_on TEXT NOT NULL DEFAULT '',
  delivery_text TEXT NOT NULL DEFAULT '',
  feedback_text TEXT NOT NULL DEFAULT '',
  response_text TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS retro_case_assets (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES retro_cases(id),
  round_id TEXT REFERENCES retro_case_rounds(id),
  type TEXT NOT NULL CONSTRAINT retro_case_assets_type_check CHECK (type IN ('IMAGE', 'VIDEO', 'AUDIO', 'DOC')),
  doc_format TEXT CONSTRAINT retro_case_assets_doc_format_check CHECK (doc_format IS NULL OR doc_format IN ('PDF', 'WORD', 'EXCEL', 'PPT')),
  position INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  display_key TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size BIGINT NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  upload_status TEXT NOT NULL DEFAULT 'UPLOADING',
  derivative_status TEXT NOT NULL DEFAULT 'PENDING',
  derivative_error TEXT,
  derivative_requested_at TIMESTAMPTZ,
  transcribe_status TEXT NOT NULL DEFAULT 'NONE' CONSTRAINT retro_case_assets_transcribe_status_check CHECK (transcribe_status IN ('NONE', 'TRANSCRIBING', 'READY', 'FAILED')),
  transcribe_fail_reason TEXT,
  audio_duration_ms INTEGER,
  asr_engine TEXT,
  asr_task_id TEXT,
  asr_submitted_at TIMESTAMPTZ,
  asr_checked_at TIMESTAMPTZ,
  transcript_json JSONB,
  lease_until TIMESTAMPTZ,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retro_round_links (
  round_id TEXT NOT NULL REFERENCES retro_case_rounds(id),
  target_kind TEXT NOT NULL CONSTRAINT retro_round_links_target_kind_check CHECK (target_kind IN ('VIDEO', 'REPORT', 'VISUAL')),
  target_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS retro_recordings (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL CONSTRAINT retro_recordings_month_key_check CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  case_id TEXT REFERENCES retro_cases(id),
  part_no INTEGER NOT NULL CONSTRAINT retro_recordings_part_no_check CHECK (part_no BETWEEN 1 AND 3),
  status TEXT NOT NULL CONSTRAINT retro_recordings_status_check CHECK (status IN ('UPLOADING', 'TRANSCRIBING', 'READY', 'FAILED', 'REMOVED')),
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
  speaker_labels_json JSONB,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  uploaded_by_name TEXT NOT NULL,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_at TIMESTAMPTZ,
  transcribed_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  removed_by_user_id TEXT REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS retro_recordings_case_part_uidx ON retro_recordings (case_id, part_no) WHERE case_id IS NOT NULL AND status <> 'REMOVED';

CREATE UNIQUE INDEX IF NOT EXISTS retro_recordings_summary_part_uidx ON retro_recordings (month_key, part_no) WHERE case_id IS NULL AND status <> 'REMOVED';

CREATE TABLE IF NOT EXISTS retro_month_jobs (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL CONSTRAINT retro_month_jobs_month_key_check CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status TEXT NOT NULL CONSTRAINT retro_month_jobs_status_check CHECK (status IN ('QUEUED', 'EXTRACTING', 'SUMMARIZING', 'DISTILLING', 'PENDING_REVIEW', 'PUBLISHED', 'FAILED', 'ABANDONED')),
  progress_index INTEGER NOT NULL DEFAULT 0,
  failed_step TEXT CONSTRAINT retro_month_jobs_failed_step_check CHECK (failed_step IS NULL OR failed_step IN ('EXTRACT', 'SUMMARIZE', 'DISTILL')),
  fail_reason TEXT,
  based_on_publication_id TEXT,
  input_snapshot_json JSONB,
  input_content_hash TEXT,
  extractions_json JSONB,
  minutes_json JSONB,
  methods_json JSONB,
  draft_revision INTEGER NOT NULL DEFAULT 1,
  llm_model TEXT,
  prompt_versions_json JSONB,
  llm_attempts INTEGER NOT NULL DEFAULT 0,
  llm_usage_json JSONB,
  relay_seq INTEGER NOT NULL DEFAULT 0,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS retro_month_jobs_live_uidx ON retro_month_jobs (month_key) WHERE status NOT IN ('PUBLISHED', 'ABANDONED');

CREATE TABLE IF NOT EXISTS retro_month_publications (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  job_id TEXT NOT NULL REFERENCES retro_month_jobs(id),
  case_ids_json JSONB NOT NULL,
  minutes_json JSONB NOT NULL,
  methods_json JSONB NOT NULL,
  quoted_segments_json JSONB NOT NULL,
  published_by_user_id TEXT NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (month_key, version_number)
);

CREATE TABLE IF NOT EXISTS retro_method_candidates (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES retro_month_publications(id),
  month_key TEXT NOT NULL,
  number INTEGER NOT NULL,
  dimension TEXT NOT NULL CONSTRAINT retro_method_candidates_dimension_check CHECK (dimension IN ('ENTRY', 'INFO', 'PATH', 'VALUE', 'SOLUTION', 'INTERACTION')),
  kind TEXT NOT NULL CONSTRAINT retro_method_candidates_kind_check CHECK (kind IN ('METHOD', 'INTUITION', 'SITUATIONAL')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '',
  transfer TEXT NOT NULL CONSTRAINT retro_method_candidates_transfer_check CHECK (transfer IN ('TRANSFERABLE', 'CASE_ONLY', 'UNSURE')),
  transfer_note TEXT NOT NULL DEFAULT '',
  sources_json JSONB NOT NULL,
  origin TEXT NOT NULL CONSTRAINT retro_method_candidates_origin_check CHECK (origin IN ('AI', 'MANUAL')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retro_cases_month_created_idx ON retro_cases (month_key, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS retro_case_rounds_case_position_idx ON retro_case_rounds (case_id, position);

CREATE INDEX IF NOT EXISTS retro_case_assets_case_idx ON retro_case_assets (case_id, round_id, position);

CREATE INDEX IF NOT EXISTS retro_recordings_case_idx ON retro_recordings (case_id);

CREATE INDEX IF NOT EXISTS retro_recordings_month_idx ON retro_recordings (month_key);

CREATE INDEX IF NOT EXISTS retro_month_publications_month_idx ON retro_month_publications (month_key, version_number DESC);

CREATE INDEX IF NOT EXISTS retro_method_candidates_month_idx ON retro_method_candidates (month_key);

ALTER TABLE retro_cases ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_case_rounds ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_case_assets ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_round_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_recordings ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_month_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_month_publications ENABLE ROW LEVEL SECURITY;

ALTER TABLE retro_method_candidates ENABLE ROW LEVEL SECURITY;

DO $retro_schema_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE retro_cases, retro_case_rounds, retro_case_assets, retro_round_links, retro_recordings, retro_month_jobs, retro_month_publications, retro_method_candidates FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE retro_cases, retro_case_rounds, retro_case_assets, retro_round_links, retro_recordings, retro_month_jobs, retro_month_publications, retro_method_candidates FROM authenticated';
  END IF;
END
$retro_schema_revoke_public_roles$;

COMMIT;
