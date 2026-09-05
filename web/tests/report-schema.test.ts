import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { REPORT_SCHEMA_STATEMENTS, REPORT_SCHEMA_TABLES } from "../db/report-schema.ts";
import { REPORT_FINAL_SCHEMA_STATEMENTS, REPORT_FINAL_SCHEMA_TABLES } from "../db/report-final-schema.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the schema module declares a CREATE TABLE and an RLS lock for every table it lists", () => {
  const schema = REPORT_SCHEMA_STATEMENTS.join("\n");
  for (const table of REPORT_SCHEMA_TABLES) {
    assert.match(
      schema,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `missing CREATE TABLE for ${table}`,
    );
    assert.match(
      schema,
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),
      `missing RLS lock for ${table}`,
    );
  }
});

test("the version chain enforces one version per person and a unique version number per report", () => {
  const schema = REPORT_SCHEMA_STATEMENTS.join("\n");
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS report_versions[\s\S]*UNIQUE \(report_id, version_number\)/,
  );
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS report_versions[\s\S]*UNIQUE \(report_id, owner_user_id\)/,
  );
  // base_version_id 和 base_version_number 必须同生同灭：要么都有基版，要么都没有。
  assert.match(
    schema,
    /CHECK \(\(base_version_id IS NULL\) = \(base_version_number IS NULL\)\)/,
  );
});

test("the weekly favorite ballot has three slots per person per week, one report each", () => {
  const schema = REPORT_SCHEMA_STATEMENTS.join("\n");
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS report_weekly_favorites[\s\S]*PRIMARY KEY \(user_id, week_key, slot\)/,
  );
  assert.match(schema, /CHECK \(slot BETWEEN 1 AND 3\)/);
  // 三票不能堆在同一份报告上。
  assert.match(
    schema,
    /report_weekly_favorites_one_ballot_per_report\s*\n?\s*UNIQUE \(user_id, week_key, report_id\)/,
  );
  // 老库是两列主键的每周一票，升级语句要显式写出来。
  assert.match(schema, /ALTER TABLE report_weekly_favorites ADD COLUMN IF NOT EXISTS slot/);
});

test("a version has at most one rating row and one comment per target", () => {
  const schema = REPORT_SCHEMA_STATEMENTS.join("\n");
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS report_version_ratings[\s\S]*version_id TEXT PRIMARY KEY REFERENCES report_versions\(id\)/,
  );
  assert.match(
    schema,
    /stars INTEGER NOT NULL CHECK \(stars BETWEEN 1 AND 5\)/,
  );
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS report_version_comments[\s\S]*PRIMARY KEY \(version_id, target_key\)/,
  );
});

test("the revoke guard covers every table the schema module declares", () => {
  const schema = REPORT_SCHEMA_STATEMENTS.join("\n");
  for (const table of REPORT_SCHEMA_TABLES) {
    assert.match(schema, new RegExp(`REVOKE ALL ON TABLE[^']*\\b${table}\\b`));
  }
});

test("the migration file mirrors the schema module so production can apply it by hand", async () => {
  const migration = await source("../db/migrations/2026-09-02-report-reverse.sql");
  for (const table of REPORT_SCHEMA_TABLES) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `migration is missing CREATE TABLE for ${table}`,
    );
    assert.match(
      migration,
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),
      `migration is missing RLS lock for ${table}`,
    );
  }
  assert.match(migration, /UNIQUE \(report_id, version_number\)/);
  assert.match(migration, /UNIQUE \(report_id, owner_user_id\)/);
  assert.match(migration, /PRIMARY KEY \(user_id, week_key\)/);
  assert.match(migration, /PRIMARY KEY \(version_id, target_key\)/);
  // 生产执行口径：整段跑在 Supabase SQL 编辑器里，附加式、可重复执行；
  // 并且要明确警告不要用 db:migrate（那条路径会撞上 V0.4 契约漂移守卫）。
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /Supabase SQL 编辑器/);
  assert.match(migration, /不要用 `npm run db:migrate`/);
});

test("bootstrap wires the report schema statements into the shared statement list", async () => {
  const bootstrap = await source("../db/bootstrap.ts");
  assert.match(bootstrap, /import \{ REPORT_SCHEMA_STATEMENTS \} from "\.\/report-schema";/);
  assert.match(bootstrap, /\.\.\.REPORT_SCHEMA_STATEMENTS,/);
});

