import assert from "node:assert/strict";
import { applySchema } from "../db/bootstrap.ts";
import { getDbClient, type DbClient } from "../db/index.ts";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import { sha256Text } from "../lib/review-workflow.ts";
import { V03_VOCABULARY_VERSION } from "../lib/taxonomy-v0.3.ts";
import type { AnnotationDraft, ShotDraft, ShotGroupDraft } from "../lib/types.ts";

const rawRunId = process.env.V033_TEST_RUN_ID || "browser_acceptance";
if (!/^[a-z0-9_-]{3,40}$/i.test(rawRunId)) throw new Error("V033_TEST_RUN_ID 格式无效。");
const runId = rawRunId.toLowerCase();
const prefix = `test_only_v033_${runId}`;
const ids = {
  video: `${prefix}_video`,
  annotation: `${prefix}_annotation`,
  group: `${prefix}_group_1`,
  shot1: `${prefix}_shot_1`,
  shot2: `${prefix}_shot_2`,
  public1: `${prefix}_snapshot_public_1`,
  approved1: `${prefix}_snapshot_approved_1`,
  public2: `${prefix}_snapshot_public_2`,
  approved2: `${prefix}_snapshot_approved_2`,
  round1: `${prefix}_review_round_1`,
  round2: `${prefix}_review_round_2`,
  release1: `${prefix}_release_1`,
  release2: `${prefix}_release_2`,
};

function makePayload(revision: number, label: string): AnnotationDraft {
  const group: ShotGroupDraft = {
    id: ids.group,
    orderIndex: 0,
    title: "TEST_ONLY 回家桥段",
    primaryRole: "建立人物／关系",
    auxiliaryRoles: ["累积情感"],
    customRole: "",
    note: "从离开到归来，用于验收桥段联合修订。",
  };
  const shots: ShotDraft[] = [
    {
      id: ids.shot1, orderIndex: 0, groupName: group.title, shotNumber: "1",
      startTime: "00:00", endTime: "00:04", shotSize: "全景", cameraAngle: "平视",
      cameraMovement: "固定", visualContent: "人物拖着行李离开家门。",
      dialogue: "", voiceover: "我以为这只是一次普通的出发。",
      screenText: "出发", soundEffect: "门轴声", music: "低声钢琴",
      creativeComment: "建立离开的原始预期。", shotGroupId: ids.group,
    },
    {
      id: ids.shot2, orderIndex: 1, groupName: group.title, shotNumber: "2",
      startTime: "00:04", endTime: "00:09", shotSize: "中景", cameraAngle: "平视",
      cameraMovement: "缓慢推进", visualContent: "人物回到家门，家人迎上前。",
      dialogue: "欢迎回家。", voiceover: "", screenText: "WELCOME HOME",
      soundEffect: "脚步声", music: "旋律抬升", creativeComment: "用归来重释出发。", shotGroupId: ids.group,
    },
  ];
  const payload = emptyAnnotation(ids.video, "TEST_ONLY 作者", "V0.3-PILOT");
  payload.id = ids.annotation;
  payload.revision = revision;
  payload.status = "SUBMITTED";
  payload.reviewStatus = "APPROVED";
  payload.analysisTitle = `TEST_ONLY V0.3.3 验收作业 ${label}`;
  payload.commercialIntent = "建立品牌与回家情感之间的连接。";
  payload.creativeTheme = "每一次出发都指向回家。";
  payload.synopsis = "人物离家远行，最终带着经历回到家人身边。";
  payload.thinkingChain = "从移动出行的功能，转向出发与归来的情感价值。";
  payload.summary = "以前后对照和情感累积完成品牌落点。";
  payload.shotCommentary = payload.summary;
  payload.shotGroups = [group];
  payload.shots = shots;
  payload.creativeStructure = {
    ...payload.creativeStructure!,
    vocabularyVersion: V03_VOCABULARY_VERSION,
    creativeButton: "把出发改写为回家的开始。",
    mechanismStatement: "结尾的归来使开场的离开获得新意义。",
    mechanismPrimary: "反转重释",
    mechanismAuxiliary: ["隐喻转译"],
    creativeRealizationPath: "先建立离开，再累积思念，最后以归来重释出发。",
    realizationSkeleton: "先建立离开，再累积思念，最后以归来重释出发。",
    brandProductLanding: "产品成为出发和回家之间的载体。",
    storyReferenceType: "归家叙事",
    storyArchetype: "离开与归来",
    primaryCreativePath: "LOVE",
    auxiliaryCreativePaths: ["INTERESTING"],
    compositeStateReason: "情感路径承重，预期重释增强。",
    formationPrimary: "BEFORE_AFTER_CONTRAST",
    formationAuxiliary: ["CROSS_GROUP_ACCUMULATION"],
    formationStatement: "前后对照为主，情感在过程中累积。",
    formationRelatedGroupIds: [],
    creativeCarriers: "家门、行李与归来的拥抱。",
    establishmentConditions: "离开与归来的镜头必须形成明确对照。",
    strengthSources: "前后意义变化与音乐抬升。",
    creativeGrade: "A",
    creativeGradeReason: "测试夹具固定值，不用于业务评价。",
    mainPathPayload: {
      emotionalBase: "家人关系", emotionalAccumulation: "离开与思念逐步累积",
      emotionalGap: "空间距离", emotionalRelease: "归来拥抱", loveMainCarrier: "家门",
    },
    auxiliaryPathNotes: { INTERESTING: "结尾重释开场的出发。" },
  };
  payload.baseReleaseId = ids.release2;
  payload.baseSnapshotId = ids.approved2;
  payload.sourcePublicSnapshotId = ids.public2;
  payload.baseReleaseNumber = 2;
  return payload;
}

