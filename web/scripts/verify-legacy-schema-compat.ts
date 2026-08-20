import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { DbClient } from "../db/index.ts";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "../db/admin-data-operation-schema.ts";
import { V04_SCHEMA_STATEMENTS } from "../db/v04-schema.ts";
import { V04_WORKFLOW_SCHEMA_STATEMENTS } from "../db/v04-workflow-schema.ts";
import {
  createVideoWithSchemaCompatibility,
  loadLegacyVideoSchemaCapabilities,
  restoreVideoWithSchemaCompatibility,
  trashVideoWithSchemaCompatibility,
  videoUploaderMatches,
} from "../lib/legacy-video-schema-compat.ts";
import type { V04Actor } from "../lib/v04-workspace-service.ts";
import { parseV04SchemaTestConfig } from "./verify-v04-schema.ts";

const { Client, Pool } = pg;
const PREFIX = "test_only_legacy_video_";
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Queryable = Pick<pg.Client, "query">;

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

async function publicFingerprint(client: Queryable) {
  const catalog = await client.query<{ line: string }>(`
    SELECT concat_ws('|', c.relkind, c.relname, coalesce(a.attname, ''),
      coalesce(a.atttypid::regtype::text, ''), coalesce(a.attnotnull::text, '')) AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname, a.attnum
  `);
  const business: string[] = [];
  for (const table of ["videos", "annotations", "annotation_snapshots", "audit_logs"]) {
    const present = await client.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`public.${table}`],
    );
    if (!present.rows[0]?.present) {
      business.push(`${table}|missing`);
      continue;
    }
    const rows = await client.query<{ count: string; hash: string }>(`
      SELECT count(*)::text AS count,
        md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), '')) AS hash
      FROM public.${quoteIdentifier(table)} t
    `);
    business.push(`${table}|${rows.rows[0]?.count}|${rows.rows[0]?.hash}`);
  }
  return sha256(`${catalog.rows.map((row) => row.line).join("\n")}\n${business.join("\n")}`);
}

