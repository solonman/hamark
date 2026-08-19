import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "../db/admin-data-operation-schema.ts";
import { V04_SCHEMA_STATEMENTS, V04_SCHEMA_TABLES } from "../db/v04-schema.ts";
import {
  previewV04UploaderMappings,
  type V04LegacyUploaderReference,
  type V04StableUserIdentity,
} from "../lib/v04-role-preview.ts";
import {
  serializeV04VocabularyTsv,
  V04_VOCABULARY_APPROVED_HASHES,
  type V04VocabularyOption,
} from "../lib/v04-vocabulary.ts";

const { Client } = pg;
const RUN_ID_PATTERN = /^[a-z0-9_-]{8,40}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_SCHEMA_PREFIX = "test_only_v04_";

export type V04SchemaTestConfig = {
  connectionString: string;
  databaseName: string;
  runId: string;
  schemaName: string;
  applicationName: string;
};

type Environment = Record<string, string | undefined>;
type Queryable = Pick<pg.Client, "query">;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function parseV04SchemaTestConfig(env: Environment): V04SchemaTestConfig {
  if (env.NODE_ENV !== "test") {
    throw new Error("V0.4 schema verification requires NODE_ENV=test");
  }
  const connectionString = env.V04_TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("V04_TEST_DATABASE_URL is required; DATABASE_URL fallback is forbidden");
  }
  const runId = env.V04_TEST_RUN_ID ?? "";
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("V04_TEST_RUN_ID must match [a-z0-9_-]{8,40}");
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("V04_TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("V04_TEST_DATABASE_URL must use PostgreSQL");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("V04_TEST_DATABASE_URL must use a loopback host");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!databaseName.toLocaleLowerCase("en-US").includes("test")) {
    throw new Error("V04_TEST_DATABASE_URL database name must contain test");
  }

  return {
    connectionString,
    databaseName,
    runId,
    schemaName: `${TEST_SCHEMA_PREFIX}${runId}`,
    applicationName: `hamark_v04_schema_test_${runId}`,
  };
}

async function queryOne<T extends pg.QueryResultRow>(client: Queryable, text: string, values: unknown[] = []) {
  const result = await client.query<T>(text, values);
  assert.equal(result.rowCount, 1, `expected one row for query: ${text.slice(0, 80)}`);
  return result.rows[0];
}

async function expectDatabaseRejection(client: Queryable, text: string, values: unknown[] = []) {
  await assert.rejects(client.query(text, values));
}