async function businessFingerprint(db: DbClient) {
  const row = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM videos WHERE COALESCE(data_scope, 'BUSINESS') = 'BUSINESS') AS videos,
      (SELECT COUNT(*) FROM annotation_snapshots s INNER JOIN videos v ON v.id = s.video_id WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS snapshots,
      (SELECT COUNT(*) FROM approved_analysis_releases r INNER JOIN videos v ON v.id = r.video_id WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS releases,
      (SELECT COUNT(*) FROM analysis_revision_events e INNER JOIN videos v ON v.id = e.video_id WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS revisions`,
  ).first<Record<string, number>>();
  return JSON.stringify(row ?? {});
}

async function cleanup(db: DbClient) {
  const video = await db.prepare(`SELECT id, data_scope, test_run_id FROM videos WHERE id = ?`)
    .bind(ids.video).first<{ id: string; data_scope: string; test_run_id: string | null }>();
  if (video && (video.data_scope !== "TEST_ONLY" || video.test_run_id !== runId)) {
    throw new Error("拒绝清理：目标不是当前 run id 的 TEST_ONLY 夹具。");
  }
  await db.withTransaction(async (transaction) => {
    await transaction.prepare(
      `DELETE FROM audit_logs WHERE
        object_id IN (SELECT id FROM analysis_revision_events WHERE video_id = ?)
        OR object_id IN (SELECT change_set_id FROM analysis_revision_events WHERE video_id = ? AND change_set_id IS NOT NULL)
        OR object_id IN (SELECT id FROM analysis_review_rounds WHERE video_id = ?)
        OR object_id IN (SELECT id FROM approved_analysis_releases WHERE video_id = ?)
        OR object_id IN (SELECT id FROM annotation_snapshots WHERE video_id = ?)
        OR object_id IN (?, ?)`,
    ).bind(ids.video, ids.video, ids.video, ids.video, ids.video, ids.video, ids.annotation).run();
    await transaction.prepare(`DELETE FROM analysis_comments WHERE video_id = ?`).bind(ids.video).run();
    await transaction.prepare(`DELETE FROM analysis_revision_events WHERE video_id = ?`).bind(ids.video).run();
    await transaction.prepare(
      `UPDATE annotations SET base_release_id = NULL, base_snapshot_id = NULL,
        source_public_snapshot_id = NULL, active_base_snapshot_id = NULL WHERE id = ?`,
    ).bind(ids.annotation).run();
    await transaction.prepare(
      `UPDATE annotation_snapshots SET base_release_id = NULL WHERE video_id = ?`,
    ).bind(ids.video).run();
    await transaction.prepare(`DELETE FROM approved_analysis_releases WHERE video_id = ?`).bind(ids.video).run();
    await transaction.prepare(`DELETE FROM analysis_review_rounds WHERE video_id = ?`).bind(ids.video).run();
    await transaction.prepare(`DELETE FROM annotation_snapshots WHERE video_id = ?`).bind(ids.video).run();
    await transaction.prepare(`DELETE FROM field_answers WHERE annotation_id = ?`).bind(ids.annotation).run();
    await transaction.prepare(`DELETE FROM shots WHERE annotation_id = ?`).bind(ids.annotation).run();
    await transaction.prepare(`DELETE FROM shot_groups WHERE annotation_id = ?`).bind(ids.annotation).run();
    await transaction.prepare(`DELETE FROM annotation_creative_structures WHERE annotation_id = ?`).bind(ids.annotation).run();
    await transaction.prepare(`DELETE FROM annotations WHERE id = ? AND video_id = ?`).bind(ids.annotation, ids.video).run();
    await transaction.prepare(`DELETE FROM videos WHERE id = ? AND data_scope = 'TEST_ONLY' AND test_run_id = ?`).bind(ids.video, runId).run();
  });
}

async function prepare(db: DbClient) {
  await cleanup(db);
  const public1 = makePayload(1, "V1");
  const approved1 = makePayload(2, "R1");
  const public2 = makePayload(3, "V2");
  const approved2 = makePayload(4, "R2");
  const draft = makePayload(5, "待提交");
  draft.status = "DRAFT";
  draft.reviewStatus = "DRAFT";
  const sourceMedia = await db.prepare(
    `SELECT object_key, thumbnail_key, original_name, content_type, file_size
    FROM videos WHERE COALESCE(data_scope, 'BUSINESS') = 'BUSINESS' AND status = 'READY'
    ORDER BY created_at ASC LIMIT 1`,
  ).first<{ object_key: string; thumbnail_key: string | null; original_name: string; content_type: string; file_size: number }>();
  await db.withTransaction(async (transaction) => {
    await transaction.prepare(
      `INSERT INTO videos (id, title, brand, description, tags_json, object_key,
        thumbnail_key, original_name, content_type, file_size, status, rights_confirmed,
        created_by_email, created_by_name, data_scope, test_run_id)
      VALUES (?, 'TEST_ONLY V0.3.3 验收作品', 'TEST_ONLY', '仅用于本机隔离验收。',
        '["TEST_ONLY","V0.3.3"]', ?, ?, ?, ?, ?, ?, 1, 'reviewer@reverse.local',
        'TEST_ONLY 作者', 'TEST_ONLY', ?)`,
    ).bind(
      ids.video,
      sourceMedia?.object_key ?? `${prefix}/missing.mp4`,
      sourceMedia?.thumbnail_key ?? null,
      sourceMedia?.original_name ?? "test-only.mp4",
      sourceMedia?.content_type ?? "video/mp4",
      Number(sourceMedia?.file_size ?? 0),
      sourceMedia ? "READY" : "FAILED",
      runId,
    ).run();
    await transaction.prepare(
      `INSERT INTO annotations (
        id, video_id, author_email, author_name, taxonomy_version, workflow_version,
        status, review_status, revision, analysis_title, commercial_intent,
        creative_theme, synopsis, thinking_chain, shot_commentary, summary
      ) VALUES (?, ?, 'reviewer@reverse.local', 'TEST_ONLY 作者', 'V0.3-PILOT',
        'REVERSE-WORKFLOW-V0.3-PILOT', 'DRAFT', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(ids.annotation, ids.video, draft.revision, draft.analysisTitle, draft.commercialIntent,
      draft.creativeTheme, draft.synopsis, draft.thinkingChain, draft.shotCommentary,
      draft.summary).run();
    const group = draft.shotGroups![0];
    await transaction.prepare(
      `INSERT INTO shot_groups (id, annotation_id, order_index, title, primary_role_id,
        primary_role_name_snapshot, auxiliary_roles_json, custom_role, note)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(group.id, ids.annotation, group.title, group.primaryRole, group.primaryRole,
      JSON.stringify(group.auxiliaryRoles), group.customRole, group.note).run();
    for (const shot of draft.shots) {
      await transaction.prepare(
        `INSERT INTO shots (id, annotation_id, order_index, group_name, shot_number,
          start_time, end_time, shot_size, camera_angle, camera_movement, visual_content,
          dialogue, voiceover, screen_text, sound_effect, music, creative_comment, shot_group_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(shot.id, ids.annotation, shot.orderIndex, shot.groupName, shot.shotNumber,
        shot.startTime, shot.endTime, shot.shotSize, shot.cameraAngle, shot.cameraMovement,
        shot.visualContent, shot.dialogue, shot.voiceover, shot.screenText, shot.soundEffect,
        shot.music, shot.creativeComment, shot.shotGroupId ?? null).run();
    }
    const s = draft.creativeStructure!;
    await transaction.prepare(
      `INSERT INTO annotation_creative_structures (
        annotation_id, vocabulary_version, creative_button, mechanism_statement,
        mechanism_primary, mechanism_auxiliary_json, mechanism_custom,
        realization_skeleton, brand_product_landing, story_reference_type, story_archetype,
        primary_creative_path, auxiliary_creative_paths_json, composite_state_reason,
        formation_primary, formation_auxiliary_json, formation_statement,
        formation_related_group_ids_json, creative_carriers, establishment_conditions,
        strength_sources, acceptance_contract, audiovisual_mechanism,
        information_release_turning, creative_grade, creative_grade_reason,
        creative_grade_version, main_path_payload_json, auxiliary_path_notes_json,
        condition_flags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(ids.annotation, s.vocabularyVersion ?? V03_VOCABULARY_VERSION, s.creativeButton,
      s.mechanismStatement, s.mechanismPrimary, JSON.stringify(s.mechanismAuxiliary),
      s.mechanismCustom, s.creativeRealizationPath || s.realizationSkeleton,
      s.brandProductLanding, s.storyReferenceType, s.storyArchetype, s.primaryCreativePath,
      JSON.stringify(s.auxiliaryCreativePaths), s.compositeStateReason, s.formationPrimary,
      JSON.stringify(s.formationAuxiliary), s.formationStatement,
      JSON.stringify(s.formationRelatedGroupIds), s.creativeCarriers,
      s.establishmentConditions, s.strengthSources, s.acceptanceContract,
      s.audiovisualMechanism, s.informationReleaseTurning, s.creativeGrade,
      s.creativeGradeReason, s.creativeGradeVersion, JSON.stringify(s.mainPathPayload),
      JSON.stringify(s.auxiliaryPathNotes), JSON.stringify(s.conditionFlags)).run();
    for (const [snapshotId, payload, workflow, version, cause] of [
      [ids.public1, public1, "SUBMITTED", 1, "INITIAL"],
      [ids.approved1, approved1, "APPROVED", 2, "EXPERT_BASE"],
      [ids.public2, public2, "SUBMITTED", 2, "AUTHOR_REVISION"],
      [ids.approved2, approved2, "APPROVED", 4, "EXPERT_BASE"],
    ] as const) {
      const payloadJson = JSON.stringify(payload);
      await transaction.prepare(
        `INSERT INTO annotation_snapshots (
          id, annotation_id, video_id, author_email, author_name, taxonomy_version,
          revision, payload_json, content_hash, version_number, revision_cause,
          workflow_status, submitted_at, base_snapshot_id, source_public_snapshot_id
        ) VALUES (?, ?, ?, 'reviewer@reverse.local', 'TEST_ONLY 作者',
          'V0.3-PILOT', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
      ).bind(snapshotId, ids.annotation, ids.video, payload.revision, payloadJson,
        await sha256Text(payloadJson), version, cause, workflow,
        snapshotId === ids.public1 ? null : snapshotId === ids.approved1 ? ids.public1 : snapshotId === ids.public2 ? ids.approved1 : ids.public2,
        snapshotId === ids.approved2 ? ids.public2 : null).run();
    }
    await transaction.prepare(
      `INSERT INTO analysis_review_rounds (id, annotation_id, video_id, submitted_snapshot_id,
        round_number, reviewer_email, reviewer_name, status, decision_note, decided_at)
      VALUES (?, ?, ?, ?, 1, 'demo@reverse.local', 'TEST_ONLY 终审者', 'APPROVED',
        'TEST_ONLY 历史轮次', CURRENT_TIMESTAMP),
        (?, ?, ?, ?, 2, 'demo@reverse.local', 'TEST_ONLY 终审者', 'APPROVED',
        'TEST_ONLY 活动轮次', CURRENT_TIMESTAMP)`,
    ).bind(ids.round1, ids.annotation, ids.video, ids.public1,
      ids.round2, ids.annotation, ids.video, ids.public2).run();
    for (const [releaseId, releaseNumber, approvedId, publicId, roundId, payload, status, replaces] of [
      [ids.release1, 1, ids.approved1, ids.public1, ids.round1, approved1, "SUPERSEDED", null],
      [ids.release2, 2, ids.approved2, ids.public2, ids.round2, approved2, "ACTIVE", ids.release1],
    ] as const) {
      const payloadJson = JSON.stringify(payload);
      await transaction.prepare(
        `INSERT INTO approved_analysis_releases (
          id, annotation_id, video_id, release_number, approved_snapshot_id,
          source_snapshot_id, source_review_round_id, payload_json, content_hash,
          approved_by_email, approved_by_name, approved_at, expert_creative_grade,
          assignment_quality_grade, assignment_quality_version, status, replaces_release_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo@reverse.local',
          'TEST_ONLY 终审者', CURRENT_TIMESTAMP, 'A', NULL, NULL, ?, ?)`,
      ).bind(releaseId, ids.annotation, ids.video, releaseNumber, approvedId, publicId,
        roundId, payloadJson, await sha256Text(payloadJson), status, replaces).run();
    }
    await transaction.prepare(
      `UPDATE annotations SET base_release_id = ?, base_snapshot_id = ?,
        source_public_snapshot_id = ? WHERE id = ?`,
    ).bind(ids.release2, ids.approved2, ids.public2, ids.annotation).run();
    await transaction.prepare(
      `UPDATE annotation_snapshots SET base_release_id = ? WHERE id = ?`,
    ).bind(ids.release2, ids.approved2).run();
  });
  return { runId, ...ids, authorProfile: "reviewer", finalReviewerProfile: "owner" };
}

await applySchema();
const db = getDbClient();
const command = process.argv[2] || "verify";
const before = await businessFingerprint(db);
if (command === "prepare") {
  console.log(JSON.stringify(await prepare(db), null, 2));
} else if (command === "cleanup") {
  await cleanup(db);
  console.log(JSON.stringify({ ok: true, runId, cleaned: ids.video }, null, 2));
} else if (command === "verify") {
  const first = await prepare(db);
  const afterFirst = await businessFingerprint(db);
  assert.equal(afterFirst, before, "TEST_ONLY 夹具不得改变业务数据指纹");
  const second = await prepare(db);
  const afterSecond = await businessFingerprint(db);
  assert.equal(afterSecond, before, "幂等重跑不得增加业务记录");
  assert.deepEqual(second, first);
  await cleanup(db);
  const afterCleanup = await businessFingerprint(db);
  assert.equal(afterCleanup, before, "夹具清理后业务数据必须保持不变");
  console.log(JSON.stringify({ ok: true, runId, idempotent: true, businessFingerprintUnchanged: true }, null, 2));
} else {
  throw new Error("命令只能是 prepare、cleanup 或 verify。");
}
