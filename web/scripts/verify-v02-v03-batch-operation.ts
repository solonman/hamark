import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applySchema } from "../db/bootstrap.ts";
import { getDbClient, type DbClient } from "../db/index.ts";
import type { CurrentUser } from "../lib/current-user.ts";
import {
  applyV02V03BatchCandidate,
  previewV02V03BatchMapping,
  V02V03BatchMappingError,
  type V02V03BatchMappingConfig,
} from "../lib/v02-v03-batch-mapping.ts";

type Row = Record<string, unknown>;

const rawRunId = process.env.V02_V03_BATCH_TEST_RUN_ID || randomUUID().slice(0, 8);
if (!/^[a-z0-9_-]{3,40}$/i.test(rawRunId)) throw new Error("TEST_ONLY run id 格式无效。");
const runId = rawRunId.toLowerCase();
const prefix = `test_only_batch_${runId}`;
const config: V02V03BatchMappingConfig = {
  operationKeyPrefix: `TEST_ONLY_V02_V03_BATCH_${runId}_`,
  dataScope: "TEST_ONLY",
  confirmation: `TEST_ONLY_CONFIRM_${runId}`,
};
const actor: CurrentUser = {
  id: `${prefix}_admin`,
  identityKey: `${prefix}_admin_identity`,
  displayName: "TEST_ONLY 管理员",
  avatarUrl: null,
  email: null,
  departments: [],
};

const cases = {
  ready: makeCase("ready", "TEST_ONLY 原作者甲", true),
  existing: makeCase("existing", "TEST_ONLY 原作者乙", true),
  missing: makeCase("missing", "TEST_ONLY 未绑定作者", false),
  disabled: makeCase("disabled", "TEST_ONLY 停用作者", true, "DISABLED"),
  rollback: makeCase("rollback", "TEST_ONLY 回滚作者", true),
};

function makeCase(suffix: string, name: string, hasUser: boolean, status = "ACTIVE") {
  return {
    suffix,
    name,
    hasUser,
    status,
    videoId: `${prefix}_${suffix}_video`,
    sourceId: `${prefix}_${suffix}_v02`,
    sourceIdentity: `${prefix}_${suffix}_identity`,
    snapshotV1: `${prefix}_${suffix}_snapshot_v1`,
    snapshotV2: `${prefix}_${suffix}_snapshot_v2`,
    targetId: `${prefix}_${suffix}_v03`,
    userId: `${prefix}_${suffix}_user`,
  };
}

