import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS } from "../db/admin-data-operation-schema.ts";
import { BOOTSTRAP_STATEMENTS } from "../db/bootstrap.ts";
import { DbClient } from "../db/index.ts";
import { V04_SCHEMA_STATEMENTS, V04_SCHEMA_TABLES } from "../db/v04-schema.ts";
import { V04_WORKFLOW_SCHEMA_STATEMENTS } from "../db/v04-workflow-schema.ts";
import { previewV04Migration } from "../lib/v04-migration-preview.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";
import {
  applyV04Schema,
  V04_SCHEMA_APPLY_CONFIRMATION,
} from "../lib/v04-schema-apply.ts";
import { V04_SCHEMA_BUNDLE_HASH } from "../lib/v04-schema-catalog.ts";
import { parseV04SchemaTestConfig } from "./verify-v04-schema.ts";

const { Client, Pool } = pg;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
type Environment = Record<string, string | undefined>;

const TARGET_STATEMENTS = new Set([
  ...ADMIN_DATA_OPERATION_SCHEMA_STATEMENTS,
  ...V04_SCHEMA_STATEMENTS,
  ...V04_WORKFLOW_SCHEMA_STATEMENTS,
]);
const TARGET_TABLES = new Set([...V04_SCHEMA_TABLES, "admin_data_operations"]);

