import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { V04_SCHEMA_STATEMENTS } from "../db/v04-schema.ts";

const read = (relativePath) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  "utf8",
);

const bootstrap = read("../db/bootstrap.ts");
const schema = read("../db/v04-schema.ts");
const migration = read("../db/migrations/2026-08-19-v04-contract-foundation.sql");
const adminSchema = read("../db/admin-data-operation-schema.ts");
const adminInstaller = read("../lib/admin-data-operations.ts");

const v04Tables = [
  "annotation_vocabulary_versions",
  "annotation_vocabulary_options",
  "workflow_contract_versions",
  "app_role_memberships",
  "schema_migration_operations",
  "annotation_choice_values",
  "collaboration_workspaces",
  "collaboration_baselines",
  "collaboration_rounds",
  "annotation_submission_snapshots",
  "collaboration_revision_events",
  "collaboration_edit_leases",
  "expert_analysis_releases",
  "video_asset_cleanup_jobs",
];

test("bootstrap composes the two isolated schema sources", () => {
  assert.match(bootstrap, /ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS/);
  assert.match(bootstrap, /V04_SCHEMA_STATEMENTS/);
  assert.match(adminInstaller, /ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS/);
  assert.doesNotMatch(adminInstaller, /CREATE TABLE IF NOT EXISTS admin_data_operations/);
  assert.match(adminSchema, /target_video_id TEXT NOT NULL/);
  assert.doesNotMatch(schema, /target_video_id/);
});

test("V0.4 migration and bootstrap schema expose all RLS-protected tables", () => {
  for (const table of v04Tables) {
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`);
    const rls = new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    assert.match(schema, create, `missing ${table} in TypeScript schema`);
    assert.match(migration, create, `missing ${table} in SQL migration`);
    assert.match(migration, rls, `missing RLS for ${table} in SQL migration`);
  }
  assert.match(adminSchema, /ALTER TABLE admin_data_operations ENABLE ROW LEVEL SECURITY/);
  assert.equal(v04Tables.length + 1, 15);
});

test("1A is additive, draft-only, and keeps V0.3 working promotion compatible", () => {
  for (const text of [schema, migration]) {
    assert.match(text, /shots ADD COLUMN IF NOT EXISTS subtitle_effect TEXT NOT NULL DEFAULT ''/);
    assert.match(text, /OLD\.snapshot_kind = 'WORKING'/);
    assert.doesNotMatch(text, /UPDATE annotations SET/);
    assert.doesNotMatch(text, /UPDATE videos SET/);
    assert.match(text, /'DRAFT'/);
  }
  assert.match(schema, /OLD\.workflow_version = \$\{sqlText\(V04_WORKFLOW_VERSION\)\}/);
  assert.match(migration, /OLD\.workflow_version = 'AD_VIDEO_WORKFLOW_V1'/);
  assert.match(schema, /domain_key TEXT NOT NULL/);
  assert.match(schema, /product_version TEXT NOT NULL/);
  assert.match(schema, /activated_at TIMESTAMPTZ/);
  assert.match(schema, /workflow_version, domain_key, product_version/);
  assert.match(schema, /role_key IN \('EXPERT', 'SYSTEM_ADMIN'\)/);
  assert.doesNotMatch(schema, /role_key IN \([^)]*MEMBER/);
});

test("schema encodes circular ownership and immutable evidence", () => {
  for (const relation of [
    "collaboration_rounds_base_submission_workspace_fk",
    "collaboration_workspaces_active_round_fk",
    "collaboration_workspaces_current_working_fk",
    "collaboration_workspaces_latest_submission_fk",
    "collaboration_workspaces_active_expert_release_fk",
  ]) {
    assert.match(schema, new RegExp(relation));
    assert.match(migration, new RegExp(relation));
  }
  assert.match(schema, /validate_v04_collaboration_relationship/);
  assert.match(schema, /validate_v04_choice_value/);
  assert.match(schema, /protect_v04_append_only_record/);
  assert.match(schema, /protect_schema_migration_operation/);
  assert.match(schema, /protect_v04_version_contract/);
  assert.match(schema, /operation_type <> 'SCHEMA_PREVIEW' OR status = 'PREVIEWED'/);
  assert.match(schema, /schema preview evidence is permanently immutable/);
  assert.match(schema, /annotation_vocabulary_options_immutable/);
  assert.match(schema, /workflow activation requires activated_at/);
});

test("SQL migration is transactional and contains the approved 60-row contract", () => {
  assert.match(migration, /^-- V0\.4 contract foundation[\s\S]*\nBEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  const seedBlock = migration.match(
    /INSERT INTO annotation_vocabulary_options[\s\S]+?ON CONFLICT \(vocabulary_version, field_key, option_id\) DO NOTHING/,
  )?.[0] ?? "";
  assert.equal(
    (seedBlock.match(/'AD_VIDEO_VOCAB_V1',\n\s+'(?:bridgeCreativeRole|generalMechanism|storyReferenceType)'/g) ?? []).length,
    60,
  );
  assert.match(migration, /8fe7c3b01517d8a0fca6c2dbd79d4b12e16eecbe53ea9f907d2562568373c8c6/);
  assert.match(migration, /V0\.4 vocabulary option count drift/);
  const expectedMigration = [
    "-- V0.4 contract foundation. Additive, idempotent, DRAFT-only.",
    "-- Deployment/build/start must never execute this migration implicitly.",
    "",
    "BEGIN;",
    "",
    V04_SCHEMA_STATEMENTS.join(";\n\n") + ";",
    "",
    "COMMIT;",
    "",
  ].join("\n");
  assert.equal(migration, expectedMigration, "migration and bootstrap schema source drifted");
});
