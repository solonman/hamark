// 报告逆向工程地基：报告主表、页、相关资料、版本链，以及互动与评审三张表。
// 报告是独立域，不挂视频侧的 V0.4 契约（collaboration_workspaces／词表版本那套）——
// 那套契约是为镜头字段服务的，报告用不上，硬挂只会把两边绑死。
// 版本链复用 V1.9 的规则（每人一版、基版快照、默认最新版），但不复用它的表：
// 报告没有时间线，级联规则也不搬过来。互动与评审三张表结构照抄视频侧的
// case-engagement-schema.ts，只把外键换成报告。
// 见 docs/19_报告逆向工程_实施规格_V0.1.md 三、数据架构。附加式迁移，不修改既有表。

export const REPORT_SCHEMA_TABLES = [
  "reports",
  "report_pages",
  "report_files",
  "report_versions",
  "report_weekly_favorites",
  "report_version_ratings",
  "report_version_comments",
] as const;

export const REPORT_SCHEMA_STATEMENTS = [
  // 主表字段命名与软删除约定对齐 videos，复用现有上传/状态机代码的阅读习惯。
  // status 是转换流水线的显式状态机（UPLOADING→QUEUED→PROCESSING→READY/FAILED），
  // pages_done 让前端不用逐页轮询就能画进度条；fail_reason/convert_notes/
  // convert_attempts 是给失败重试留的诊断字段，成功路径上始终为空。
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    object_key TEXT NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size INTEGER NOT NULL DEFAULT 0,
    source_format TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'UPLOADING',
    page_count INTEGER NOT NULL DEFAULT 0,
    pages_done INTEGER NOT NULL DEFAULT 0,
    fail_reason TEXT,
    convert_notes TEXT,
    convert_attempts INTEGER NOT NULL DEFAULT 0,
    converter_version TEXT,
    derived_pdf_key TEXT,
    -- 数据万象（CI）转换后端专用，script 后端不写这几列。ci_job_large/ci_job_small
    -- 是提交的两个 doc_jobs 任务 id；ci_callback_token 是这份报告专属的回调令牌，
    -- 拼进 CallBack URL 的查询串；ci_checked_at 记录上一次向 CI 查询任务状态的时间，
    -- 给列表/详情接口的轮询兜底做节流。见 lib/report-converter.ts。
    ci_job_large TEXT,
    ci_job_small TEXT,
    ci_callback_token TEXT,
    ci_checked_at TIMESTAMPTZ,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  )`,
  // 附加式补列：2026-09-02-report-reverse.sql 那份迁移已经在生产跑过，reports 表
  // 已经存在，靠 CREATE TABLE 里的新列碰不到它；这几条 ADD COLUMN IF NOT EXISTS
  // 让已建表的库也能补上数据万象转换后端要用的列，可重复执行。与
  // db/migrations/2026-09-02-report-ci.sql 一一对应。
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_job_large TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_job_small TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_callback_token TEXT`,
  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_checked_at TIMESTAMPTZ`,
  // 报告库首页按状态筛「转换中/失败」这类队列视图，再按上传时间排序。
  `CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at)`,
  // 页是系统事实：PPT/PDF 有几页就是几页，只由离线转换脚本写入，工作台不能新增或
  // 删除页，只能划分模块/单元的归属。render_status 让单页转换失败时降级占位，
  // 不因为一页出错拖垮整份报告的转换流程。
  `CREATE TABLE IF NOT EXISTS report_pages (
    report_id TEXT NOT NULL REFERENCES reports(id),
    page_no INTEGER NOT NULL CHECK (page_no > 0),
    thumb_key TEXT NOT NULL,
    large_key TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    text_excerpt TEXT NOT NULL DEFAULT '',
    render_status TEXT NOT NULL DEFAULT 'OK',
    PRIMARY KEY (report_id, page_no)
  )`,
  // 相关资料是「案例背景与资料」部分的附件列表，独立于原件与页图；允许陆续追加、
  // 允许软删除，不进版本 payload——它是报告级的共享附件，不是某一版的标注内容。
  `CREATE TABLE IF NOT EXISTS report_files (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES reports(id),
    object_key TEXT NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size INTEGER NOT NULL DEFAULT 0,
    uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS report_files_report_idx ON report_files (report_id)`,
  // 版本链：UNIQUE (report_id, owner_user_id) 让「每人一版」由数据库兜底，不靠应用层
  // 自觉；UNIQUE (report_id, version_number) 保证版本号在同一报告下唯一。
  // base_payload_json 是创建这一版时固化的基版快照，用于「对比基版」而不是对比
  // 「当前基版」——基版之后被谁改过都不影响这份快照。报告没有时间线，所以只搬
  // V1.9 版本链「每人一版、基版快照、默认最新版」这三条规则，不搬级联规则。
  `CREATE TABLE IF NOT EXISTS report_versions (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES reports(id),
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    owner_name_snapshot TEXT NOT NULL,
    base_version_id TEXT REFERENCES report_versions(id),
    base_version_number INTEGER,
    base_payload_json JSONB,
    base_captured_at TIMESTAMPTZ,
    payload_json JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    payload_schema_version TEXT NOT NULL DEFAULT 'report-annotation/1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, version_number),
    UNIQUE (report_id, owner_user_id),
    CHECK ((base_version_id IS NULL) = (base_version_number IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS report_versions_report_updated_idx ON report_versions (report_id, updated_at DESC)`,
  // week_key 是投票时按自然周算出来的（Asia/Shanghai，周一起算），slot 是这一周的
  // 三个票位之一：主键 (user_id, week_key, slot) 让「每人每周最多三票」由数据库兜底，
  // 唯一约束 (user_id, week_key, report_id) 让三票必须落在三份不同的报告上。
  // 结构照抄视频侧的 case_weekly_favorites，只把外键换成报告。
  `CREATE TABLE IF NOT EXISTS report_weekly_favorites (
    user_id TEXT NOT NULL REFERENCES users(id),
    week_key TEXT NOT NULL,
    slot INTEGER NOT NULL DEFAULT 1,
    report_id TEXT NOT NULL REFERENCES reports(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, week_key, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS report_weekly_favorites_report_idx ON report_weekly_favorites (report_id)`,
  // 老库里这张表是每周一票的形状；CREATE TABLE IF NOT EXISTS 不改已存在的表，
  // 升级要显式写出来。做法与 db/case-engagement-schema.ts 里那段完全一致。
  `ALTER TABLE report_weekly_favorites ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1`,
  `DO $report_weekly_ballots$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'report_weekly_favorites'::regclass
        AND contype = 'p' AND array_length(conkey, 1) = 2
    ) THEN
      ALTER TABLE report_weekly_favorites DROP CONSTRAINT report_weekly_favorites_pkey;
      ALTER TABLE report_weekly_favorites ADD PRIMARY KEY (user_id, week_key, slot);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'report_weekly_favorites'::regclass
        AND conname = 'report_weekly_favorites_slot_range'
    ) THEN
      ALTER TABLE report_weekly_favorites
        ADD CONSTRAINT report_weekly_favorites_slot_range CHECK (slot BETWEEN 1 AND 3);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'report_weekly_favorites'::regclass
        AND conname = 'report_weekly_favorites_one_ballot_per_report'
    ) THEN
      ALTER TABLE report_weekly_favorites
        ADD CONSTRAINT report_weekly_favorites_one_ballot_per_report
        UNIQUE (user_id, week_key, report_id);
    END IF;
  END
  $report_weekly_ballots$`,
  // 一个版本只有一条评级：改分是覆盖同一行，不是叠加第二个分数。
  `CREATE TABLE IF NOT EXISTS report_version_ratings (
    version_id TEXT PRIMARY KEY REFERENCES report_versions(id),
    report_id TEXT NOT NULL REFERENCES reports(id),
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    rated_by_user_id TEXT NOT NULL REFERENCES users(id),
    rated_by_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS report_version_ratings_report_idx ON report_version_ratings (report_id)`,
  // 一个条目一条评论：评审再写就是改这一条，不叠成讨论串。挂在版本上而不是报告
  // 上——评论说的是这个人这一版在这个条目上的写法，换一版评论不跟着搬。
  `CREATE TABLE IF NOT EXISTS report_version_comments (
    version_id TEXT NOT NULL REFERENCES report_versions(id),
    target_key TEXT NOT NULL,
    report_id TEXT NOT NULL REFERENCES reports(id),
    target_label TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL CHECK (length(body) > 0),
    author_user_id TEXT NOT NULL REFERENCES users(id),
    author_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (version_id, target_key)
  )`,
  `CREATE INDEX IF NOT EXISTS report_version_comments_report_idx ON report_version_comments (report_id)`,
  `ALTER TABLE reports ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_pages ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_files ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_versions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_weekly_favorites ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_version_ratings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_version_comments ENABLE ROW LEVEL SECURITY`,
  // 运行时只走服务端 BYPASSRLS 连接；开启 RLS 且不建策略，等于关掉
  // anon/authenticated 的 PostgREST 通道，对本项目的查询没有任何影响。
  // 与 db/v19-version-chain-schema.ts、db/case-engagement-schema.ts 末尾的守卫保持一致。
  `DO $report_schema_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${REPORT_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${REPORT_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $report_schema_revoke_public_roles$`,
] as const;