const PRE_1A_BOOTSTRAP_STATEMENTS = BOOTSTRAP_STATEMENTS.filter((statement) => {
  if (TARGET_STATEMENTS.has(statement)) return false;
  if (statement.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public")) return false;
  const rls = statement.match(/^ALTER TABLE\s+([a-z0-9_]+)\s+ENABLE ROW LEVEL SECURITY$/i);
  return !rls || !TARGET_TABLES.has(rls[1] as typeof V04_SCHEMA_TABLES[number]);
});

async function publicFingerprint(client: pg.Client) {
  const catalog = await client.query<{ line: string }>(`
    SELECT concat_ws('|',c.relkind,c.relname,a.attname,a.atttypid::regtype::text,
      a.attnotnull::text,coalesce(pg_get_expr(d.adbin,d.adrelid),'')) AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname,a.attnum`);
  const tables = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const rows: string[] = [];
  for (const { table_name: table } of tables.rows) {
    const summary = await client.query<{ count: string; hash: string }>(`
      SELECT COUNT(*)::text AS count,
        COALESCE(md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))),md5('')) AS hash
      FROM ${quote("public")}.${quote(table)} t`);
    rows.push(`${table}|${summary.rows[0].count}|${summary.rows[0].hash}`);
  }
  return {
    catalog: sha256(catalog.rows.map((row) => row.line).join("\n")),
    business: sha256(rows.join("\n")),
  };
}

async function createGuardedSchema(client: pg.Client, schema: string, runId: string, token: string) {
  assert.match(schema, /^test_only_v04_apply_[a-z0-9_-]{8,55}$/);
  const existing = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
  assert.equal(existing.rowCount, 0, `refusing to reuse ${schema}`);
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  await client.query(`CREATE TABLE ${quote(schema)}.__v04_apply_marker (
    run_id TEXT PRIMARY KEY,cleanup_token TEXT NOT NULL)`);
  await client.query(`INSERT INTO ${quote(schema)}.__v04_apply_marker VALUES ($1,$2)`, [runId, token]);
}

async function dropGuardedSchema(client: pg.Client, schema: string, runId: string, token: string) {
  assert.match(schema, /^test_only_v04_apply_[a-z0-9_-]{8,55}$/);
  const marker = await client.query<{ run_id: string; cleanup_token: string }>(
    `SELECT run_id,cleanup_token FROM ${quote(schema)}.__v04_apply_marker`,
  );
  assert.equal(marker.rowCount, 1);
  assert.equal(marker.rows[0].run_id, runId);
  assert.equal(marker.rows[0].cleanup_token, token);
  await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
}

async function installPre1A(client: pg.Client, schema: string) {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quote(schema)},public`);
    for (const statement of PRE_1A_BOOTSTRAP_STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedStableAdmins(client: pg.Client, schema: string, runId: string) {
  await client.query(`SET search_path TO ${quote(schema)},public`);
  const names = ["老孙", "李丽萍", "晏恩华", `TEST_ONLY Schema Admin ${runId}`];
  const now = "2026-08-20T04:00:00.000Z";
  for (let index = 0; index < names.length; index += 1) {
    const id = `user_${runId}_${index}`;
    await client.query(`INSERT INTO users (
      id,wecom_corp_id,wecom_user_id,identity_key,display_name,email,status,
      last_login_at,last_synced_at,created_at,updated_at
    ) VALUES ($1,'TEST_ONLY',$1,$2,$3,NULL,'ACTIVE',$4,$4,$4,$4)`, [
      id, `test-only:${runId}:${index}`, names[index], now,
    ]);
  }
  await client.query("INSERT INTO app_admins(display_name) VALUES($1) ON CONFLICT DO NOTHING", [names[3]]);
  return { userId: `user_${runId}_3`, displayName: names[3] };
}

function servicePool(connectionString: string, schema: string, runId: string) {
  return new Pool({
    connectionString,
    ssl: false,
    application_name: `hamark_v04_apply_${runId}`,
    options: `-c search_path=${schema},public`,
    max: 4,
  });
}

function applyInput(preview: Awaited<ReturnType<typeof previewV04Migration>>, now: Date, idempotencyKey: string) {
  return {
    action: "APPLY_SCHEMA" as const,
    previewToken: preview.previewToken,
    targetCodeSha: preview.targetCodeSha,
    idempotencyKey,
    confirmation: V04_SCHEMA_APPLY_CONFIRMATION,
    approvalReference: "TEST_ONLY approved R5 Gate T",
    backupReference: "TEST_ONLY provider restore point",
    backupVerifiedAt: now.toISOString(),
  };
}

async function verifySuccessPath(input: {
  client: pg.Client;
  connectionString: string;
  schema: string;
  runId: string;
}) {
  await installPre1A(input.client, input.schema);
  const actor = await seedStableAdmins(input.client, input.schema, input.runId);
  const pool = servicePool(input.connectionString, input.schema, input.runId);
  try {
    const db = new DbClient(pool);
    const now = new Date("2026-08-20T04:15:00.000Z");
    const options = {
      now,
      environmentKey: `test-only:${input.runId}`,
      targetCodeSha: `TEST_ONLY_${input.runId}`,
    };
    const preview = await previewV04Migration(db, actor, options);
    assert.equal(preview.schemaState, "PRE_1A_EXACT");
    assert.equal(preview.ready, true);
    assert.equal(preview.contract.status, "MISSING");
    assert.equal(preview.zeroWrite.unchanged, true);
    assert.equal(preview.facts.P07.drift.length, 0);
    assert(preview.facts.P07.absent.tables.includes("workflow_contract_versions"));
    assert.equal(Object.keys(preview.facts).length, 11);

    await assert.rejects(
      applyV04Schema(db, actor, {
        ...applyInput(preview, now, `v04-apply-${input.runId}-stale`),
        previewToken: `${preview.previewToken.slice(0, -1)}0`,
      }, options),
      (error: unknown) => error instanceof V04ServiceError && error.code === "STALE_PREVIEW",
    );

    const concurrentKeys = [
      `v04-apply-${input.runId}-success-a`,
      `v04-apply-${input.runId}-success-b`,
    ];
    const concurrentResults = await Promise.all([
      applyV04Schema(db, actor, applyInput(
        preview, now, concurrentKeys[0],
      ), options),
      applyV04Schema(db, actor, applyInput(
        preview, now, concurrentKeys[1],
      ), options),
    ]);
    const createdIndex = concurrentResults.findIndex((item) => !item.alreadyApplied);
    assert(createdIndex >= 0);
    const result = concurrentResults[createdIndex];
    assert.equal(result.status, "APPLIED", JSON.stringify(result.failure ?? {}));
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.bundleHash, V04_SCHEMA_BUNDLE_HASH);
    assert.equal(concurrentResults.filter((item) => !item.alreadyApplied).length, 1);
    assert.equal(concurrentResults.filter((item) => item.alreadyApplied).length, 1);
    assert.equal(result.postPreview?.schemaState, "TARGET_APPLIED_EXACT");
    assert.equal(result.postPreview?.contract.status, "DRAFT");
    assert.equal(result.postPreview?.sourceHash, preview.sourceHash);
    assert.equal(result.postPreview?.targetHash, preview.targetHash);
    assert.equal(result.postPreview?.nonTargetHash, preview.nonTargetHash);
    assert.equal(result.previewTokenDigest, preview.previewTokenDigest);
    assert.equal("previewToken" in result, false);
    assert.equal("previewToken" in (result.postPreview ?? {}), false);
    assert.equal(JSON.stringify(result).includes(preview.previewToken), false);

    const storedOperation = await input.client.query<{
      preview_token: string;
      result_json: unknown;
      error_json: unknown;
    }>(`SELECT preview_token,result_json,error_json
      FROM ${quote(input.schema)}.schema_migration_operations WHERE id=$1`, [result.operationId]);
    assert.equal(storedOperation.rows.length, 1);
    assert.equal(storedOperation.rows[0].preview_token, preview.previewTokenDigest);
    assert.equal(JSON.stringify(storedOperation.rows[0]).includes(preview.previewToken), false);

    const replay = await applyV04Schema(db, actor, applyInput(
      preview, now, concurrentKeys[createdIndex],
    ), options);
    assert.equal(replay.status, "APPLIED");
    assert.equal(replay.alreadyApplied, true);
    assert.equal(replay.operationId, result.operationId);

    const catalog = await input.client.query<{ tables: string; rls: string }>(`
      SELECT COUNT(*) FILTER (WHERE c.relname=ANY($2::text[]))::text AS tables,
        COUNT(*) FILTER (WHERE c.relname=ANY($2::text[]) AND c.relrowsecurity)::text AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p')`, [
      input.schema, [...V04_SCHEMA_TABLES, "admin_data_operations"],
    ]);
    assert.equal(Number(catalog.rows[0].tables), 15);
    assert.equal(Number(catalog.rows[0].rls), 15);
    const contract = await input.client.query<{ status: string; activated_at: Date | null }>(`
      SELECT status,activated_at FROM ${quote(input.schema)}.workflow_contract_versions`);
    assert.equal(contract.rows.length, 1);
    assert.equal(contract.rows[0].status, "DRAFT");
    assert.equal(contract.rows[0].activated_at, null);
    const optionCount = await input.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${quote(input.schema)}.annotation_vocabulary_options`,
    );
    assert.equal(Number(optionCount.rows[0].count), 60);
    const memberships = await input.client.query<{ user_id: string; role_key: string }>(
      `SELECT user_id,role_key FROM ${quote(input.schema)}.app_role_memberships WHERE status='ACTIVE'`,
    );
    assert.deepEqual(memberships.rows, [{ user_id: actor.userId, role_key: "SYSTEM_ADMIN" }]);
    return { preview, result };
  } finally {
    await pool.end();
  }
}

async function verifyFailurePath(input: {
  client: pg.Client;
  connectionString: string;
  schema: string;
  runId: string;
}) {
  await installPre1A(input.client, input.schema);
  const actor = await seedStableAdmins(input.client, input.schema, input.runId);
  const pool = servicePool(input.connectionString, input.schema, input.runId);
  try {
    const db = new DbClient(pool);
    const now = new Date("2026-08-20T04:20:00.000Z");
    const options = {
      now,
      environmentKey: `test-only:${input.runId}`,
      targetCodeSha: `TEST_ONLY_${input.runId}`,
    };
    const preview = await previewV04Migration(db, actor, options);
    assert.equal(preview.ready, true);
    const failed = await applyV04Schema(db, actor, applyInput(
      preview, now, `v04-apply-${input.runId}-failure`,
    ), { ...options, failAt: "AFTER_SCHEMA" });
    assert.equal(failed.status, "FAILED");
    assert.deepEqual(failed.failure, { stage: "SCHEMA_DDL", code: "SCHEMA_APPLY_FAILED" });
    const after = await previewV04Migration(db, actor, options);
    assert.equal(after.schemaState, "CONTROL_LEDGER_ONLY_EXACT");
    assert.equal(after.ready, true);
    const tables = await input.client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables WHERE table_schema=$1
        AND table_name IN ('schema_migration_operations','annotation_vocabulary_versions','app_role_memberships')
      ORDER BY table_name`, [input.schema]);
    assert.deepEqual(tables.rows.map((row) => row.table_name), ["schema_migration_operations"]);
    const ledger = await input.client.query<{ status: string; error_json: { stage: string; code: string } }>(
      `SELECT status,error_json FROM ${quote(input.schema)}.schema_migration_operations`,
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].status, "FAILED");
    assert.deepEqual(ledger.rows[0].error_json, { stage: "SCHEMA_DDL", code: "SCHEMA_APPLY_FAILED" });

    const staleKey = `v04-apply-${input.runId}-stale-applying`;
    await input.client.query(`INSERT INTO ${quote(input.schema)}.schema_migration_operations (
      id,operation_key,operation_type,schema_version,contract_codes_json,status,
      preview_token,source_catalog_hash,target_catalog_hash,non_target_hash,
      actor_user_id,idempotency_key,started_at
    ) VALUES ($1,$2,'SCHEMA_APPLY','V04_SCHEMA_1A_V1',$3::jsonb,'APPLYING',$4,$5,$6,$7,$8,$9,$10)`, [
      `operation_${input.runId}_stale`, `operation-key-${input.runId}-stale`,
      JSON.stringify({ bundleHash: V04_SCHEMA_BUNDLE_HASH, targetCodeSha: options.targetCodeSha }),
      after.previewTokenDigest, after.sourceHash, after.targetHash, after.nonTargetHash,
      actor.userId, staleKey, new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    ]);
    const reconciled = await applyV04Schema(db, actor, applyInput(after, now, staleKey), options);
    assert.equal(reconciled.status, "FAILED");
    assert.deepEqual(reconciled.failure, {
      stage: "STALE_APPLYING_RECONCILIATION",
      code: "STALE_APPLYING",
    });
    const reconciledRow = await input.client.query<{ status: string }>(
      `SELECT status FROM ${quote(input.schema)}.schema_migration_operations WHERE id=$1`,
      [`operation_${input.runId}_stale`],
    );
    assert.equal(reconciledRow.rows[0].status, "FAILED");

    await input.client.query(`SET search_path TO ${quote(input.schema)},public`);
    await input.client.query(V04_SCHEMA_STATEMENTS[0]);
    const drift = await previewV04Migration(db, actor, options);
    assert.equal(drift.schemaState, "DRIFT_OR_PARTIAL");
    assert.equal(drift.ready, false);
    assert(drift.stopReasons.includes("SCHEMA_DRIFT_OR_PARTIAL"));
  } finally {
    await pool.end();
  }
}

