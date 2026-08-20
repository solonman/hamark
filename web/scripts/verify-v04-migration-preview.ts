import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BOOTSTRAP_STATEMENTS } from "../db/bootstrap.ts";
import { DbClient } from "../db/index.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";
import {
  assertV04PreviewToken,
  compareV04SchemaObjects,
  inspectV04SchemaObjects,
  previewV04Migration,
  V04_FROZEN_SCHEMA_OBJECT_EXPECTATION,
} from "../lib/v04-migration-preview.ts";
import { parseV04SchemaTestConfig } from "./verify-v04-schema.ts";

const { Client, Pool } = pg;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
type Environment = Record<string, string | undefined>;

async function publicFingerprint(client: pg.Client) {
  const catalog = await client.query<{ line: string }>(`
    SELECT concat_ws('|', c.relkind, c.relname, a.attname, a.atttypid::regtype::text,
      a.attnotnull::text, coalesce(pg_get_expr(d.adbin,d.adrelid),'')) AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
    ORDER BY c.relname,a.attnum`);
  const rows = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const business: string[] = [];
  for (const row of rows.rows) {
    const summary = await client.query<{ count: string; hash: string }>(`
      SELECT COUNT(*)::text AS count,
        COALESCE(md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))),md5('')) AS hash
      FROM ${quote("public")}.${quote(row.table_name)} t`);
    business.push(`${row.table_name}|${summary.rows[0].count}|${summary.rows[0].hash}`);
  }
  return {
    catalog: sha256(catalog.rows.map((row) => row.line).join("\n")),
    business: sha256(business.join("\n")),
  };
}

