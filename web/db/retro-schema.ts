// 客户需求复盘库的地基：案例、回合、附件（需求凭证与回合附件同表）、关联作品、点评录音、
// 月度整理任务、已发布版本、方法候选。见 docs/26_客户需求复盘库_实施规格_V0.1.md 八、数据。
//
// 与生产迁移逐条一致（tests/retro-schema.test.ts 断言）：RETRO_LIBRARY_STATEMENTS 对应
// db/migrations/2026-10-19-retro-library.sql，RETRO_DOC_PREVIEW_STATEMENTS 对应
// db/migrations/2026-10-20-retro-doc-preview.sql；两份合起来就是 RETRO_SCHEMA_STATEMENTS。
// 是独立表族，不挂 V0.4 契约、不建版本链（规格 4.1，理由同 docs/22 2.3）。
// 时间列一律 TIMESTAMPTZ + now()，不写 CURRENT_TIMESTAMP（会被 normalizeSql 改写成文本，docs/25 3.2）。
// 已发布版本与方法候选只增不改；二期方法库在它们上面另建审定关系，不回写这里。

export const RETRO_SCHEMA_TABLES = [
  "retro_cases",
  "retro_case_rounds",
  "retro_case_assets",
  "retro_round_links",
  "retro_recordings",
  "retro_month_jobs",
  "retro_month_publications",
  "retro_method_candidates",
] as const;

export const RETRO_RECORDING_STATUSES = ["UPLOADING", "TRANSCRIBING", "READY", "FAILED", "REMOVED"] as const;
export const RETRO_ASSET_TYPES = ["IMAGE", "VIDEO", "AUDIO", "DOC"] as const;
export const RETRO_DOC_FORMATS = ["PDF", "WORD", "EXCEL", "PPT"] as const;
export const RETRO_TRANSCRIBE_STATUSES = ["NONE", "TRANSCRIBING", "READY", "FAILED"] as const;
export const RETRO_LINK_KINDS = ["VIDEO", "REPORT", "VISUAL"] as const;
export const RETRO_JOB_STATUSES = [
  "QUEUED",
  "EXTRACTING",
  "SUMMARIZING",
  "DISTILLING",
  "PENDING_REVIEW",
  "PUBLISHED",
  "FAILED",
  "ABANDONED",
] as const;
export const RETRO_JOB_FAILED_STEPS = ["EXTRACT", "SUMMARIZE", "DISTILL"] as const;
export const RETRO_METHOD_DIMENSIONS = ["ENTRY", "INFO", "PATH", "VALUE", "SOLUTION", "INTERACTION"] as const;
export const RETRO_METHOD_KINDS = ["METHOD", "INTUITION", "SITUATIONAL"] as const;
export const RETRO_METHOD_TRANSFERS = ["TRANSFERABLE", "CASE_ONLY", "UNSURE"] as const;

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