function sourcePayload(item: ReturnType<typeof makeCase>, version: number) {
  const groupSizes = item.suffix === "ready" ? [2, 1, 3] : [1, 2];
  const shots: Row[] = [];
  let order = 0;
  groupSizes.forEach((size, groupIndex) => {
    for (let shotIndex = 0; shotIndex < size; shotIndex += 1) {
      shots.push({
        orderIndex: order,
        groupName: `桥段 ${groupIndex + 1}`,
        shotNumber: String(order + 1),
        startTime: "",
        endTime: "",
        shotSize: "中景",
        cameraAngle: "平视",
        cameraMovement: "固定",
        visualContent: `TEST_ONLY ${item.suffix} 画面 ${order + 1}`,
        dialogue: "",
        voiceover: "",
        screenText: "",
        soundEffect: "",
        music: "",
        creativeComment: shotIndex === 0 ? `桥段 ${groupIndex + 1} 的创意作用` : "",
      });
      order += 1;
    }
  });
  const codes = [
    ...Array.from({ length: 9 }, (_, index) => `A${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `B${index + 1}`),
  ];
  return {
    id: item.sourceId,
    videoId: item.videoId,
    authorName: item.name,
    taxonomyVersion: "V0.2",
    workflowVersion: "REVERSE-WORKFLOW-V0.2",
    status: "SUBMITTED",
    revision: version,
    analysisTitle: `TEST_ONLY ${item.suffix} V${version} 标题`,
    commercialIntent: `TEST_ONLY ${item.suffix} 商业意图`,
    creativeTheme: `TEST_ONLY ${item.suffix} 创意母题`,
    synopsis: `TEST_ONLY ${item.suffix} 故事梗概`,
    thinkingChain: `TEST_ONLY ${item.suffix} 创意思维链`,
    shotCommentary: `TEST_ONLY ${item.suffix} 镜头点评`,
    summary: `TEST_ONLY ${item.suffix} 总结`,
    shots,
    fields: codes.map((code) => ({
      code,
      answer: code === "B2" ? `TEST_ONLY ${item.suffix} 故事参照`
        : code === "B3" ? `TEST_ONLY ${item.suffix} 故事原型`
          : `TEST_ONLY ${item.suffix} ${code} 答案`,
      evidence: `TEST_ONLY ${code} 依据`,
      source: "HUMAN_ORIGINAL",
    })),
    updatedAt: null,
  };
}

async function tableExists(db: DbClient, table: string) {
  const row = await db.prepare(`SELECT to_regclass(?) AS name`).bind(`public.${table}`)
    .first<{ name: string | null }>();
  return Boolean(row?.name);
}

async function businessFingerprint(db: DbClient) {
  const row = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM videos WHERE COALESCE(data_scope, 'BUSINESS') = 'BUSINESS') AS videos,
      (SELECT COUNT(*) FROM annotations a INNER JOIN videos v ON v.id = a.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS annotations,
      (SELECT COUNT(*) FROM annotation_snapshots s INNER JOIN videos v ON v.id = s.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS snapshots,
      (SELECT COUNT(*) FROM shots s INNER JOIN annotations a ON a.id = s.annotation_id
        INNER JOIN videos v ON v.id = a.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS shots,
      (SELECT COUNT(*) FROM field_answers f INNER JOIN annotations a ON a.id = f.annotation_id
        INNER JOIN videos v ON v.id = a.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS fields`,
  ).first<Row>();
  return JSON.stringify(row ?? {});
}

async function cleanup(db: DbClient) {
  const videoIds = Object.values(cases).map((item) => item.videoId);
  for (const videoId of videoIds) {
    const video = await db.prepare(`SELECT data_scope, test_run_id FROM videos WHERE id = ?`)
      .bind(videoId).first<{ data_scope: string; test_run_id: string | null }>();
    if (video && (video.data_scope !== "TEST_ONLY" || video.test_run_id !== runId)) {
      throw new Error("拒绝清理：目标不是当前 run id 的 TEST_ONLY 数据。");
    }
  }
  await db.withTransaction(async (tx) => {
    if (await tableExists(tx, "admin_data_operations")) {
      await tx.prepare(`DELETE FROM admin_data_operations WHERE operation_key LIKE ?`)
        .bind(`${config.operationKeyPrefix}%`).run();
    }
    await tx.prepare(`DELETE FROM audit_logs WHERE object_id LIKE ?`)
      .bind(`${config.operationKeyPrefix}%`).run();
    for (const item of Object.values(cases)) {
      await tx.prepare(
        `UPDATE annotations SET base_release_id = NULL, base_snapshot_id = NULL,
          source_public_snapshot_id = NULL, active_base_snapshot_id = NULL WHERE video_id = ?`,
      ).bind(item.videoId).run();
      await tx.prepare(`UPDATE annotation_snapshots SET base_release_id = NULL WHERE video_id = ?`)
        .bind(item.videoId).run();
      await tx.prepare(`DELETE FROM analysis_comments WHERE video_id = ?`).bind(item.videoId).run();
      await tx.prepare(`DELETE FROM analysis_revision_events WHERE video_id = ?`).bind(item.videoId).run();
      await tx.prepare(`DELETE FROM approved_analysis_releases WHERE video_id = ?`).bind(item.videoId).run();
      await tx.prepare(`DELETE FROM analysis_review_rounds WHERE video_id = ?`).bind(item.videoId).run();
      await tx.prepare(`DELETE FROM annotation_snapshots WHERE video_id = ?`).bind(item.videoId).run();
      await tx.prepare(
        `DELETE FROM field_answers WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
      ).bind(item.videoId).run();
      await tx.prepare(
        `DELETE FROM shots WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
      ).bind(item.videoId).run();
      await tx.prepare(
        `DELETE FROM shot_groups WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
      ).bind(item.videoId).run();
      await tx.prepare(
        `DELETE FROM annotation_creative_structures WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
      ).bind(item.videoId).run();
      await tx.prepare(`DELETE FROM annotations WHERE video_id = ?`).bind(item.videoId).run();
      await tx.prepare(
        `DELETE FROM videos WHERE id = ? AND data_scope = 'TEST_ONLY' AND test_run_id = ?`,
      ).bind(item.videoId, runId).run();
      if (item.hasUser) {
        await tx.prepare(`DELETE FROM users WHERE id = ? AND identity_key = ?`)
          .bind(item.userId, item.sourceIdentity).run();
      }
    }
  });
}

async function prepare(db: DbClient) {
  await cleanup(db);
  const now = new Date().toISOString();
  await db.withTransaction(async (tx) => {
    for (const item of Object.values(cases)) {
      if (item.hasUser) {
        await tx.prepare(
          `INSERT INTO users (
            id, wecom_corp_id, wecom_user_id, identity_key, display_name, status,
            last_login_at, last_synced_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.userId, `${prefix}_corp`, `${prefix}_${item.suffix}_wecom`, item.sourceIdentity,
          item.name, item.status, now, now, now, now,
        ).run();
      }
      await tx.prepare(
        `INSERT INTO videos (
          id, title, brand, description, tags_json, object_key, original_name,
          content_type, file_size, status, rights_confirmed, created_by_email,
          created_by_name, data_scope, test_run_id
        ) VALUES (?, ?, 'TEST_ONLY', 'TEST_ONLY 批量映射验证', '[]', ?, 'test.mp4',
          'video/mp4', 1, 'READY', 1, ?, 'TEST_ONLY 上传者', 'TEST_ONLY', ?)`,
      ).bind(
        item.videoId, `TEST_ONLY ${item.suffix} 作品`, `${prefix}/${item.suffix}.mp4`,
        `${prefix}_uploader`, runId,
      ).run();
      await tx.prepare(
        `INSERT INTO annotations (
          id, video_id, author_email, author_name, taxonomy_version, workflow_version,
          status, review_status, revision
        ) VALUES (?, ?, ?, ?, 'V0.2', 'REVERSE-WORKFLOW-V0.2', 'SUBMITTED', 'SUBMITTED', 2)`,
      ).bind(item.sourceId, item.videoId, item.sourceIdentity, item.name).run();
      const v1 = sourcePayload(item, 1);
      const v2 = sourcePayload(item, 2);
      const oldTime = new Date(Date.now() - 60_000).toISOString();
      await tx.prepare(
        `INSERT INTO annotation_snapshots (
          id, annotation_id, video_id, author_email, author_name, taxonomy_version,
          revision, version_number, payload_json, content_hash, workflow_status,
          created_at, submitted_at
        ) VALUES (?, ?, ?, ?, ?, 'V0.2', 1, 1, ?, ?, 'SUBMITTED', ?, ?)`,
      ).bind(
        item.snapshotV1, item.sourceId, item.videoId, item.sourceIdentity, item.name,
        JSON.stringify(v1), `${prefix}_${item.suffix}_hash_v1`, oldTime, oldTime,
      ).run();
      await tx.prepare(
        `INSERT INTO annotation_snapshots (
          id, annotation_id, video_id, author_email, author_name, taxonomy_version,
          revision, version_number, payload_json, content_hash, workflow_status,
          created_at, submitted_at
        ) VALUES (?, ?, ?, ?, ?, 'V0.2', 2, 2, ?, ?, 'SUBMITTED', ?, ?)`,
      ).bind(
        item.snapshotV2, item.sourceId, item.videoId, item.sourceIdentity, item.name,
        JSON.stringify(v2), `${prefix}_${item.suffix}_hash_v2`, now, now,
      ).run();
    }
    const item = cases.existing;
    await tx.prepare(
      `INSERT INTO annotations (
        id, video_id, author_email, author_name, taxonomy_version, workflow_version,
        status, review_status, revision, analysis_title
      ) VALUES (?, ?, ?, ?, 'V0.3-PILOT', 'REVERSE-WORKFLOW-V0.3.3',
        'DRAFT', 'DRAFT', 4, 'TEST_ONLY 已有人工 V0.3')`,
    ).bind(item.targetId, item.videoId, item.sourceIdentity, item.name).run();
  });
}

function candidateFor(
  preview: Awaited<ReturnType<typeof previewV02V03BatchMapping>>,
  item: ReturnType<typeof makeCase>,
) {
  const candidate = preview.candidates.find((entry) => entry.video.id === item.videoId);
  assert.ok(candidate, `缺少 ${item.suffix} 候选项`);
  return candidate;
}

async function expectMappingError(operation: () => Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof V02V03BatchMappingError && error.code === code);
}

async function targetState(db: DbClient, item: ReturnType<typeof makeCase>) {
  return (await db.prepare(
    `SELECT a.id, a.author_email, a.author_name, a.status, a.review_status, a.revision,
      a.analysis_title, a.source_snapshot_id,
      (SELECT COUNT(*) FROM shots WHERE annotation_id = a.id) AS shots,
      (SELECT COUNT(*) FROM shot_groups WHERE annotation_id = a.id) AS groups,
      (SELECT COUNT(*) FROM field_answers WHERE annotation_id = a.id) AS fields,
      (SELECT COUNT(*) FROM field_answers WHERE annotation_id = a.id AND source = 'SYSTEM_MAPPED') AS mapped_fields,
      (SELECT primary_creative_path FROM annotation_creative_structures WHERE annotation_id = a.id) AS primary_path,
      (SELECT mechanism_primary FROM annotation_creative_structures WHERE annotation_id = a.id) AS mechanism_primary,
      (SELECT story_reference_type FROM annotation_creative_structures WHERE annotation_id = a.id) AS story_reference,
      (SELECT story_archetype FROM annotation_creative_structures WHERE annotation_id = a.id) AS story_archetype
    FROM annotations a
    WHERE a.video_id = ? AND a.author_email = ? AND a.taxonomy_version = 'V0.3-PILOT'
      AND a.deleted_at IS NULL`,
  ).bind(item.videoId, item.sourceIdentity).first<Row>()) ?? null;
}

const db = getDbClient();
await applySchema();
const businessBefore = await businessFingerprint(db);

try {
  await prepare(db);
  let preview = await previewV02V03BatchMapping(db, config);
  assert.equal(preview.summary.sourcePairs, 5);
  assert.equal(preview.summary.ready, 2);
  assert.equal(preview.summary.skippedExisting, 1);
  assert.equal(preview.summary.blocked, 2);
  const ready = candidateFor(preview, cases.ready);
  assert.equal(ready.status, "READY");
  assert.equal(ready.source.snapshotVersionNumber, 2);
  assert.equal(ready.source.groups, 3);
  assert.equal(ready.source.shots, 6);
  assert.equal(ready.source.legacyFields, 19);
  assert.equal(ready.author.currentName, cases.ready.name);
  assert.equal(candidateFor(preview, cases.existing).status, "SKIP_EXISTING");
  assert.match(candidateFor(preview, cases.missing).reasons.join("；"), /未绑定/);
  assert.match(candidateFor(preview, cases.disabled).reasons.join("；"), /已停用/);

  await expectMappingError(() => applyV02V03BatchCandidate({
    actor, candidateKey: ready.candidateKey, candidateToken: ready.candidateToken!,
    confirmation: "wrong", db, config,
  }), "CONFIRMATION_MISMATCH");
  await expectMappingError(() => applyV02V03BatchCandidate({
    actor, candidateKey: ready.candidateKey, candidateToken: "stale",
    confirmation: config.confirmation, db, config,
  }), "PREVIEW_STALE");

  const result = await applyV02V03BatchCandidate({
    actor, candidateKey: ready.candidateKey, candidateToken: ready.candidateToken!,
    confirmation: config.confirmation, db, config,
  });
  assert.equal(result.authorName, cases.ready.name);
  assert.deepEqual(result.mapped, { shots: 6, groups: 3, legacyFields: 19 });
  const mapped = await targetState(db, cases.ready);
  assert.ok(mapped);
  assert.equal(mapped.author_email, cases.ready.sourceIdentity);
  assert.equal(mapped.author_name, cases.ready.name);
  assert.equal(mapped.status, "DRAFT");
  assert.equal(mapped.review_status, "DRAFT");
  assert.equal(Number(mapped.revision), 1);
  assert.equal(mapped.analysis_title, "TEST_ONLY ready V2 标题");
  assert.equal(mapped.source_snapshot_id, cases.ready.snapshotV2);
  assert.equal(Number(mapped.shots), 6);
  assert.equal(Number(mapped.groups), 3);
  assert.equal(Number(mapped.fields), 19);
  assert.equal(Number(mapped.mapped_fields), 19);
  assert.equal(mapped.primary_path, "");
  assert.equal(mapped.mechanism_primary, "");
  assert.equal(mapped.story_reference, "TEST_ONLY ready 故事参照");
  assert.equal(mapped.story_archetype, "TEST_ONLY ready 故事原型");

  await db.prepare(`UPDATE annotations SET analysis_title = 'TEST_ONLY 用户后续修订' WHERE id = ?`)
    .bind(String(mapped.id)).run();
  const replay = await applyV02V03BatchCandidate({
    actor, candidateKey: ready.candidateKey, candidateToken: ready.candidateToken!,
    confirmation: config.confirmation, db, config,
  });
  assert.equal(replay.alreadyApplied, true);
  assert.equal((await targetState(db, cases.ready))?.analysis_title, "TEST_ONLY 用户后续修订");

  preview = await previewV02V03BatchMapping(db, config);
  assert.equal(candidateFor(preview, cases.ready).status, "COMPLETED");
  const rollback = candidateFor(preview, cases.rollback);
  assert.equal(rollback.status, "READY");
  await expectMappingError(() => applyV02V03BatchCandidate({
    actor, candidateKey: rollback.candidateKey, candidateToken: rollback.candidateToken!,
    confirmation: config.confirmation, db, config, failAfterInsertForTest: true,
  }), "TEST_ROLLBACK");
  assert.equal(await targetState(db, cases.rollback), null);
  const rollbackLedger = await db.prepare(
    `SELECT status FROM admin_data_operations WHERE operation_key LIKE ?`,
  ).bind(`${config.operationKeyPrefix}${rollback.candidateKey}`).first<Row>();
  assert.equal(rollbackLedger, null);
  assert.equal((await targetState(db, cases.existing))?.analysis_title, "TEST_ONLY 已有人工 V0.3");
} finally {
  await cleanup(db);
}

const businessAfter = await businessFingerprint(db);
assert.equal(businessAfter, businessBefore, "TEST_ONLY 验收不得改变正式业务数据指纹");
console.log(JSON.stringify({
  ok: true,
  runId,
  covered: [
    "latest-public-version", "same-active-author", "existing-target-skip",
    "missing-author-block", "disabled-author-block", "wrong-confirmation",
    "stale-preview", "mapped-lineage-and-counts", "v03-semantics-left-blank",
    "idempotent-replay", "post-edit-preserved", "transaction-rollback",
    "business-fingerprint",
  ],
  businessFingerprintUnchanged: true,
  cleaned: true,
}, null, 2));