async function installSchema(client: pg.Client) {
  await client.query("BEGIN");
  try {
    for (const statement of BOOTSTRAP_STATEMENTS) {
      if (statement.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public")) continue;
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function installFrozenObject(client: pg.Client, objectName: string) {
  const statement = BOOTSTRAP_STATEMENTS.find((item) =>
    item.includes(`CREATE INDEX IF NOT EXISTS ${objectName}`) ||
    item.includes(`CREATE UNIQUE INDEX IF NOT EXISTS ${objectName}`) ||
    item.includes(`CREATE TRIGGER ${objectName}`));
  assert(statement, `missing frozen bootstrap statement for ${objectName}`);
  await client.query(statement);
}

async function isolatedFingerprint(client: pg.Client, schemaName: string) {
  const rows = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema=$1 AND table_type='BASE TABLE' AND table_name NOT LIKE '__v04_%'
    ORDER BY table_name`, [schemaName]);
  const evidence: string[] = [];
  for (const row of rows.rows) {
    const summary = await client.query<{ count: string; hash: string }>(`
      SELECT COUNT(*)::text AS count,
        COALESCE(md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text))),md5('')) AS hash
      FROM ${quote(schemaName)}.${quote(row.table_name)} t`);
    evidence.push(`${row.table_name}|${summary.rows[0].count}|${summary.rows[0].hash}`);
  }
  return sha256(evidence.join("\n"));
}

async function verifyPre1AAdminCompatibility(
  client: pg.Client,
  connectionString: string,
  runId: string,
) {
  const schemaName = `test_only_v04_preview_pre_${runId}`;
  const marker = randomBytes(16).toString("hex");
  const exists = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schemaName]);
  if (exists.rowCount) throw new Error(`refusing to reuse ${schemaName}`);
  await client.query(`CREATE SCHEMA ${quote(schemaName)}`);
  try {
    await client.query(`SET search_path TO ${quote(schemaName)},public`);
    await client.query(`CREATE TABLE __v04_preview_pre_marker (
      run_id TEXT PRIMARY KEY, cleanup_token TEXT NOT NULL
    )`);
    await client.query("INSERT INTO __v04_preview_pre_marker VALUES ($1,$2)", [runId, marker]);
    await client.query(`CREATE TABLE users (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, status TEXT NOT NULL
    )`);
    await client.query(`CREATE TABLE app_admins (
      display_name TEXT PRIMARY KEY
    )`);
    await client.query(`INSERT INTO users (id,display_name,status) VALUES
      ($1,'TEST_ONLY Pre Admin','ACTIVE'),
      ($2,'TEST_ONLY Ambiguous','ACTIVE'),
      ($3,'TEST_ONLY Ambiguous','ACTIVE'),
      ($4,'TEST_ONLY Missing','ACTIVE'),
      ($5,'TEST_ONLY Disabled','DISABLED')`, [
      `user_${runId}_pre_unique`,
      `user_${runId}_pre_ambiguous_a`,
      `user_${runId}_pre_ambiguous_b`,
      `user_${runId}_pre_missing`,
      `user_${runId}_pre_disabled`,
    ]);
    await client.query(`INSERT INTO app_admins (display_name) VALUES
      ('TEST_ONLY Pre Admin'),('TEST_ONLY Ambiguous'),('TEST_ONLY Disabled')`);
    const before = await isolatedFingerprint(client, schemaName);
    const pool = new Pool({
      connectionString,
      ssl: false,
      application_name: `hamark_v04_preview_pre_service_${runId}`,
      options: `-c search_path=${schemaName},public`,
      max: 3,
    });
    try {
      const db = new DbClient(pool);
      const uniqueActor = {
        userId: `user_${runId}_pre_unique`,
        displayName: "TEST_ONLY Pre Admin",
      };
      const first = await previewV04Migration(db, uniqueActor, {
        now: new Date("2026-08-19T12:30:00.000Z"),
        environmentKey: "test-only-pre-1a",
      });
      const repeated = await previewV04Migration(db, uniqueActor, {
        now: new Date("2026-08-19T12:31:00.000Z"),
        environmentKey: "test-only-pre-1a",
      });
      assert.equal(first.ready, false);
      assert.equal(first.contract.status, "MISSING");
      assert(first.facts.P07.missingTables.includes("app_role_memberships"));
      assert(first.facts.P07.missingTables.includes("workflow_contract_versions"));
      assert.equal(first.previewToken, repeated.previewToken);
      assert.equal(first.sourceHash, repeated.sourceHash);
      assert.equal(first.targetHash, repeated.targetHash);
      assert.equal(first.nonTargetHash, repeated.nonTargetHash);

      for (const denied of [
        {
          actor: { userId: `user_${runId}_pre_ambiguous_a`, displayName: "TEST_ONLY Ambiguous" },
          classification: "AMBIGUOUS",
        },
        {
          actor: { userId: `user_${runId}_pre_missing`, displayName: "TEST_ONLY Missing" },
          classification: "MISSING",
        },
        {
          actor: { userId: `user_${runId}_pre_disabled`, displayName: "TEST_ONLY Disabled" },
          classification: "DISABLED",
        },
      ]) {
        await assert.rejects(
          previewV04Migration(db, denied.actor, { environmentKey: "test-only-pre-1a" }),
          (error: unknown) => error instanceof V04ServiceError
            && error.code === "ADMIN_REQUIRED"
            && error.details.classification === denied.classification,
        );
      }
    } finally {
      await pool.end();
    }
    assert.equal(await isolatedFingerprint(client, schemaName), before, "pre-1A PREVIEW must be zero-write");
    return {
      pre1AUniqueAdminAllowed: true,
      pre1AAmbiguousMissingDisabledRejected: true,
      pre1ASchemaDriftP07Returned: true,
      pre1AZeroWrite: true,
    };
  } finally {
    await client.query(`SET search_path TO ${quote(schemaName)},public`);
    const guard = await client.query<{ run_id: string; cleanup_token: string }>(
      "SELECT run_id,cleanup_token FROM __v04_preview_pre_marker",
    );
    assert.equal(guard.rowCount, 1);
    assert.equal(guard.rows[0].run_id, runId);
    assert.equal(guard.rows[0].cleanup_token, marker);
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA ${quote(schemaName)} CASCADE`);
  }
}