export const RETRO_LIBRARY_STATEMENTS = [
  // 案例主表。month_key 是复盘月份（YYYY-MM），按它归组；background（任务与最初需求）选填（规格 4.2）。
  `CREATE TABLE IF NOT EXISTS retro_cases (
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
  )`,
  // 回合：软删除，已发布成果里的「第 N 版」标记仍能找到它。
  `CREATE TABLE IF NOT EXISTS retro_case_rounds (
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
  )`,
  // 附件：round_id 为空 = 「任务与最初需求」的需求凭证；非空 = 挂在该回合上（规格 4.3）。
  // 列与 visual_case_assets 一致；AUDIO（客户录音）另有转写列，含义同 retro_recordings。
  // 移除附件是真删（规格 4.3，同 docs/22 决定 #20），所以这里没有 deleted_at。
  `CREATE TABLE IF NOT EXISTS retro_case_assets (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES retro_cases(id),
    round_id TEXT REFERENCES retro_case_rounds(id),
    type TEXT NOT NULL CONSTRAINT retro_case_assets_type_check CHECK (type IN (${list(RETRO_ASSET_TYPES)})),
    doc_format TEXT CONSTRAINT retro_case_assets_doc_format_check CHECK (doc_format IS NULL OR doc_format IN (${list(RETRO_DOC_FORMATS)})),
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
    transcribe_status TEXT NOT NULL DEFAULT 'NONE' CONSTRAINT retro_case_assets_transcribe_status_check CHECK (transcribe_status IN (${list(RETRO_TRANSCRIBE_STATUSES)})),
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
  )`,
  // 关联作品：只存指向，原作品删除后关联保留、界面显示「原作品已删除」（规格 4.4）。
  `CREATE TABLE IF NOT EXISTS retro_round_links (
    round_id TEXT NOT NULL REFERENCES retro_case_rounds(id),
    target_kind TEXT NOT NULL CONSTRAINT retro_round_links_target_kind_check CHECK (target_kind IN (${list(RETRO_LINK_KINDS)})),
    target_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (round_id, target_kind, target_id)
  )`,
  // 点评录音：case_id 为空 = 当月的整场总结。移除是软删除（status = REMOVED），行和对象都保留。
  `CREATE TABLE IF NOT EXISTS retro_recordings (
    id TEXT PRIMARY KEY,
    month_key TEXT NOT NULL CONSTRAINT retro_recordings_month_key_check CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    case_id TEXT REFERENCES retro_cases(id),
    part_no INTEGER NOT NULL CONSTRAINT retro_recordings_part_no_check CHECK (part_no BETWEEN 1 AND 3),
    status TEXT NOT NULL CONSTRAINT retro_recordings_status_check CHECK (status IN (${list(RETRO_RECORDING_STATUSES)})),
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
  )`,
  // 案例内段号唯一、总结内段号唯一（都排除已移除的）。
  `CREATE UNIQUE INDEX IF NOT EXISTS retro_recordings_case_part_uidx ON retro_recordings (case_id, part_no) WHERE case_id IS NOT NULL AND status <> 'REMOVED'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS retro_recordings_summary_part_uidx ON retro_recordings (month_key, part_no) WHERE case_id IS NULL AND status <> 'REMOVED'`,
  // 月度整理任务（规格 6.2）。extractions_json 按案例输入哈希缓存逐案提炼的结果。
  `CREATE TABLE IF NOT EXISTS retro_month_jobs (
    id TEXT PRIMARY KEY,
    month_key TEXT NOT NULL CONSTRAINT retro_month_jobs_month_key_check CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    status TEXT NOT NULL CONSTRAINT retro_month_jobs_status_check CHECK (status IN (${list(RETRO_JOB_STATUSES)})),
    progress_index INTEGER NOT NULL DEFAULT 0,
    failed_step TEXT CONSTRAINT retro_month_jobs_failed_step_check CHECK (failed_step IS NULL OR failed_step IN (${list(RETRO_JOB_FAILED_STEPS)})),
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
  )`,
  // 同一个月同时只能有一个未结束的任务。
  `CREATE UNIQUE INDEX IF NOT EXISTS retro_month_jobs_live_uidx ON retro_month_jobs (month_key) WHERE status NOT IN ('PUBLISHED', 'ABANDONED')`,
  // 已发布版本：只增不改。quoted_segments_json 是被引用片段的原文快照，录音以后被移除也照样能显示。
  `CREATE TABLE IF NOT EXISTS retro_month_publications (
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
  )`,
  // 方法候选：发布时从 methods_json 逐条写入，供二期方法库使用；只增不改。
  `CREATE TABLE IF NOT EXISTS retro_method_candidates (
    id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES retro_month_publications(id),
    month_key TEXT NOT NULL,
    number INTEGER NOT NULL,
    dimension TEXT NOT NULL CONSTRAINT retro_method_candidates_dimension_check CHECK (dimension IN (${list(RETRO_METHOD_DIMENSIONS)})),
    kind TEXT NOT NULL CONSTRAINT retro_method_candidates_kind_check CHECK (kind IN (${list(RETRO_METHOD_KINDS)})),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    situation TEXT NOT NULL DEFAULT '',
    transfer TEXT NOT NULL CONSTRAINT retro_method_candidates_transfer_check CHECK (transfer IN (${list(RETRO_METHOD_TRANSFERS)})),
    transfer_note TEXT NOT NULL DEFAULT '',
    sources_json JSONB NOT NULL,
    origin TEXT NOT NULL CONSTRAINT retro_method_candidates_origin_check CHECK (origin IN ('AI', 'MANUAL')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS retro_cases_month_created_idx ON retro_cases (month_key, created_at DESC) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS retro_case_rounds_case_position_idx ON retro_case_rounds (case_id, position)`,
  `CREATE INDEX IF NOT EXISTS retro_case_assets_case_idx ON retro_case_assets (case_id, round_id, position)`,
  `CREATE INDEX IF NOT EXISTS retro_recordings_case_idx ON retro_recordings (case_id)`,
  `CREATE INDEX IF NOT EXISTS retro_recordings_month_idx ON retro_recordings (month_key)`,
  `CREATE INDEX IF NOT EXISTS retro_month_publications_month_idx ON retro_month_publications (month_key, version_number DESC)`,
  `CREATE INDEX IF NOT EXISTS retro_method_candidates_month_idx ON retro_method_candidates (month_key)`,
  ...RETRO_SCHEMA_TABLES.map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),
  // 运行时只走服务端 BYPASSRLS 连接；开启 RLS 且不建策略，等于关掉 anon/authenticated 的
  // PostgREST 通道。与 db/visual-schema.ts、db/audio-review-schema.ts 末尾一致。
  `DO $retro_schema_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${RETRO_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${RETRO_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $retro_schema_revoke_public_roles$`,
] as const;

/**
 * 文档逐页预览（docs/26 4.3「全部在站内弹层预览」，2026-10-20）：PDF／Word／Excel／PPT complete 后
 * 由数据万象 doc_jobs 转成逐页图片（大图 1600w、小图 480w 两个任务），没有回调，详情接口顺手轮询收口。
 * derivative_status 复用为转换状态（PENDING／READY／FAILED），失败原因写 derivative_error。
 * pages_json 每页 { pageNo, ok }（转换成功时另带两档对象键）。只加列，可重复执行，不改旧数据。
 */
export const RETRO_DOC_PREVIEW_STATEMENTS = [
  `ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS ci_job_large TEXT`,
  `ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS ci_job_small TEXT`,
  `ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS ci_checked_at TIMESTAMPTZ`,
  `ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS page_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS pages_json JSONB`,
] as const;

export const RETRO_SCHEMA_STATEMENTS = [...RETRO_LIBRARY_STATEMENTS, ...RETRO_DOC_PREVIEW_STATEMENTS] as const;
