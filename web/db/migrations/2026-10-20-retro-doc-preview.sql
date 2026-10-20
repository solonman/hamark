-- 客户需求复盘库：文档附件逐页预览（docs/26 4.3「全部在站内弹层预览」，2026-10-20）。
-- 与 db/retro-schema.ts 中的 RETRO_DOC_PREVIEW_STATEMENTS 一一对应。
--
-- 生产执行方式：先确认 2026-10-19-retro-library.sql 已执行；在 Supabase SQL 编辑器里整段执行本文件；
-- 执行成功后再推送代码。不要用 `npm run db:migrate` 应用到生产（会被 V0.4 契约漂移守卫中止）。
--
-- 改动：retro_case_assets 只加 5 列（数据万象两个任务的 id、上次查询时间、页数、逐页结果），
-- 全部 ADD COLUMN IF NOT EXISTS，可重复执行；不改任何旧数据，不碰其它表。

BEGIN;

ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS ci_job_large TEXT;
ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS ci_job_small TEXT;
ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS ci_checked_at TIMESTAMPTZ;
ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS page_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retro_case_assets ADD COLUMN IF NOT EXISTS pages_json JSONB;

COMMIT;
