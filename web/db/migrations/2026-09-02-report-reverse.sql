-- 报告逆向工程地基：报告主表、页、相关资料、版本链，以及互动与评审三张表。
-- 与 db/report-schema.ts 中的 REPORT_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 “V0.4 taxonomy contract drift” 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 本迁移是附加式的：只新增 reports / report_pages / report_files /
-- report_versions / report_weekly_favorites / report_version_ratings /
-- report_version_comments 七张表、对应索引，以及这七张表的 RLS 收口。
-- 不修改、不删除任何既有表、约束或触发器。可重复执行。

BEGIN;

-- 主表字段命名与软删除约定对齐 videos，复用现有上传/状态机代码的阅读习惯。
-- status 是转换流水线的显式状态机（UPLOADING→QUEUED→PROCESSING→READY/FAILED），
-- pages_done 让前端不用逐页轮询就能画进度条；fail_reason/convert_notes/
-- convert_attempts 是给失败重试留的诊断字段，成功路径上始终为空。
CREATE TABLE IF NOT EXISTS reports (
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
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

-- 报告库首页按状态筛「转换中/失败」这类队列视图，再按上传时间排序。
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at);

-- 页是系统事实：PPT/PDF 有几页就是几页，只由离线转换脚本写入，工作台不能新增或
-- 删除页，只能划分模块/单元的归属。render_status 让单页转换失败时降级占位，
-- 不因为一页出错拖垮整份报告的转换流程。
CREATE TABLE IF NOT EXISTS report_pages (
  report_id TEXT NOT NULL REFERENCES reports(id),
  page_no INTEGER NOT NULL CHECK (page_no > 0),
  thumb_key TEXT NOT NULL,
  large_key TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  text_excerpt TEXT NOT NULL DEFAULT '',
  render_status TEXT NOT NULL DEFAULT 'OK',
  PRIMARY KEY (report_id, page_no)
);

-- 相关资料是「案例背景与资料」部分的附件列表，独立于原件与页图；允许陆续追加、
-- 允许软删除，不进版本 payload——它是报告级的共享附件，不是某一版的标注内容。
CREATE TABLE IF NOT EXISTS report_files (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id),
  object_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS report_files_report_idx ON report_files (report_id);

-- 版本链：UNIQUE (report_id, owner_user_id) 让「每人一版」由数据库兜底，不靠应用层
-- 自觉；UNIQUE (report_id, version_number) 保证版本号在同一报告下唯一。
-- base_payload_json 是创建这一版时固化的基版快照，用于「对比基版」而不是对比
-- 「当前基版」——基版之后被谁改过都不影响这份快照。报告没有时间线，所以只搬
-- V1.9 版本链「每人一版、基版快照、默认最新版」这三条规则，不搬级联规则。
CREATE TABLE IF NOT EXISTS report_versions (
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
);

CREATE INDEX IF NOT EXISTS report_versions_report_updated_idx ON report_versions (report_id, updated_at DESC);

-- week_key 是投票时按自然周算出来的（Asia/Shanghai，周一起算），写进主键让
-- 「每人每周只有一票」由数据库兜底。结构照抄视频侧的 case_weekly_favorites，
-- 只把外键换成报告。
CREATE TABLE IF NOT EXISTS report_weekly_favorites (
  user_id TEXT NOT NULL REFERENCES users(id),
  week_key TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_key)
);

CREATE INDEX IF NOT EXISTS report_weekly_favorites_report_idx ON report_weekly_favorites (report_id);

-- 一个版本只有一条评级：改分是覆盖同一行，不是叠加第二个分数。
CREATE TABLE IF NOT EXISTS report_version_ratings (
  version_id TEXT PRIMARY KEY REFERENCES report_versions(id),
  report_id TEXT NOT NULL REFERENCES reports(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  rated_by_user_id TEXT NOT NULL REFERENCES users(id),
  rated_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_version_ratings_report_idx ON report_version_ratings (report_id);

-- 一个条目一条评论：评审再写就是改这一条，不叠成讨论串。挂在版本上而不是报告
-- 上——评论说的是这个人这一版在这个条目上的写法，换一版评论不跟着搬。
CREATE TABLE IF NOT EXISTS report_version_comments (
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
);

CREATE INDEX IF NOT EXISTS report_version_comments_report_idx ON report_version_comments (report_id);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_weekly_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_version_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_version_comments ENABLE ROW LEVEL SECURITY;

-- 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
-- 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
DO $report_schema_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE reports, report_pages, report_files, report_versions, report_weekly_favorites, report_version_ratings, report_version_comments FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE reports, report_pages, report_files, report_versions, report_weekly_favorites, report_version_ratings, report_version_comments FROM authenticated';
  END IF;
END
$report_schema_revoke_public_roles$;

COMMIT;
