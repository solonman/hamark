import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applySchema } from "../db/bootstrap.ts";
import { getDbClient, type DbClient } from "../db/index.ts";
import type { CurrentUser } from "../lib/current-user.ts";
import {
  applyWelcomeHomeMapping,
  previewWelcomeHomeMapping,
  WelcomeHomeMappingError,
  type WelcomeHomeMappingConfig,
} from "../lib/welcome-home-production-mapping.ts";

const rawRunId = process.env.WELCOME_HOME_TEST_RUN_ID || randomUUID().slice(0, 8);
if (!/^[a-z0-9_-]{3,40}$/i.test(rawRunId)) throw new Error("TEST_ONLY run id 格式无效。");
const runId = rawRunId.toLowerCase();
const prefix = `test_only_welcome_${runId}`;
const ids = {
  video: `${prefix}_video`,
  source: `${prefix}_source`,
  target: `${prefix}_target`,
  sourceSnapshotV1: `${prefix}_source_snapshot_v1`,
  sourceSnapshot: `${prefix}_source_snapshot`,
};
const config: WelcomeHomeMappingConfig = {
  videoId: ids.video,
  operationKey: `TEST_ONLY_WELCOME_HOME_${runId}`,
  sourceAuthorName: `TEST_ONLY 来源 ${runId}`,
  targetAuthorName: `TEST_ONLY 目标 ${runId}`,
  sourceSnapshotVersionNumber: 2,
  confirmation: `TEST_ONLY_CONFIRM_${runId}`,
  dataScope: "TEST_ONLY",
};
const actor: CurrentUser = {
  id: `${prefix}_actor`,
  identityKey: `${prefix}_admin_identity`,
  displayName: config.targetAuthorName,
  avatarUrl: null,
  email: null,
  departments: [],
};

