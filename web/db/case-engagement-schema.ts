// 案例库互动与评审：每周一票的收藏，老孙给作业版本打的星级，以及逐条目的评论。
// 附加式迁移，不修改既有表；三张表都不参与任何既有读写路径。

export const CASE_ENGAGEMENT_SCHEMA_TABLES = [
  "case_weekly_favorites",
  "analysis_version_ratings",
  "analysis_version_comments",
] as const;

export const CASE_ENGAGEMENT_SCHEMA_STATEMENTS = [
  // week_key 是投票时按案例上传时间算出来的自然周（Asia/Shanghai，周一起算）。
  // 把它写进主键，是让「每人每周只有一票」由数据库兜底，而不是靠应用层自觉。
  `CREATE TABLE IF NOT EXISTS case_weekly_favorites (
    user_id TEXT NOT NULL REFERENCES users(id),
    week_key TEXT NOT NULL,
    video_id TEXT NOT NULL REFERENCES videos(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, week_key)
  )`,
  `CREATE INDEX IF NOT EXISTS case_weekly_favorites_video_idx
    ON case_weekly_favorites (video_id)`,
  // 一个版本只有一条评级：老孙改分是覆盖同一行，不是叠加第二个分数。
  `CREATE TABLE IF NOT EXISTS analysis_version_ratings (
    version_id TEXT PRIMARY KEY REFERENCES analysis_versions(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    rated_by_user_id TEXT NOT NULL REFERENCES users(id),
    rated_by_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS analysis_version_ratings_video_idx
    ON analysis_version_ratings (video_id)`,
  // 一个条目一条评论：评审再写就是改这一条，不叠成讨论串。
  // 挂在版本上而不是案例上——评论说的是这个人这一版的写法。
  `CREATE TABLE IF NOT EXISTS analysis_version_comments (
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
  )`,
  `CREATE INDEX IF NOT EXISTS analysis_version_comments_video_idx
    ON analysis_version_comments (video_id)`,
  `ALTER TABLE case_weekly_favorites ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE analysis_version_ratings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE analysis_version_comments ENABLE ROW LEVEL SECURITY`,
  // 运行时只走服务端 BYPASSRLS 连接；开启 RLS 且不建策略，等于关掉
  // anon/authenticated 的 PostgREST 通道，对本项目的查询没有任何影响。
  // 与 db/v19-version-chain-schema.ts 末尾的守卫保持一致。
  `DO $case_engagement_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${CASE_ENGAGEMENT_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${CASE_ENGAGEMENT_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $case_engagement_revoke_public_roles$`,
] as const;
