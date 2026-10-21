-- 客户需求复盘库：案例加「反思」（docs/26 4.2，2026-10-21）。
-- 与 db/retro-schema.ts 中的 RETRO_REFLECTION_STATEMENTS 一一对应。
--
-- 生产执行方式：先确认 2026-10-19-retro-library.sql、2026-10-20-retro-doc-preview.sql 已执行；
-- 在 Supabase SQL 编辑器里整段执行本文件，执行成功后再推送代码。
--
-- 改动：retro_cases 只加 reflection 一列（默认空串），ADD COLUMN IF NOT EXISTS，可重复执行；不改任何旧数据。

BEGIN;

ALTER TABLE retro_cases ADD COLUMN IF NOT EXISTS reflection TEXT NOT NULL DEFAULT '';

COMMIT;
