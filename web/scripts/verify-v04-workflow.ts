import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { BOOTSTRAP_STATEMENTS } from "../db/bootstrap.ts";
import { V04_SCHEMA_TABLES } from "../db/v04-schema.ts";
import { DbClient } from "../db/index.ts";
import {
  emptyV04DraftPayload,
  hashV04Payload,
} from "../lib/v04-domain.ts";
import type {
  V04Change,
  V04DraftPayloadV1,
} from "../lib/v04-contract.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";
import { assertV04GrayAccess, hashV04GrayUserId } from "../lib/v04-gray-access.ts";
import {
  applyV04GrayTestObject,
  previewV04GrayTestObject,
  V04_GRAY_TEST_OBJECT_CONFIRMATION,
} from "../lib/v04-gray-test-object.ts";
import { V04_GRAY_TEST_MEDIA } from "../lib/v04-gray-test-media.ts";
import {
  loadV04CaseCardReadModel,
  loadV04CaseDetailReadModel,
  loadV04HistoryReadModel,
  loadV04WorkspaceReadModel,
} from "../lib/v04-read-models.ts";
import {
  acquireV04Lease,
  forceReleaseV04Lease,
  grantV04ExpertPreference,
  heartbeatV04Lease,
  materializeV04Workspace,
  releaseV04Lease,
  restoreV04Draft,
  saveV04Draft,
  submitV04Draft,
  withdrawV04ExpertPreference,
  type V04Actor,
  type V04LeaseProof,
} from "../lib/v04-workspace-service.ts";
import { restoreVideo, trashVideo } from "../lib/v04-video-lifecycle.ts";
import { parseV04SchemaTestConfig } from "./verify-v04-schema.ts";
import type { ObjectBody, PresignedPutOptions, VideoBucket } from "../storage/types.ts";

const { Client, Pool } = pg;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Environment = Record<string, string | undefined>;

class MemoryVideoBucket implements VideoBucket {
  readonly objects = new Map<string, Uint8Array>();

  async createPresignedPutUrl(key: string, options: PresignedPutOptions) {
    void options;
    return `memory://put/${key}`;
  }

  async createPresignedGetUrl(key: string) {
    return `memory://get/${key}`;
  }

  async put(key: string, body: ObjectBody) {
    if (body instanceof Uint8Array) this.objects.set(key, body.slice());
    else if (body instanceof Blob) this.objects.set(key, new Uint8Array(await body.arrayBuffer()));
    else this.objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength, httpEtag: `memory-${value.byteLength}` } : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const value = this.objects.get(key);
    if (!value) return { body: null };
    const selected = options?.range
      ? value.slice(options.range.offset, options.range.offset + options.range.length)
      : value;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(selected));
          controller.close();
        },
      }),
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

async function publicFingerprint(client: pg.Client) {
  const result = await client.query<{ line: string }>(`
    SELECT concat_ws('|', c.relkind, c.relname, a.attname, a.atttypid::regtype::text,
      a.attnotnull::text, coalesce(pg_get_expr(d.adbin, d.adrelid), '')) AS line
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname, a.attnum
  `);
  return sha256(result.rows.map((row) => row.line).join("\n"));
}

async function count(db: DbClient, table: string, where = "TRUE", values: Array<string | number> = []) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .bind(...values).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function expectCode(operation: Promise<unknown>, code: V04ServiceError["code"]) {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof V04ServiceError);
    assert.equal(error.code, code);
    return true;
  });
}

function actor(runId: string, key: string): V04Actor {
  return {
    userId: `user_${runId}_${key}`,
    identityKey: `test-only:${runId}:${key}`,
    displayName: `TEST_ONLY ${key}`,
    sessionId: `session_${runId}_${key}`,
    requestId: `request_${runId}_${key}`,
  };
}

function proof(lease: { leaseToken: string; leaseVersion: number }, tabToken: string): V04LeaseProof {
  return { leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion, tabToken };
}

function completePayload(): V04DraftPayloadV1 {
  const payload = emptyV04DraftPayload();
  payload.script.shotGroups = [{
    id: "group-main",
    orderIndex: 0,
    bridgeName: "建立与回家",
    primaryCreativeRole: {
      ...payload.factsAndCoreJudgement.mainMechanism,
      selectedOptionIds: ["ESTABLISH_CHARACTER_RELATIONSHIP"],
    },
    auxiliaryCreativeRole: {
      ...payload.factsAndCoreJudgement.auxiliaryMechanism,
      selectedOptionIds: ["ACCUMULATE_EMOTION"],
    },
    keyCreativeDescription: "以重复动作完成情感累积。",
    shots: [{
      id: "shot-main",
      orderIndex: 0,
      startTime: "00:00",
      endTime: "00:01",
      shotScale: "近景",
      cameraAngle: "平视",
      cameraMovement: "固定",
      visualContent: "人物打开家门。",
      screenCopy: "",
      subtitleEffect: "",
      dialogue: "",
      voiceOver: "欢迎回家。",
      soundEffect: "开门声",
      music: "温暖钢琴",
    }],
  }];
  Object.assign(payload.factsAndCoreJudgement, {
    commercialIntent: "建立品牌归属感。",
    storySynopsis: "人物经历分离后回家。",
    creativeMotif: "回家。",
    tensionButton: "分离与重逢。",
    mainMechanism: {
      ...payload.factsAndCoreJudgement.mainMechanism,
      selectedOptionIds: ["INSIGHT_RESONANCE"],
    },
    auxiliaryMechanism: {
      ...payload.factsAndCoreJudgement.auxiliaryMechanism,
      selectedOptionIds: ["REPETITION_CHANGES_MEANING"],
    },
    creativeThinkingChain: "从离开推导重逢，再落到品牌。",
    storyReference: {
      ...payload.factsAndCoreJudgement.storyReference,
      selectedOptionIds: ["FAREWELL_REUNION"],
    },
    creativeCarriers: ["STORY"],
    carrierExplanation: "由故事和重复动作承重。",
    acceptanceContract: "生活真实性。",
    overallCreativeRating: "A",
    ratingReason: "结构完整。",
  });
  payload.perceptionPath = {
    primaryType: "LOVE",
    primaryDetails: {
      emotionalBase: "思念",
      accumulation: "重复回忆",
      gapPressure: "分离",
      releaseMethod: "重逢",
      mainCarrier: "故事",
    },
    auxiliaryTypes: [{
      type: "PERCEPTION",
      description: "门的视听重复。",
      creativeRole: "提供识别性。",
    }],
  };
  return payload;
}