async function businessFingerprint(db: DbClient) {
  const result = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM videos WHERE COALESCE(data_scope, 'BUSINESS') = 'BUSINESS') AS videos,
      (SELECT COUNT(*) FROM annotations a INNER JOIN videos v ON v.id = a.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS annotations,
      (SELECT COUNT(*) FROM annotation_snapshots s INNER JOIN videos v ON v.id = s.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS snapshots,
      (SELECT COUNT(*) FROM approved_analysis_releases r INNER JOIN videos v ON v.id = r.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS releases,
      (SELECT COUNT(*) FROM analysis_review_rounds r INNER JOIN videos v ON v.id = r.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS review_rounds,
      (SELECT COUNT(*) FROM analysis_comments c INNER JOIN videos v ON v.id = c.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS comments,
      (SELECT COUNT(*) FROM analysis_revision_events e INNER JOIN videos v ON v.id = e.video_id
        WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS revision_events`,
  ).first<Record<string, unknown>>();
  return JSON.stringify(result ?? {});
}

async function cleanup(db: DbClient) {
  const video = await db.prepare(`SELECT data_scope, test_run_id FROM videos WHERE id = ?`)
    .bind(ids.video).first<{ data_scope: string; test_run_id: string | null }>();
  if (video && (video.data_scope !== "TEST_ONLY" || video.test_run_id !== runId)) {
    throw new Error("拒绝清理：目标不是当前 run id 的 TEST_ONLY 数据。");
  }
  await db.withTransaction(async (tx) => {
    if (await tableExists(tx, "admin_data_operations")) {
      await tx.prepare(`DELETE FROM admin_data_operations WHERE operation_key LIKE ?`)
        .bind(`TEST_ONLY_WELCOME_HOME_${runId}%`).run();
    }
    await tx.prepare(`DELETE FROM audit_logs WHERE object_id LIKE ?`).bind(`TEST_ONLY_WELCOME_HOME_${runId}%`).run();
    await tx.prepare(`DELETE FROM analysis_comments WHERE video_id = ?`).bind(ids.video).run();
    await tx.prepare(`DELETE FROM analysis_revision_events WHERE video_id = ?`).bind(ids.video).run();
    await tx.prepare(
      `UPDATE annotations SET base_release_id = NULL, base_snapshot_id = NULL,
        source_public_snapshot_id = NULL, active_base_snapshot_id = NULL WHERE video_id = ?`,
    ).bind(ids.video).run();
    await tx.prepare(`UPDATE annotation_snapshots SET base_release_id = NULL WHERE video_id = ?`)
      .bind(ids.video).run();
    await tx.prepare(`DELETE FROM approved_analysis_releases WHERE video_id = ?`).bind(ids.video).run();
    await tx.prepare(`DELETE FROM analysis_review_rounds WHERE video_id = ?`).bind(ids.video).run();
    await tx.prepare(`DELETE FROM annotation_snapshots WHERE video_id = ?`).bind(ids.video).run();
    await tx.prepare(
      `DELETE FROM field_answers WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
    ).bind(ids.video).run();
    await tx.prepare(
      `DELETE FROM shots WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
    ).bind(ids.video).run();
    await tx.prepare(
      `DELETE FROM shot_groups WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
    ).bind(ids.video).run();
    await tx.prepare(
      `DELETE FROM annotation_creative_structures WHERE annotation_id IN (SELECT id FROM annotations WHERE video_id = ?)`,
    ).bind(ids.video).run();
    await tx.prepare(`DELETE FROM annotations WHERE video_id = ?`).bind(ids.video).run();
    await tx.prepare(
      `DELETE FROM videos WHERE id = ? AND data_scope = 'TEST_ONLY' AND test_run_id = ?`,
    ).bind(ids.video, runId).run();
  });
}

async function tableExists(db: DbClient, table: string) {
  const result = await db.prepare(`SELECT to_regclass(?) AS name`).bind(`public.${table}`)
    .first<{ name: string | null }>();
  return Boolean(result?.name);
}

async function prepare(db: DbClient) {
  await cleanup(db);
  await db.withTransaction(async (tx) => {
    await tx.prepare(
      `INSERT INTO videos (
        id, title, brand, description, tags_json, object_key, original_name,
        content_type, file_size, status, rights_confirmed, created_by_email,
        created_by_name, data_scope, test_run_id
      ) VALUES (?, 'TEST_ONLY 欢迎回家映射', 'TEST_ONLY', '隔离数据操作验收',
        '[]', ?, 'test.mp4', 'video/mp4', 1, 'READY', 1, ?, ?, 'TEST_ONLY', ?)`,
    ).bind(ids.video, `${prefix}/test.mp4`, `${prefix}_uploader`, "TEST_ONLY 上传者", runId).run();
    await tx.prepare(
      `INSERT INTO annotations (
        id, video_id, author_email, author_name, taxonomy_version, workflow_version,
        status, review_status, revision, analysis_title, commercial_intent,
        creative_theme, synopsis, thinking_chain, shot_commentary, summary
      ) VALUES (?, ?, ?, ?, 'V0.2', 'REVERSE-WORKFLOW-V0.2', 'DRAFT', 'DRAFT', 10,
        'V0.2 原文标题', 'V0.2 商业意图', 'V0.2 创意母题', 'V0.2 故事梗概',
        'V0.2 创意思维链', 'V0.2 镜头点评', 'V0.2 总结')`,
    ).bind(ids.source, ids.video, `${prefix}_source_identity`, config.sourceAuthorName).run();
    const groupEnds = [4, 8, 11, 14, 17, 20, 23];
    const sourceShots: Row[] = [];
    for (let index = 0; index < 23; index += 1) {
      const groupIndex = groupEnds.findIndex((end) => index < end);
      const creativeComment = index === (groupEnds[groupIndex - 1] ?? 0)
        ? `桥段作用 ${groupIndex + 1}` : "";
      sourceShots.push({
        id: `${prefix}_source_shot_${index}`,
        orderIndex: index,
        groupName: `桥段 ${groupIndex + 1}`,
        shotNumber: String(index + 1),
        startTime: "",
        endTime: "",
        shotSize: "中景",
        cameraAngle: "平视",
        cameraMovement: "固定",
        visualContent: `TEST_ONLY 画面 ${index + 1}`,
        dialogue: "",
        voiceover: "",
        screenText: "",
        soundEffect: "",
        music: "",
        creativeComment,
      });
      await tx.prepare(
        `INSERT INTO shots (
          id, annotation_id, order_index, group_name, shot_number, start_time,
          end_time, shot_size, camera_angle, camera_movement, visual_content,
          dialogue, voiceover, screen_text, sound_effect, music, creative_comment
        ) VALUES (?, ?, ?, ?, ?, '', '', '中景', '平视', '固定', ?, '', '', '', '', '', ?)`,
      ).bind(
        `${prefix}_source_shot_${index}`, ids.source, index, `桥段 ${groupIndex + 1}`,
        String(index + 1), `TEST_ONLY 画面 ${index + 1}`,
        creativeComment,
      ).run();
    }
    const codes = [
      ...Array.from({ length: 9 }, (_, index) => `A${index + 1}`),
      ...Array.from({ length: 10 }, (_, index) => `B${index + 1}`),
    ];
    const sourceFields: Row[] = [];
    for (const code of codes) {
      const answer = code === "B2" ? "归家叙事" : code === "B3" ? "离开与归来" : `${code} TEST_ONLY 答案`;
      sourceFields.push({ code, answer, evidence: "TEST_ONLY 依据", source: "HUMAN_ORIGINAL" });
      await tx.prepare(
        `INSERT INTO field_answers (id, annotation_id, field_code, answer, evidence, source)
        VALUES (?, ?, ?, ?, 'TEST_ONLY 依据', 'HUMAN_ORIGINAL')`,
      ).bind(`${prefix}_source_field_${code}`, ids.source, code, answer).run();
    }
    const sourcePayload = JSON.stringify({
      id: ids.source,
      videoId: ids.video,
      authorName: config.sourceAuthorName,
      taxonomyVersion: "V0.2",
      workflowVersion: "REVERSE-WORKFLOW-V0.2",
      status: "SUBMITTED",
      revision: 7,
      analysisTitle: "V0.2 公开版本 V2 标题",
      commercialIntent: "V0.2 商业意图",
      creativeTheme: "V0.2 创意母题",
      synopsis: "V0.2 故事梗概",
      thinkingChain: "V0.2 创意思维链",
      shotCommentary: "V0.2 镜头点评",
      summary: "V0.2 总结",
      shots: sourceShots,
      fields: sourceFields,
      updatedAt: null,
    });
    const v1At = new Date(Date.now() - 60_000).toISOString();
    const v2At = new Date().toISOString();
    await tx.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name, taxonomy_version,
        revision, version_number, payload_json, content_hash, workflow_status,
        created_at, submitted_at
      ) VALUES (?, ?, ?, ?, ?, 'V0.2', 6, 1, ?, ?, 'SUBMITTED', ?, ?)`,
    ).bind(
      ids.sourceSnapshotV1, ids.source, ids.video, `${prefix}_source_identity`, config.sourceAuthorName,
      sourcePayload, `${prefix}_source_hash_v1`, v1At, v1At,
    ).run();
    await tx.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name, taxonomy_version,
        revision, version_number, payload_json, content_hash, workflow_status,
        created_at, submitted_at
      ) VALUES (?, ?, ?, ?, ?, 'V0.2', 7, 2, ?, ?, 'SUBMITTED', ?, ?)`,
    ).bind(
      ids.sourceSnapshot, ids.source, ids.video, `${prefix}_source_identity`, config.sourceAuthorName,
      sourcePayload, `${prefix}_source_hash_v2`, v2At, v2At,
    ).run();
  });
}

