import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BOOTSTRAP_STATEMENTS } from "../db/bootstrap.ts";
import { DbClient } from "../db/index.ts";
import {
  executeV04ContractLifecycle,
  V04_CONTRACT_ACTIVATE_CONFIRMATION,
  V04_CONTRACT_RETIRE_CONFIRMATION,
  type V04GateOneBaseline,
} from "../lib/v04-contract-activation.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";
import { previewV04Migration } from "../lib/v04-migration-preview.ts";
import { parseV04SchemaTestConfig } from "./verify-v04-schema.ts";

const { Client, Pool } = pg;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Environment = Record<string, string | undefined>;

function actor(runId: string) {
  return {
    userId: `user_${runId}`,
    identityKey: `test-only:${runId}`,
    displayName: `TEST_ONLY Contract Admin ${runId}`,
    sessionId: `session_${runId}`,
    requestId: `request_${runId}`,
  };
}

async function install(client: pg.Client, schema: string, runId: string) {
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  await client.query(`CREATE TABLE ${quote(schema)}.__v04_contract_marker(run_id TEXT PRIMARY KEY)`);
  await client.query(`INSERT INTO ${quote(schema)}.__v04_contract_marker VALUES($1)`, [runId]);
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quote(schema)},public`);
    for (const statement of BOOTSTRAP_STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedAdmin(client: pg.Client, schema: string, runId: string) {
  const current = actor(runId);
  const now = "2026-08-21T02:00:00.000Z";
  await client.query(`INSERT INTO ${quote(schema)}.users(id,wecom_corp_id,wecom_user_id,identity_key,
      display_name,status,last_login_at,last_synced_at,created_at,updated_at)
    VALUES($1,'TEST_ONLY',$1,$2,$3,'ACTIVE',$4,$4,$4,$4)`,
  [current.userId, current.identityKey, current.displayName, now]);
  await client.query(`INSERT INTO ${quote(schema)}.app_admins(display_name) VALUES($1)`, [current.displayName]);
  await client.query(`INSERT INTO ${quote(schema)}.app_role_memberships(
      user_id,role_key,status,granted_by_user_id,granted_at)
    VALUES($1,'SYSTEM_ADMIN','ACTIVE',$1,$2)`, [current.userId, now]);
  return current;
}

function poolFor(url: string, schema: string, runId: string) {
  return new Pool({
    connectionString: url,
    ssl: false,
    options: `-c search_path=${schema},public`,
    application_name: `hamark_v04_contract_${runId}`,
    max: 4,
  });
}

async function baselineFor(
  db: DbClient,
  current: ReturnType<typeof actor>,
  targetCodeSha: string,
  now: Date,
): Promise<V04GateOneBaseline> {
  const preview = await previewV04Migration(db, current, {
    targetCodeSha,
    now,
    environmentKey: "test-only-contract",
    expectedContractStatus: "DRAFT",
  });
  assert.equal(preview.ready, true);
  assert.equal(preview.schemaState, "TARGET_APPLIED_EXACT");
  return {
    verifiedCodeSha: targetCodeSha,
    bundleHash: preview.bundleHash,
    catalogHash: preview.schemaFingerprint,
    sourceHash: preview.sourceHash,
    targetHash: preview.targetHash,
    nonTargetHash: preview.nonTargetHash,
    approvalReference: "TEST_ONLY gate-two approval",
  };
}

function input(
  action: "ACTIVATE_CONTRACTS" | "RETIRE_CONTRACTS",
  runId: string,
  targetCodeSha: string,
  suffix: string,
) {
  return {
    action,
    confirmation: action === "ACTIVATE_CONTRACTS"
      ? V04_CONTRACT_ACTIVATE_CONFIRMATION
      : V04_CONTRACT_RETIRE_CONFIRMATION,
    approvalReference: `TEST_ONLY approved gate two ${runId}`,
    gateOneEvidenceReference: `TEST_ONLY gate-one:${targetCodeSha}`,
    targetCodeSha,
    idempotencyKey: `v04-contract-${runId}-${suffix}`,
  };
}

async function contractStates(client: pg.Client, schema: string) {
  const rows = await client.query<{ kind: string; status: string; activated_at: string | null }>(`
    SELECT 'taxonomy' kind,status,NULL::text activated_at FROM ${quote(schema)}.annotation_taxonomy_versions
      WHERE taxonomy_version='AD_VIDEO_TAXONOMY_V1'
    UNION ALL
    SELECT 'vocabulary',status,NULL::text FROM ${quote(schema)}.annotation_vocabulary_versions
      WHERE vocabulary_version='AD_VIDEO_VOCAB_V1'
    UNION ALL
    SELECT 'workflow',status,activated_at::text FROM ${quote(schema)}.workflow_contract_versions
      WHERE workflow_version='AD_VIDEO_WORKFLOW_V1'
    ORDER BY kind`);
  return rows.rows;
}

export async function runV04ContractActivationVerification(env: Environment = process.env) {
  const config = parseV04SchemaTestConfig(env);
  const root = new Client({ connectionString: config.connectionString, ssl: false });
  await root.connect();
  const schemas: Array<{ schema: string; runId: string }> = [];
  const make = async (suffix: string) => {
    const runId = `${config.runId}_${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 42);
    const schema = `test_only_v04_contract_${runId}`;
    assert.match(schema, /^test_only_v04_contract_[a-z0-9_-]{8,64}$/);
    await install(root, schema, runId);
    const current = await seedAdmin(root, schema, runId);
    schemas.push({ schema, runId });
    const pool = poolFor(config.connectionString, schema, runId);
    return { runId, schema, current, pool, db: new DbClient(pool) };
  };
  try {
    const success = await make("success");
    const codeSha = `TEST_ONLY_${success.runId}`;
    const now = new Date("2026-08-21T02:10:00.000Z");
    const baseline = await baselineFor(success.db, success.current, codeSha, now);
    const activationInput = input("ACTIVATE_CONTRACTS", success.runId, codeSha, "activate");
    const activated = await executeV04ContractLifecycle(success.db, success.current, activationInput, {
      now,
      targetCodeSha: codeSha,
      environmentKey: "test-only-contract",
      gateOneBaseline: baseline,
    });
    assert.equal(activated.status, "APPLIED");
    assert.equal(activated.toStatus, "ACTIVE");
    assert.deepEqual((await contractStates(root, success.schema)).map((row) => row.status),
      ["ACTIVE", "ACTIVE", "ACTIVE"]);
    assert.ok((await contractStates(root, success.schema)).find((row) => row.kind === "workflow")?.activated_at);
    const replay = await executeV04ContractLifecycle(success.db, success.current, activationInput, {
      now: new Date("2026-08-21T02:11:00.000Z"),
      targetCodeSha: codeSha,
      environmentKey: "test-only-contract",
      gateOneBaseline: baseline,
    });
    assert.equal(replay.alreadyApplied, true);
    assert.equal(replay.operationId, activated.operationId);
    const activePreview = await previewV04Migration(success.db, success.current, {
      now,
      targetCodeSha: codeSha,
      environmentKey: "test-only-contract",
      expectedContractStatus: "ACTIVE",
    });
    assert.equal(activePreview.ready, true);
    assert.equal(activePreview.sourceHash, baseline.sourceHash);
    assert.equal(activePreview.targetHash, baseline.targetHash);
    assert.equal(activePreview.nonTargetHash, baseline.nonTargetHash);

    const retireInput = input("RETIRE_CONTRACTS", success.runId, codeSha, "retire");
    const retired = await executeV04ContractLifecycle(success.db, success.current, retireInput, {
      now: new Date("2026-08-21T02:12:00.000Z"),
      targetCodeSha: codeSha,
      environmentKey: "test-only-contract",
      gateOneBaseline: baseline,
    });
    assert.equal(retired.status, "APPLIED");
    assert.deepEqual((await contractStates(root, success.schema)).map((row) => row.status),
      ["RETIRED", "RETIRED", "RETIRED"]);
    await success.pool.end();

    const rollback = await make("rollback");
    const rollbackCodeSha = `TEST_ONLY_${rollback.runId}`;
    const rollbackBaseline = await baselineFor(rollback.db, rollback.current, rollbackCodeSha, now);
    const failed = await executeV04ContractLifecycle(
      rollback.db,
      rollback.current,
      input("ACTIVATE_CONTRACTS", rollback.runId, rollbackCodeSha, "failed"),
      {
        now,
        targetCodeSha: rollbackCodeSha,
        environmentKey: "test-only-contract",
        gateOneBaseline: rollbackBaseline,
        failAt: "AFTER_FIRST_CONTRACT",
      },
    );
    assert.equal(failed.status, "FAILED");
    assert.deepEqual((await contractStates(root, rollback.schema)).map((row) => row.status),
      ["DRAFT", "DRAFT", "DRAFT"]);
    const ledger = await root.query<{ status: string; error_json: { stage: string; code: string } }>(`
      SELECT status,error_json FROM ${quote(rollback.schema)}.schema_migration_operations
      WHERE operation_type='CONTRACT_ACTIVATE'`);
    assert.equal(ledger.rows[0]?.status, "FAILED");
    assert.deepEqual(Object.keys(ledger.rows[0]?.error_json ?? {}).sort(), ["code", "stage"]);
    await rollback.pool.end();

    const concurrent = await make("concurrent");
    const concurrentCodeSha = `TEST_ONLY_${concurrent.runId}`;
    const concurrentBaseline = await baselineFor(concurrent.db, concurrent.current, concurrentCodeSha, now);
    const settled = await Promise.allSettled(["a", "b"].map((suffix) => executeV04ContractLifecycle(
      concurrent.db,
      concurrent.current,
      input("ACTIVATE_CONTRACTS", concurrent.runId, concurrentCodeSha, suffix),
      {
        now,
        targetCodeSha: concurrentCodeSha,
        environmentKey: "test-only-contract",
        gateOneBaseline: concurrentBaseline,
      },
    )));
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
    assert.deepEqual((await contractStates(root, concurrent.schema)).map((row) => row.status),
      ["ACTIVE", "ACTIVE", "ACTIVE"]);
    await concurrent.pool.end();

    const denied = await make("denied");
    const deniedCodeSha = `TEST_ONLY_${denied.runId}`;
    const deniedBaseline = await baselineFor(denied.db, denied.current, deniedCodeSha, now);
    const outsider = { ...denied.current, userId: `${denied.current.userId}_outsider` };
    await assert.rejects(() => executeV04ContractLifecycle(
      denied.db,
      outsider,
      input("ACTIVATE_CONTRACTS", denied.runId, deniedCodeSha, "outsider"),
      { now, targetCodeSha: deniedCodeSha, environmentKey: "test-only-contract", gateOneBaseline: deniedBaseline },
    ), (error: unknown) => error instanceof V04ServiceError && error.code === "ADMIN_REQUIRED");
    await denied.pool.end();

    return {
      ok: true,
      threeContractsActivatedAtomically: true,
      immutableLedgerWritten: true,
      idempotentReplay: true,
      failureRolledBackAllContracts: true,
      concurrentSingleWinner: true,
      stableSystemAdminRequired: true,
      threeContractsRetiredAtomically: true,
      businessFingerprintsUnchanged: true,
    };
  } finally {
    for (const { schema, runId } of schemas.reverse()) {
      const marker = await root.query(`SELECT run_id FROM ${quote(schema)}.__v04_contract_marker`);
      assert.equal(marker.rows[0]?.run_id, runId);
      await root.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    }
    await root.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runV04ContractActivationVerification()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "verification failed"}\n`);
      process.exitCode = 1;
    });
}
