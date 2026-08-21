import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BOOTSTRAP_STATEMENTS } from "../db/bootstrap.ts";
import { DbClient } from "../db/index.ts";
import { loadAnnotationById } from "../lib/annotation-server.ts";
import { emptyCreativeStructure } from "../lib/taxonomy-v0.3.ts";
import type { AnnotationDraft, ShotDraft, ShotGroupDraft } from "../lib/types.ts";
import { emptyV04DraftPayload, hashV04Payload } from "../lib/v04-domain.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";
import {
  acquireV04Lease,
  materializeV04Workspace,
  releaseV04Lease,
  saveV04Draft,
  type V04Actor,
} from "../lib/v04-workspace-service.ts";
import {
  applyWelcomeHomeV19Mapping,
  previewWelcomeHomeV19Mapping,
  WELCOME_HOME_V19_MAPPING_CONFIRMATION,
  WELCOME_HOME_V19_MAPPING_OPERATION_TYPE,
} from "../lib/welcome-home-v19-mapping.ts";
import { WELCOME_HOME_V19_AUDIT_VIDEO_ID } from "../lib/welcome-home-v19-conflict-audit.ts";

const { Client, Pool } = pg;
const groupSizes = [4, 4, 3, 3, 3, 3, 3];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

function config(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== "test") throw new Error("WELCOME_HOME_V19_MAPPING_TEST_ONLY_NODE_ENV_REQUIRED");
  const connectionString = env.V04_TEST_DATABASE_URL?.trim();
  const runId = env.V04_TEST_RUN_ID?.trim();
  if (!connectionString || !runId) throw new Error("WELCOME_HOME_V19_MAPPING_TEST_ONLY_CONFIG_REQUIRED");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("WELCOME_HOME_V19_MAPPING_TEST_ONLY_LOOPBACK_REQUIRED");
  if (!url.pathname.toLowerCase().includes("test")) throw new Error("WELCOME_HOME_V19_MAPPING_TEST_ONLY_DATABASE_REQUIRED");
  const safe = runId.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  if (!safe) throw new Error("WELCOME_HOME_V19_MAPPING_TEST_ONLY_RUN_ID_REQUIRED");
  return { connectionString, runId: safe, schema: `test_only_welcome_home_v19_mapping_${safe}` };
}