export async function runV04SchemaApplyVerification(env: Environment = process.env) {
  const config = parseV04SchemaTestConfig(env);
  const connection = new URL(config.connectionString);
  connection.searchParams.delete("sslmode");
  const connectionString = connection.toString();
  const client = new Client({
    connectionString,
    ssl: false,
    application_name: `hamark_v04_apply_root_${config.runId}`,
  });
  await client.connect();
  const publicBefore = await publicFingerprint(client);
  const schemas = [
    { name: `test_only_v04_apply_${config.runId}_ok`, runId: `${config.runId}_ok`, token: randomBytes(16).toString("hex") },
    { name: `test_only_v04_apply_${config.runId}_fail`, runId: `${config.runId}_fail`, token: randomBytes(16).toString("hex") },
  ];
  try {
    for (const item of schemas) await createGuardedSchema(client, item.name, item.runId, item.token);
    const success = await verifySuccessPath({
      client, connectionString, schema: schemas[0].name, runId: schemas[0].runId,
    });
    await verifyFailurePath({
      client, connectionString, schema: schemas[1].name, runId: schemas[1].runId,
    });
    return {
      ok: true,
      pre1AReady: true,
      previewFactCount: Object.keys(success.preview.facts).length,
      zeroWrite: success.preview.zeroWrite.unchanged,
      applied: success.result.status === "APPLIED",
      uniqueStableAdmin: true,
      catalogAndRlsExact: true,
      contractsDraft: true,
      vocabularyOptions: 60,
      concurrentSingleApply: true,
      idempotentReplay: true,
      failureLedgerPreserved: true,
      savepointRollback: true,
      staleApplyingReconciled: true,
      partialDriftRejected: true,
      runtimeTokenNotPersisted: true,
      bundleHash: V04_SCHEMA_BUNDLE_HASH,
      publicFingerprintUnchanged: true,
    };
  } finally {
    for (const item of schemas.reverse()) {
      const exists = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [item.name]);
      if (exists.rowCount) await dropGuardedSchema(client, item.name, item.runId, item.token);
    }
    const publicAfter = await publicFingerprint(client);
    assert.deepEqual(publicAfter, publicBefore, "public catalog/business fingerprint changed");
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runV04SchemaApplyVerification().then((evidence) => {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