async function installLegacyFixture(client: Queryable, schemaName: string, runId: string, cleanupToken: string) {
  const fixture = await readFile(resolve(process.cwd(), "tests/fixtures/v04-pre1a-history.sql"), "utf8");
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
  await client.query(`CREATE TABLE __legacy_video_test_marker (
    run_id TEXT PRIMARY KEY, cleanup_token TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await client.query(
    "INSERT INTO __legacy_video_test_marker (run_id, cleanup_token) VALUES ($1, $2)",
    [runId, cleanupToken],
  );
  await client.query(fixture);
  await client.query(`ALTER TABLE videos
    ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]',
    ADD COLUMN data_scope TEXT NOT NULL DEFAULT 'BUSINESS',
    ADD COLUMN test_run_id TEXT`);
}

async function dropGuardedSchema(
  client: Queryable,
  schemaName: string,
  runId: string,
  cleanupToken: string,
) {
  if (!schemaName.startsWith(PREFIX) || !schemaName.includes(runId)) {
    throw new Error("TEST_ONLY legacy compatibility cleanup guard rejected the schema name");
  }
  const marker = await client.query<{ run_id: string; cleanup_token: string }>(
    `SELECT run_id, cleanup_token FROM ${quoteIdentifier(schemaName)}.__legacy_video_test_marker`,
  );
  assert.equal(marker.rowCount, 1);
  assert.equal(marker.rows[0]?.run_id, runId);
  assert.equal(marker.rows[0]?.cleanup_token, cleanupToken);
  await client.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
}

function actor(requestId: string): V04Actor {
  return {
    userId: "user_active",
    identityKey: "owner@example.com",
    displayName: "Owner",
    sessionId: "session_active",
    requestId,
  };
}

async function createDbPool(connectionString: string, schemaName: string) {
  const pool = new Pool({
    connectionString,
    ssl: false,
    max: 3,
    options: `-c search_path=${schemaName},public`,
  });
  await pool.query("SELECT 1");
  return pool;
}

async function verifyPre1A(connectionString: string, schemaName: string) {
  const pool = await createDbPool(connectionString, schemaName);
  try {
    const db = new DbClient(pool);
    const capabilities = await loadLegacyVideoSchemaCapabilities(db);
    assert.equal(capabilities.stableUploader, false);
    assert.equal(capabilities.fullV04Lifecycle, false);

    const detail = await db.prepare(`SELECT id, created_by_email,
      to_jsonb(videos)->>'created_by_user_id' AS created_by_user_id
      FROM videos WHERE id = ? AND deleted_at IS NULL`).bind("video_v03").first<{
        id: string; created_by_email: string; created_by_user_id: string | null;
      }>();
    assert.equal(detail?.id, "video_v03");
    assert.equal(detail?.created_by_user_id, null);
    assert.equal(videoUploaderMatches(detail!, actor("request_pre_detail")), true);
    assert.equal(videoUploaderMatches(detail!, {
      userId: "user_other", identityKey: "other@example.com",
    }), false);

    await createVideoWithSchemaCompatibility(db, capabilities, {
      id: "video_pre_upload",
      title: "TEST_ONLY pre-1A upload",
      brand: "",
      description: "legacy upload path",
      tagsJson: "[]",
      objectKey: "test/pre-upload.mp4",
      thumbnailKey: "test/pre-upload.jpg",
      originalName: "pre-upload.mp4",
      contentType: "video/mp4",
      fileSize: 123,
      actor: actor("request_pre_upload"),
      requestId: "request_pre_upload",
    });
    const uploaded = await db.prepare(
      "SELECT created_by_email, status FROM videos WHERE id = ?",
    ).bind("video_pre_upload").first<{ created_by_email: string; status: string }>();
    assert.deepEqual(uploaded, { created_by_email: "owner@example.com", status: "UPLOADING" });
    const createdAudit = await db.prepare(
      "SELECT action FROM audit_logs WHERE object_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind("video_pre_upload").first<{ action: string }>();
    assert.equal(createdAudit?.action, "VIDEO_CREATED");

    const trashed = await trashVideoWithSchemaCompatibility(
      db, "video_pre_upload", actor("request_pre_trash"),
      { reason: "TEST_ONLY", idempotencyKey: "request_pre_trash" },
    );
    assert.equal("compatibilityMode" in trashed ? trashed.compatibilityMode : null, "PRE_1A");
    assert.equal((await db.prepare("SELECT deleted_at FROM videos WHERE id = ?")
      .bind("video_pre_upload").first<{ deleted_at: string | null }>())?.deleted_at === null, false);
    const restored = await restoreVideoWithSchemaCompatibility(
      db, "video_pre_upload", actor("request_pre_restore"),
      { idempotencyKey: "request_pre_restore" },
    );
    assert.equal("compatibilityMode" in restored ? restored.compatibilityMode : null, "PRE_1A");
    assert.equal((await db.prepare("SELECT deleted_at FROM videos WHERE id = ?")
      .bind("video_pre_upload").first<{ deleted_at: string | null }>())?.deleted_at, null);
  } finally {
    await pool.end();
  }
}

async function verifyLatest(connectionString: string, schemaName: string) {
  const pool = await createDbPool(connectionString, schemaName);
  try {
    const db = new DbClient(pool);
    const capabilities = await loadLegacyVideoSchemaCapabilities(db);
    assert.equal(capabilities.stableUploader, true);
    assert.equal(capabilities.fullV04Lifecycle, true);
    await createVideoWithSchemaCompatibility(db, capabilities, {
      id: "video_latest_upload",
      title: "TEST_ONLY latest upload",
      brand: "",
      description: "latest upload path",
      tagsJson: "[]",
      objectKey: "test/latest-upload.mp4",
      thumbnailKey: "test/latest-upload.jpg",
      originalName: "latest-upload.mp4",
      contentType: "video/mp4",
      fileSize: 456,
      actor: actor("request_latest_upload"),
      requestId: "request_latest_upload",
    });
    const uploaded = await db.prepare(
      "SELECT created_by_email, created_by_user_id, status FROM videos WHERE id = ?",
    ).bind("video_latest_upload").first<{
      created_by_email: string; created_by_user_id: string | null; status: string;
    }>();
    assert.deepEqual(uploaded, {
      created_by_email: "owner@example.com",
      created_by_user_id: "user_active",
      status: "UPLOADING",
    });
    const audit = await db.prepare(
      "SELECT actor_user_id, request_id FROM audit_logs WHERE object_id = ? AND action = 'VIDEO_CREATED'",
    ).bind("video_latest_upload").first<{ actor_user_id: string | null; request_id: string | null }>();
    assert.deepEqual(audit, { actor_user_id: "user_active", request_id: "request_latest_upload" });

    const trashed = await trashVideoWithSchemaCompatibility(
      db, "video_latest_upload", actor("request_latest_trash"),
      { reason: "TEST_ONLY", idempotencyKey: "request_latest_trash" },
    );
    assert.equal("compatibilityMode" in trashed, false);
    assert.equal(typeof trashed.restoreUntil, "string");
    const restored = await restoreVideoWithSchemaCompatibility(
      db, "video_latest_upload", actor("request_latest_restore"),
      { idempotencyKey: "request_latest_restore" },
    );
    assert.equal(restored.restored, true);
    assert.equal((await db.prepare("SELECT deleted_at FROM videos WHERE id = ?")
      .bind("video_latest_upload").first<{ deleted_at: string | null }>())?.deleted_at, null);

    // Existing rows remain manageable after 1A even when their nullable stable
    // uploader id has not been backfilled; the old identity is only a fallback.
    const legacyRowTrashed = await trashVideoWithSchemaCompatibility(
      db, "video_v03", actor("request_latest_legacy_trash"),
      { reason: "TEST_ONLY", idempotencyKey: "request_latest_legacy_trash" },
    );
    assert.equal("compatibilityMode" in legacyRowTrashed, false);
    await restoreVideoWithSchemaCompatibility(
      db, "video_v03", actor("request_latest_legacy_restore"),
      { idempotencyKey: "request_latest_legacy_restore" },
    );
  } finally {
    await pool.end();
  }
}

export async function runLegacyVideoSchemaCompatibilityVerification(
  env: Record<string, string | undefined>,
) {
  const config = parseV04SchemaTestConfig(env);
  const cleanupToken = randomBytes(18).toString("hex");
  const preSchema = `${PREFIX}${config.runId}_pre`;
  const latestSchema = `${PREFIX}${config.runId}_latest`;
  const client = new Client({
    connectionString: config.connectionString,
    ssl: false,
    application_name: `hamark_legacy_compat_${config.runId}`,
  });
  await client.connect();
  const before = await publicFingerprint(client);
  let preCreated = false;
  let latestCreated = false;
  try {
    await installLegacyFixture(client, preSchema, config.runId, cleanupToken);
    preCreated = true;
    await verifyPre1A(config.connectionString, preSchema);

    await client.query("SET search_path TO public");
    await installLegacyFixture(client, latestSchema, config.runId, cleanupToken);
    latestCreated = true;
    await applyStatements(client, ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS);
    await applyStatements(client, V04_SCHEMA_STATEMENTS);
    await applyStatements(client, V04_WORKFLOW_SCHEMA_STATEMENTS);
    await verifyLatest(config.connectionString, latestSchema);

    return {
      ok: true,
      pre1A: true,
      latest: true,
      singleBranchWrites: true,
      stableIdentityFallbackSafe: true,
    };
  } finally {
    await client.query("SET search_path TO public");
    if (latestCreated) await dropGuardedSchema(client, latestSchema, config.runId, cleanupToken);
    if (preCreated) await dropGuardedSchema(client, preSchema, config.runId, cleanupToken);
    const after = await publicFingerprint(client);
    assert.equal(after, before, "TEST_ONLY verification changed public schema or business rows");
    await client.end();
  }
}

const executedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (executedDirectly) {
  runLegacyVideoSchemaCompatibilityVerification(process.env)
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