async function seedHistory(db: DbClient, runId: string) {
  const time = "2026-08-19T12:00:00.000Z";
  const userRows = [
    [`user_${runId}_admin`, "TEST_ONLY Admin", "ACTIVE"],
    [`user_${runId}_unique`, "老孙", "ACTIVE"],
    [`user_${runId}_dup_a`, "李丽萍", "ACTIVE"],
    [`user_${runId}_dup_b`, "李丽萍", "DISABLED"],
    [`user_${runId}_disabled`, "晏恩华", "DISABLED"],
    [`user_${runId}_expert`, "TEST_ONLY Expert", "ACTIVE"],
  ] as const;
  for (const [id, name, status] of userRows) {
    await db.prepare(`INSERT INTO users (
      id,wecom_corp_id,wecom_user_id,identity_key,display_name,email,status,
      last_login_at,last_synced_at,created_at,updated_at
    ) VALUES (?,'TEST_ONLY',?,?,?,NULL,?,?,?,?,?)`).bind(
      id, id, `test-only:${runId}:${id}`, name, status, time, time, time, time,
    ).run();
  }
  await db.prepare(`INSERT INTO app_role_memberships (user_id,role_key,status)
    VALUES (?,'SYSTEM_ADMIN','ACTIVE'),(?,'EXPERT','ACTIVE')`).bind(
    `user_${runId}_admin`, `user_${runId}_expert`,
  ).run();

  for (const [suffix, title, objectKey] of [
    ["v02", "TEST_ONLY V0.2", `test-only/${runId}/v02.mp4`],
    ["v03", "TEST_ONLY V0.3", `test-only/${runId}/v03.mp4`],
    ["empty", "TEST_ONLY Empty", `test-only/${runId}/empty.mp4`],
  ]) {
    await db.prepare(`INSERT INTO videos (
      id,title,brand,description,tags_json,object_key,original_name,content_type,file_size,
      status,rights_confirmed,created_by_email,created_by_name,created_at,updated_at,
      data_scope,test_run_id,created_by_user_id,deletion_state
    ) VALUES (?,?,?,?,?,?,?,?,?,'READY',1,?,?,?,?,'BUSINESS',?,?,'ACTIVE')`).bind(
      `video_${runId}_${suffix}`, title, "TEST_ONLY", "", "[]", objectKey,
      `${suffix}.mp4`, "video/mp4", 1, `test-${suffix}@example.invalid`, "TEST_ONLY",
      time, time, runId, `user_${runId}_admin`,
    ).run();
  }

  const annotations = [
    { suffix: "v02", taxonomy: "V0.2", workflow: "REVERSE-WORKFLOW-V0.2" },
    { suffix: "v03", taxonomy: "V0.3-PILOT", workflow: "REVERSE-WORKFLOW-V0.3-PILOT" },
  ];
  for (const item of annotations) {
    await db.prepare(`INSERT INTO annotations (
      id,video_id,author_email,author_name,taxonomy_version,workflow_version,status,revision,
      analysis_title,commercial_intent,creative_theme,synopsis,thinking_chain,shot_commentary,
      summary,created_at,updated_at,review_status
    ) VALUES (?,?,?,?,?,?,'SUBMITTED',2,?,?,?,?,?,?,?, ?,?,'SUBMITTED')`).bind(
      `annotation_${runId}_${item.suffix}`, `video_${runId}_${item.suffix}`,
      `legacy-${item.suffix}@example.invalid`, `Legacy ${item.suffix}`, item.taxonomy, item.workflow,
      "Legacy", "Intent", "Theme", "Synopsis", "Chain", "", "Summary", time, time,
    ).run();
    await db.prepare(`INSERT INTO shot_groups (
      id,annotation_id,order_index,title,primary_role_id,primary_role_name_snapshot,
      auxiliary_roles_json,custom_role,note,taxonomy_version,created_at,updated_at
    ) VALUES (?,?,0,'桥段','OTHER','其他（自定义）','["ACCUMULATE_EMOTION"]',
      '旧自定义作用','保留原文',?,?,?)`).bind(
      `group_${runId}_${item.suffix}`, `annotation_${runId}_${item.suffix}`, item.taxonomy, time, time,
    ).run();
    await db.prepare(`INSERT INTO shots (
      id,annotation_id,order_index,group_name,shot_number,start_time,end_time,shot_size,
      camera_angle,camera_movement,visual_content,dialogue,voiceover,screen_text,sound_effect,
      music,creative_comment,shot_group_id,subtitle_effect
    ) VALUES (?,?,0,'桥段','1','00:00','00:01','近景','平视','固定','旧画面','','',
      '旧字幕','','','不可推断字幕特效',?,'')`).bind(
      `shot_${runId}_${item.suffix}`, `annotation_${runId}_${item.suffix}`,
      `group_${runId}_${item.suffix}`,
    ).run();
    await db.prepare(`INSERT INTO annotation_creative_structures (
      annotation_id,mechanism_primary,mechanism_auxiliary_json,mechanism_custom,
      story_reference_type,updated_at
    ) VALUES (?,'__CUSTOM__','["现有词表不适用／待形成新机制"]',
      '旧开放填写','其他（自定义参照类型）',?)`).bind(
      `annotation_${runId}_${item.suffix}`, time,
    ).run();
    await db.prepare(`INSERT INTO annotation_snapshots (
      id,annotation_id,video_id,author_email,author_name,taxonomy_version,revision,payload_json,
      content_hash,created_at,version_number,workflow_status,snapshot_kind,workflow_version
    ) VALUES (?,?,?,?,?,?,2,?,'legacy-hash',?,1,'SUBMITTED','WORKING',?)`).bind(
      `snapshot_${runId}_${item.suffix}`, `annotation_${runId}_${item.suffix}`,
      `video_${runId}_${item.suffix}`, `legacy-${item.suffix}@example.invalid`, `Legacy ${item.suffix}`,
      item.taxonomy, JSON.stringify({ legacy: item.suffix }), time, item.workflow,
    ).run();
  }

  await db.prepare(`INSERT INTO v03_collaboration_streams (
    id,video_id,taxonomy_version,canonical_annotation_id,current_snapshot_id,
    source_author_email,source_author_name,status,created_by_email,created_by_name,created_at,updated_at
  ) VALUES (?,?,'V0.3-PILOT',?,?,?,'Legacy v03','ACTIVE',?,'TEST_ONLY',?,?)`).bind(
    `stream_${runId}`, `video_${runId}_v03`, `annotation_${runId}_v03`, `snapshot_${runId}_v03`,
    "legacy-v03@example.invalid", "test-only@example.invalid", time, time,
  ).run();
  await db.prepare(`INSERT INTO v03_collaboration_baselines (
    id,stream_id,annotation_id,source_type,source_snapshot_id,payload_json,content_hash,
    source_author_email,source_author_name,created_by_email,created_by_name,created_at
  ) VALUES (?,?,?,'EXISTING_V03',?,'{}','baseline-hash',?,'Legacy v03',?,'TEST_ONLY',?)`).bind(
    `baseline_${runId}`, `stream_${runId}`, `annotation_${runId}_v03`, `snapshot_${runId}_v03`,
    "legacy-v03@example.invalid", "test-only@example.invalid", time,
  ).run();
  await db.prepare(`INSERT INTO v03_collaboration_rounds (
    id,stream_id,annotation_id,round_number,status,base_type,base_baseline_id,starting_revision,
    created_by_email,created_by_name,created_at
  ) VALUES (?,?,?,1,'ACTIVE','INITIAL_BASELINE',?,2,?,'TEST_ONLY',?)`).bind(
    `round_${runId}`, `stream_${runId}`, `annotation_${runId}_v03`, `baseline_${runId}`,
    "test-only@example.invalid", time,
  ).run();
  await db.prepare(`UPDATE v03_collaboration_streams SET initial_baseline_id=?,active_round_id=? WHERE id=?`)
    .bind(`baseline_${runId}`, `round_${runId}`, `stream_${runId}`).run();
  return {
    adminUserId: `user_${runId}_admin`,
    uniqueLegacyAdminUserId: `user_${runId}_unique`,
    expertUserId: `user_${runId}_expert`,
    streamId: `stream_${runId}`,
    v03AnnotationId: `annotation_${runId}_v03`,
    v03VideoId: `video_${runId}_v03`,
  };
}