function topLevelChanges(current: V04DraftPayloadV1, target: V04DraftPayloadV1): V04Change[] {
  const changes: V04Change[] = [];
  const push = (targetKey: string, targetLabel: string, beforeValue: unknown, afterValue: unknown, valueType: V04Change["valueType"] = "TEXT") => {
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changes.push({ targetKey, targetLabel, beforeValue, afterValue, valueType });
    }
  };
  push("script.structure", "脚本结构", current.script.shotGroups, target.script.shotGroups, "STRUCTURE");
  for (const key of Object.keys(target.factsAndCoreJudgement) as Array<keyof V04DraftPayloadV1["factsAndCoreJudgement"]>) {
    const valueType = typeof target.factsAndCoreJudgement[key] === "string"
      ? "TEXT"
      : key === "creativeCarriers" ? "MULTI_SELECT" : "CHOICE_WITH_CUSTOM";
    push(`facts.${key}`, String(key), current.factsAndCoreJudgement[key], target.factsAndCoreJudgement[key], valueType);
  }
  push("path.primaryType", "主导路径", current.perceptionPath.primaryType, target.perceptionPath.primaryType, "SINGLE_SELECT");
  push("path.primaryDetails", "主导路径细项", current.perceptionPath.primaryDetails, target.perceptionPath.primaryDetails, "STRUCTURE");
  push("path.auxiliaryTypes", "辅助路径", current.perceptionPath.auxiliaryTypes, target.perceptionPath.auxiliaryTypes, "STRUCTURE");
  return changes;
}

