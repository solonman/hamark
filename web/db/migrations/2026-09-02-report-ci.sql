-- 报告转换后端：给 reports 表补上数据万象（CI 文档转码）专用的四列。
-- 与 db/report-schema.ts 中 REPORT_SCHEMA_STATEMENTS 里同名的 ALTER TABLE 语句一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 "V0.4 taxonomy contract drift" 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 本迁移是附加式的：只给已经存在的 reports 表（2026-09-02-report-reverse.sql 建的）
-- 补四个可空列，不改动其余列、约束、索引或触发器，也不碰其他任何表。全部用
-- ADD COLUMN IF NOT EXISTS，可重复执行。
--
-- 这四列只有 REPORT_CONVERTER=ci（数据万象转换后端）时才会被写入；script 后端
-- （离线机跑 scripts/convert-report-pages.ts）不碰这几列，一直是 NULL，不影响它
-- 原有的行为。字段含义见 lib/report-converter.ts 顶部注释：
--   ci_job_large / ci_job_small  提交给数据万象的两个 doc_jobs 任务 id（大图/小图）
--   ci_callback_token            这份报告专属的回调令牌，拼进 CallBack URL 的查询串
--   ci_checked_at                上一次向 CI 查询任务状态的时间，供轮询兜底节流用

BEGIN;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_job_large TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_job_small TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_callback_token TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ci_checked_at TIMESTAMPTZ;

COMMIT;
