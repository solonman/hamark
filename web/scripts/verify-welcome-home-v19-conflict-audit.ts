import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { DbClient } from "@/db";
import { emptyCreativeStructure } from "@/lib/taxonomy-v0.3";
import type { AnnotationDraft, ShotDraft, ShotGroupDraft } from "@/lib/types";
import { emptyV04DraftPayload, hashV04Payload } from "@/lib/v04-domain";
import type { V04DraftPayloadV1 } from "@/lib/v04-contract";
import { V04ServiceError } from "@/lib/v04-errors";
import {
  auditWelcomeHomeV19Conflict,
  WELCOME_HOME_V19_AUDIT_VIDEO_ID,
} from "@/lib/welcome-home-v19-conflict-audit";

const { Pool } = pg;
const ADMIN_ID = "user_test_only_welcome_v19_admin";
const groupSizes = [4, 4, 3, 3, 3, 3, 3];

function requiredTestConfig(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== "test") throw new Error("WELCOME_V19_TEST_ONLY_NODE_ENV_REQUIRED");
  const connectionString = env.V04_TEST_DATABASE_URL?.trim();
  const runId = env.V04_TEST_RUN_ID?.trim();
  if (!connectionString || !runId) throw new Error("WELCOME_V19_TEST_ONLY_CONFIG_REQUIRED");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("WELCOME_V19_TEST_ONLY_LOOPBACK_REQUIRED");
  }
  if (!url.pathname.toLowerCase().includes("test")) {
    throw new Error("WELCOME_V19_TEST_ONLY_DATABASE_NAME_REQUIRED");
  }
  const safeRunId = runId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  if (!safeRunId) throw new Error("WELCOME_V19_TEST_ONLY_RUN_ID_REQUIRED");
  return { connectionString, schema: `test_only_welcome_v19_${safeRunId}` };
}

const populated = (index: number, count: number, label: string) =>
  index < count ? `${label}-${index + 1}` : "";