async function targetState(db: DbClient) {
  const row = await db.prepare(
    `SELECT a.id, a.status, a.review_status, a.revision, a.analysis_title, a.source_snapshot_id,
      (SELECT COUNT(*) FROM shots WHERE annotation_id = a.id) AS shots,
      (SELECT COUNT(*) FROM shot_groups WHERE annotation_id = a.id) AS groups,
      (SELECT COUNT(*) FROM field_answers WHERE annotation_id = a.id) AS fields
    FROM annotations a
    WHERE a.video_id = ? AND a.author_email = ? AND a.taxonomy_version = 'V0.3-PILOT'`,
  ).bind(ids.video, actor.identityKey).first<Record<string, unknown>>();
  return row ?? {};
}

async function expectMappingError(operation: () => Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof WelcomeHomeMappingError && error.code === code);
}

const db = getDbClient();
await applySchema();
const businessBefore = await businessFingerprint(db);

try {
  await prepare(db);
  let preview = await previewWelcomeHomeMapping(actor, db, config);
  assert.equal(preview.ready, true, preview.reasons.join("；"));
  assert.deepEqual(preview.mapping, {
    shots: 23,
    groups: 7,
    legacyFields: 19,
    primaryCreativePath: "LOVE",
    storyReferenceTypePresent: true,
    storyArchetypePresent: true,
    explanatoryFieldsRemainBlank: true,
  });

  await db.prepare(`UPDATE annotation_snapshots SET author_name = 'TEST_ONLY 错误来源' WHERE annotation_id = ?`)
    .bind(ids.source).run();
  assert.equal((await previewWelcomeHomeMapping(actor, db, config)).ready, false, "跨来源必须被阻断");
  await db.prepare(`UPDATE annotation_snapshots SET author_name = ? WHERE annotation_id = ?`)
    .bind(config.sourceAuthorName, ids.source).run();

  await db.prepare(
    `INSERT INTO annotations (
      id, video_id, author_email, author_name, taxonomy_version, workflow_version,
      status, review_status, revision
    ) VALUES (?, ?, ?, ?, 'V0.3-PILOT', 'REVERSE-WORKFLOW-V0.3.3', 'DRAFT', 'DRAFT', 1)`,
  ).bind(ids.target, ids.video, actor.identityKey, actor.displayName).run();
  assert.equal(
    (await previewWelcomeHomeMapping(actor, db, config)).ready,
    false,
    "已有目标工作稿必须被阻断",
  );
  await db.prepare(`DELETE FROM annotations WHERE id = ?`).bind(ids.target).run();

  const sourceSnapshotBefore = await db.prepare(
    `SELECT payload_json, content_hash FROM annotation_snapshots WHERE id = ?`,
  ).bind(ids.sourceSnapshot).first<{ payload_json: string; content_hash: string }>();
  if (!sourceSnapshotBefore) throw new Error("TEST_ONLY 来源快照缺失");
  const badPayload = JSON.parse(sourceSnapshotBefore.payload_json) as { shots: Row[] };
  badPayload.shots.push({ orderIndex: 23, groupName: "错误桥段", visualContent: "错误数量" });
  await db.prepare(`UPDATE annotation_snapshots SET payload_json = ? WHERE id = ?`)
    .bind(JSON.stringify(badPayload), ids.sourceSnapshot).run();
  assert.equal(
    (await previewWelcomeHomeMapping(actor, db, config)).ready,
    false,
    "不可变来源快照的错误镜头数必须被阻断",
  );
  await db.prepare(`UPDATE annotation_snapshots SET payload_json = ?, content_hash = ? WHERE id = ?`)
    .bind(sourceSnapshotBefore.payload_json, sourceSnapshotBefore.content_hash, ids.sourceSnapshot).run();

  await db.prepare(
    `INSERT INTO annotation_snapshots (
      id, annotation_id, video_id, author_email, author_name, taxonomy_version,
      revision, version_number, payload_json, content_hash, workflow_status, submitted_at
    ) SELECT ?, annotation_id, video_id, author_email, author_name, taxonomy_version,
      8, 3, payload_json, ?, workflow_status, CURRENT_TIMESTAMP
    FROM annotation_snapshots WHERE id = ?`,
  ).bind(`${prefix}_source_snapshot_v3`, `${prefix}_source_hash_v3`, ids.sourceSnapshot).run();
  assert.equal(
    (await previewWelcomeHomeMapping(actor, db, config)).ready,
    false,
    "来源出现 V3 时必须被阻断",
  );
  await db.prepare(`DELETE FROM annotation_snapshots WHERE id = ?`)
    .bind(`${prefix}_source_snapshot_v3`).run();

  preview = await previewWelcomeHomeMapping(actor, db, config);
  assert.equal(preview.ready, true, preview.reasons.join("；"));
  await expectMappingError(() => applyWelcomeHomeMapping({
    actor, confirmation: "wrong", previewToken: preview.previewToken!, db, config,
  }), "CONFIRMATION_MISMATCH");
  await expectMappingError(() => applyWelcomeHomeMapping({
    actor, confirmation: config.confirmation, previewToken: "stale", db, config,
  }), "PREVIEW_STALE");

  const concurrent = await Promise.all([
    applyWelcomeHomeMapping({ actor, confirmation: config.confirmation, previewToken: preview.previewToken!, db, config }),
    applyWelcomeHomeMapping({ actor, confirmation: config.confirmation, previewToken: preview.previewToken!, db, config }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.alreadyApplied).sort(), [false, true]);
  const mapped = await targetState(db);
  assert.equal(mapped.status, "DRAFT");
  assert.equal(mapped.review_status, "DRAFT");
  assert.equal(Number(mapped.revision), 1);
  assert.equal(mapped.source_snapshot_id, ids.sourceSnapshot);
  assert.equal(Number(mapped.shots), 23);
  assert.equal(Number(mapped.groups), 7);
  assert.equal(Number(mapped.fields), 19);

  await db.prepare(
    `UPDATE annotations SET analysis_title = 'TEST_ONLY 用户后续修订'
    WHERE video_id = ? AND author_email = ? AND taxonomy_version = 'V0.3-PILOT'`,
  ).bind(ids.video, actor.identityKey).run();
  const replay = await applyWelcomeHomeMapping({
    actor, confirmation: config.confirmation, previewToken: preview.previewToken!, db, config,
  });
  assert.equal(replay.alreadyApplied, true);
  assert.equal((await targetState(db)).analysis_title, "TEST_ONLY 用户后续修订", "重放不得覆盖后续修订");

  await cleanup(db);
  const rollbackConfig = { ...config, operationKey: `${config.operationKey}_ROLLBACK` };
  await prepare(db);
  const rollbackPreview = await previewWelcomeHomeMapping(actor, db, rollbackConfig);
  const beforeRollback = await targetState(db);
  await expectMappingError(() => applyWelcomeHomeMapping({
    actor,
    confirmation: rollbackConfig.confirmation,
    previewToken: rollbackPreview.previewToken!,
    db,
    config: rollbackConfig,
    failAfterMappingForTest: true,
  }), "TEST_ROLLBACK");
  assert.deepEqual(await targetState(db), beforeRollback, "强制异常后目标工作稿必须完整回滚");
  const rolledBackLedger = await db.prepare(
    `SELECT status FROM admin_data_operations WHERE operation_key = ?`,
  ).bind(rollbackConfig.operationKey).first<Row>();
  assert.equal(rolledBackLedger, null, "回滚操作不得留下伪完成账本");
} finally {
  await cleanup(db);
}

const businessAfter = await businessFingerprint(db);
assert.equal(businessAfter, businessBefore, "TEST_ONLY 验收不得改变正式业务数据指纹");
console.log(JSON.stringify({
  ok: true,
  runId,
  covered: [
    "cross-source", "existing-target", "snapshot-count", "source-V3", "wrong-confirmation",
    "stale-preview", "concurrent-replay", "post-edit-replay", "transaction-rollback",
    "business-fingerprint",
  ],
  businessFingerprintUnchanged: true,
  cleaned: true,
}, null, 2));

type Row = Record<string, unknown>;
