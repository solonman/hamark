-- 每周收藏从「每人 1 票」改成「每人 3 票，每票投给不同的一个作品」。
-- 与 db/case-engagement-schema.ts、db/report-schema.ts 里的升级语句一一对应。
--
-- 生产执行方式：在 Supabase SQL 编辑器里整段执行本文件。
-- 不要用 `npm run db:migrate` 应用到生产：那条路径会重跑整份 bootstrap 脚本，
-- 其中的 V0.4 契约漂移守卫要求契约状态仍为 DRAFT，而生产契约早已 ACTIVE，
-- 会以 “V0.4 taxonomy contract drift” 中止（事务回滚，不会损坏数据，但迁移不会生效）。
--
-- 只动两张收藏表，且只加不删：多一列 slot（既有的那一票落在 slot 1）、主键多一列、
-- 多一条唯一约束。已经投出去的票原样保留，谁也不会因为这次迁移掉票。
-- 三个票位由主键 (user_id, week_key, slot) 兜底：一周物理上放不下第四票。
-- 一票一作品由 UNIQUE (user_id, week_key, <作品>) 兜底：三票不能堆在同一个作品上。
-- 可重复执行。

BEGIN;

ALTER TABLE case_weekly_favorites ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1;

DO $case_weekly_ballots$
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
$case_weekly_ballots$;

ALTER TABLE report_weekly_favorites ADD COLUMN IF NOT EXISTS slot INTEGER NOT NULL DEFAULT 1;

DO $report_weekly_ballots$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'report_weekly_favorites'::regclass
      AND contype = 'p' AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE report_weekly_favorites DROP CONSTRAINT report_weekly_favorites_pkey;
    ALTER TABLE report_weekly_favorites ADD PRIMARY KEY (user_id, week_key, slot);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'report_weekly_favorites'::regclass
      AND conname = 'report_weekly_favorites_slot_range'
  ) THEN
    ALTER TABLE report_weekly_favorites
      ADD CONSTRAINT report_weekly_favorites_slot_range CHECK (slot BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'report_weekly_favorites'::regclass
      AND conname = 'report_weekly_favorites_one_ballot_per_report'
  ) THEN
    ALTER TABLE report_weekly_favorites
      ADD CONSTRAINT report_weekly_favorites_one_ballot_per_report
      UNIQUE (user_id, week_key, report_id);
  END IF;
END
$report_weekly_ballots$;

COMMIT;
