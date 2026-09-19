-- 公共视觉库地基：案例主表、素材表、纯收藏表。
-- 与 db/visual-schema.ts 中的 VISUAL_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 "V0.4 taxonomy contract drift" 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 本迁移是附加式的：只新增 visual_cases / visual_case_assets /
-- visual_case_favorites 三张表、四个索引，以及这三张表的 RLS 收口。
-- 不修改、不删除任何既有表、约束或触发器。可重复执行。

BEGIN;

-- 案例主表（字段命名与软删除约定对齐 videos / reports）。status 只有
-- UPLOADING | READY 两态——部分失败不会把整条案例判为 FAILED（规格 4.2）。
CREATE TABLE IF NOT EXISTS visual_cases (
  id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL DEFAULT 'PUBLIC_VISUAL',
  subdomain TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  location TEXT NOT NULL,
  creator TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  rights_note TEXT NOT NULL DEFAULT '仅公司内部学习使用',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  metadata_schema_version TEXT NOT NULL DEFAULT 'visual-metadata/1',
  status TEXT NOT NULL DEFAULT 'UPLOADING',
  created_by_email TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

-- 素材：视频和图片排在同一条序列里，position 就是展示顺序，第一位就是封面。
-- 视频 ≤12、图片 ≤24 的约束放在服务层校验，不用部分唯一索引。
CREATE TABLE IF NOT EXISTS visual_case_assets (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES visual_cases(id),
  type TEXT NOT NULL,
  position INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  display_key TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  upload_status TEXT NOT NULL DEFAULT 'UPLOADING',
  derivative_status TEXT NOT NULL DEFAULT 'PENDING',
  derivative_error TEXT,
  derivative_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 纯收藏，不限数量：主键就是 (case_id, user_id)，再点一次就是取消，不是再投一票。
-- 刻意不照抄 case_weekly_favorites / report_weekly_favorites 的 week_key / slot。
CREATE TABLE IF NOT EXISTS visual_case_favorites (
  case_id TEXT NOT NULL REFERENCES visual_cases(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);

CREATE INDEX IF NOT EXISTS visual_cases_created_at_idx ON visual_cases (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visual_cases_subdomain_created_at_idx ON visual_cases (subdomain, created_at DESC);
CREATE INDEX IF NOT EXISTS visual_case_assets_case_position_idx ON visual_case_assets (case_id, position);
CREATE INDEX IF NOT EXISTS visual_case_favorites_user_idx ON visual_case_favorites (user_id);

ALTER TABLE visual_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_case_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_case_favorites ENABLE ROW LEVEL SECURITY;

-- 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
-- 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
DO $visual_schema_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE visual_cases, visual_case_assets, visual_case_favorites FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE visual_cases, visual_case_assets, visual_case_favorites FROM authenticated';
  END IF;
END
$visual_schema_revoke_public_roles$;

COMMIT;
