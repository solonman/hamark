// 公共视觉库的地基：案例主表、素材表（视频与图片同排一条序列）、纯收藏表。
// 是独立表族，不挂视频侧的 V0.4 契约、不建版本链、不建评审表——理由见
// docs/22_公共视觉_立项与实施规格_V0.2.md 二.3、四.1。写法照抄 db/report-schema.ts：
// 字段命名与软删除约定对齐 videos/reports，RLS 语句随表一起放在这个文件里，由
// db/bootstrap.ts 展开；派生值（封面、载体计数、收藏数）一律不入库，查询时推导。
//
// 与两个案例库的投票表刻意不同：visual_case_favorites 没有 week_key/slot，见表注释。

export const VISUAL_SCHEMA_TABLES = [
  "visual_cases",
  "visual_case_assets",
  "visual_case_favorites",
] as const;

export const VISUAL_SCHEMA_STATEMENTS = [
  // 案例主表（字段命名与软删除约定对齐 videos / reports）。status 只有
  // UPLOADING | READY 两态——部分失败不会把整条案例判为 FAILED（规格 4.2）。
  `CREATE TABLE IF NOT EXISTS visual_cases (
    id TEXT PRIMARY KEY,
    domain_key TEXT NOT NULL DEFAULT 'PUBLIC_VISUAL',
    subdomain TEXT NOT NULL,                       -- OOH | PUBLIC_ART | RETAIL
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',              -- 一句话摘要，≤60 字
    text_body TEXT NOT NULL DEFAULT '',            -- 案例简介（纯文本，保留换行）
    tags_json TEXT NOT NULL DEFAULT '[]',
    location TEXT NOT NULL,                        -- 采集地点，必填
    creator TEXT NOT NULL DEFAULT '',              -- 创作方／品牌
    occurred_at TEXT NOT NULL DEFAULT '',          -- 首次投放／落成时间，原文保存不解析
    source_url TEXT NOT NULL DEFAULT '',           -- 只收 http(s)
    rights_note TEXT NOT NULL DEFAULT '仅公司内部学习使用',
    metadata_json TEXT NOT NULL DEFAULT '{}',      -- 子领域专有项，见规格 3.3.2
    metadata_schema_version TEXT NOT NULL DEFAULT 'visual-metadata/1',
    status TEXT NOT NULL DEFAULT 'UPLOADING',      -- UPLOADING | READY（见下方「状态」）
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  )`,
  // 素材：视频和图片排在同一条序列里，position 就是展示顺序，第一位就是封面。
  // 视频 ≤12、图片 ≤24 的约束放在服务层校验，不用部分唯一索引：约束将来可能
  // 放宽，写死在 DB 层就得迁移才能改。
  `CREATE TABLE IF NOT EXISTS visual_case_assets (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES visual_cases(id),
    type TEXT NOT NULL,                            -- VIDEO | IMAGE
    position INTEGER NOT NULL,                     -- 0 起；调整顺序时在一个事务里整体重写
    object_key TEXT NOT NULL,                      -- 原始素材
    thumbnail_key TEXT,                            -- 图片：480w 派生图；视频：浏览器截帧封面（≤1600w）
    display_key TEXT,                              -- 图片：1600w 派生图；视频为空
    original_name TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,   -- 视频用
    upload_status TEXT NOT NULL DEFAULT 'UPLOADING',   -- UPLOADING | READY
    derivative_status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | READY | FAILED
    derivative_error TEXT,
    derivative_requested_at TIMESTAMPTZ,           -- 兜底重提交按它判断「PENDING 超过 60 秒」
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // 纯收藏，不限数量：主键就是 (case_id, user_id)，再点一次就是取消，不是再投一票。
  // 刻意不照抄 case_weekly_favorites / report_weekly_favorites：那两张表的 week_key 与
  // slot 是评选活动的配额语义，本域不参与评选，带过来只会让人误以为这里也要每周限票。
  `CREATE TABLE IF NOT EXISTS visual_case_favorites (
    case_id TEXT NOT NULL REFERENCES visual_cases(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (case_id, user_id)
  )`,
  // 库首页按上传时间倒序拉全量；WHERE deleted_at IS NULL 让索引只覆盖还在库里的案例。
  `CREATE INDEX IF NOT EXISTS visual_cases_created_at_idx ON visual_cases (created_at DESC) WHERE deleted_at IS NULL`,
  // 子领域筛选 + 时间排序的复合索引。
  `CREATE INDEX IF NOT EXISTS visual_cases_subdomain_created_at_idx ON visual_cases (subdomain, created_at DESC)`,
  // 素材条按 position 取一条案例的全部素材。
  `CREATE INDEX IF NOT EXISTS visual_case_assets_case_position_idx ON visual_case_assets (case_id, position)`,
  // 「只看我收藏的」按 user_id 找这个人收藏过的全部案例。
  `CREATE INDEX IF NOT EXISTS visual_case_favorites_user_idx ON visual_case_favorites (user_id)`,
  `ALTER TABLE visual_cases ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE visual_case_assets ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE visual_case_favorites ENABLE ROW LEVEL SECURITY`,
  // 运行时只走服务端 BYPASSRLS 连接；开启 RLS 且不建策略，等于关掉
  // anon/authenticated 的 PostgREST 通道，对本项目的查询没有任何影响。
  // 与 db/report-schema.ts 末尾的守卫保持一致。
  `DO $visual_schema_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${VISUAL_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${VISUAL_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $visual_schema_revoke_public_roles$`,
] as const;
