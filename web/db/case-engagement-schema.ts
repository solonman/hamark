// 案例库互动与评审：每周三票的收藏，老孙给作业版本打的星级，以及逐条目的评论。
// 三张表都不参与任何既有读写路径。除了把 case_weekly_favorites 从「每周一票」
// 升级成三个票位（加 slot、换主键、加唯一约束）之外，不动任何既有表。

export const CASE_ENGAGEMENT_SCHEMA_TABLES = [
  "case_weekly_favorites",
  "analysis_version_ratings",
  "analysis_version_comments",
] as const;

export const CASE_ENGAGEMENT_SCHEMA_STATEMENTS = [
  // week_key 是投票时按案例上传时间算出来的自然周（Asia/Shanghai，周一起算）。
  // slot 是这一周的三个票位之一：把 (user_id, week_key, slot) 做成主键，
  // 「每人每周最多三票」就是物理上放不下第四行，而不是靠应用层数得准。
  // 再加一条 (user_id, week_key, video_id) 唯一：三票必须落在三部不同的片上，
  // 谁也不能把三票都堆到同一部片上。
  `CREATE TABLE IF NOT EXISTS case_weekly_favorites (
    user_id TEXT NOT NULL REFERENCES users(id),
    week_key TEXT NOT NULL,
    slot INTEGER NOT NULL DEFAULT 1,
    video_id TEXT NOT NULL REFERENCES videos(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, week_key, slot)
  )`,
  `CREATE INDEX IF NOT EXISTS case_weekly_favorites_video_idx
    ON case_weekly_favorites (video_id)`,
  // 老库里这张表是每周一票的形状（主键两列、没有 slot）。CREATE TABLE IF NOT EXISTS
  // 碰到已存在的表什么也不做，所以升级要显式写出来；已有的那一票落在 slot 1，
  // 与新口径不冲突。约束都显式命名，重复执行时按名字判断，不会叠出第二条。
  `ALTER TABLE case_weekly_favorites ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1`,
  `DO $case_weekly_ballots$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'case_weekly_favorites'::regclass
        AND contype = 'p' AND array_length(conkey, 1) = 2
    ) THEN
      ALTER TABLE case_weekly_favorites DROP CONSTRAINT case_weekly_favorites_pkey;
      ALTER TABLE case_weekly_favorites ADD PRIMARY KEY (user_id, week_key, slot);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'case_weekly_favorites'::regclass
        AND conname = 'case_weekly_favorites_slot_range'
    ) THEN
      ALTER TABLE case_weekly_favorites
        ADD CONSTRAINT case_weekly_favorites_slot_range CHECK (slot BETWEEN 1 AND 3);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'case_weekly_favorites'::regclass
        AND conname = 'case_weekly_favorites_one_ballot_per_case'
    ) THEN
      ALTER TABLE case_weekly_favorites
        ADD CONSTRAINT case_weekly_favorites_one_ballot_per_case
        UNIQUE (user_id, week_key, video_id);
    END IF;
  END
  $case_weekly_ballots$`,
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
  // version_id 不建外键：最终版（analysis_final_versions）的 id 不在
  // analysis_versions 里，写评论时改由服务端自行校验 version_id 属于该案例
  // （普通版本或最终版之一）——见 db/final-version-schema.ts 与
  // docs/20_最终版与评论跨版本_实施规格_V0.1.md 二。
  `CREATE TABLE IF NOT EXISTS analysis_version_comments (
    version_id TEXT NOT NULL,
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