test("the CI converter columns exist on a fresh reports table and can be added to an existing one", () => {
  const schema = REPORT_SCHEMA_STATEMENTS.join("\n");
  // 新库：CREATE TABLE 里直接带这四列。
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reports[\s\S]*ci_job_large TEXT/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reports[\s\S]*ci_job_small TEXT/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reports[\s\S]*ci_callback_token TEXT/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reports[\s\S]*ci_checked_at TIMESTAMPTZ/);
  // 老库（2026-09-02-report-reverse.sql 已经跑过）：靠 ADD COLUMN IF NOT EXISTS 补列。
  for (const column of ["ci_job_large TEXT", "ci_job_small TEXT", "ci_callback_token TEXT", "ci_checked_at TIMESTAMPTZ"]) {
    assert.match(schema, new RegExp(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS ${column}`));
  }
});

test("the report-ci migration file adds the same four columns and can be re-run safely", async () => {
  const migration = await source("../db/migrations/2026-09-02-report-ci.sql");
  for (const column of ["ci_job_large TEXT", "ci_job_small TEXT", "ci_callback_token TEXT", "ci_checked_at TIMESTAMPTZ"]) {
    assert.match(migration, new RegExp(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /Supabase SQL 编辑器/);
  assert.match(migration, /不要用 `npm run db:migrate`/);
});

// ---------------------------------------------------------------------------
// 报告集成版 — db/report-final-schema.ts / db/migrations/2026-09-03-report-final.sql
// 见 docs/21_报告集成版_实施规格_V0.1.md 二（数据）。
// ---------------------------------------------------------------------------

test("the final-version schema module declares a CREATE TABLE and an RLS lock for every table it lists", () => {
  const schema = REPORT_FINAL_SCHEMA_STATEMENTS.join("\n");
  for (const table of REPORT_FINAL_SCHEMA_TABLES) {
    assert.match(
      schema,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `missing CREATE TABLE for ${table}`,
    );
    assert.match(
      schema,
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),
      `missing RLS lock for ${table}`,
    );
  }
});

test("report_final_versions is one per report and report_final_intakes carries the eight report-side intake kinds", () => {
  const schema = REPORT_FINAL_SCHEMA_STATEMENTS.join("\n");
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS report_final_versions[\s\S]*report_id TEXT NOT NULL UNIQUE REFERENCES reports\(id\)/,
  );
  assert.match(schema, /status TEXT NOT NULL DEFAULT 'OPEN' CHECK \(status IN \('OPEN', 'DONE'\)\)/);
  for (const kind of [
    "FIELD", "INSERT_MODULE", "INSERT_UNIT", "INSERT_BLOCK",
    "REMOVE_MODULE", "REMOVE_UNIT", "REMOVE_BLOCK", "SPAN",
  ]) {
    assert.match(schema, new RegExp(`'${kind}'`), `report_final_intakes.kind is missing ${kind}`);
  }
  // 没有 change_set_id 列——报告没有客户端变更集，幂等靠整份 payload 的 revision 乐观锁。
  assert.doesNotMatch(schema, /change_set_id/);
});

test("report_versions gets base_is_final and report_version_comments loses its version_id foreign key", () => {
  const schema = REPORT_FINAL_SCHEMA_STATEMENTS.join("\n");
  assert.match(
    schema,
    /ALTER TABLE report_versions ADD COLUMN IF NOT EXISTS base_is_final BOOLEAN NOT NULL DEFAULT false/,
  );
  assert.match(
    schema,
    /ALTER TABLE report_version_comments DROP CONSTRAINT IF EXISTS report_version_comments_version_id_fkey/,
  );
});

test("the final-version revoke guard covers every table the schema module declares", () => {
  const schema = REPORT_FINAL_SCHEMA_STATEMENTS.join("\n");
  for (const table of REPORT_FINAL_SCHEMA_TABLES) {
    assert.match(schema, new RegExp(`REVOKE ALL ON TABLE[^']*\\b${table}\\b`));
  }
});

test("the report-final migration file mirrors the schema module so production can apply it by hand", async () => {
  const migration = await source("../db/migrations/2026-09-03-report-final.sql");
  for (const table of REPORT_FINAL_SCHEMA_TABLES) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `migration is missing CREATE TABLE for ${table}`,
    );
    assert.match(
      migration,
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`),
      `migration is missing RLS lock for ${table}`,
    );
  }
  assert.match(migration, /ALTER TABLE report_versions\s+ADD COLUMN IF NOT EXISTS base_is_final/);
  assert.match(
    migration,
    /ALTER TABLE report_version_comments\s+DROP CONSTRAINT IF EXISTS report_version_comments_version_id_fkey/,
  );
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /Supabase SQL 编辑器/);
  assert.match(migration, /不要用 `npm run db:migrate`/);
});

test("bootstrap wires the report-final schema statements in after the report schema", async () => {
  const bootstrap = await source("../db/bootstrap.ts");
  assert.match(bootstrap, /import \{ REPORT_FINAL_SCHEMA_STATEMENTS \} from "\.\/report-final-schema";/);
  const reportIdx = bootstrap.indexOf("...REPORT_SCHEMA_STATEMENTS,");
  const finalIdx = bootstrap.indexOf("...REPORT_FINAL_SCHEMA_STATEMENTS,");
  assert.ok(reportIdx !== -1 && finalIdx !== -1 && reportIdx < finalIdx,
    "REPORT_FINAL_SCHEMA_STATEMENTS must be spread in after REPORT_SCHEMA_STATEMENTS " +
    "(report_final_versions references reports(id) and report_versions(id))");
});