export async function runV04MigrationPreviewVerification(env: Environment = process.env) {
  const config = parseV04SchemaTestConfig(env);
  const schemaName = `test_only_v04_preview_${config.runId}`;
  const marker = randomBytes(16).toString("hex");
  const client = new Client({
    connectionString: config.connectionString,
    ssl: false,
    application_name: `hamark_v04_preview_test_${config.runId}`,
  });
  const evidence: Record<string, unknown> = {
    runId: config.runId,
    host: "loopback",
    database: config.databaseName,
  };
  let owned = false;
  await client.connect();
  const publicBefore = await publicFingerprint(client);
  try {
    Object.assign(
      evidence,
      await verifyPre1AAdminCompatibility(client, config.connectionString, config.runId),
    );
    const exists = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schemaName]);
    if (exists.rowCount) throw new Error(`refusing to reuse ${schemaName}`);
    await client.query(`CREATE SCHEMA ${quote(schemaName)}`);
    owned = true;
    await client.query(`CREATE TABLE ${quote(schemaName)}.__v04_preview_marker (
      run_id TEXT PRIMARY KEY,cleanup_token TEXT NOT NULL)`);
    await client.query(`INSERT INTO ${quote(schemaName)}.__v04_preview_marker VALUES ($1,$2)`, [config.runId, marker]);
    await client.query(`SET search_path TO ${quote(schemaName)},public`);
    await installSchema(client);
    const pool = new Pool({
      connectionString: config.connectionString,
      ssl: false,
      application_name: `hamark_v04_preview_service_${config.runId}`,
      options: `-c search_path=${schemaName},public`,
      max: 6,
    });
    const db = new DbClient(pool);
    try {
      const fixture = await seedHistory(db, config.runId);
      const before = await isolatedFingerprint(client, schemaName);
      const first = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: new Date("2026-08-19T12:30:00.000Z"), environmentKey: "test-only",
      });
      const second = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: new Date("2026-08-19T12:31:00.000Z"), environmentKey: "test-only",
      });
      const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
        previewV04Migration(db, { userId: fixture.adminUserId }, {
          now: new Date("2026-08-19T12:32:00.000Z"), environmentKey: "test-only",
        })));
      assert.equal(first.ready, true);
      assert.equal(first.contract.status, "DRAFT");
      assert.equal(first.previewToken, second.previewToken);
      assert.equal(first.schemaFingerprint, second.schemaFingerprint);
      assert.equal(first.sourceHash, second.sourceHash);
      assert.equal(first.targetHash, second.targetHash);
      assert.equal(first.nonTargetHash, second.nonTargetHash);
      assert(concurrent.every((item) => item.previewToken === first.previewToken));
      assert.equal(first.facts.P01.businessVideos, 3,
        "isolated TEST_ONLY schema must exercise the BUSINESS preview scope");
      assert.equal(first.facts.P01.v02Annotations, 1);
      assert.equal(first.facts.P01.v03Annotations, 1);
      assert.equal(first.facts.P02.v03Streams, 1);
      assert.equal(first.facts.P02.logicalEmptyBusinessVideos, 3);
      assert.equal(first.facts.P08.legacyCustomMarkers, 2);
      assert.equal(first.facts.P08.pendingMechanisms, 2);
      assert.deepEqual(first.facts.P09.classifications, { UNIQUE: 1, AMBIGUOUS: 1, MISSING: 0, DISABLED: 1 });
      assert.equal(first.facts.P09.mappings.length, 3);
      assert.equal(first.facts.P10.cosOrphanStatus, "NOT_CONFIRMABLE_FROM_DATABASE");
      assert.equal(await isolatedFingerprint(client, schemaName), before, "PREVIEW must be zero-write");
      assert.equal(first.expiresAt, "2026-08-19T13:00:00.000Z");
      assert.doesNotThrow(() => assertV04PreviewToken(
        second,
        first.previewToken,
        new Date("2026-08-19T12:59:59.999Z"),
      ));
      assert.throws(() => assertV04PreviewToken(
        second,
        first.previewToken,
        new Date(first.expiresAt),
      ), (error) => error instanceof V04ServiceError &&
        error.code === "STALE_PREVIEW" && error.details.reason === "EXPIRED");
      const nextWindow = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: new Date(first.expiresAt), environmentKey: "test-only",
      });
      assert.notEqual(nextWindow.previewToken, first.previewToken);
      assert.equal(nextWindow.expiresAt, "2026-08-19T13:30:00.000Z");
      assert.throws(() => assertV04PreviewToken(
        nextWindow,
        first.previewToken,
        new Date(first.expiresAt),
      ), (error) => error instanceof V04ServiceError && error.code === "STALE_PREVIEW");
      await assert.rejects(
        previewV04Migration(db, { userId: fixture.expertUserId }, { environmentKey: "test-only" }),
        (error: unknown) => error instanceof V04ServiceError && error.code === "ADMIN_REQUIRED",
      );
      await assert.rejects(
        previewV04Migration(db, {
          userId: fixture.uniqueLegacyAdminUserId,
          displayName: "老孙",
        }, { environmentKey: "test-only" }),
        (error: unknown) => error instanceof V04ServiceError
          && error.code === "ADMIN_REQUIRED"
          && error.details.authorizationMode === "STABLE_MEMBERSHIP_REQUIRED",
      );

      const driftNow = new Date("2026-08-19T12:50:00.000Z");
      const expectReadyAfterCleanup = async () => {
        const restored = await previewV04Migration(db, { userId: fixture.adminUserId }, {
          now: driftNow, environmentKey: "test-only",
        });
        assert.equal(restored.ready, true, "cleaned schema must return to the frozen ready catalog");
      };

      await client.query("CREATE INDEX arbitrary_preview_probe ON collaboration_workspaces(status)");
      const extraIndex = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert.equal(extraIndex.ready, false);
      assert(extraIndex.facts.P07.extraIndexes.includes("collaboration_workspaces.arbitrary_preview_probe"));
      await client.query("DROP INDEX arbitrary_preview_probe");
      await expectReadyAfterCleanup();

      await client.query(`CREATE FUNCTION arbitrary_preview_trigger_function() RETURNS trigger AS $$
        BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER arbitrary_preview_probe BEFORE UPDATE ON app_role_memberships
        FOR EACH ROW EXECUTE FUNCTION arbitrary_preview_trigger_function()`);
      const extraTrigger = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert.equal(extraTrigger.ready, false);
      assert(extraTrigger.facts.P07.extraTriggers.includes("app_role_memberships.arbitrary_preview_probe"));
      const updateTriggerBefore = (await inspectV04SchemaObjects(db)).triggers.find((object) =>
        object.objectName === "arbitrary_preview_probe");
      assert(updateTriggerBefore);
      await client.query("DROP TRIGGER arbitrary_preview_probe ON app_role_memberships");
      await client.query(`CREATE TRIGGER arbitrary_preview_probe BEFORE UPDATE OF status ON app_role_memberships
        FOR EACH ROW EXECUTE FUNCTION arbitrary_preview_trigger_function()`);
      const updateTriggerAfter = (await inspectV04SchemaObjects(db)).triggers.find((object) =>
        object.objectName === "arbitrary_preview_probe");
      assert(updateTriggerAfter);
      const updateColumnDrift = compareV04SchemaObjects({
        indexes: [], policies: [], triggers: [updateTriggerAfter],
      }, {
        indexes: [], policies: [], triggers: [updateTriggerBefore],
      });
      assert.deepEqual(updateColumnDrift.triggers.changed, [
        "app_role_memberships.arbitrary_preview_probe",
      ]);
      await client.query("DROP TRIGGER arbitrary_preview_probe ON app_role_memberships");
      await client.query("DROP FUNCTION arbitrary_preview_trigger_function() ");
      await expectReadyAfterCleanup();

      await client.query("DROP INDEX collaboration_revision_events_round_idx");
      await client.query(`CREATE INDEX collaboration_revision_events_round_idx
        ON collaboration_revision_events(round_id, created_at) INCLUDE (workspace_id)`);
      const changedIndex = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert.equal(changedIndex.ready, false);
      assert(changedIndex.facts.P07.changedIndexes.includes(
        "collaboration_revision_events.collaboration_revision_events_round_idx"));
      await client.query("DROP INDEX collaboration_revision_events_round_idx");
      const missingIndex = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert(missingIndex.facts.P07.missingIndexes.includes(
        "collaboration_revision_events.collaboration_revision_events_round_idx"));
      await installFrozenObject(client, "collaboration_revision_events_round_idx");
      await expectReadyAfterCleanup();

      await client.query("DROP TRIGGER annotation_choice_values_validate ON annotation_choice_values");
      await client.query(`CREATE TRIGGER annotation_choice_values_validate
        BEFORE INSERT OR UPDATE ON annotation_choice_values
        FOR EACH STATEMENT EXECUTE FUNCTION validate_v04_choice_value()`);
      const changedTrigger = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert.equal(changedTrigger.ready, false);
      assert(changedTrigger.facts.P07.changedTriggers.includes(
        "annotation_choice_values.annotation_choice_values_validate"));
      await client.query("DROP TRIGGER annotation_choice_values_validate ON annotation_choice_values");
      const missingTrigger = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert(missingTrigger.facts.P07.missingTriggers.includes(
        "annotation_choice_values.annotation_choice_values_validate"));
      await installFrozenObject(client, "annotation_choice_values_validate");
      await expectReadyAfterCleanup();

      await client.query(`CREATE POLICY arbitrary_preview_policy ON collaboration_workspaces
        AS RESTRICTIVE FOR SELECT TO PUBLIC USING (false)`);
      const extraPolicy = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: driftNow, environmentKey: "test-only",
      });
      assert.equal(extraPolicy.ready, false);
      assert(extraPolicy.facts.P07.extraPolicies.includes(
        "collaboration_workspaces.arbitrary_preview_policy"));
      const catalogWithPolicy = await inspectV04SchemaObjects(db);
      const policyObject = catalogWithPolicy.policies.find((object) =>
        object.objectName === "arbitrary_preview_policy");
      assert(policyObject);
      const testPolicyExpectation = {
        ...V04_FROZEN_SCHEMA_OBJECT_EXPECTATION,
        policies: [policyObject],
      };
      assert.deepEqual(compareV04SchemaObjects(catalogWithPolicy, testPolicyExpectation).policies, {
        missing: [], extra: [], changed: [],
      });
      await client.query("DROP POLICY arbitrary_preview_policy ON collaboration_workspaces");
      const policyMissing = compareV04SchemaObjects(
        await inspectV04SchemaObjects(db),
        testPolicyExpectation,
      );
      assert.deepEqual(policyMissing.policies.missing, [
        "collaboration_workspaces.arbitrary_preview_policy",
      ]);
      await client.query(`CREATE POLICY arbitrary_preview_policy ON collaboration_workspaces
        AS RESTRICTIVE FOR SELECT TO PUBLIC USING (true)`);
      const policyChanged = compareV04SchemaObjects(
        await inspectV04SchemaObjects(db),
        testPolicyExpectation,
      );
      assert.deepEqual(policyChanged.policies.changed, [
        "collaboration_workspaces.arbitrary_preview_policy",
      ]);
      await client.query("DROP POLICY arbitrary_preview_policy ON collaboration_workspaces");
      await expectReadyAfterCleanup();

      await db.prepare(`INSERT INTO audit_logs (
        id,actor_email,action,object_type,object_id,detail_json,actor_user_id,request_id,workflow_version
      ) VALUES (?,'test-only@example.invalid','VIDEO_PHYSICAL_DELETE','VIDEO',?,'{}',?,?,'REVERSE-WORKFLOW-V0.3-PILOT')`)
        .bind(`audit_${config.runId}_delete`, `missing_video_${config.runId}`, fixture.adminUserId, `test_${config.runId}`).run();
      await db.prepare(`INSERT INTO annotation_snapshots (
        id,annotation_id,video_id,author_email,author_name,taxonomy_version,revision,payload_json,
        content_hash,version_number,workflow_status,snapshot_kind,workflow_version
      ) SELECT ?,annotation_id,video_id,author_email,author_name,taxonomy_version,3,'{"legacy":"changed"}',
        'legacy-hash-2',1,workflow_status,'CANDIDATE',workflow_version
        FROM annotation_snapshots WHERE id=?`).bind(
        `snapshot_${config.runId}_v03_duplicate`, `snapshot_${config.runId}_v03`,
      ).run();
      await db.prepare("UPDATE v03_collaboration_streams SET current_snapshot_id=?,active_round_id='missing_round' WHERE id=?")
        .bind(`snapshot_${config.runId}_v03_duplicate`, fixture.streamId).run();
      const changed = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: new Date("2026-08-19T12:40:00.000Z"), environmentKey: "test-only",
      });
      assert.notEqual(changed.previewToken, first.previewToken);
      assert(changed.facts.P03.versionAnomalies >= 2);
      assert.equal(changed.facts.P04.promotedCurrentSnapshotCount, 1);
      assert(changed.facts.P05.referenceAnomalyCount >= 1);
      assert.equal(changed.facts.P10.physicalDeleteAuditCount, 1);
      assert.equal(changed.facts.P10.databaseOrphanCount, 1);
      assert.throws(() => assertV04PreviewToken(
        changed,
        first.previewToken,
        new Date("2026-08-19T12:40:00.000Z"),
      ), (error) =>
        error instanceof V04ServiceError && error.code === "STALE_PREVIEW");

      await client.query(`ALTER TABLE ${quote(schemaName)}.collaboration_workspaces ADD COLUMN preview_drift TEXT`);
      const drift = await previewV04Migration(db, { userId: fixture.adminUserId }, {
        now: new Date("2026-08-19T12:45:00.000Z"), environmentKey: "test-only",
      });
      assert.equal(drift.ready, false);
      assert(drift.facts.P07.extraColumns.includes("collaboration_workspaces.preview_drift"));
      assert.equal(drift.anomalies[0].type, "SCHEMA_DRIFT");
      const columnStillExists = await client.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='collaboration_workspaces' AND column_name='preview_drift'`, [schemaName]);
      assert.equal(columnStillExists.rowCount, 1, "PREVIEW must report drift without repairing it");
      evidence.preview11 = Object.keys(first.facts).length === 11;
      evidence.repeatedTokenStable = true;
      evidence.parallelPreviewStable = true;
      evidence.expiryBoundaryRejected = true;
      evidence.crossWindowTokenChanged = true;
      evidence.stalePreviewRejected = true;
      evidence.zeroWrite = true;
      evidence.schemaDriftReportedNotRepaired = true;
      evidence.arbitraryIndexAndTriggerDetected = true;
      evidence.sameNameIndexAndTriggerDriftDetected = true;
      evidence.indexIncludeTriggerOrientationAndUpdateColumnsDetected = true;
      evidence.policyExtraMissingChangedDetected = true;
      evidence.stableAdminOnly = true;
      evidence.latestSchemaLegacyNameFallbackRejected = true;
      evidence.contractStatus = first.contract.status;
      evidence.firstPreviewTokenDigest = first.previewTokenDigest;
      evidence.schemaFingerprint = first.schemaFingerprint;
      evidence.sourceHash = first.sourceHash;
      evidence.targetHash = first.targetHash;
      evidence.nonTargetHash = first.nonTargetHash;
      evidence.previewFacts = first.facts;
      evidence.anomalyTypes = changed.anomalies.map((item) => item.type);
    } finally {
      await pool.end();
    }
  } finally {
    if (owned) {
      await client.query("SET search_path TO public");
      const guard = await client.query<{ run_id: string; cleanup_token: string }>(
        `SELECT run_id,cleanup_token FROM ${quote(schemaName)}.__v04_preview_marker`,
      );
      assert.equal(guard.rowCount, 1);
      assert.equal(guard.rows[0].run_id, config.runId);
      assert.equal(guard.rows[0].cleanup_token, marker);
      await client.query(`DROP SCHEMA ${quote(schemaName)} CASCADE`);
    }
    const publicAfter = await publicFingerprint(client);
    assert.deepEqual(publicAfter, publicBefore, "public catalog/business fingerprint changed");
    evidence.publicFingerprintUnchanged = true;
    evidence.testSchemaCleaned = true;
    await client.end();
  }
  console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
  return evidence;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runV04MigrationPreviewVerification().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