function sourceFixture(): AnnotationDraft {
  const groups: ShotGroupDraft[] = groupSizes.map((_, index) => ({
    id: `group-${index + 1}`,
    orderIndex: index,
    title: `桥段-${index + 1}`,
    primaryRole: "",
    auxiliaryRoles: [],
    customRole: "",
    note: `关键描述-${index + 1}`,
  }));
  const shots: ShotDraft[] = [];
  let globalIndex = 0;
  groupSizes.forEach((size, groupIndex) => {
    for (let localIndex = 0; localIndex < size; localIndex += 1) {
      const index = globalIndex++;
      shots.push({
        id: `shot-${index + 1}`,
        orderIndex: index,
        groupName: groups[groupIndex].title,
        shotNumber: String(index + 1),
        startTime: populated(index, 22, "开始"),
        endTime: populated(index, 22, "结束"),
        shotSize: populated(index, 22, "景别"),
        cameraAngle: populated(index, 10, "角度"),
        cameraMovement: "",
        visualContent: populated(index, 23, "画面"),
        dialogue: populated(index, 20, "对白"),
        voiceover: populated(index, 19, "旁白"),
        screenText: populated(index, 11, "字幕"),
        soundEffect: populated(index, 9, "声效"),
        music: populated(index, 17, "音乐"),
        creativeComment: "",
        shotGroupId: groups[groupIndex].id,
      });
    }
  });
  return {
    id: "annotation-v03-source",
    videoId: WELCOME_HOME_V19_AUDIT_VIDEO_ID,
    authorName: "test-only-source-author",
    taxonomyVersion: "V0.3-PILOT",
    workflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT",
    status: "DRAFT",
    revision: 153,
    analysisTitle: "",
    commercialIntent: "commercial-source-sensitive-fixture",
    creativeTheme: "motif-source-sensitive-fixture",
    synopsis: "synopsis-source-sensitive-fixture",
    thinkingChain: "chain-source-sensitive-fixture",
    shotCommentary: "",
    summary: "rating-source-sensitive-fixture",
    shots,
    shotGroups: groups,
    fields: [],
    creativeStructure: {
      ...emptyCreativeStructure(),
      creativeButton: "button-source-sensitive-fixture",
      primaryCreativePath: "LOVE",
    },
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function targetFixture(source: AnnotationDraft, mode: "EMPTY" | "SAME") {
  const target = emptyV04DraftPayload();
  const value = (current: string) => mode === "SAME" ? current : "";
  target.script.shotGroups = (source.shotGroups ?? []).map((group) => ({
    id: group.id,
    orderIndex: group.orderIndex,
    bridgeName: value(group.title),
    primaryCreativeRole: structuredClone(target.factsAndCoreJudgement.mainMechanism),
    auxiliaryCreativeRole: structuredClone(target.factsAndCoreJudgement.auxiliaryMechanism),
    keyCreativeDescription: value(group.note),
    shots: source.shots.filter((shot) => shot.shotGroupId === group.id).map((shot) => ({
      id: shot.id,
      orderIndex: shot.orderIndex,
      startTime: value(shot.startTime),
      endTime: value(shot.endTime),
      shotScale: value(shot.shotSize),
      cameraAngle: value(shot.cameraAngle),
      cameraMovement: "",
      visualContent: value(shot.visualContent),
      screenCopy: value(shot.screenText),
      subtitleEffect: "",
      dialogue: value(shot.dialogue),
      voiceOver: value(shot.voiceover),
      soundEffect: value(shot.soundEffect),
      music: value(shot.music),
    })),
  }));
  target.factsAndCoreJudgement.commercialIntent = value(source.commercialIntent);
  target.factsAndCoreJudgement.storySynopsis = value(source.synopsis);
  target.factsAndCoreJudgement.creativeMotif = value(source.creativeTheme);
  target.factsAndCoreJudgement.tensionButton = value(source.creativeStructure?.creativeButton ?? "");
  target.factsAndCoreJudgement.creativeThinkingChain = value(source.thinkingChain);
  target.factsAndCoreJudgement.ratingReason = value(source.summary);
  target.perceptionPath.primaryType = mode === "SAME" ? "LOVE" : "";
  return target;
}

async function installFixture(pool: pg.Pool, schema: string) {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}`);
  await pool.query(`CREATE TABLE app_role_memberships (
    user_id TEXT NOT NULL, role_key TEXT NOT NULL, status TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE annotations (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content_hash TEXT
  )`);
  await pool.query(`CREATE TABLE annotation_snapshots (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot_kind TEXT,
    workflow_status TEXT, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE v03_collaboration_rounds (
    id TEXT PRIMARY KEY, round_number INTEGER NOT NULL, status TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE v03_collaboration_streams (
    id TEXT PRIMARY KEY, video_id TEXT NOT NULL, taxonomy_version TEXT NOT NULL,
    canonical_annotation_id TEXT NOT NULL, active_round_id TEXT,
    current_snapshot_id TEXT, status TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE collaboration_workspaces (
    id TEXT PRIMARY KEY, video_id TEXT NOT NULL, workflow_version TEXT NOT NULL,
    canonical_annotation_id TEXT NOT NULL, current_working_snapshot_id TEXT,
    status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE annotation_submission_snapshots (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, submission_number INTEGER NOT NULL
  )`);
  await pool.query(`CREATE TABLE collaboration_revision_events (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, applied_revision INTEGER NOT NULL
  )`);
  await pool.query(`CREATE TABLE collaboration_edit_leases (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`INSERT INTO app_role_memberships VALUES ($1, 'SYSTEM_ADMIN', 'ACTIVE')`, [ADMIN_ID]);
  const source = sourceFixture();
  const payload = JSON.stringify(source);
  const hash = createHash("sha256").update(payload).digest("hex");
  await pool.query(`INSERT INTO annotation_snapshots VALUES (
    'snapshot-v03-source', 153, 'WORKING', 'WORKING', $1, $2
  )`, [payload, hash]);
  await pool.query(`INSERT INTO annotations VALUES ('annotation-v03-source', 153, $1)`, [hash]);
  await pool.query(`INSERT INTO v03_collaboration_rounds VALUES ('round-v03-source', 1, 'ACTIVE')`);
  await pool.query(`INSERT INTO v03_collaboration_streams VALUES (
    'stream-v03-source', $1, 'V0.3-PILOT', 'annotation-v03-source',
    'round-v03-source', 'snapshot-v03-source', 'ACTIVE'
  )`, [WELCOME_HOME_V19_AUDIT_VIDEO_ID]);
}

async function clearTarget(pool: pg.Pool) {
  await pool.query("DELETE FROM collaboration_edit_leases");
  await pool.query("DELETE FROM collaboration_revision_events");
  await pool.query("DELETE FROM annotation_submission_snapshots");
  await pool.query("DELETE FROM collaboration_workspaces");
  await pool.query("DELETE FROM annotation_snapshots WHERE id <> 'snapshot-v03-source'");
  await pool.query("DELETE FROM annotations WHERE id <> 'annotation-v03-source'");
}

async function seedTarget(pool: pg.Pool, payload: V04DraftPayloadV1, suffix = "one") {
  const hash = hashV04Payload(payload);
  const annotationId = `annotation-v04-${suffix}`;
  const snapshotId = `snapshot-v04-${suffix}`;
  const workspaceId = `workspace-v04-${suffix}`;
  await pool.query("INSERT INTO annotations VALUES ($1, 2, $2)", [annotationId, hash]);
  await pool.query("INSERT INTO annotation_snapshots VALUES ($1, 2, 'WORKING', 'WORKING', $2, $3)",
    [snapshotId, JSON.stringify(payload), hash]);
  await pool.query(`INSERT INTO collaboration_workspaces (
    id, video_id, workflow_version, canonical_annotation_id,
    current_working_snapshot_id, status
  ) VALUES ($1, $2, 'AD_VIDEO_WORKFLOW_V1', $3, $4, 'ACTIVE')`,
  [workspaceId, WELCOME_HOME_V19_AUDIT_VIDEO_ID, annotationId, snapshotId]);
}

async function fixtureFingerprint(pool: pg.Pool) {
  const tables = [
    "app_role_memberships", "annotations", "annotation_snapshots",
    "v03_collaboration_rounds", "v03_collaboration_streams", "collaboration_workspaces",
    "annotation_submission_snapshots", "collaboration_revision_events", "collaboration_edit_leases",
  ];
  const facts = [];
  for (const table of tables) {
    const row = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    facts.push([table, row.rows[0].count]);
  }
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export async function runWelcomeHomeV19ConflictAuditVerification(env: NodeJS.ProcessEnv) {
  const config = requiredTestConfig(env);
  const adminPool = new Pool({ connectionString: config.connectionString, ssl: false });
  const testPool = new Pool({
    connectionString: config.connectionString,
    ssl: false,
    max: 12,
    options: `-c search_path=${config.schema}`,
  });
  const source = sourceFixture();
  const db = new DbClient(testPool);
  const evidence = {
    allEmpty: false,
    allSame: false,
    partialConflict: false,
    structureDrift: false,
    sourceDrift: false,
    noWorkspace: false,
    multipleWorkspace: false,
    concurrentGetStable: false,
    zeroWrite: false,
    privacySafe: false,
    nonAdminRejected: false,
  };
  try {
    await installFixture(adminPool, config.schema);
    await clearTarget(testPool);
    await seedTarget(testPool, targetFixture(source, "EMPTY"));
    const before = await fixtureFingerprint(testPool);
    const empty = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.equal(empty.ready, true);
    assert.equal(empty.totals.TARGET_EMPTY, 196);
    evidence.allEmpty = true;

    await clearTarget(testPool);
    await seedTarget(testPool, targetFixture(source, "SAME"));
    const same = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.equal(same.ready, true);
    assert.equal(same.totals.TARGET_SAME, 196);
    evidence.allSame = true;

    await clearTarget(testPool);
    const conflictPayload = targetFixture(source, "EMPTY");
    conflictPayload.factsAndCoreJudgement.commercialIntent = "existing-target-value";
    conflictPayload.factsAndCoreJudgement.storySynopsis = source.synopsis;
    await seedTarget(testPool, conflictPayload);
    const partial = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.equal(partial.ready, true);
    assert.equal(partial.totals.TARGET_DIFFERENT, 1);
    assert.equal(partial.totals.TARGET_SAME, 1);
    evidence.partialConflict = true;

    for (const mutate of [
      (payload: V04DraftPayloadV1) => { payload.script.shotGroups.pop(); },
      (payload: V04DraftPayloadV1) => {
        payload.script.shotGroups[0].shots.push(structuredClone(payload.script.shotGroups[0].shots[0]));
      },
      (payload: V04DraftPayloadV1) => {
        [payload.script.shotGroups[0].orderIndex, payload.script.shotGroups[1].orderIndex] = [1, 0];
      },
    ]) {
      await clearTarget(testPool);
      const drift = targetFixture(source, "EMPTY");
      mutate(drift);
      await seedTarget(testPool, drift);
      const result = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
      assert.equal(result.ready, false);
      assert.ok(result.stopReasons.includes("STRUCTURE_DRIFT"));
    }
    evidence.structureDrift = true;

    await testPool.query("UPDATE annotation_snapshots SET revision = 152 WHERE id = 'snapshot-v03-source'");
    const revisionDrift = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.ok(revisionDrift.stopReasons.includes("SOURCE_REVISION_DRIFT"));
    await testPool.query("UPDATE annotation_snapshots SET revision = 153, content_hash = 'bad-hash' WHERE id = 'snapshot-v03-source'");
    const hashDrift = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.ok(hashDrift.stopReasons.includes("SOURCE_HASH_DRIFT"));
    const sourcePayload = JSON.stringify(source);
    await testPool.query("UPDATE annotation_snapshots SET content_hash = $1 WHERE id = 'snapshot-v03-source'",
      [createHash("sha256").update(sourcePayload).digest("hex")]);
    evidence.sourceDrift = true;

    await clearTarget(testPool);
    const missing = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.ok(missing.stopReasons.includes("TARGET_WORKSPACE_MISSING"));
    evidence.noWorkspace = true;
    await seedTarget(testPool, targetFixture(source, "EMPTY"), "one");
    await seedTarget(testPool, targetFixture(source, "EMPTY"), "two");
    const multiple = await auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID });
    assert.ok(multiple.stopReasons.includes("TARGET_WORKSPACE_MULTIPLE"));
    evidence.multipleWorkspace = true;

    await clearTarget(testPool);
    await seedTarget(testPool, targetFixture(source, "EMPTY"));
    const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
      auditWelcomeHomeV19Conflict(db, { userId: ADMIN_ID })));
    assert.equal(new Set(concurrent.map((item) => item.previewDigest)).size, 1);
    assert.ok(concurrent.every((item) => item.readFingerprint.unchanged));
    evidence.concurrentGetStable = true;
    const after = await fixtureFingerprint(testPool);
    assert.equal(after, before);
    evidence.zeroWrite = true;

    const serialized = JSON.stringify(concurrent[0]);
    for (const forbidden of [
      ADMIN_ID,
      "test-only-source-author",
      "commercial-source-sensitive-fixture",
      "motif-source-sensitive-fixture",
      "rating-source-sensitive-fixture",
      "payload_json",
      "holder_user_id",
    ]) assert.doesNotMatch(serialized, new RegExp(forbidden));
    evidence.privacySafe = true;
    await assert.rejects(
      auditWelcomeHomeV19Conflict(db, { userId: "user_test_only_not_admin" }),
      (error) => error instanceof V04ServiceError && error.code === "ADMIN_REQUIRED",
    );
    evidence.nonAdminRejected = true;
    return evidence;
  } finally {
    await testPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
    await adminPool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWelcomeHomeV19ConflictAuditVerification(process.env)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "verification failed"}\n`);
      process.exitCode = 1;
    });
}
