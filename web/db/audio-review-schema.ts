// 录音点评改写：点评任务表 + 版本表的「版本类型」。见 docs/25_录音点评改写_实施规格_V0.1.md 三、数据。
//
// 与 db/migrations/2026-10-10-audio-review.sql 逐条一致（tests/audio-review-schema.test.ts 断言）。
// 物理上落在既有表上的两处改动也放在这里，理由同 db/final-version-schema.ts 开头：
// db/v19-version-chain-schema.ts 与 2026-08-24 的历史迁移有逐条一致性测试，不能再补语句。
//   - analysis_versions 加 version_kind（PERSONAL / AUDIO_REVIEW）与 audio_review_id；
//   - 「每人一个版本」从整表 UNIQUE (workspace_id, owner_user_id) 改成只约束 PERSONAL 的
//     部分唯一索引：先建索引、再删旧约束，同一事务内完成，不留无约束的空档。
//     现有写入全是不带冲突目标的 ON CONFLICT DO NOTHING，部分唯一索引同样生效。

export const AUDIO_REVIEW_SCHEMA_TABLES = ["audio_reviews"] as const;

export const AUDIO_REVIEW_STATUSES = [
  "UPLOADING",
  "TRANSCRIBING",
  "UNDERSTANDING",
  "PENDING_CONFIRM",
  "GENERATED",
  "FAILED",
  "ABANDONED",
] as const;

export const AUDIO_REVIEW_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS audio_reviews (
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
  )`,
  // 一版作业只有一个在途或已生成的点评；放弃的不占位，可以重新上传。
  `CREATE UNIQUE INDEX IF NOT EXISTS audio_reviews_live_base_uidx ON audio_reviews (base_version_id) WHERE status <> 'ABANDONED'`,
  `CREATE INDEX IF NOT EXISTS audio_reviews_workspace_idx ON audio_reviews (workspace_id, created_at DESC)`,
  `ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS version_kind TEXT NOT NULL DEFAULT 'PERSONAL'`,
  `DO $audio_review_version_kind_check$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'analysis_versions'::regclass AND conname = 'analysis_versions_version_kind_check'
    ) THEN
      ALTER TABLE analysis_versions ADD CONSTRAINT analysis_versions_version_kind_check
        CHECK (version_kind IN ('PERSONAL', 'AUDIO_REVIEW'));
    END IF;
  END
  $audio_review_version_kind_check$`,
  `ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS audio_review_id TEXT REFERENCES audio_reviews(id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS analysis_versions_personal_owner_uidx ON analysis_versions (workspace_id, owner_user_id) WHERE version_kind = 'PERSONAL'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS analysis_versions_audio_review_base_uidx ON analysis_versions (base_version_id) WHERE version_kind = 'AUDIO_REVIEW'`,
  // 旧的整表唯一约束是建表时内联写的、没有显式命名，按列查出来再删；已删过就什么也不做。
  `DO $audio_review_drop_owner_unique$
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
  $audio_review_drop_owner_unique$`,
  `ALTER TABLE audio_reviews ENABLE ROW LEVEL SECURITY`,
  // 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
  // 等于关闭 anon/authenticated 的 PostgREST 通路。与 db/agent-token-schema.ts 末尾一致。
  `DO $audio_review_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${AUDIO_REVIEW_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${AUDIO_REVIEW_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $audio_review_revoke_public_roles$`,
] as const;
