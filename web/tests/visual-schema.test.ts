import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { VISUAL_SCHEMA_STATEMENTS, VISUAL_SCHEMA_TABLES } from "../db/visual-schema.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const schema = VISUAL_SCHEMA_STATEMENTS.join("\n");

test("the three tables (visual_cases, visual_case_assets, visual_case_favorites) are all declared", () => {
  assert.deepEqual([...VISUAL_SCHEMA_TABLES], ["visual_cases", "visual_case_assets", "visual_case_favorites"]);
  for (const table of VISUAL_SCHEMA_TABLES) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
});

test("visual_cases carries every column from the spec, with the documented defaults", () => {
  assert.match(schema, /subdomain TEXT NOT NULL,/);
  assert.match(schema, /title TEXT NOT NULL,/);
  assert.match(schema, /summary TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /text_body TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /tags_json TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(schema, /location TEXT NOT NULL,/);
  assert.match(schema, /creator TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /occurred_at TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /source_url TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /rights_note TEXT NOT NULL DEFAULT '仅公司内部学习使用'/);
  assert.match(schema, /metadata_json TEXT NOT NULL DEFAULT '\{\}'/);
  assert.match(schema, /metadata_schema_version TEXT NOT NULL DEFAULT 'visual-metadata\/1'/);
  assert.match(schema, /status TEXT NOT NULL DEFAULT 'UPLOADING'/);
  assert.match(schema, /created_by_email TEXT NOT NULL,/);
  assert.match(schema, /created_by_name TEXT NOT NULL,/);
  assert.match(schema, /deleted_at TEXT\n {2}\)/);
});

test("visual_case_assets carries the asset-level upload/derivative state machine columns", () => {
  assert.match(schema, /case_id TEXT NOT NULL REFERENCES visual_cases\(id\)/);
  assert.match(schema, /type TEXT NOT NULL,[^\n]*-- VIDEO \| IMAGE/);
  assert.match(schema, /position INTEGER NOT NULL,/);
  assert.match(schema, /object_key TEXT NOT NULL,/);
  assert.match(schema, /thumbnail_key TEXT,/);
  assert.match(schema, /display_key TEXT,/);
  assert.match(schema, /duration_seconds INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /upload_status TEXT NOT NULL DEFAULT 'UPLOADING'/);
  assert.match(schema, /derivative_status TEXT NOT NULL DEFAULT 'PENDING'/);
  assert.match(schema, /derivative_error TEXT,/);
  assert.match(schema, /derivative_requested_at TIMESTAMPTZ,/);
});

test("visual_case_favorites is a pure, unlimited favorite — primary key (case_id, user_id), no week_key/slot columns", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS visual_case_favorites \(\s*case_id TEXT NOT NULL REFERENCES visual_cases\(id\),\s*user_id TEXT NOT NULL REFERENCES users\(id\),\s*created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\),\s*PRIMARY KEY \(case_id, user_id\)\s*\)/);
  assert.doesNotMatch(schema, /week_key/);
  assert.doesNotMatch(schema, /\bslot\b/);
});

test("the four indexes from spec 4.2 are all present", () => {
  assert.match(schema, /CREATE INDEX IF NOT EXISTS visual_cases_created_at_idx ON visual_cases \(created_at DESC\) WHERE deleted_at IS NULL/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS visual_cases_subdomain_created_at_idx ON visual_cases \(subdomain, created_at DESC\)/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS visual_case_assets_case_position_idx ON visual_case_assets \(case_id, position\)/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS visual_case_favorites_user_idx ON visual_case_favorites \(user_id\)/);
});

test("all three tables have row level security enabled, inside this schema file itself", () => {
  for (const table of VISUAL_SCHEMA_TABLES) {
    assert.match(schema, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  }
});

test("db/bootstrap.ts spreads VISUAL_SCHEMA_STATEMENTS into the single schema source of truth", () => {
  return source("../db/bootstrap.ts").then((bootstrap) => {
    assert.match(bootstrap, /import \{ VISUAL_SCHEMA_STATEMENTS \} from "\.\/visual-schema"/);
    assert.match(bootstrap, /\.\.\.VISUAL_SCHEMA_STATEMENTS,/);
  });
});

test("the migration file mirrors the same three tables, four indexes and RLS grants, and can run twice (IF NOT EXISTS everywhere)", async () => {
  const migration = await source("../db/migrations/2026-09-19-public-visual.sql");
  for (const table of VISUAL_SCHEMA_TABLES) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /CREATE INDEX IF NOT EXISTS visual_cases_created_at_idx/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS visual_cases_subdomain_created_at_idx/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS visual_case_assets_case_position_idx/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS visual_case_favorites_user_idx/);
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /^COMMIT;/m);
});
