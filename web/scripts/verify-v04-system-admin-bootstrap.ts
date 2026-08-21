import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BOOTSTRAP_STATEMENTS } from "../db/bootstrap.ts";
import { DbClient } from "../db/index.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";
import {
  bootstrapV04SystemAdmin,
  inspectV04SystemAdminBootstrapCandidate,
  V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION,
} from "../lib/v04-system-admin-bootstrap.ts";
import { parseV04SchemaTestConfig } from "./verify-v04-schema.ts";

const { Client, Pool } = pg;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Environment = Record<string, string | undefined>;

function actor(runId: string) {
  return { userId: `user_${runId}`, identityKey: `test-only:${runId}`,
    displayName: `TEST_ONLY Admin ${runId}`, sessionId: `session_${runId}`, requestId: `request_${runId}` };
}

function request(runId: string, suffix: string) {
  return { action: "BOOTSTRAP_SYSTEM_ADMIN" as const,
    confirmation: V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION,
    approvalReference: `TEST_ONLY approval ${runId}`,
    targetCodeSha: `TEST_ONLY_${runId}`, idempotencyKey: `v04-admin-${runId}-${suffix}` };
}

async function install(client: pg.Client, schema: string) {
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  await client.query(`CREATE TABLE ${quote(schema)}.__marker(run_id TEXT PRIMARY KEY)`);
  await client.query(`INSERT INTO ${quote(schema)}.__marker VALUES($1)`, [schema]);
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quote(schema)},public`);
    for (const statement of BOOTSTRAP_STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function seed(client: pg.Client, schema: string, runId: string, mode = "unique") {
  const current = actor(runId);
  const name = mode === "cross" ? `${current.displayName} caller` : current.displayName;
  const status = mode === "disabled" ? "DISABLED" : "ACTIVE";
  const now = "2026-08-21T00:00:00.000Z";
  await client.query(`INSERT INTO ${quote(schema)}.users(id,wecom_corp_id,wecom_user_id,identity_key,
    display_name,status,last_login_at,last_synced_at,created_at,updated_at)
    VALUES($1,'TEST_ONLY',$1,$2,$3,$4,$5,$5,$5,$5)`, [current.userId,current.identityKey,name,status,now]);
  await client.query(`INSERT INTO ${quote(schema)}.app_admins(display_name) VALUES($1) ON CONFLICT DO NOTHING`, [current.displayName]);
  if (mode === "ambiguous" || mode === "cross") {
    await client.query(`INSERT INTO ${quote(schema)}.users(id,wecom_corp_id,wecom_user_id,identity_key,
      display_name,status,last_login_at,last_synced_at,created_at,updated_at)
      VALUES($1,'TEST_ONLY',$1,$2,$3,'ACTIVE',$4,$4,$4,$4)`,
    [`user_${runId}_other`,`test-only:${runId}:other`,current.displayName,now]);
  }
  if (mode === "existing") await client.query(`INSERT INTO ${quote(schema)}.app_role_memberships
    (user_id,role_key,status,granted_by_user_id) VALUES($1,'SYSTEM_ADMIN','ACTIVE',$1)`, [current.userId]);
  return current;
}

function servicePool(url: string, schema: string, runId: string) {
  return new Pool({ connectionString: url, ssl: false, options: `-c search_path=${schema},public`,
    application_name: `hamark_v04_admin_${runId}`, max: 4 });
}

async function businessFingerprint(client: pg.Client, schema: string) {
  const lines: string[] = [];
  for (const table of ["videos","annotations","shots","annotation_snapshots","audit_logs"]) {
    const row = await client.query<{ count:string; hash:string }>(`SELECT COUNT(*)::text count,
      COALESCE(md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))),md5('')) hash
      FROM ${quote(schema)}.${quote(table)} t`);
    lines.push(`${table}|${row.rows[0].count}|${row.rows[0].hash}`);
  }
  return digest(lines.join("\n"));
}

export async function runV04SystemAdminBootstrapVerification(env: Environment = process.env) {
  const config = parseV04SchemaTestConfig(env);
  const root = new Client({ connectionString: config.connectionString, ssl: false });
  await root.connect();
  const schemas: string[] = [];
  const make = async (suffix: string) => {
    const runId = `${config.runId}_${suffix}`.slice(0, 40);
    const schema = `test_only_v04_admin_${runId}`;
    assert.match(schema, /^test_only_v04_admin_[a-z0-9_-]{8,60}$/);
    await install(root, schema); schemas.push(schema); return { runId, schema };
  };
  try {
    const success = await make("success");
    const current = await seed(root, success.schema, success.runId);
    const pool = servicePool(config.connectionString, success.schema, success.runId);
    const db = new DbClient(pool);
    const before = await businessFingerprint(root, success.schema);
    assert.equal((await inspectV04SystemAdminBootstrapCandidate(db, current)).eligible, true);
    const firstInput = request(success.runId, "same-request");
    const first = await bootstrapV04SystemAdmin(db, current, firstInput,
      { targetCodeSha: firstInput.targetCodeSha, now: new Date("2026-08-21T00:05:00Z") });
    const replay = await bootstrapV04SystemAdmin(db, current, firstInput,
      { targetCodeSha: firstInput.targetCodeSha, now: new Date("2026-08-21T00:06:00Z") });
    assert.equal(first.schemaState, "TARGET_APPLIED_EXACT"); assert.equal(replay.alreadyApplied, true);
    await assert.rejects(() => bootstrapV04SystemAdmin(db, current, request(success.runId,"new-request"),
      { targetCodeSha: firstInput.targetCodeSha }), (error: unknown) =>
      error instanceof V04ServiceError && error.details.classification === "SYSTEM_ADMIN_EXISTS");
    assert.equal(await businessFingerprint(root, success.schema), before);
    await pool.end();

    const concurrent = await make("concurrent");
    const concurrentActor = await seed(root, concurrent.schema, concurrent.runId);
    const concurrentPool = servicePool(config.connectionString, concurrent.schema, concurrent.runId);
    const concurrentDb = new DbClient(concurrentPool);
    const requests = [request(concurrent.runId,"request-a"), request(concurrent.runId,"request-b")];
    const settled = await Promise.allSettled(requests.map((item) => bootstrapV04SystemAdmin(
      concurrentDb, concurrentActor, item, { targetCodeSha: item.targetCodeSha })));
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
    await concurrentPool.end();

    const cases = [["disabled","DISABLED"],["ambiguous","AMBIGUOUS"],["cross","DISABLED"],["existing","SYSTEM_ADMIN_EXISTS"]] as const;
    for (const [mode, expected] of cases) {
      const scenario = await make(mode); const caseActor = await seed(root, scenario.schema, scenario.runId, mode);
      const casePool = servicePool(config.connectionString, scenario.schema, scenario.runId);
      const candidate = await inspectV04SystemAdminBootstrapCandidate(new DbClient(casePool), caseActor);
      assert.equal(candidate.eligible, false); assert.equal(candidate.classification, expected); await casePool.end();
    }

    const drift = await make("drift"); const driftActor = await seed(root, drift.schema, drift.runId);
    await root.query(`DROP TRIGGER workflow_contract_versions_immutable
      ON ${quote(drift.schema)}.workflow_contract_versions`);
    const driftPool = servicePool(config.connectionString, drift.schema, drift.runId);
    const driftRequest = request(drift.runId,"request");
    await assert.rejects(() => bootstrapV04SystemAdmin(new DbClient(driftPool), driftActor, driftRequest,
      { targetCodeSha: driftRequest.targetCodeSha }), (error: unknown) =>
      error instanceof V04ServiceError && error.code === "TRANSACTION_ROLLED_BACK");
    assert.equal((await root.query(`SELECT 1 FROM ${quote(drift.schema)}.app_role_memberships`)).rowCount, 0);
    await driftPool.end();
    return { ok:true, legalUniqueActor:true, inactiveRejected:true, ambiguousRejected:true,
      existingAdminRejected:true, crossUserRejected:true, idempotentReplay:true,
      concurrentSingleWinner:true, schemaDriftRolledBack:true, publicBusinessFingerprintUnchanged:true };
  } finally {
    for (const schema of schemas.reverse()) {
      const marker = await root.query(`SELECT run_id FROM ${quote(schema)}.__marker`);
      assert.equal(marker.rows[0]?.run_id, schema); await root.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    }
    await root.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runV04SystemAdminBootstrapVerification().then((result) => process.stdout.write(`${JSON.stringify(result,null,2)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "verification failed"}\n`); process.exitCode=1; });
}