async function installSchema(client: pg.Client) {
  await client.query("BEGIN");
  try {
    for (const statement of BOOTSTRAP_STATEMENTS) {
      // The production bootstrap ends with a public-schema ACL hardening block.
      // This verifier installs the complete contract into an isolated TEST_ONLY
      // schema and must leave public ACLs as well as public data untouched.
      if (statement.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public")) continue;
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seed(db: DbClient, runId: string) {
  const actors = {
    a: actor(runId, "a"),
    b: actor(runId, "b"),
    expert: actor(runId, "expert"),
    admin: actor(runId, "admin"),
  };
  const now = "2026-08-19T12:00:00.000Z";
  for (const item of Object.values(actors)) {
    await db.prepare(
      `INSERT INTO users (
        id, wecom_corp_id, wecom_user_id, identity_key, display_name,
        email, status, last_login_at, last_synced_at, created_at, updated_at
      ) VALUES (?, 'TEST_ONLY', ?, ?, ?, NULL, 'ACTIVE', ?, ?, ?, ?)`,
    ).bind(
      item.userId, item.userId, item.identityKey, item.displayName,
      now, now, now, now,
    ).run();
    await db.prepare(
      `INSERT INTO auth_sessions (
        id, user_id, token_hash, expires_at, last_seen_at, created_at
      ) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(item.sessionId, item.userId, `test-only-${item.userId}`, now, now).run();
  }
  await db.prepare(
    `INSERT INTO app_role_memberships (user_id, role_key, status, granted_by_user_id)
    VALUES (?, 'EXPERT', 'ACTIVE', ?), (?, 'SYSTEM_ADMIN', 'ACTIVE', ?)`,
  ).bind(actors.expert.userId, actors.admin.userId, actors.admin.userId, actors.admin.userId).run();

  const videoId = `video_${runId}_main`;
  const emptyVideoId = `video_${runId}_empty`;
  for (const [id, title] of [[videoId, "TEST_ONLY 1B main"], [emptyVideoId, "TEST_ONLY 1B empty"]]) {
    await db.prepare(
      `INSERT INTO videos (
        id, title, brand, description, tags_json, object_key, original_name,
        file_size, status, rights_confirmed, created_by_email, created_by_name,
        created_by_user_id, data_scope, test_run_id, created_at, updated_at,
        deletion_state
      ) VALUES (?, ?, 'TEST_ONLY', '', '[]', ?, 'test.mp4', 1024, 'READY', 1,
        ?, ?, ?, 'TEST_ONLY', ?, ?, ?, 'ACTIVE')`,
    ).bind(
      id, title, `test-only/${runId}/${id}.mp4`, actors.a.identityKey,
      actors.a.displayName, actors.a.userId, runId, now, now,
    ).run();
  }
  return { actors, videoId, emptyVideoId };
}

async function snapshotCounts(db: DbClient, runId: string) {
  const videoIds = (await db.prepare(
    `SELECT id FROM videos WHERE data_scope = 'TEST_ONLY' AND test_run_id = ? ORDER BY id`,
  ).bind(runId).all<{ id: string }>()).results.map((row) => row.id);
  return {
    videos: videoIds.length,
    workspaces: await count(
      db,
      "collaboration_workspaces",
      "video_id IN (SELECT id FROM videos WHERE data_scope = 'TEST_ONLY' AND test_run_id = ?)",
      [runId],
    ),
    audits: await count(db, "audit_logs", "workflow_version = ?", ["AD_VIDEO_WORKFLOW_V1"]),
    submissions: await count(db, "annotation_submission_snapshots"),
    revisions: await count(db, "collaboration_revision_events"),
  };
}

async function assertRls(client: pg.Client, schemaName: string, runId: string) {
  const role = `v04_1b_nonowner_${runId}`;
  await client.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
  try {
    await client.query(`GRANT USAGE ON SCHEMA ${quote(schemaName)} TO ${quote(role)}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quote(schemaName)} TO ${quote(role)}`);
    await client.query(`SET ROLE ${quote(role)}`);
    for (const table of [...V04_SCHEMA_TABLES, "admin_data_operations"]) {
      const hidden = await client.query(`SELECT * FROM ${quote(table)}`);
      assert.equal(hidden.rowCount, 0, `${table} rows must be hidden from a non-owner role`);
    }
    const updated = await client.query("UPDATE collaboration_workspaces SET status = 'ARCHIVED'");
    assert.equal(updated.rowCount, 0);
    const deleted = await client.query("DELETE FROM collaboration_workspaces");
    assert.equal(deleted.rowCount, 0);
    await assert.rejects(client.query(
      "INSERT INTO app_role_memberships (user_id, role_key) VALUES ('no-user', 'EXPERT')",
    ));
  } finally {
    await client.query("RESET ROLE");
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quote(schemaName)} FROM ${quote(role)}`);
    await client.query(`REVOKE USAGE ON SCHEMA ${quote(schemaName)} FROM ${quote(role)}`);
    await client.query(`DROP ROLE ${quote(role)}`);
  }
}

export async function runV04WorkflowVerification(env: Environment = process.env) {
  const config = parseV04SchemaTestConfig(env);
  const schemaName = `${config.schemaName}_workflow`;
  const marker = randomBytes(16).toString("hex");
  const client = new Client({
    connectionString: config.connectionString,
    ssl: false,
    application_name: `hamark_v04_workflow_test_${config.runId}`,
  });
  await client.connect();
  const publicBefore = await publicFingerprint(client);
  let owned = false;
  const evidence: Record<string, unknown> = {
    host: "loopback",
    database: config.databaseName,
    runId: config.runId,
  };
  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [schemaName],
    );
    if (existing.rowCount) throw new Error(`refusing to reuse ${schemaName}`);
    await client.query(`CREATE SCHEMA ${quote(schemaName)}`);
    owned = true;
    await client.query(`CREATE TABLE ${quote(schemaName)}.__v04_1b_marker (
      run_id TEXT PRIMARY KEY, cleanup_token TEXT NOT NULL
    )`);
    await client.query(
      `INSERT INTO ${quote(schemaName)}.__v04_1b_marker VALUES ($1, $2)`,
      [config.runId, marker],
    );
    await client.query(`SET search_path TO ${quote(schemaName)}, public`);
    await installSchema(client);

    const pool = new Pool({
      connectionString: config.connectionString,
      ssl: false,
      application_name: `hamark_v04_workflow_service_${config.runId}`,
      options: `-c search_path=${schemaName},public`,
      max: 6,
    });
    const db = new DbClient(pool);
    try {
      const { actors, videoId, emptyVideoId } = await seed(db, config.runId);
      await db.prepare(
        `UPDATE annotation_taxonomy_versions SET status='ACTIVE'
        WHERE taxonomy_version='AD_VIDEO_TAXONOMY_V1' AND status='DRAFT'`,
      ).run();
      await db.prepare(
        `UPDATE annotation_vocabulary_versions SET status='ACTIVE'
        WHERE vocabulary_version='AD_VIDEO_VOCAB_V1' AND status='DRAFT'`,
      ).run();
      await db.prepare(
        `UPDATE workflow_contract_versions SET status='ACTIVE',activated_at=?
        WHERE workflow_version='AD_VIDEO_WORKFLOW_V1' AND status='DRAFT'`,
      ).bind("2026-08-19T12:00:00.000Z").run();
      const grayEnvironment = {
        V04_GRAY_ROLLOUT_ENABLED: "true",
        V04_GRAY_USER_ID_SHA256S:
          `${hashV04GrayUserId(actors.a.userId)},${hashV04GrayUserId(actors.b.userId)}`,
        V04_GRAY_TEST_VIDEO_IDS: `${videoId},${emptyVideoId}`,
        V04_GRAY_CONTROLLED_VIDEO_IDS: "",
      };
      await assertV04GrayAccess(db, actors.a.userId, videoId, grayEnvironment);
      await assertV04GrayAccess(db, actors.b.userId, videoId, grayEnvironment);
      await expectCode(
        assertV04GrayAccess(db, actors.expert.userId, videoId, grayEnvironment),
        "FORBIDDEN",
      );
      const grayMediaBucket = new MemoryVideoBucket();
      const grayMediaNow = new Date("2026-08-19T12:10:00.000Z");
      const grayMediaOptions = {
        tokenSecret: "TEST_ONLY_v04_gray_media_token_secret_32_bytes",
        targetCodeSha: "TEST_ONLY_GRAY_MEDIA_SHA",
        now: grayMediaNow,
      };
      const grayMediaBusinessBefore = await count(db, "videos", "data_scope='BUSINESS'");
      const grayMediaPreview = await previewV04GrayTestObject(
        db, grayMediaBucket, actors.admin, grayMediaOptions,
      );
      assert.equal(grayMediaPreview.ready, true);
      assert.equal(grayMediaPreview.zeroWrite.unchanged, true);
      assert.equal(grayMediaPreview.facts.targetState, "ABSENT");
      const failedGrayMedia = await applyV04GrayTestObject(
        db,
        grayMediaBucket,
        actors.admin,
        {
          action: "CREATE_TEST_ONLY_GRAY_VIDEO",
          previewToken: grayMediaPreview.previewToken,
          idempotencyKey: `gray-media-failure-${config.runId}`,
          confirmation: V04_GRAY_TEST_OBJECT_CONFIRMATION,
          approvalReference: "TEST_ONLY_GATE2_MEDIA_APPROVAL",
          targetCodeSha: grayMediaOptions.targetCodeSha,
        },
        { ...grayMediaOptions, failAt: "AFTER_UPLOAD" },
      );
      assert.equal(failedGrayMedia.status, "FAILED");
      assert.equal(failedGrayMedia.compensation, "OBJECT_DELETED");
      assert.equal(grayMediaBucket.objects.has(V04_GRAY_TEST_MEDIA.objectKey), false);
      assert.equal(await count(db, "videos", "id=?", [V04_GRAY_TEST_MEDIA.videoId]), 0);
      const grayMediaRetryPreview = await previewV04GrayTestObject(
        db, grayMediaBucket, actors.admin, grayMediaOptions,
      );
      const grayMediaInput = {
        action: "CREATE_TEST_ONLY_GRAY_VIDEO" as const,
        previewToken: grayMediaRetryPreview.previewToken,
        idempotencyKey: `gray-media-success-${config.runId}`,
        confirmation: V04_GRAY_TEST_OBJECT_CONFIRMATION,
        approvalReference: "TEST_ONLY_GATE2_MEDIA_APPROVAL",
        targetCodeSha: grayMediaOptions.targetCodeSha,
      };
      const createdGrayMedia = await applyV04GrayTestObject(
        db, grayMediaBucket, actors.admin, grayMediaInput, grayMediaOptions,
      );
      assert.equal(createdGrayMedia.status, "APPLIED", JSON.stringify(createdGrayMedia));
      assert.equal(createdGrayMedia.alreadyApplied, false);
      assert.equal((await grayMediaBucket.head(V04_GRAY_TEST_MEDIA.objectKey))?.size,
        V04_GRAY_TEST_MEDIA.fileSize);
      const createdVideo = await db.prepare(`SELECT status,data_scope,test_run_id,file_size,
          created_by_user_id,object_key FROM videos WHERE id=?`)
        .bind(V04_GRAY_TEST_MEDIA.videoId).first<{
          status: string; data_scope: string; test_run_id: string; file_size: number;
          created_by_user_id: string; object_key: string;
        }>();
      assert.deepEqual(createdVideo, {
        status: "READY",
        data_scope: "TEST_ONLY",
        test_run_id: V04_GRAY_TEST_MEDIA.testRunId,
        file_size: V04_GRAY_TEST_MEDIA.fileSize,
        created_by_user_id: actors.admin.userId,
        object_key: V04_GRAY_TEST_MEDIA.objectKey,
      });
      assert.equal(await count(db, "videos", "data_scope='BUSINESS'"), grayMediaBusinessBefore);
      const replayedGrayMedia = await applyV04GrayTestObject(
        db, grayMediaBucket, actors.admin, grayMediaInput, grayMediaOptions,
      );
      assert.equal(replayedGrayMedia.alreadyApplied, true);
      const concurrentGrayMedia = await Promise.all([
        applyV04GrayTestObject(db, grayMediaBucket, actors.admin, {
          ...grayMediaInput,
          idempotencyKey: `gray-media-concurrent-a-${config.runId}`,
        }, grayMediaOptions),
        applyV04GrayTestObject(db, grayMediaBucket, actors.admin, {
          ...grayMediaInput,
          idempotencyKey: `gray-media-concurrent-b-${config.runId}`,
        }, grayMediaOptions),
      ]);
      assert(concurrentGrayMedia.every((item) => item.status === "APPLIED" && item.alreadyApplied));
      assert.equal(await count(db, "videos", "id=?", [V04_GRAY_TEST_MEDIA.videoId]), 1);
      const trashedGrayMedia = await trashVideo(db, V04_GRAY_TEST_MEDIA.videoId, actors.admin, {
        reason: "TEST_ONLY gray media retention verification",
        idempotencyKey: `gray-media-trash-${config.runId}`,
        now: grayMediaNow,
      });
      assert.equal(trashedGrayMedia.trashed, true);
      assert.equal(grayMediaBucket.objects.has(V04_GRAY_TEST_MEDIA.objectKey), true);
      const trashedRow = await db.prepare(`SELECT deletion_state,restore_until FROM videos WHERE id=?`)
        .bind(V04_GRAY_TEST_MEDIA.videoId).first<{ deletion_state: string; restore_until: string }>();
      assert.equal(trashedRow?.deletion_state, "TRASHED");
      assert.equal(Date.parse(trashedRow?.restore_until ?? "") - grayMediaNow.getTime(),
        90 * 24 * 60 * 60 * 1000);
      await restoreVideo(db, V04_GRAY_TEST_MEDIA.videoId, actors.admin, {
        idempotencyKey: `gray-media-restore-${config.runId}`,
        now: new Date(grayMediaNow.getTime() + 1000),
      });
      assert.equal(grayMediaBucket.objects.has(V04_GRAY_TEST_MEDIA.objectKey), true);
      const nonAdminPreview = await previewV04GrayTestObject(
        db, grayMediaBucket, actors.a, grayMediaOptions,
      );
      assert.equal(nonAdminPreview.ready, false);
      assert(nonAdminPreview.stopReasons.includes("SYSTEM_ADMIN_REQUIRED"));
      evidence.grayTestMediaPreviewZeroWrite = grayMediaPreview.zeroWrite.unchanged;
      evidence.grayTestMediaFailureCompensated = failedGrayMedia.compensation === "OBJECT_DELETED";
      evidence.grayTestMediaReadyAndHidden = createdVideo?.status === "READY"
        && createdVideo.data_scope === "TEST_ONLY"
        && await count(db, "videos", "data_scope='BUSINESS'") === grayMediaBusinessBefore;
      evidence.grayTestMediaIdempotentConcurrent = concurrentGrayMedia.every((item) => item.alreadyApplied);
      evidence.grayTestMediaSoftDeleteKeepsAsset = grayMediaBucket.objects.has(V04_GRAY_TEST_MEDIA.objectKey);
      await expectCode(
        assertV04GrayAccess(db, actors.a.userId, `video_${config.runId}_unknown`, grayEnvironment),
        "CASE_NOT_FOUND",
      );
      evidence.grayTwoStableUsers = true;
      evidence.grayUnknownActorAndVideoDenied = true;
      const emptyBefore = await snapshotCounts(db, config.runId);
      const logicalA = await loadV04WorkspaceReadModel(db, emptyVideoId);
      const logicalB = await loadV04WorkspaceReadModel(db, emptyVideoId);
      assert.equal(logicalA.logicalEmpty, true);
      assert.equal(logicalB.logicalEmpty, true);
      assert.equal((await loadV04CaseCardReadModel(db, emptyVideoId)).state, "NOT_STARTED");
      assert.deepEqual(await snapshotCounts(db, config.runId), emptyBefore, "logical GET must be zero-write");

      const materialized = await materializeV04Workspace(db, videoId, actors.a);
      assert.equal(materialized.created, true);
      const repeatMaterialize = await materializeV04Workspace(db, videoId, actors.b);
      assert.equal(repeatMaterialize.created, false);
      assert.equal(await count(db, "collaboration_workspaces", "video_id = ?", [videoId]), 1);

      const tabA1 = `tab_${config.runId}_a1`;
      const tabA2 = `tab_${config.runId}_a2`;
      const tabB = `tab_${config.runId}_b`;
      const leaseA = await acquireV04Lease(db, videoId, actors.a, { tabToken: tabA1 });
      const leaseAProof = proof(leaseA, tabA1);
      const leaseAReplay = await acquireV04Lease(db, videoId, actors.a, {
        tabToken: tabA1,
        existingLeaseToken: leaseA.leaseToken,
        existingLeaseVersion: leaseA.leaseVersion,
        now: new Date(Date.now() + 1_000),
      });
      assert.equal(leaseAReplay.reused, true);
      assert(Date.parse(leaseAReplay.expiresAt) > Date.parse(leaseA.expiresAt));
      await expectCode(acquireV04Lease(db, videoId, actors.a, { tabToken: tabA2 }), "LEASE_HELD_BY_OTHER");
      await expectCode(acquireV04Lease(db, videoId, actors.b, { tabToken: tabB }), "LEASE_HELD_BY_OTHER");
      await expectCode(heartbeatV04Lease(db, videoId, actors.a, { ...leaseAProof, tabToken: tabA2 }), "LEASE_HELD_BY_OTHER");
      const heartbeat = await heartbeatV04Lease(db, videoId, actors.a, leaseAProof);
      assert.equal(heartbeat.leaseVersion, leaseA.leaseVersion);

      const emptyHash = hashV04Payload(emptyV04DraftPayload());
      const save1 = await saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: 0,
        expectedHash: emptyHash,
        changeSetId: `change_${config.runId}_1`,
        changes: [{
          targetKey: "facts.commercialIntent",
          targetLabel: "商业意图",
          valueType: "TEXT",
          beforeValue: "",
          afterValue: "初始意图",
        }],
        lease: leaseAProof,
      });
      assert.equal(save1.revision, 1);
      assert.equal(save1.workflowState, "INCOMPLETE");
      assert.equal((await loadV04CaseCardReadModel(db, videoId)).state, "INCOMPLETE");
      const replayedSave1 = await saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: 0,
        expectedHash: emptyHash,
        changeSetId: `change_${config.runId}_1`,
        changes: [{
          targetKey: "facts.commercialIntent",
          targetLabel: "商业意图",
          valueType: "TEXT",
          beforeValue: "",
          afterValue: "初始意图",
        }],
        lease: leaseAProof,
      });
      assert.equal(replayedSave1.revision, 1);
      assert.equal(replayedSave1.idempotentReplay, true);
      await expectCode(saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: 1,
        expectedHash: save1.contentHash,
        changeSetId: `change_${config.runId}_1`,
        changes: [{
          targetKey: "facts.storySynopsis",
          targetLabel: "故事梗概",
          valueType: "TEXT",
          beforeValue: "",
          afterValue: "不同的幂等内容",
        }],
        lease: leaseAProof,
      }), "IDEMPOTENCY_CONFLICT");
      await expectCode(saveV04Draft(db, actors.b, {
        videoId,
        expectedRevision: 1,
        expectedHash: save1.contentHash,
        changeSetId: `change_${config.runId}_b`,
        changes: [],
        lease: { ...leaseAProof, tabToken: tabB },
      }), "LEASE_HELD_BY_OTHER");

      const save2 = await saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: 1,
        expectedHash: save1.contentHash,
        changeSetId: `change_${config.runId}_2`,
        changes: [{
          targetKey: "facts.storySynopsis", targetLabel: "故事梗概", valueType: "TEXT",
          beforeValue: "", afterValue: "初始故事",
        }],
        lease: leaseAProof,
      });
      assert.equal(save2.revision, 2);
      await expectCode(saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: 1,
        expectedHash: save1.contentHash,
        changeSetId: `change_${config.runId}_same-target`,
        changes: [{
          targetKey: "facts.storySynopsis", targetLabel: "故事梗概", valueType: "TEXT",
          beforeValue: "", afterValue: "冲突故事",
        }],
        lease: leaseAProof,
      }), "REVISION_CONFLICT");
      const rebased = await saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: 1,
        expectedHash: save1.contentHash,
        changeSetId: `change_${config.runId}_rebase`,
        changes: [{
          targetKey: "facts.creativeMotif", targetLabel: "创意母题", valueType: "TEXT",
          beforeValue: "", afterValue: "归属",
        }],
        lease: leaseAProof,
      });
      assert.equal(rebased.rebased, true);
      assert.equal(rebased.revision, 3);
      await expectCode(submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: rebased.revision,
        expectedDraftHash: rebased.contentHash,
        idempotencyKey: `submit_${config.runId}_incomplete`,
        lease: leaseAProof,
      }), "PUBLICATION_INCOMPLETE");

      const workspaceBeforeComplete = await loadV04WorkspaceReadModel(db, videoId);
      const target = completePayload();
      const saveReady = await saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: workspaceBeforeComplete.draftRevision,
        expectedHash: workspaceBeforeComplete.draftContentHash,
        changeSetId: `change_${config.runId}_complete`,
        changes: topLevelChanges(workspaceBeforeComplete.payload, target),
        lease: leaseAProof,
      });
      assert.equal((await loadV04WorkspaceReadModel(db, videoId)).publication.publicationReady, true);
      await expectCode(submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: rebased.revision,
        expectedDraftHash: rebased.contentHash,
        idempotencyKey: `submit_${config.runId}_stale`,
        lease: leaseAProof,
      }), "REVISION_CONFLICT");
      await expectCode(submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: saveReady.revision,
        expectedDraftHash: saveReady.contentHash,
        idempotencyKey: `submit_${config.runId}_wrong-lease`,
        lease: { ...leaseAProof, leaseToken: "wrong-token" },
      }), "LEASE_HELD_BY_OTHER");

      await assert.rejects(submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: saveReady.revision,
        expectedDraftHash: saveReady.contentHash,
        idempotencyKey: `submit_${config.runId}_rollback_1`,
        lease: leaseAProof,
      }, { afterSubmissionInsert: () => { throw new Error("TEST_ONLY_AFTER_INSERT"); } }));
      assert.equal(await count(db, "annotation_submission_snapshots"), 0);

      const submission1 = await submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: saveReady.revision,
        expectedDraftHash: saveReady.contentHash,
        idempotencyKey: `submit_${config.runId}_1`,
        lease: leaseAProof,
      });
      assert.equal(submission1.submissionNumber, 1);
      assert.equal((await loadV04CaseCardReadModel(db, videoId)).state, "SUBMITTED");
      assert.equal((await loadV04CaseDetailReadModel(db, videoId)).latestSubmission?.submissionNumber, 1);
      const replay1 = await submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: saveReady.revision,
        expectedDraftHash: saveReady.contentHash,
        idempotencyKey: `submit_${config.runId}_1`,
        lease: leaseAProof,
      });
      assert.equal(replay1.submissionId, submission1.submissionId);
      assert.equal(replay1.idempotentReplay, true);
      await expectCode(submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: saveReady.revision,
        expectedDraftHash: saveReady.contentHash,
        idempotencyKey: `submit_${config.runId}_same-hash`,
        lease: leaseAProof,
      }), "NO_CHANGES_TO_SUBMIT");

      const saveModified = await saveV04Draft(db, actors.a, {
        videoId,
        expectedRevision: saveReady.revision,
        expectedHash: saveReady.contentHash,
        changeSetId: `change_${config.runId}_modified`,
        changes: [{
          targetKey: "facts.ratingReason", targetLabel: "评价理由", valueType: "TEXT",
          beforeValue: "结构完整。", afterValue: "结构完整，视听清晰。",
        }],
        lease: leaseAProof,
      });
      assert.equal((await loadV04WorkspaceReadModel(db, videoId)).state, "MODIFIED_UNSUBMITTED");
      assert.equal((await loadV04CaseCardReadModel(db, videoId)).state, "MODIFIED_UNSUBMITTED");
      assert.equal((await loadV04CaseDetailReadModel(db, videoId)).latestSubmission?.submissionNumber, 1,
        "case detail must not expose an unsaved/latest draft as submitted content");
      const submission2 = await submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: saveModified.revision,
        expectedDraftHash: saveModified.contentHash,
        idempotencyKey: `submit_${config.runId}_2`,
        lease: leaseAProof,
      });
      assert.equal(submission2.submissionNumber, 2);
      assert.equal((await loadV04WorkspaceReadModel(db, videoId)).state, "MODIFICATION_SUBMITTED");
      assert.equal((await loadV04CaseCardReadModel(db, videoId)).state, "MODIFICATION_SUBMITTED");
      assert.equal((await loadV04CaseDetailReadModel(db, videoId)).latestSubmission?.submissionNumber, 2);

      await assert.rejects(grantV04ExpertPreference(db, videoId, submission1.submissionId, actors.expert, {
        grade: "B", idempotencyKey: `expert_${config.runId}_rollback`,
      }, { afterReleaseInsert: () => { throw new Error("TEST_ONLY_EXPERT_ROLLBACK"); } }));
      assert.equal(await count(db, "expert_analysis_releases"), 0);
      await expectCode(grantV04ExpertPreference(db, videoId, submission1.submissionId, actors.admin, {
        grade: "A", idempotencyKey: `expert_${config.runId}_admin`,
      }), "EXPERT_REQUIRED");
      const expert1 = await grantV04ExpertPreference(db, videoId, submission1.submissionId, actors.expert, {
        grade: "A", idempotencyKey: `expert_${config.runId}_1`,
      });
      const detailWithOlderPreference = await loadV04CaseDetailReadModel(db, videoId);
      assert.equal(detailWithOlderPreference.latestSubmission?.submissionNumber, 2);
      assert.equal(detailWithOlderPreference.expertPreferredSubmission?.submissionNumber, 1);
      assert.equal(detailWithOlderPreference.isSameVersion, false);
      const expert2 = await grantV04ExpertPreference(db, videoId, submission2.submissionId, actors.expert, {
        grade: "S", idempotencyKey: `expert_${config.runId}_2`,
      });
      assert.notEqual(expert1.releaseId, expert2.releaseId);
      const detailWithPreference = await loadV04CaseDetailReadModel(db, videoId);
      assert.equal(detailWithPreference.latestSubmission?.submissionNumber, 2);
      assert.equal(detailWithPreference.expertPreferredSubmission?.submissionNumber, 2);
      await withdrawV04ExpertPreference(db, videoId, actors.expert, {
        idempotencyKey: `expert_${config.runId}_withdraw`,
      });

      const beforeRestore = await loadV04WorkspaceReadModel(db, videoId);
      await assert.rejects(restoreV04Draft(db, videoId, actors.a, {
        sourceType: "SUBMISSION",
        sourceId: submission1.submissionId,
        idempotencyKey: `restore_${config.runId}_rollback`,
        reason: "TEST_ONLY restore rollback",
        lease: leaseAProof,
      }, { afterPointerUpdate: () => { throw new Error("TEST_ONLY_RESTORE_ROLLBACK"); } }));
      const afterFailedRestore = await loadV04WorkspaceReadModel(db, videoId);
      assert.equal(afterFailedRestore.draftRevision, beforeRestore.draftRevision);
      assert.equal(afterFailedRestore.draftContentHash, beforeRestore.draftContentHash);
      const restored = await restoreV04Draft(db, videoId, actors.a, {
        sourceType: "SUBMISSION",
        sourceId: submission1.submissionId,
        idempotencyKey: `restore_${config.runId}_1`,
        reason: "TEST_ONLY restore",
        lease: leaseAProof,
      });
      assert(restored.revision > saveModified.revision);
      const detailAfterRestore = await loadV04CaseDetailReadModel(db, videoId);
      assert.equal(detailAfterRestore.latestSubmission?.submissionNumber, 2,
        "restore must not move latest submission pointer");

      await assert.rejects(submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: restored.revision,
        expectedDraftHash: restored.contentHash,
        idempotencyKey: `submit_${config.runId}_rollback_pointer`,
        lease: leaseAProof,
      }, { afterPointerUpdate: () => { throw new Error("TEST_ONLY_AFTER_POINTER"); } }));
      assert.equal(await count(db, "annotation_submission_snapshots"), 2);
      assert.equal((await loadV04CaseDetailReadModel(db, videoId)).latestSubmission?.submissionNumber, 2);
      const submission3 = await submitV04Draft(db, actors.a, {
        videoId,
        expectedDraftRevision: restored.revision,
        expectedDraftHash: restored.contentHash,
        idempotencyKey: `submit_${config.runId}_3`,
        lease: leaseAProof,
      });
      assert.equal(submission3.submissionNumber, 3,
        "failed pointer update must not consume the next submission number");

      const countsBeforeGet = await snapshotCounts(db, config.runId);
      await Promise.all([
        loadV04WorkspaceReadModel(db, videoId),
        loadV04CaseCardReadModel(db, videoId),
        loadV04CaseDetailReadModel(db, videoId),
        loadV04HistoryReadModel(db, videoId),
      ]);
      await Promise.all([
        loadV04WorkspaceReadModel(db, videoId),
        loadV04CaseCardReadModel(db, videoId),
        loadV04CaseDetailReadModel(db, videoId),
        loadV04HistoryReadModel(db, videoId),
      ]);
      assert.deepEqual(await snapshotCounts(db, config.runId), countsBeforeGet, "all read models must be zero-write");

      await releaseV04Lease(db, videoId, actors.a, leaseAProof);
      const leaseB = await acquireV04Lease(db, videoId, actors.b, { tabToken: tabB });
      const late = new Date(Date.now() + 121_000);
      const leaseA2 = await acquireV04Lease(db, videoId, actors.a, { tabToken: tabA1, now: late });
      await expectCode(heartbeatV04Lease(db, videoId, actors.b, proof(leaseB, tabB), late), "LEASE_HELD_BY_OTHER");
      await expectCode(forceReleaseV04Lease(db, videoId, actors.expert, {
        reason: "TEST_ONLY expert cannot force", confirmed: true,
        idempotencyKey: `force_release_${config.runId}_expert`, now: late,
      }), "ADMIN_REQUIRED");
      const forced = await forceReleaseV04Lease(db, videoId, actors.admin, {
        reason: "TEST_ONLY force release", confirmed: true,
        idempotencyKey: `force_release_${config.runId}`, now: late,
      });
      assert.equal(forced.released, true);
      const forceReplay = await forceReleaseV04Lease(db, videoId, actors.admin, {
        reason: "TEST_ONLY force release", confirmed: true,
        idempotencyKey: `force_release_${config.runId}`, now: late,
      });
      assert.equal(forceReplay.idempotentReplay, true);
      await expectCode(heartbeatV04Lease(db, videoId, actors.a, proof(leaseA2, tabA1), late), "LEASE_REQUIRED");

      const beforeTrashHistory = await loadV04HistoryReadModel(db, videoId);
      await assert.rejects(trashVideo(db, videoId, actors.a, {
        reason: "TEST_ONLY trash rollback",
        idempotencyKey: `trash_${config.runId}_rollback`,
      }, { afterVideoUpdate: () => { throw new Error("TEST_ONLY_TRASH_ROLLBACK"); } }));
      await loadV04CaseDetailReadModel(db, videoId);
      const trashed = await trashVideo(db, videoId, actors.a, {
        reason: "TEST_ONLY trash",
        idempotencyKey: `trash_${config.runId}`,
      });
      assert.equal(trashed.trashed, true);
      await expectCode(loadV04CaseDetailReadModel(db, videoId), "CASE_IN_TRASH");
      await assert.rejects(restoreVideo(db, videoId, actors.a, {
        idempotencyKey: `video_restore_${config.runId}_rollback`,
      }, { afterVideoUpdate: () => { throw new Error("TEST_ONLY_VIDEO_RESTORE_ROLLBACK"); } }));
      await expectCode(loadV04CaseDetailReadModel(db, videoId), "CASE_IN_TRASH");
      const restoredVideo = await restoreVideo(db, videoId, actors.a, {
        idempotencyKey: `video_restore_${config.runId}`,
      });
      assert.equal(restoredVideo.restored, true);
      const afterTrashHistory = await loadV04HistoryReadModel(db, videoId);
      assert.equal(afterTrashHistory.events.length, beforeTrashHistory.events.length,
        "trash/restore must preserve immutable analysis history");
      assert.equal(await count(db, "video_asset_cleanup_jobs"), 0,
        "batch 1B must not execute or enqueue an asset purge");

      const lifecycleNow = new Date("2026-08-19T13:00:00.000Z");
      await expectCode(trashVideo(db, emptyVideoId, actors.b, {
        reason: "not uploader", idempotencyKey: `trash_${config.runId}_forbidden`, now: lifecycleNow,
      }), "FORBIDDEN");
      await trashVideo(db, emptyVideoId, actors.admin, {
        reason: "TEST_ONLY admin trash", idempotencyKey: `trash_${config.runId}_admin`, now: lifecycleNow,
      });
      await expectCode(restoreVideo(db, emptyVideoId, actors.a, {
        idempotencyKey: `restore_${config.runId}_expired`,
        now: new Date(lifecycleNow.getTime() + 91 * 24 * 60 * 60 * 1000),
      }), "CASE_IN_TRASH");
      await restoreVideo(db, emptyVideoId, actors.admin, {
        idempotencyKey: `restore_${config.runId}_admin`,
        now: new Date(lifecycleNow.getTime() + 24 * 60 * 60 * 1000),
      });
      assert.equal((await loadV04CaseCardReadModel(db, emptyVideoId)).state, "NOT_STARTED");

      const submissionRows = await db.prepare(
        `SELECT submission_number, content_hash FROM annotation_submission_snapshots
        ORDER BY submission_number`,
      ).all<{ submission_number: number; content_hash: string }>();
      assert.deepEqual(submissionRows.results.map((row) => Number(row.submission_number)), [1, 2, 3]);
      assert.equal(submissionRows.results[0].content_hash, submission1.contentHash);
      assert.equal(submissionRows.results[1].content_hash, submission2.contentHash);
      assert.equal(submissionRows.results[2].content_hash, submission3.contentHash);

      evidence.logicalEmptyGetWrites = 0;
      evidence.uniqueWorkspace = 1;
      evidence.leaseTwoUsersTwoTabs = true;
      evidence.disjointRebase = true;
      evidence.sameTargetConflict = true;
      evidence.firstSubmissionNumber = submission1.submissionNumber;
      evidence.secondSubmissionNumber = submission2.submissionNumber;
      evidence.thirdSubmissionAfterRollback = submission3.submissionNumber;
      evidence.idempotentSubmission = replay1.submissionId === submission1.submissionId;
      evidence.failedSubmissionConsumedNumber = false;
      evidence.pointerRollbackProtected = true;
      evidence.expertRollbackProtected = true;
      evidence.restoreRollbackProtected = true;
      evidence.softDeleteRollbackProtected = true;
      evidence.expertIndependent = true;
      evidence.restoreNonDestructive = true;
      evidence.readModelsZeroWrite = true;
      evidence.softDeleteNoAssetAction = true;
      evidence.stableUploaderAndAdminRestore = true;
    } finally {
      await pool.end();
    }
    await assertRls(client, schemaName, config.runId);
    evidence.rlsDeniedNonOwner = true;
  } finally {
    if (owned) {
      await client.query("SET search_path TO public");
      const markerRow = await client.query<{ run_id: string; cleanup_token: string }>(
        `SELECT run_id, cleanup_token FROM ${quote(schemaName)}.__v04_1b_marker`,
      );
      assert.equal(markerRow.rowCount, 1);
      assert.equal(markerRow.rows[0].run_id, config.runId);
      assert.equal(markerRow.rows[0].cleanup_token, marker);
      await client.query(`DROP SCHEMA ${quote(schemaName)} CASCADE`);
    }
    const publicAfter = await publicFingerprint(client);
    assert.equal(publicAfter, publicBefore, "public catalog fingerprint changed");
    evidence.publicFingerprintUnchanged = true;
    await client.end();
  }
  console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
  return evidence;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runV04WorkflowVerification().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
