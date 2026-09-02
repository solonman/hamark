// 最终版：每个案例一份，内容按处取各版本里最新的一次修改。附加式迁移。
// 见 docs/20_最终版与评论跨版本_实施规格_V0.1.md 二（数据）。
//
// 同时携带两件与最终版功能相关、但物理上落在既有表上的改动：
//   - analysis_versions 加 base_is_final 列（「基于最终版」手动创建的标记，
//     spec 五、13）——不放进 db/v19-version-chain-schema.ts，因为那份文件的
//     语句与 db/migrations/2026-08-24-v19-version-chain.sql 有逐条一致性测试
//     （tests/v19-api-contract.test.ts），那份历史迁移在生产已经执行过，不能
//     再补语句进去；这里的新增列改走这份新迁移。
//   - analysis_version_comments.version_id 去掉外键：最终版的 id 不在
//     analysis_versions 里，写评论时校验 version_id 归属改由服务端自己做。

export const FINAL_VERSION_SCHEMA_TABLES = [
  "analysis_final_versions",
  "analysis_final_intakes",
] as const;

export const FINAL_VERSION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS analysis_final_versions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL UNIQUE REFERENCES collaboration_workspaces(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
    done_at TIMESTAMPTZ,
    done_by_user_id TEXT REFERENCES users(id),
    done_by_name TEXT,
    origin_payload_json JSONB NOT NULL,
    payload_json JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // 汇入记录：每一条都是「某处的一次修改」，溯源视图与「未纳入」都从这里读。
  `CREATE TABLE IF NOT EXISTS analysis_final_intakes (
    id TEXT PRIMARY KEY,
    final_id TEXT NOT NULL REFERENCES analysis_final_versions(id),
    workspace_id TEXT NOT NULL REFERENCES collaboration_workspaces(id),
    video_id TEXT NOT NULL REFERENCES videos(id),
    seq BIGSERIAL NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('FIELD', 'INSERT_GROUP', 'INSERT_SHOT', 'REMOVE_GROUP', 'REMOVE_SHOT')),
    target_key TEXT NOT NULL,
    target_label TEXT NOT NULL DEFAULT '',
    value_json JSONB NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('VERSION', 'FINAL_DIRECT')),
    source_version_id TEXT REFERENCES analysis_versions(id),
    source_version_number INTEGER,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    actor_name TEXT NOT NULL,
    change_set_id TEXT,
    applied BOOLEAN NOT NULL,
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS analysis_final_intakes_final_seq_idx ON analysis_final_intakes (final_id, seq)`,
  `CREATE INDEX IF NOT EXISTS analysis_final_intakes_final_target_idx ON analysis_final_intakes (final_id, target_key)`,
  // spec 五、13:「基于最终版」手动创建的版本标记；最终版 id 不在 analysis_versions
  // 里，base_version_id/number 只能记 null，靠这一列区分「无基版」与「基于最终版」。
  `ALTER TABLE analysis_versions ADD COLUMN IF NOT EXISTS base_is_final BOOLEAN NOT NULL DEFAULT false`,
  // 评论表去外键：最终版的 id 不在 analysis_versions 里，旧约束会挡住写在最终版
  // 上的评论。已经跑过 2026-09-01-case-engagement.sql 的库需要这条显式 DROP；
  // 新库直接从 db/case-engagement-schema.ts 里没有外键的建表语句起步。
  `ALTER TABLE analysis_version_comments DROP CONSTRAINT IF EXISTS analysis_version_comments_version_id_fkey`,
  `ALTER TABLE analysis_final_versions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE analysis_final_intakes ENABLE ROW LEVEL SECURITY`,
  // 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
  // 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
  // 与 db/v19-version-chain-schema.ts / db/case-engagement-schema.ts 末尾一致。
  `DO $final_version_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${FINAL_VERSION_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${FINAL_VERSION_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $final_version_revoke_public_roles$`,
] as const;