async function applyStatements(client: Queryable, statements: readonly string[]) {
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function publicFingerprints(client: Queryable) {
  const catalog = await client.query<{ line: string }>(`
    SELECT concat_ws('|', c.relkind, c.relname, a.attname, a.atttypid::regtype::text,
      a.attnotnull::text, coalesce(pg_get_expr(d.adbin, d.adrelid), '')) AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname, a.attnum
  `);
  const businessLines: string[] = [];
  for (const table of ["videos", "annotations", "annotation_snapshots", "approved_analysis_releases"]) {
    const exists = await queryOne<{ present: boolean }>(client,
      "SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
    if (!exists.present) {
      businessLines.push(`${table}|missing`);
      continue;
    }
    const result = await queryOne<{ row_count: string; row_hash: string }>(client, `
      SELECT count(*)::text AS row_count,
        md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), '')) AS row_hash
      FROM ${quoteIdentifier("public")}.${quoteIdentifier(table)} t
    `);
    businessLines.push(`${table}|${result.row_count}|${result.row_hash}`);
  }
  return {
    catalog: sha256(catalog.rows.map((row) => row.line).join("\n")),
    business: sha256(businessLines.join("\n")),
  };
}

async function createGuardedSchema(client: Queryable, config: V04SchemaTestConfig, cleanupToken: string) {
  const existing = await queryOne<{ present: boolean }>(client,
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present",
    [config.schemaName]);
  if (existing.present) throw new Error(`refusing to reuse existing TEST_ONLY schema ${config.schemaName}`);
  await client.query(`CREATE SCHEMA ${quoteIdentifier(config.schemaName)}`);
  await client.query(`CREATE TABLE ${quoteIdentifier(config.schemaName)}.__v04_test_marker (
    run_id TEXT PRIMARY KEY,
    cleanup_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await client.query(
    `INSERT INTO ${quoteIdentifier(config.schemaName)}.__v04_test_marker (run_id, cleanup_token)
      VALUES ($1, $2)`,
    [config.runId, cleanupToken],
  );
  await client.query(`SET search_path TO ${quoteIdentifier(config.schemaName)}, public`);
}

async function dropGuardedSchema(client: Queryable, config: V04SchemaTestConfig, cleanupToken: string) {
  if (!config.schemaName.startsWith(TEST_SCHEMA_PREFIX) || config.schemaName !== `${TEST_SCHEMA_PREFIX}${config.runId}`) {
    throw new Error("TEST_ONLY schema cleanup guard rejected the target");
  }
  const marker = await client.query<{ run_id: string; cleanup_token: string }>(
    `SELECT run_id, cleanup_token FROM ${quoteIdentifier(config.schemaName)}.__v04_test_marker`,
  );
  if (marker.rowCount !== 1 || marker.rows[0].run_id !== config.runId ||
      marker.rows[0].cleanup_token !== cleanupToken) {
    throw new Error("TEST_ONLY schema cleanup marker mismatch");
  }
  await client.query("SET search_path TO public");
  await client.query(`DROP SCHEMA ${quoteIdentifier(config.schemaName)} CASCADE`);
}

async function installFixture(client: Queryable, fixtureSql: string) {
  await client.query(fixtureSql);
}

async function legacyFingerprint(client: Queryable) {
  const result = await queryOne<{ evidence: string }>(client, `
    SELECT jsonb_build_object(
      'annotations', (SELECT coalesce(jsonb_agg(jsonb_build_array(
        id, video_id, taxonomy_version, workflow_version, status, revision,
        analysis_title, commercial_intent, synopsis
      ) ORDER BY id), '[]'::jsonb) FROM annotations WHERE taxonomy_version IN ('V0.2', 'V0.3-PILOT')),
      'shots', (SELECT coalesce(jsonb_agg(jsonb_build_array(
        s.id, s.annotation_id, s.order_index, s.shot_number, s.visual_content
      ) ORDER BY s.id), '[]'::jsonb) FROM shots s JOIN annotations a ON a.id = s.annotation_id
        WHERE a.taxonomy_version IN ('V0.2', 'V0.3-PILOT')),
      'snapshots', (SELECT coalesce(jsonb_agg(jsonb_build_array(
        id, annotation_id, taxonomy_version, revision, payload_json, content_hash, snapshot_kind
      ) ORDER BY id), '[]'::jsonb) FROM annotation_snapshots
        WHERE taxonomy_version IN ('V0.2', 'V0.3-PILOT'))
    )::text AS evidence
  `);
  return sha256(result.evidence);
}

async function catalogFingerprint(client: Queryable, schemaName: string) {
  const result = await client.query<{ line: string }>(`
    WITH catalog AS (
      SELECT 'table' AS kind, c.relname AS object_name,
        concat(c.relrowsecurity::text, '|', c.relforcerowsecurity::text) AS detail
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE '__v04_%'
      UNION ALL
      SELECT 'column', c.relname || '.' || a.attname,
        concat_ws('|', a.attnum::text, a.atttypid::regtype::text, a.attnotnull::text,
          coalesce(pg_get_expr(d.adbin, d.adrelid), ''))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE '__v04_%'
      UNION ALL
      SELECT 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid, true)
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname NOT LIKE '__v04_%'
      UNION ALL
      SELECT 'index', tablename || '.' || indexname,
        replace(indexdef, quote_ident($1) || '.', '')
      FROM pg_indexes WHERE schemaname = $1 AND tablename NOT LIKE '__v04_%'
      UNION ALL
      SELECT 'trigger', event_object_table || '.' || trigger_name,
        concat_ws('|', action_timing, event_manipulation, action_statement)
      FROM information_schema.triggers
      WHERE trigger_schema = $1 AND event_object_table NOT LIKE '__v04_%'
    )
    SELECT concat_ws('|', kind, object_name, detail) AS line
    FROM catalog ORDER BY kind, object_name, detail
  `, [schemaName]);
  return sha256(result.rows.map((row) => row.line).join("\n"));
}

async function assertContractEvidence(client: Queryable) {
  const statuses = await queryOne<{
    taxonomy_status: string;
    vocabulary_status: string;
    workflow_status: string;
    activated_at: Date | null;
    content_hash: string;
  }>(client, `
    SELECT t.status AS taxonomy_status, v.status AS vocabulary_status,
      w.status AS workflow_status, w.activated_at, v.content_hash
    FROM annotation_taxonomy_versions t
    JOIN annotation_vocabulary_versions v ON v.taxonomy_version = t.taxonomy_version
    JOIN workflow_contract_versions w ON w.taxonomy_version = t.taxonomy_version
    WHERE t.taxonomy_version = 'AD_VIDEO_TAXONOMY_V1'
  `);
  assert.deepEqual(
    [statuses.taxonomy_status, statuses.vocabulary_status, statuses.workflow_status],
    ["DRAFT", "DRAFT", "DRAFT"],
  );
  assert.equal(statuses.activated_at, null);
  assert.equal(statuses.content_hash, V04_VOCABULARY_APPROVED_HASHES.combined);

  const optionRows = await client.query<{
    field_key: V04VocabularyOption["fieldKey"];
    order_index: number;
    option_id: string;
    label: string;
    group_key: string;
  }>(`
    SELECT field_key, order_index, option_id, label, group_key
    FROM annotation_vocabulary_options
    WHERE vocabulary_version = 'AD_VIDEO_VOCAB_V1'
    ORDER BY CASE field_key
      WHEN 'bridgeCreativeRole' THEN 1 WHEN 'generalMechanism' THEN 2 ELSE 3 END,
      order_index
  `);
  const options: V04VocabularyOption[] = optionRows.rows.map((row) => ({
    fieldKey: row.field_key,
    orderIndex: row.order_index,
    optionId: row.option_id,
    labelZhCn: row.label,
    groupKey: row.group_key,
  }));
  assert.equal(options.length, 60);
  assert.equal(sha256(serializeV04VocabularyTsv(options)), V04_VOCABULARY_APPROVED_HASHES.combined);
  for (const fieldKey of ["bridgeCreativeRole", "generalMechanism", "storyReferenceType"] as const) {
    const selected = options.filter((option) => option.fieldKey === fieldKey);
    assert.equal(sha256(serializeV04VocabularyTsv(selected)), V04_VOCABULARY_APPROVED_HASHES[fieldKey]);
  }
}

async function assertRolePreviewIsReadOnly(client: Queryable) {
  const before = await queryOne<{ count: string }>(client,
    "SELECT count(*)::text AS count FROM app_role_memberships");
  const users = await client.query<V04StableUserIdentity>(
    "SELECT id, email, status FROM users ORDER BY id",
  );
  const references = await client.query<{ videoId: string; createdByEmail: string }>(
    `SELECT id AS "videoId", created_by_email AS "createdByEmail"
      FROM videos WHERE id LIKE 'video_identity_%' ORDER BY id`,
  );
  const preview = previewV04UploaderMappings(
    users.rows,
    references.rows as V04LegacyUploaderReference[],
  );
  assert.deepEqual(preview.map((item) => item.classification).sort(),
    ["AMBIGUOUS", "DISABLED", "MISSING"]);
  assert(!JSON.stringify(preview).includes("@"));
  const after = await queryOne<{ count: string }>(client,
    "SELECT count(*)::text AS count FROM app_role_memberships");
  assert.equal(after.count, before.count);
}

async function insertV04CollaborationFixture(client: Queryable) {
  await client.query(`
    INSERT INTO annotations (
      id, video_id, author_email, author_name, taxonomy_version, workflow_version,
      status, revision, analysis_title, commercial_intent, synopsis,
      vocabulary_version, payload_schema_version, content_hash, updated_by_user_id
    ) VALUES (
      'annotation_v04', 'video_v04', 'owner@example.com', 'Owner',
      'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1', 'DRAFT', 1,
      'V0.4 title', 'V0.4 intent', 'V0.4 synopsis',
      'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', 'working-content-hash', 'user_active'
    )
  `);
  await client.query(
    "INSERT INTO shot_groups (id, annotation_id, order_index, title) VALUES ('group_v04', 'annotation_v04', 0, 'V0.4 group')",
  );
  await client.query(`
    INSERT INTO annotation_snapshots (
      id, annotation_id, video_id, author_email, author_name, taxonomy_version,
      revision, payload_json, content_hash, snapshot_kind, workflow_version,
      vocabulary_version, payload_schema_version, created_by_user_id
    ) VALUES (
      'snapshot_v04_working', 'annotation_v04', 'video_v04', 'owner@example.com', 'Owner',
      'AD_VIDEO_TAXONOMY_V1', 1, '{"version":"V0.4"}', 'working-content-hash', 'WORKING',
      'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', 'user_active'
    )
  `);
  await client.query(`
    INSERT INTO collaboration_workspaces (
      id, video_id, domain_key, taxonomy_version, workflow_version, vocabulary_version,
      canonical_annotation_id, created_by_user_id
    ) VALUES (
      'workspace_v04', 'video_v04', 'AD_VIDEO', 'AD_VIDEO_TAXONOMY_V1',
      'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_VOCAB_V1', 'annotation_v04', 'user_active'
    )
  `);
  await client.query(`
    INSERT INTO collaboration_baselines (
      id, workspace_id, annotation_id, source_kind, payload_json, content_hash,
      taxonomy_version, workflow_version, payload_schema_version, created_by_user_id
    ) VALUES (
      'baseline_v04', 'workspace_v04', 'annotation_v04', 'EMPTY', '{}', 'baseline-hash',
      'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1', 'AD_VIDEO_PAYLOAD_V1', 'user_active'
    )
  `);
  await client.query(`
    INSERT INTO collaboration_rounds (
      id, workspace_id, annotation_id, round_number, base_type, base_baseline_id,
      starting_revision, created_by_user_id
    ) VALUES ('round_v04', 'workspace_v04', 'annotation_v04', 1, 'BASELINE',
      'baseline_v04', 0, 'user_active')
  `);
  await client.query(`
    UPDATE collaboration_workspaces
    SET active_round_id = 'round_v04', current_working_snapshot_id = 'snapshot_v04_working'
    WHERE id = 'workspace_v04'
  `);
}

async function assertChoiceValues(client: Queryable) {
  await client.query(`
    INSERT INTO annotation_choice_values (
      id, annotation_id, target_type, target_id, field_key, selected_option_ids,
      custom_text, vocabulary_version, updated_by_user_id
    ) VALUES
      ('choice_fixed', 'annotation_v04', 'ANNOTATION', 'annotation_v04', 'generalMechanism',
       '["INSIGHT_RESONANCE"]', '', 'AD_VIDEO_VOCAB_V1', 'user_active'),
      ('choice_custom', 'annotation_v04', 'ANNOTATION', 'annotation_v04', 'storyReferenceType',
       '[]', 'custom-only', 'AD_VIDEO_VOCAB_V1', 'user_active'),
      ('choice_both', 'annotation_v04', 'SHOT_GROUP', 'group_v04', 'bridgeCreativeRole',
       '["ESTABLISH_CHARACTER_RELATIONSHIP"]', 'fixed-and-custom', 'AD_VIDEO_VOCAB_V1', 'user_active')
  `);
  await expectDatabaseRejection(client, `
    INSERT INTO annotation_choice_values (
      id, annotation_id, target_type, target_id, field_key, selected_option_ids,
      vocabulary_version, updated_by_user_id
    ) VALUES ('choice_bad_target', 'annotation_v04', 'ANNOTATION', 'wrong', 'generalMechanism',
      '[]', 'AD_VIDEO_VOCAB_V1', 'user_active')
  `);
  await expectDatabaseRejection(client, `
    INSERT INTO annotation_choice_values (
      id, annotation_id, target_type, target_id, field_key, selected_option_ids,
      vocabulary_version, updated_by_user_id
    ) VALUES ('choice_bad_option', 'annotation_v04', 'ANNOTATION', 'annotation_v04', 'generalMechanism',
      '["NOT_APPROVED"]', 'AD_VIDEO_VOCAB_V1', 'user_active')
  `);
  await expectDatabaseRejection(client, `
    INSERT INTO annotation_choice_values (
      id, annotation_id, target_type, target_id, field_key, selected_option_ids,
      vocabulary_version, updated_by_user_id
    ) VALUES ('choice_duplicate', 'annotation_v04', 'ANNOTATION', 'annotation_v04', 'generalMechanism',
      '["INSIGHT_RESONANCE", "INSIGHT_RESONANCE"]', 'AD_VIDEO_VOCAB_V1', 'user_active')
  `);
}

async function assertCollaborationRelationships(client: Queryable) {
  await client.query(`
    INSERT INTO annotation_submission_snapshots (
      id, workspace_id, round_id, annotation_id, video_id, submission_number,
      source_working_snapshot_id, source_revision, source_content_hash, payload_json,
      content_hash, taxonomy_version, workflow_version, vocabulary_version,
      payload_schema_version, submitted_by_user_id, idempotency_key
    ) VALUES (
      'submission_v04_1', 'workspace_v04', 'round_v04', 'annotation_v04', 'video_v04', 1,
      'snapshot_v04_working', 1, 'working-content-hash', '{"submission":1}',
      'submission-hash-1', 'AD_VIDEO_TAXONOMY_V1', 'AD_VIDEO_WORKFLOW_V1',
      'AD_VIDEO_VOCAB_V1', 'AD_VIDEO_PAYLOAD_V1', 'user_active', 'submission-key-1'
    )
  `);
  await client.query(`
    INSERT INTO expert_analysis_releases (
      id, workspace_id, submission_snapshot_id, grade, reason, granted_by_user_id
    ) VALUES ('release_v04_1', 'workspace_v04', 'submission_v04_1', 'A', 'TEST_ONLY', 'user_active')
  `);
  await client.query(`
    UPDATE collaboration_workspaces
    SET latest_submission_snapshot_id = 'submission_v04_1', active_expert_release_id = 'release_v04_1'
    WHERE id = 'workspace_v04'
  `);
  await client.query(`
    INSERT INTO collaboration_edit_leases (
      id, workspace_id, round_id, holder_user_id, session_id, tab_token_hash,
      lease_token_hash, lease_version, expires_at
    ) VALUES ('lease_v04_1', 'workspace_v04', 'round_v04', 'user_active', 'session_active',
      'tab-hash-1', 'lease-hash-1', 1, now() + interval '120 seconds')
  `);
  await expectDatabaseRejection(client, `
    INSERT INTO collaboration_edit_leases (
      id, workspace_id, round_id, holder_user_id, session_id, tab_token_hash,
      lease_token_hash, lease_version, expires_at
    ) VALUES ('lease_v04_2', 'workspace_v04', 'round_v04', 'user_active', 'session_active',
      'tab-hash-2', 'lease-hash-2', 1, now() + interval '120 seconds')
  `);
  await expectDatabaseRejection(client, `
    INSERT INTO collaboration_rounds (
      id, workspace_id, annotation_id, round_number, base_type, base_submission_snapshot_id,
      starting_revision, created_by_user_id
    ) VALUES ('round_v04_2', 'workspace_v04', 'annotation_v04', 2, 'SUBMISSION',
      'submission_v04_1', 1, 'user_active')
  `);
  await expectDatabaseRejection(client,
    "UPDATE annotation_submission_snapshots SET content_hash = 'changed' WHERE id = 'submission_v04_1'");
}

async function assertSchemaLedger(client: Queryable) {
  const baseColumns = `(
    id, operation_key, operation_type, schema_version, status, preview_token,
    source_catalog_hash, target_catalog_hash, non_target_hash, actor_user_id, idempotency_key
  )`;
  await client.query(`INSERT INTO schema_migration_operations ${baseColumns} VALUES (
    'schema_preview_1', 'preview-1', 'SCHEMA_PREVIEW', 'V0.4-1A', 'PREVIEWED', 'token-1',
    'source-1', 'target-1', 'non-target-1', 'user_active', 'idem-preview-1')`);
  await expectDatabaseRejection(client,
    "UPDATE schema_migration_operations SET status = 'APPLYING' WHERE id = 'schema_preview_1'");
  await expectDatabaseRejection(client,
    "DELETE FROM schema_migration_operations WHERE id = 'schema_preview_1'");

  await client.query(`INSERT INTO schema_migration_operations ${baseColumns} VALUES (
    'schema_apply_1', 'apply-1', 'SCHEMA_APPLY', 'V0.4-1A', 'PREVIEWED', 'token-2',
    'source-2', 'target-2', 'non-target-2', 'user_active', 'idem-apply-1')`);
  await client.query(
    "UPDATE schema_migration_operations SET status = 'APPLYING', started_at = now() WHERE id = 'schema_apply_1'",
  );
  await client.query(
    "UPDATE schema_migration_operations SET status = 'APPLIED', completed_at = now(), result_json = '{}' WHERE id = 'schema_apply_1'",
  );
  await expectDatabaseRejection(client,
    "UPDATE schema_migration_operations SET result_json = '{\"changed\":true}' WHERE id = 'schema_apply_1'");
}

async function assertRlsDeniesNonOwner(client: pg.Client, config: V04SchemaTestConfig) {
  const roleName = `v04_1a_nonowner_${config.runId}`;
  assert(RUN_ID_PATTERN.test(config.runId));
  const exists = await queryOne<{ present: boolean }>(client,
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present", [roleName]);
  if (exists.present) throw new Error(`refusing to reuse existing TEST_ONLY role ${roleName}`);
  await client.query(`CREATE ROLE ${quoteIdentifier(roleName)} NOLOGIN`);
  try {
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(config.schemaName)} TO ${quoteIdentifier(roleName)}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(config.schemaName)} TO ${quoteIdentifier(roleName)}`);
    await client.query(`SET ROLE ${quoteIdentifier(roleName)}`);
    const selected = await client.query("SELECT * FROM annotation_vocabulary_versions");
    assert.equal(selected.rowCount, 0, "RLS must hide all rows from nonowner SELECT");
    await expectDatabaseRejection(client, `
      INSERT INTO app_role_memberships (user_id, role_key)
      VALUES ('user_active', 'EXPERT')
    `);
    const updated = await client.query(
      "UPDATE annotation_vocabulary_versions SET status = 'ACTIVE' WHERE vocabulary_version = 'AD_VIDEO_VOCAB_V1'",
    );
    assert.equal(updated.rowCount, 0, "RLS must deny nonowner UPDATE");
    const deleted = await client.query(
      "DELETE FROM annotation_vocabulary_options WHERE vocabulary_version = 'AD_VIDEO_VOCAB_V1'",
    );
    assert.equal(deleted.rowCount, 0, "RLS must deny nonowner DELETE");
  } finally {
    await client.query("RESET ROLE");
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdentifier(config.schemaName)} FROM ${quoteIdentifier(roleName)}`,
    );
    await client.query(
      `REVOKE USAGE ON SCHEMA ${quoteIdentifier(config.schemaName)} FROM ${quoteIdentifier(roleName)}`,
    );
    await client.query(`DROP ROLE ${quoteIdentifier(roleName)}`);
  }
}

async function runInstalledMatrix(
  client: pg.Client,
  config: V04SchemaTestConfig,
  expectedLegacyFingerprint: string,
) {
  await assertContractEvidence(client);
  assert.equal(await legacyFingerprint(client), expectedLegacyFingerprint);
  await assertRolePreviewIsReadOnly(client);

  await client.query(
    "UPDATE annotation_snapshots SET snapshot_kind = 'CANDIDATE' WHERE id = 'snapshot_v03'",
  );
  const v03 = await queryOne<{ snapshot_kind: string }>(client,
    "SELECT snapshot_kind FROM annotation_snapshots WHERE id = 'snapshot_v03'");
  assert.equal(v03.snapshot_kind, "CANDIDATE");

  await insertV04CollaborationFixture(client);
  await expectDatabaseRejection(client,
    "UPDATE annotation_snapshots SET snapshot_kind = 'CANDIDATE' WHERE id = 'snapshot_v04_working'");
  await assertChoiceValues(client);
  await assertCollaborationRelationships(client);
  await assertSchemaLedger(client);
  await assertRlsDeniesNonOwner(client, config);

  const rls = await queryOne<{ protected_count: string }>(client, `
    SELECT count(*)::text AS protected_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relrowsecurity
  `, [config.schemaName, [...V04_SCHEMA_TABLES, "admin_data_operations"]]);
  assert.equal(Number(rls.protected_count), 15);
}

async function assertDriftRollsBack(
  client: pg.Client,
  config: V04SchemaTestConfig,
  fixtureSql: string,
  migrationSql: string,
) {
  await installFixture(client, fixtureSql);
  const before = await legacyFingerprint(client);
  await client.query(`
    INSERT INTO annotation_taxonomy_versions (taxonomy_version, workflow_version, status, label)
    VALUES ('AD_VIDEO_TAXONOMY_V1', 'WRONG_WORKFLOW', 'DRAFT', 'drift')
  `);
  let driftError: unknown;
  try {
    await client.query(migrationSql);
  } catch (error) {
    driftError = error;
    await client.query("ROLLBACK");
  }
  assert(driftError instanceof Error, "schema drift must reject migration");
  assert.match(driftError.message, /V0\.4 taxonomy contract drift/);
  const created = await queryOne<{ count: string }>(client, `
    SELECT count(*)::text AS count FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = 'workflow_contract_versions'
  `, [config.schemaName]);
  assert.equal(created.count, "0", "drift failure must roll back migration-created tables");
  assert.equal(await legacyFingerprint(client), before);
}

export async function runV04SchemaVerification(env: Environment = process.env) {
  const config = parseV04SchemaTestConfig(env);
  const fixtureSql = await readFile(resolve("tests/fixtures/v04-pre1a-history.sql"), "utf8");
  const migrationSql = await readFile(resolve("db/migrations/2026-08-19-v04-contract-foundation.sql"), "utf8");
  const cleanupToken = randomBytes(16).toString("hex");
  const client = new Client({
    connectionString: config.connectionString,
    ssl: false,
    application_name: config.applicationName,
  });
  let schemaOwnedByRun = false;
  const evidence: Record<string, unknown> = {
    runId: config.runId,
    database: config.databaseName,
    host: "loopback",
    applicationName: config.applicationName,
  };

  await client.connect();
  const publicBefore = await publicFingerprints(client);
  try {
    // E1 + R1: TypeScript bootstrap source on representative history, then repeat.
    await createGuardedSchema(client, config, cleanupToken);
    schemaOwnedByRun = true;
    await installFixture(client, fixtureSql);
    const legacyBeforeBootstrap = await legacyFingerprint(client);
    await applyStatements(client, ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS);
    await applyStatements(client, V04_SCHEMA_STATEMENTS);
    const bootstrapCatalog = await catalogFingerprint(client, config.schemaName);
    await applyStatements(client, ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS);
    await applyStatements(client, V04_SCHEMA_STATEMENTS);
    assert.equal(await catalogFingerprint(client, config.schemaName), bootstrapCatalog);
    await runInstalledMatrix(client, config, legacyBeforeBootstrap);
    evidence.E1 = true;
    evidence.R1 = true;
    evidence.H1_H7 = true;
    evidence.P1 = true;
    evidence.S1 = true;
    evidence.bootstrapCatalogHash = bootstrapCatalog;
    await dropGuardedSchema(client, config, cleanupToken);
    schemaOwnedByRun = false;

    // E2 + R2: checked-in SQL migration must create the exact same catalog and be repeatable.
    await createGuardedSchema(client, config, cleanupToken);
    schemaOwnedByRun = true;
    await installFixture(client, fixtureSql);
    const legacyBeforeMigration = await legacyFingerprint(client);
    await applyStatements(client, ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS);
    await client.query(migrationSql);
    const migrationCatalog = await catalogFingerprint(client, config.schemaName);
    assert.equal(migrationCatalog, bootstrapCatalog, "bootstrap and migration catalogs diverged");
    assert.equal(await legacyFingerprint(client), legacyBeforeMigration);
    await client.query(migrationSql);
    assert.equal(await catalogFingerprint(client, config.schemaName), migrationCatalog);
    evidence.E2 = true;
    evidence.R2 = true;
    evidence.migrationCatalogHash = migrationCatalog;
    await dropGuardedSchema(client, config, cleanupToken);
    schemaOwnedByRun = false;

    // D1: a conflicting pre-existing contract must abort and roll back atomically.
    await createGuardedSchema(client, config, cleanupToken);
    schemaOwnedByRun = true;
    await assertDriftRollsBack(client, config, fixtureSql, migrationSql);
    evidence.D1 = true;
    await dropGuardedSchema(client, config, cleanupToken);
    schemaOwnedByRun = false;
  } finally {
    if (schemaOwnedByRun) {
      try {
        await dropGuardedSchema(client, config, cleanupToken);
      } catch (cleanupError) {
        console.error("TEST_ONLY cleanup failed", cleanupError);
      }
    }
    const publicAfter = await publicFingerprints(client);
    assert.deepEqual(publicAfter, publicBefore, "public catalog/business fingerprint changed");
    evidence.publicCatalogHash = publicAfter.catalog;
    evidence.publicBusinessHash = publicAfter.business;
    await client.end();
  }

  console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
  return evidence;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runV04SchemaVerification().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
