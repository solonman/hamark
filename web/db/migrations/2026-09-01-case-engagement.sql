-- 案例库互动与评审：每周一票的收藏、作业版本的星级评级、逐条目评论。
-- 与 db/case-engagement-schema.ts 中的 CASE_ENGAGEMENT_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 “V0.4 taxonomy contract drift” 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 本迁移是附加式的：只新增三张表、三个索引，以及这三张表的 RLS 收口。
-- 不修改、不删除任何既有表、约束或触发器。可重复执行。

BEGIN;

-- week_key 是投票时按案例上传时间算出的自然周（Asia/Shanghai，周一起算）。
-- 把它放进主键，是让「每人每周只有一票」由数据库兜底，而不是靠应用层自觉。
CREATE TABLE IF NOT EXISTS case_weekly_favorites (
  user_id TEXT NOT NULL REFERENCES users(id),
  week_key TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_key)
);

CREATE INDEX IF NOT EXISTS case_weekly_favorites_video_idx
  ON case_weekly_favorites (video_id);

-- 一个版本只有一条评级：改分是覆盖同一行，不是叠加第二个分数。
CREATE TABLE IF NOT EXISTS analysis_version_ratings (
  version_id TEXT PRIMARY KEY REFERENCES analysis_versions(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  rated_by_user_id TEXT NOT NULL REFERENCES users(id),
  rated_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_version_ratings_video_idx
  ON analysis_version_ratings (video_id);

-- 一个条目一条评论：评审再写就是改这一条，不叠成讨论串。
-- 挂在版本上而不是案例上——评论说的是这个人这一版的写法。
CREATE TABLE IF NOT EXISTS analysis_version_comments (
  version_id TEXT NOT NULL REFERENCES analysis_versions(id),
  target_key TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(id),
  target_label TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL CHECK (length(body) > 0),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, target_key)
);

CREATE INDEX IF NOT EXISTS analysis_version_comments_video_idx
  ON analysis_version_comments (video_id);

ALTER TABLE case_weekly_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_version_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_version_comments ENABLE ROW LEVEL SECURITY;

-- 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
-- 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
DO $case_engagement_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE case_weekly_favorites, analysis_version_ratings, analysis_version_comments FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE case_weekly_favorites, analysis_version_ratings, analysis_version_comments FROM authenticated';
  END IF;
END
$case_engagement_revoke_public_roles$;

COMMIT;