const populated = (index: number, count: number, label: string) => index < count ? `${label}-${index + 1}` : "";
function sourceFixture(): AnnotationDraft {
  const groups: ShotGroupDraft[] = groupSizes.map((_, index) => ({
    id: `group-${index + 1}`, orderIndex: index, title: `桥段-${index + 1}`,
    primaryRole: "", auxiliaryRoles: [], customRole: "", note: `关键描述-${index + 1}`,
  }));
  const shots: ShotDraft[] = [];
  let index = 0;
  groupSizes.forEach((size, groupIndex) => {
    for (let local = 0; local < size; local += 1) {
      const current = index++;
      shots.push({
        id: `shot-${current + 1}`, orderIndex: current,
        groupName: groups[groupIndex].title, shotGroupId: groups[groupIndex].id,
        shotNumber: String(current + 1), startTime: populated(current, 22, "开始"),
        endTime: populated(current, 22, "结束"), shotSize: populated(current, 22, "景别"),
        cameraAngle: populated(current, 10, "角度"), cameraMovement: "",
        visualContent: populated(current, 23, "画面"), dialogue: populated(current, 20, "对白"),
        voiceover: populated(current, 19, "旁白"), screenText: populated(current, 11, "字幕"),
        soundEffect: populated(current, 9, "声效"), music: populated(current, 17, "音乐"), creativeComment: "",
      });
    }
  });
  return {
    id: "annotation-welcome-v03", videoId: WELCOME_HOME_V19_AUDIT_VIDEO_ID,
    authorName: "TEST_ONLY source", taxonomyVersion: "V0.3-PILOT",
    workflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT", sourceSnapshotId: null,
    status: "DRAFT", revision: 153, analysisTitle: "", commercialIntent: "商业意图",
    creativeTheme: "创意母题", synopsis: "故事梗概", thinkingChain: "创意思维链",
    shotCommentary: "", summary: "评价理由", shots, shotGroups: groups, fields: [],
    creativeStructure: { ...emptyCreativeStructure(), creativeButton: "创意按钮", primaryCreativePath: "LOVE" },
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function actor(runId: string): V04Actor {
  return {
    userId: `user_${runId}_admin`, identityKey: `test-only:${runId}:admin`,
    displayName: "TEST_ONLY admin", sessionId: `session_${runId}_admin`, requestId: `request_${runId}_admin`,
  };
}

async function install(client: pg.Client) {
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

async function seedIdentityAndVideo(db: DbClient, runId: string, currentActor: V04Actor) {
  const now = "2026-08-21T12:00:00.000Z";
  await db.prepare(`INSERT INTO users (
    id,wecom_corp_id,wecom_user_id,identity_key,display_name,email,status,
    last_login_at,last_synced_at,created_at,updated_at
  ) VALUES (?,'TEST_ONLY',?,?,?,NULL,'ACTIVE',?,?,?,?)`)
    .bind(currentActor.userId, currentActor.userId, currentActor.identityKey,
      currentActor.displayName, now, now, now, now).run();
  await db.prepare(`INSERT INTO auth_sessions (id,user_id,token_hash,expires_at,last_seen_at,created_at)
    VALUES (?,?,?,'2099-01-01T00:00:00.000Z',?,?)`)
    .bind(currentActor.sessionId, currentActor.userId, `token-${runId}`, now, now).run();
  await db.prepare(`INSERT INTO app_role_memberships (user_id,role_key,status,granted_by_user_id)
    VALUES (?,'SYSTEM_ADMIN','ACTIVE',?)`).bind(currentActor.userId, currentActor.userId).run();
  await db.prepare(`INSERT INTO videos (
    id,title,brand,description,tags_json,object_key,original_name,content_type,file_size,status,
    rights_confirmed,created_by_email,created_by_name,created_by_user_id,data_scope,test_run_id,
    created_at,updated_at,deletion_state
  ) VALUES (?,'TEST_ONLY welcome home','TEST_ONLY','','[]',?,'test.mp4','video/mp4',1685,'READY',1,
    ?,?,?, 'TEST_ONLY',?,?,?,'ACTIVE')`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, `test-only/${runId}/welcome.mp4`, currentActor.identityKey,
      currentActor.displayName, currentActor.userId, runId, now, now).run();
  await db.prepare(`INSERT INTO videos (
    id,title,brand,description,tags_json,object_key,original_name,content_type,file_size,status,
    rights_confirmed,created_by_email,created_by_name,created_by_user_id,data_scope,test_run_id,
    created_at,updated_at,deletion_state
  ) VALUES (?,'TEST_ONLY other','TEST_ONLY','','[]',?,'other.mp4','video/mp4',1,'READY',1,
    ?,?,?, 'TEST_ONLY',?,?,?,'ACTIVE')`)
    .bind(`video_${runId}_other`, `test-only/${runId}/other.mp4`, currentActor.identityKey,
      currentActor.displayName, currentActor.userId, runId, now, now).run();
  await db.prepare("UPDATE annotation_taxonomy_versions SET status='ACTIVE' WHERE taxonomy_version='AD_VIDEO_TAXONOMY_V1'").run();
  await db.prepare("UPDATE annotation_vocabulary_versions SET status='ACTIVE' WHERE vocabulary_version='AD_VIDEO_VOCAB_V1'").run();
  await db.prepare("UPDATE workflow_contract_versions SET status='ACTIVE',activated_at=?::timestamptz WHERE workflow_version='AD_VIDEO_WORKFLOW_V1'")
    .bind(now).run();
}

async function seedSource(db: DbClient, source: AnnotationDraft, currentActor: V04Actor) {
  const annotationId = source.id!;
  const now = source.updatedAt!;
  await db.prepare(`INSERT INTO annotations (
    id,video_id,author_email,author_name,taxonomy_version,workflow_version,status,revision,
    analysis_title,commercial_intent,creative_theme,synopsis,thinking_chain,shot_commentary,summary,
    created_at,updated_at,content_hash,updated_by_user_id
  ) VALUES (?,?,?,?,?,'REVERSE-WORKFLOW-V0.3-PILOT','DRAFT',153,?,?,?,?,?,?,?, ?,?,'${"b".repeat(64)}',?)`)
    .bind(annotationId, source.videoId, "test-only-source", source.authorName, source.taxonomyVersion,
      source.analysisTitle, source.commercialIntent, source.creativeTheme, source.synopsis,
      source.thinkingChain, source.shotCommentary, source.summary, now, now, currentActor.userId).run();
  for (const group of source.shotGroups ?? []) {
    await db.prepare(`INSERT INTO shot_groups (
      id,annotation_id,order_index,title,primary_role_id,primary_role_name_snapshot,
      auxiliary_roles_json,custom_role,note,taxonomy_version,created_at,updated_at
    ) VALUES (?,?,?,?,'','','[]','',?,'V0.3-PILOT',?,?)`)
      .bind(group.id, annotationId, group.orderIndex, group.title, group.note, now, now).run();
  }
  for (const shot of source.shots) {
    await db.prepare(`INSERT INTO shots (
      id,annotation_id,order_index,group_name,shot_group_id,shot_number,start_time,end_time,
      shot_size,camera_angle,camera_movement,visual_content,dialogue,voiceover,screen_text,
      sound_effect,music,creative_comment,subtitle_effect
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'','')`)
      .bind(shot.id, annotationId, shot.orderIndex, shot.groupName, shot.shotGroupId ?? null,
        shot.shotNumber, shot.startTime, shot.endTime, shot.shotSize, shot.cameraAngle,
        shot.cameraMovement, shot.visualContent, shot.dialogue, shot.voiceover,
        shot.screenText, shot.soundEffect, shot.music).run();
  }
  await db.prepare(`INSERT INTO annotation_creative_structures (
    annotation_id,creative_button,primary_creative_path,updated_at
  ) VALUES (?,?,'LOVE',?)`).bind(annotationId, source.creativeStructure!.creativeButton, now).run();
  const live = await loadAnnotationById(annotationId, db);
  assert.ok(live);
  const snapshotId = "snapshot-welcome-v03-rev153";
  await db.prepare(`INSERT INTO annotation_snapshots (
    id,annotation_id,video_id,author_email,author_name,taxonomy_version,revision,payload_json,
    content_hash,created_at,workflow_status,snapshot_kind,workflow_version,vocabulary_version,
    payload_schema_version,created_by_user_id
  ) VALUES (?,?,?,?,?,'V0.3-PILOT',153,?,'${"a".repeat(64)}',?,'WORKING','WORKING',
    'REVERSE-WORKFLOW-V0.3-PILOT','V0.3.2','V0.3.2',?)`)
    .bind(snapshotId, annotationId, source.videoId, "test-only-source", source.authorName,
      JSON.stringify(live), now, currentActor.userId).run();
  await db.prepare(`INSERT INTO v03_collaboration_streams (
    id,video_id,taxonomy_version,canonical_annotation_id,initial_baseline_id,active_round_id,
    current_snapshot_id,source_author_email,source_author_name,status,created_by_email,
    created_by_name,created_at,updated_at
  ) VALUES ('stream-welcome-v03',?,'V0.3-PILOT',?,NULL,NULL,?,'test-only-source',?,'ACTIVE',
    ?,?,?,?)`).bind(source.videoId, annotationId, snapshotId, source.authorName,
      currentActor.identityKey, currentActor.displayName, now, now).run();
  await db.prepare(`INSERT INTO v03_collaboration_rounds (
    id,stream_id,annotation_id,round_number,status,base_type,starting_revision,
    created_by_email,created_by_name,created_at
  ) VALUES ('round-welcome-v03','stream-welcome-v03',?,1,'ACTIVE','EMPTY_INITIAL',153,?,?,?)`)
    .bind(annotationId, currentActor.identityKey, currentActor.displayName, now).run();
  await db.prepare("UPDATE v03_collaboration_streams SET active_round_id='round-welcome-v03' WHERE id='stream-welcome-v03'").run();
}

async function seedTarget(db: DbClient, currentActor: V04Actor) {
  await materializeV04Workspace(db, WELCOME_HOME_V19_AUDIT_VIDEO_ID, currentActor);
  const emptyHash = hashV04Payload(emptyV04DraftPayload());
  const tabToken = "test-only-tab-welcome-home";
  const lease = await acquireV04Lease(db, WELCOME_HOME_V19_AUDIT_VIDEO_ID, currentActor, { tabToken });
  await saveV04Draft(db, currentActor, {
    videoId: WELCOME_HOME_V19_AUDIT_VIDEO_ID,
    expectedRevision: 0,
    expectedHash: emptyHash,
    changeSetId: "test-only-seed-love-path",
    changes: [{ targetKey: "path.primaryType", targetLabel: "主导路径", valueType: "SINGLE_SELECT", beforeValue: "", afterValue: "LOVE" }],
    lease: { tabToken, leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion },
  });
  await releaseV04Lease(db, WELCOME_HOME_V19_AUDIT_VIDEO_ID, currentActor,
    { tabToken, leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion });
}

async function counts(db: DbClient) {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM admin_data_operations WHERE operation_type=?) AS ledgers,
    (SELECT COUNT(*) FROM annotation_submission_snapshots) AS submissions,
    (SELECT COUNT(*) FROM expert_analysis_releases) AS experts,
    (SELECT COUNT(*) FROM collaboration_revision_events) AS revisions,
    (SELECT COUNT(*) FROM annotation_snapshots WHERE video_id=?) AS snapshots`)
    .bind(WELCOME_HOME_V19_MAPPING_OPERATION_TYPE, WELCOME_HOME_V19_AUDIT_VIDEO_ID).first<Record<string, number> & { ledgers: number; submissions: number; experts: number; revisions: number; snapshots: number }>();
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));
}

function applyInput(preview: Awaited<ReturnType<typeof previewWelcomeHomeV19Mapping>>, key: string) {
  return {
    action: "APPLY_WELCOME_HOME_V19_MAPPING" as const,
    confirmation: WELCOME_HOME_V19_MAPPING_CONFIRMATION,
    previewToken: preview.previewToken,
    targetCodeSha: preview.targetCodeSha,
    idempotencyKey: key,
    approvalReference: "TEST_ONLY_APPROVAL_REFERENCE_V1",
  };
}

export async function runWelcomeHomeV19MappingVerification(env: NodeJS.ProcessEnv = process.env) {
  const current = config(env);
  const schema = current.schema;
  const marker = randomBytes(16).toString("hex");
  const client = new Client({ connectionString: current.connectionString, ssl: false });
  await client.connect();
  const evidence: Record<string, boolean> = {
    oldHashCanonicalSame: false, canonicalDriftRejected: false, sourceRevisionDriftRejected: false,
    expiredTokenRejected: false, failureRolledBack: false, exact195Plus1: false,
    mapped7And23: false, all196Same: false, concurrentSingleExecution: false,
    idempotentReplay: false, submissionExpertUnchanged: false, sourceHistoryUnchanged: false,
    nonTargetUnchanged: false, cleanupGuarded: false,
  };
  let owned = false;
  try {
    const exists = await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
    if (exists.rowCount) throw new Error(`refusing to reuse ${schema}`);
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    owned = true;
    await client.query(`CREATE TABLE ${quote(schema)}.__mapping_marker (run_id TEXT PRIMARY KEY,marker TEXT NOT NULL)`);
    await client.query(`INSERT INTO ${quote(schema)}.__mapping_marker VALUES ($1,$2)`, [current.runId, marker]);
    await client.query(`SET search_path TO ${quote(schema)},public`);
    await install(client);
    const pool = new Pool({ connectionString: current.connectionString, ssl: false,
      options: `-c search_path=${schema},public`, max: 8 });
    const db = new DbClient(pool);
    const currentActor = actor(current.runId);
    try {
      await seedIdentityAndVideo(db, current.runId, currentActor);
      await seedSource(db, sourceFixture(), currentActor);
      await seedTarget(db, currentActor);
      const baselineCounts = await counts(db);
      const initial = await previewWelcomeHomeV19Mapping(db, currentActor, {
        tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:01:00.000Z"), targetCodeSha: "test-code-sha",
      });
      assert.equal(initial.ready, true);
      assert.equal(initial.totals.TARGET_EMPTY, 195);
      assert.equal(initial.totals.TARGET_SAME, 1);
      evidence.oldHashCanonicalSame = true;
      evidence.exact195Plus1 = true;

      await db.prepare("UPDATE annotations SET commercial_intent='canonical-drift' WHERE id='annotation-welcome-v03'").run();
      await assert.rejects(previewWelcomeHomeV19Mapping(db, currentActor, {
        tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:01:00.000Z"), targetCodeSha: "test-code-sha",
      }), (error) => error instanceof V04ServiceError && error.code === "STALE_PREVIEW");
      await db.prepare("UPDATE annotations SET commercial_intent='商业意图' WHERE id='annotation-welcome-v03'").run();
      evidence.canonicalDriftRejected = true;

      await db.prepare("UPDATE annotations SET revision=152 WHERE id='annotation-welcome-v03'").run();
      await assert.rejects(previewWelcomeHomeV19Mapping(db, currentActor, {
        tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:01:00.000Z"), targetCodeSha: "test-code-sha",
      }), (error) => error instanceof V04ServiceError && error.code === "STALE_PREVIEW");
      await db.prepare("UPDATE annotations SET revision=153 WHERE id='annotation-welcome-v03'").run();
      evidence.sourceRevisionDriftRejected = true;

      await assert.rejects(applyWelcomeHomeV19Mapping(db, currentActor,
        applyInput(initial, "test-only-expired-idempotency"), {
          tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:31:01.000Z"), targetCodeSha: "test-code-sha",
        }), (error) => error instanceof V04ServiceError && error.code === "STALE_PREVIEW");
      evidence.expiredTokenRejected = true;

      const fresh = await previewWelcomeHomeV19Mapping(db, currentActor, {
        tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:02:00.000Z"), targetCodeSha: "test-code-sha",
      });
      await assert.rejects(applyWelcomeHomeV19Mapping(db, currentActor,
        applyInput(fresh, "test-only-failure-idempotency"), {
          tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:02:00.000Z"), targetCodeSha: "test-code-sha", failAt: "AFTER_SNAPSHOT",
        }));
      assert.deepEqual(await counts(db), baselineCounts);
      evidence.failureRolledBack = true;

      const concurrentPreview = await previewWelcomeHomeV19Mapping(db, currentActor, {
        tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:03:00.000Z"), targetCodeSha: "test-code-sha",
      });
      const concurrent = await Promise.allSettled([
        applyWelcomeHomeV19Mapping(db, currentActor, applyInput(concurrentPreview, "test-only-concurrent-key-0001"), {
          tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:03:00.000Z"), targetCodeSha: "test-code-sha",
        }),
        applyWelcomeHomeV19Mapping(db, currentActor, applyInput(concurrentPreview, "test-only-concurrent-key-0002"), {
          tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:03:00.000Z"), targetCodeSha: "test-code-sha",
        }),
      ]);
      const fulfilled = concurrent.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof applyWelcomeHomeV19Mapping>>> => item.status === "fulfilled");
      assert.equal(fulfilled.length, 1);
      assert.equal(fulfilled[0].value.outcome, "APPLIED");
      const post = await previewWelcomeHomeV19Mapping(db, currentActor, {
        tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:04:00.000Z"), targetCodeSha: "test-code-sha",
      });
      assert.equal(post.alreadyApplied, true);
      assert.equal(post.totals.TARGET_SAME, 196);
      assert.equal(post.structure.targetShotGroupCount, 7);
      assert.equal(post.structure.targetShotCount, 23);
      evidence.concurrentSingleExecution = true;
      evidence.mapped7And23 = true;
      evidence.all196Same = true;
      const replay = await applyWelcomeHomeV19Mapping(db, currentActor,
        applyInput(concurrentPreview, "test-only-concurrent-key-0001"), {
          tokenSecret: "test-only-secret", now: new Date("2026-08-21T12:04:00.000Z"), targetCodeSha: "test-code-sha",
        });
      assert.equal(replay.outcome, "ALREADY_APPLIED");
      evidence.idempotentReplay = true;
      const afterCounts = await counts(db);
      assert.equal(afterCounts.ledgers, 1);
      assert.equal(afterCounts.submissions, baselineCounts.submissions);
      assert.equal(afterCounts.experts, baselineCounts.experts);
      evidence.submissionExpertUnchanged = true;
      const sourceSnapshots = await db.prepare("SELECT COUNT(*) AS count FROM annotation_snapshots WHERE annotation_id='annotation-welcome-v03'").first<{ count: number }>();
      assert.equal(Number(sourceSnapshots?.count), 1);
      evidence.sourceHistoryUnchanged = true;
      const other = await db.prepare("SELECT status FROM videos WHERE id=?").bind(`video_${current.runId}_other`).first<{ status: string }>();
      assert.equal(other?.status, "READY");
      evidence.nonTargetUnchanged = true;
    } finally {
      await pool.end();
    }
    evidence.cleanupGuarded = true;
    return evidence;
  } finally {
    if (owned) {
      const row = await client.query(`SELECT marker FROM ${quote(schema)}.__mapping_marker WHERE run_id=$1`, [current.runId]);
      if (row.rows[0]?.marker !== marker) throw new Error("cleanup marker mismatch");
      await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    }
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWelcomeHomeV19MappingVerification(process.env)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "verification failed"}\n`);
      process.exitCode = 1;
    });
}
