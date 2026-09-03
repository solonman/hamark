-- 报告「集成版」：每份报告一份，内容按处取各版本里最新的一次修改。
-- 与 db/report-final-schema.ts 中的 REPORT_FINAL_SCHEMA_STATEMENTS 一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 “V0.4 taxonomy contract drift” 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 本迁移是附加式的：新增 report_final_versions / report_final_intakes 两张表、
-- 两个索引、两张表的 RLS 收口；另外给 report_versions 加一个可空默认列
-- （base_is_final），给 report_version_comments 去掉 version_id 上的外键
-- （因为集成版的 id 不在 report_versions 里，写在集成版上的评论会被这条旧
-- 约束挡住）。不删除、不改写任何既有数据。可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS report_final_versions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE REFERENCES reports(id),
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
);

-- 汇入记录：每一条都是「某处的一次修改」，溯源视图与「未纳入」都从这里读。
CREATE TABLE IF NOT EXISTS report_final_intakes (
  id TEXT PRIMARY KEY,
  final_id TEXT NOT NULL REFERENCES report_final_versions(id),
  report_id TEXT NOT NULL REFERENCES reports(id),
  seq BIGSERIAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'FIELD', 'INSERT_MODULE', 'INSERT_UNIT', 'INSERT_BLOCK',
    'REMOVE_MODULE', 'REMOVE_UNIT', 'REMOVE_BLOCK', 'SPAN'
  )),
  target_key TEXT NOT NULL,
  target_label TEXT NOT NULL DEFAULT '',
  value_json JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('VERSION', 'FINAL_DIRECT')),
  source_version_id TEXT REFERENCES report_versions(id),
  source_version_number INTEGER,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  applied BOOLEAN NOT NULL,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_final_intakes_final_seq_idx
  ON report_final_intakes (final_id, seq);

CREATE INDEX IF NOT EXISTS report_final_intakes_final_target_idx
  ON report_final_intakes (final_id, target_key);

-- spec 五、13:「基于集成版」手动创建的版本标记。
ALTER TABLE report_versions
  ADD COLUMN IF NOT EXISTS base_is_final BOOLEAN NOT NULL DEFAULT false;

-- 集成版的 id 不在 report_versions 里，这条旧外键会挡住写在集成版上的评论。
-- 服务端改为自行校验 version_id 属于该报告（普通版本或集成版）。
ALTER TABLE report_version_comments
  DROP CONSTRAINT IF EXISTS report_version_comments_version_id_fkey;

ALTER TABLE report_final_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_final_intakes ENABLE ROW LEVEL SECURITY;

-- 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
-- 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
DO $report_final_revoke_public_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE report_final_versions, report_final_intakes FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE report_final_versions, report_final_intakes FROM authenticated';
  END IF;
END
$report_final_revoke_public_roles$;

COMMIT;
