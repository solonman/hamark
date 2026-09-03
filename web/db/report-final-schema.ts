// 报告「集成版」：每份报告一份，内容按处取各版本里最新的一次修改。附加式迁移。
// 见 docs/21_报告集成版_实施规格_V0.1.md 二（数据）。对照视频侧 db/final-version-schema.ts：
// 同一形状，字段名从 workspace/video 换成 report，kind 词表换成报告的八种记录
// （FIELD、INSERT_MODULE/INSERT_UNIT/INSERT_BLOCK、REMOVE_MODULE/REMOVE_UNIT/
// REMOVE_BLOCK、SPAN——报告独有的页范围结构记录，视频没有对应物，见规格一之 C）。
//
// 同时携带两件与集成版功能相关、但物理上落在既有表上的改动：
//   - report_versions 加 base_is_final 列（「基于集成版」手动创建的标记，spec 五、13）。
//   - report_version_comments.version_id 去掉外键：集成版的 id 不在 report_versions
//     里，写评论时校验 version_id 归属改由服务端自己做（见 lib/report-review-server.ts
//     的 requireCommentVersionOfReport，照抄视频侧 case-review-server.ts 的写法）。

export const REPORT_FINAL_SCHEMA_TABLES = [
  "report_final_versions",
  "report_final_intakes",
] as const;

export const REPORT_FINAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS report_final_versions (
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
  )`,
  // 汇入记录：每一条都是「某处的一次修改」，溯源视图与「未纳入」都从这里读。
  // 与视频侧 report_final_intakes 的唯一结构差异：没有 change_set_id 列——报告
  // 没有客户端变更集，幂等性天然由整份 payload 保存自带的 revision 乐观锁提供
  // （同一 revision 只可能成功保存一次），不需要额外的去重键。
  `CREATE TABLE IF NOT EXISTS report_final_intakes (
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
  )`,
  `CREATE INDEX IF NOT EXISTS report_final_intakes_final_seq_idx ON report_final_intakes (final_id, seq)`,
  `CREATE INDEX IF NOT EXISTS report_final_intakes_final_target_idx ON report_final_intakes (final_id, target_key)`,
  // 「基于集成版」手动创建版本的标记（spec 五、13，同视频侧 analysis_versions.base_is_final）：
  // 集成版的 id 不在 report_versions 里，base_version_id/number 只能记 null，
  // 靠这一列区分「无基版（报告的第一版）」与「基于集成版」。
  `ALTER TABLE report_versions ADD COLUMN IF NOT EXISTS base_is_final BOOLEAN NOT NULL DEFAULT false`,
  // 评论表去外键：集成版的 id 不在 report_versions 里，旧约束会挡住写在集成版
  // 上的评论。服务端改为自行校验 version_id 属于该报告（普通版本或集成版），
  // 同视频侧 lib/case-review-server.ts 的 requireCommentVersionOfVideo 写法。
  `ALTER TABLE report_version_comments DROP CONSTRAINT IF EXISTS report_version_comments_version_id_fkey`,
  `ALTER TABLE report_final_versions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE report_final_intakes ENABLE ROW LEVEL SECURITY`,
  // 运行时只经服务端的 BYPASSRLS 连接访问；开启 RLS 且不建策略，
  // 等于关闭 anon/authenticated 的 PostgREST 通路，不影响任何既有查询。
  // 与 db/final-version-schema.ts / db/report-schema.ts 末尾一致。
  `DO $report_final_revoke_public_roles$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${REPORT_FINAL_SCHEMA_TABLES.join(", ")} FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE ${REPORT_FINAL_SCHEMA_TABLES.join(", ")} FROM authenticated';
    END IF;
  END
  $report_final_revoke_public_roles$`,
] as const;
