import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDbClient, type DbClient } from "../db/index.ts";
import { assertLocalDemoDatabase } from "../lib/local-demo.ts";
import { V03_VOCABULARY_VERSION, V03_WORKFLOW_VERSION } from "../lib/taxonomy-v0.3.ts";

const TARGET = {
  videoId: "video_1329aaab-2c5c-40b2-867e-d30abb325cb1",
  sourceAnnotationId: "annotation_6fd6cbb3-f642-4add-92de-187006478087",
  sourceAuthorName: "演示用户",
  sourceRevision: 10,
  sourceSnapshotId: "snapshot_8c9beb81-dae2-4e3a-a4ea-98078524a535",
  sourceSnapshotRevision: 7,
  targetAnnotationId: "annotation_3b9bf676-27d7-45e9-89a1-c6242ddf0803",
  targetAuthorName: "老孙",
  targetRevision: 18,
  activeReleaseId: "approved_release_5c92f521-af29-485d-a770-73b0ea153c5c",
  activeReleaseNumber: 5,
  activeApprovedSnapshotId: "snapshot_d2e63fbf-d43a-4dd2-bac0-ad3fd8831fd9",
} as const;

const CONFIRMATION = "welcome-home-v02r10-to-v03-draft";

type Row = Record<string, unknown>;
type BindValue = string | number | boolean | null;

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withoutEmail(row: Row | null) {
  if (!row) return null;
  const copy = { ...row };
  delete copy.author_email;
  return copy;
}

async function rows(db: DbClient, sql: string, ...bindings: BindValue[]) {
  const result = await db.prepare(sql).bind(...bindings).all<Row>();
  return result.results;
}

async function loadMutablePackage(db: DbClient, annotationId: string) {
  const annotation = await db.prepare(
    `SELECT * FROM annotations WHERE id = ?`,
  ).bind(annotationId).first<Row>();
  if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);
  // Keep queries sequential so this helper is also safe on a transaction-scoped
  // PostgreSQL client, which does not support concurrent query execution.
  const shots = await rows(db, `SELECT * FROM shots WHERE annotation_id = ? ORDER BY order_index, id`, annotationId);
  const groups = await rows(db, `SELECT * FROM shot_groups WHERE annotation_id = ? ORDER BY order_index, id`, annotationId);
  const fields = await rows(db, `SELECT * FROM field_answers WHERE annotation_id = ? ORDER BY field_code, id`, annotationId);
  const structures = await rows(db, `SELECT * FROM annotation_creative_structures WHERE annotation_id = ?`, annotationId);
  return { annotation, shots, groups, fields, structure: structures[0] ?? null };
}

async function safetySummary(db: DbClient) {
  const otherAnnotations = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(revision), 0) AS revision_sum FROM annotations WHERE id <> ?`).bind(TARGET.targetAnnotationId).first<Row>();
  const otherShots = await db.prepare(`SELECT COUNT(*) AS count FROM shots WHERE annotation_id <> ?`).bind(TARGET.targetAnnotationId).first<Row>();
  const otherGroups = await db.prepare(`SELECT COUNT(*) AS count FROM shot_groups WHERE annotation_id <> ?`).bind(TARGET.targetAnnotationId).first<Row>();
  const otherFields = await db.prepare(`SELECT COUNT(*) AS count FROM field_answers WHERE annotation_id <> ?`).bind(TARGET.targetAnnotationId).first<Row>();
  const otherStructures = await db.prepare(`SELECT COUNT(*) AS count FROM annotation_creative_structures WHERE annotation_id <> ?`).bind(TARGET.targetAnnotationId).first<Row>();
  const snapshots = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(revision), 0) AS revision_sum FROM annotation_snapshots`).first<Row>();
  const releases = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(release_number), 0) AS release_sum FROM approved_analysis_releases`).first<Row>();
  const reviewRounds = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(round_number), 0) AS round_sum FROM analysis_review_rounds`).first<Row>();
  const revisionEvents = await db.prepare(`SELECT COUNT(*) AS count FROM analysis_revision_events`).first<Row>();
  const comments = await db.prepare(`SELECT COUNT(*) AS count FROM analysis_comments WHERE deleted_at IS NULL`).first<Row>();
  return {
    otherAnnotations,
    otherShots,
    otherGroups,
    otherFields,
    otherStructures,
    snapshots,
    releases,
    reviewRounds,
    revisionEvents,
    comments,
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (String(actual ?? "") !== String(expected ?? "")) {
    throw new Error(`${label} changed; expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function assertPreconditions(db: DbClient, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  const target = await db.prepare(
    `SELECT * FROM annotations WHERE id = ? AND video_id = ? AND taxonomy_version = 'V0.3-PILOT'${suffix}`,
  ).bind(TARGET.targetAnnotationId, TARGET.videoId).first<Row>();
  const source = await db.prepare(
    `SELECT * FROM annotations WHERE id = ? AND video_id = ? AND taxonomy_version = 'V0.2'${suffix}`,
  ).bind(TARGET.sourceAnnotationId, TARGET.videoId).first<Row>();
  const release = await db.prepare(
    `SELECT * FROM approved_analysis_releases WHERE id = ? AND video_id = ?${suffix}`,
  ).bind(TARGET.activeReleaseId, TARGET.videoId).first<Row>();
  const sourceSnapshot = await db.prepare(
    `SELECT id, annotation_id, author_name, taxonomy_version, revision, workflow_status
    FROM annotation_snapshots WHERE id = ?`,
  ).bind(TARGET.sourceSnapshotId).first<Row>();

  if (!target || !source || !release || !sourceSnapshot) {
    throw new Error("The exact approved source/target objects are no longer available.");
  }
  assertEqual(target.author_name, TARGET.targetAuthorName, "target author");
  assertEqual(target.revision, TARGET.targetRevision, "target revision");
  assertEqual(target.status, "SUBMITTED", "target status");
  assertEqual(target.review_status, "APPROVED", "target review status");
  assertEqual(target.active_base_snapshot_id, TARGET.activeApprovedSnapshotId, "target active base snapshot");
  assertEqual(target.source_snapshot_id, TARGET.sourceSnapshotId, "target V0.2 source snapshot");
  assertEqual(source.author_name, TARGET.sourceAuthorName, "source author");
  assertEqual(source.revision, TARGET.sourceRevision, "source revision");
  assertEqual(source.status, "DRAFT", "source status");
  assertEqual(source.review_status, "DRAFT", "source review status");
  assertEqual(release.release_number, TARGET.activeReleaseNumber, "active release number");
  assertEqual(release.status, "ACTIVE", "active release status");
  assertEqual(release.approved_snapshot_id, TARGET.activeApprovedSnapshotId, "active approved snapshot");
  assertEqual(sourceSnapshot.annotation_id, TARGET.sourceAnnotationId, "source snapshot annotation");
  assertEqual(sourceSnapshot.author_name, TARGET.sourceAuthorName, "source snapshot author");
  assertEqual(sourceSnapshot.taxonomy_version, "V0.2", "source snapshot taxonomy");
  assertEqual(sourceSnapshot.revision, TARGET.sourceSnapshotRevision, "source snapshot revision");
  assertEqual(sourceSnapshot.workflow_status, "SUBMITTED", "source snapshot workflow status");
  return { target, source, release, sourceSnapshot };
}

type SourceShot = Row & {
  id: string;
  order_index: number;
  group_name: string;
  creative_comment: string;
};

type SourceField = Row & {
  field_code: string;
  answer: string;
  evidence: string;
};

function makeMappedGroupsAndShots(sourceShots: SourceShot[]) {
  const groups: Array<{
    id: string;
    title: string;
    note: string;
    shots: SourceShot[];
  }> = [];
  for (const shot of sourceShots) {
    const title = String(shot.group_name ?? "").trim() || `桥段 ${groups.length + 1}`;
    let group = groups[groups.length - 1];
    if (!group || group.title !== title) {
      group = { id: id("group"), title, note: "", shots: [] };
      groups.push(group);
    }
    group.shots.push(shot);
    if (!group.note && String(shot.creative_comment ?? "").trim()) {
      group.note = String(shot.creative_comment).trim();
    }
  }
  return { groups, shotCount: sourceShots.length };
}

async function createBackup() {
  const db = getDbClient();
  const state = await assertPreconditions(db);
  const sourcePackage = await loadMutablePackage(db, TARGET.sourceAnnotationId);
  const targetPackage = await loadMutablePackage(db, TARGET.targetAnnotationId);
  const safety = await safetySummary(db);
  const createdAt = new Date().toISOString();
  const backup = {
    kind: "WELCOME_HOME_V02_TO_V03_PREWRITE_BACKUP",
    createdAt,
    target: TARGET,
    state: {
      target: withoutEmail(state.target),
      source: withoutEmail(state.source),
      release: state.release,
      sourceSnapshot: state.sourceSnapshot,
    },
    sourcePackage: {
      ...sourcePackage,
      annotation: withoutEmail(sourcePackage.annotation),
    },
    targetPackage: {
      ...targetPackage,
      annotation: withoutEmail(targetPackage.annotation),
    },
    hashes: {
      sourcePackage: sha256(sourcePackage),
      targetPackage: sha256(targetPackage),
      safety: sha256(safety),
    },
    safety,
  };
  const backupDir = path.resolve(process.cwd(), "../.local-demo/backups");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = createdAt.replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `welcome-home-v02-to-v03-${stamp}.json`);
  await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  return { backupPath, backup, sourcePackage, targetPackage, safety };
}

async function applyMapping(
  backupPath: string,
  backupSafety: unknown,
  previousTargetHash: string,
) {
  const db = getDbClient();
  return db.withTransaction(async (tx) => {
    const { target, source } = await assertPreconditions(tx, true);
    const sourceShots = await rows(
      tx,
      `SELECT * FROM shots WHERE annotation_id = ? ORDER BY order_index, id`,
      TARGET.sourceAnnotationId,
    ) as SourceShot[];
    const sourceFields = await rows(
      tx,
      `SELECT * FROM field_answers WHERE annotation_id = ? ORDER BY field_code, id`,
      TARGET.sourceAnnotationId,
    ) as SourceField[];
    if (sourceShots.length !== 23) throw new Error(`Expected 23 source shots, got ${sourceShots.length}`);
    const fieldCodes = sourceFields.map((field) => field.field_code).sort();
    const expectedCodes = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "B1", "B10", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"].sort();
    if (JSON.stringify(fieldCodes) !== JSON.stringify(expectedCodes)) {
      throw new Error(`Expected all 19 V0.2 fields, got ${fieldCodes.join(", ")}`);
    }
    const fieldByCode = new Map(sourceFields.map((field) => [field.field_code, field]));
    const storyReferenceType = String(fieldByCode.get("B2")?.answer ?? "").trim();
    const storyArchetype = String(fieldByCode.get("B3")?.answer ?? "").trim();
    if (!storyReferenceType || !storyArchetype) {
      throw new Error("B2/B3 cannot be empty for the approved deterministic mapping.");
    }
    const { groups, shotCount } = makeMappedGroupsAndShots(sourceShots);
    if (groups.length !== 7 || shotCount !== 23) {
      throw new Error(`Expected 7 groups/23 shots, got ${groups.length}/${shotCount}`);
    }

    const safetyBefore = await safetySummary(tx);
    if (sha256(safetyBefore) !== sha256(backupSafety)) {
      throw new Error("Other business data changed after backup; mapping aborted.");
    }

    await tx.prepare(`DELETE FROM shots WHERE annotation_id = ?`).bind(TARGET.targetAnnotationId).run();
    await tx.prepare(`DELETE FROM shot_groups WHERE annotation_id = ?`).bind(TARGET.targetAnnotationId).run();
    await tx.prepare(`DELETE FROM field_answers WHERE annotation_id = ?`).bind(TARGET.targetAnnotationId).run();
    await tx.prepare(`DELETE FROM annotation_creative_structures WHERE annotation_id = ?`).bind(TARGET.targetAnnotationId).run();

    await tx.prepare(
      `UPDATE annotations SET
        author_name = ?, workflow_version = ?, source_snapshot_id = ?,
        status = 'DRAFT', review_status = 'DRAFT', active_base_snapshot_id = NULL,
        base_release_id = NULL, base_snapshot_id = NULL, source_public_snapshot_id = NULL,
        revision = ?, analysis_title = ?, commercial_intent = ?, creative_theme = ?,
        synopsis = ?, thinking_chain = ?, shot_commentary = ?, summary = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND review_status = 'APPROVED'`,
    ).bind(
      TARGET.targetAuthorName,
      V03_WORKFLOW_VERSION,
      TARGET.sourceSnapshotId,
      TARGET.targetRevision + 1,
      String(source.analysis_title ?? "").trim(),
      String(source.commercial_intent ?? "").trim(),
      String(source.creative_theme ?? "").trim(),
      String(source.synopsis ?? "").trim(),
      String(source.thinking_chain ?? "").trim(),
      String(source.shot_commentary ?? "").trim(),
      String(source.summary ?? "").trim(),
      TARGET.targetAnnotationId,
      TARGET.targetRevision,
    ).run();

    for (const [index, group] of groups.entries()) {
      await tx.prepare(
        `INSERT INTO shot_groups (
          id, annotation_id, order_index, title, primary_role_id,
          primary_role_name_snapshot, auxiliary_roles_json, custom_role, note,
          taxonomy_version
        ) VALUES (?, ?, ?, ?, '', '', '[]', '', ?, 'V0.3-PILOT')`,
      ).bind(group.id, TARGET.targetAnnotationId, index, group.title, group.note).run();
      for (const shot of group.shots) {
        await tx.prepare(
          `INSERT INTO shots (
            id, annotation_id, order_index, group_name, shot_group_id, shot_number,
            start_time, end_time, shot_size, camera_angle, camera_movement,
            visual_content, dialogue, voiceover, screen_text, sound_effect, music,
            creative_comment
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        ).bind(
          id("shot"), TARGET.targetAnnotationId, Number(shot.order_index), group.title,
          group.id, String(shot.shot_number ?? ""), String(shot.start_time ?? ""),
          String(shot.end_time ?? ""), String(shot.shot_size ?? ""),
          String(shot.camera_angle ?? ""), String(shot.camera_movement ?? ""),
          String(shot.visual_content ?? ""), String(shot.dialogue ?? ""),
          String(shot.voiceover ?? ""), String(shot.screen_text ?? ""),
          String(shot.sound_effect ?? ""), String(shot.music ?? ""),
        ).run();
      }
    }

    for (const field of sourceFields) {
      await tx.prepare(
        `INSERT INTO field_answers (
          id, annotation_id, field_code, answer, evidence, source
        ) VALUES (?, ?, ?, ?, ?, 'SYSTEM_MAPPED')`,
      ).bind(
        id("field"), TARGET.targetAnnotationId, field.field_code,
        String(field.answer ?? ""), String(field.evidence ?? ""),
      ).run();
    }

    await tx.prepare(
      `INSERT INTO annotation_creative_structures (
        annotation_id, vocabulary_version, creative_button, mechanism_statement,
        mechanism_primary, mechanism_auxiliary_json, mechanism_custom,
        realization_skeleton, brand_product_landing,
        story_reference_type, story_archetype, primary_creative_path,
        auxiliary_creative_paths_json, composite_state_reason,
        formation_primary, formation_auxiliary_json, formation_statement,
        formation_related_group_ids_json, creative_carriers,
        establishment_conditions, strength_sources, acceptance_contract,
        audiovisual_mechanism, information_release_turning, creative_grade,
        creative_grade_reason, creative_grade_version,
        main_path_payload_json, auxiliary_path_notes_json, condition_flags_json
      ) VALUES (?, ?, '', '', '', '[]', '', '', '', ?, ?, 'LOVE', '[]', '',
        '', '[]', '', '[]', '', '', '', '', '', '', '', '',
        'CREATIVE-GRADE-V0.1', '{}', '{}', ?)`,
    ).bind(
      TARGET.targetAnnotationId,
      V03_VOCABULARY_VERSION,
      storyReferenceType,
      storyArchetype,
      JSON.stringify({
        unconventionalWorld: false,
        audiovisualCarriesIdea: false,
        interestingLoadBearing: false,
      }),
    ).run();

    const afterPackage = await loadMutablePackage(tx, TARGET.targetAnnotationId);
    const afterAnnotation = afterPackage.annotation;
    assertEqual(afterAnnotation.status, "DRAFT", "mapped target status");
    assertEqual(afterAnnotation.review_status, "DRAFT", "mapped target review status");
    assertEqual(afterAnnotation.revision, TARGET.targetRevision + 1, "mapped target revision");
    assertEqual(afterAnnotation.source_snapshot_id, TARGET.sourceSnapshotId, "mapped source snapshot");
    assertEqual(afterAnnotation.base_release_id, null, "mapped base release");
    if (afterPackage.shots.length !== 23 || afterPackage.groups.length !== 7 || afterPackage.fields.length !== 19) {
      throw new Error("Mapped target child counts are incomplete.");
    }

    const releaseAfter = await tx.prepare(
      `SELECT status, release_number, approved_snapshot_id FROM approved_analysis_releases WHERE id = ?`,
    ).bind(TARGET.activeReleaseId).first<Row>();
    assertEqual(releaseAfter?.status, "ACTIVE", "R5 status after mapping");
    assertEqual(releaseAfter?.release_number, TARGET.activeReleaseNumber, "R5 number after mapping");
    assertEqual(releaseAfter?.approved_snapshot_id, TARGET.activeApprovedSnapshotId, "R5 snapshot after mapping");

    const safetyAfter = await safetySummary(tx);
    if (sha256(safetyAfter) !== sha256(safetyBefore)) {
      throw new Error("A non-target business data summary changed; transaction rolled back.");
    }

    const detail = {
      sourceAnnotationId: TARGET.sourceAnnotationId,
      sourceWorkingRevision: TARGET.sourceRevision,
      sourceSnapshotId: TARGET.sourceSnapshotId,
      sourcePackageHash: sha256(await loadMutablePackage(tx, TARGET.sourceAnnotationId)),
      previousTargetRevision: TARGET.targetRevision,
      newTargetRevision: TARGET.targetRevision + 1,
      mapped: { shots: 23, groups: 7, legacyFields: 19, directStructureFields: 3 },
      preservedActiveRelease: TARGET.activeReleaseNumber,
      backupFileName: path.basename(backupPath),
      previousTargetHash,
      newTargetHash: sha256(afterPackage),
    };
    await tx.prepare(
      `INSERT INTO audit_logs (
        id, actor_email, action, object_type, object_id, detail_json
      ) VALUES (?, ?, 'V02_TO_V03_CASE_MAPPING', 'ANNOTATION', ?, ?)`,
    ).bind(
      id("audit"), String(target.author_email), TARGET.targetAnnotationId,
      JSON.stringify(detail),
    ).run();
    return { afterPackage, safetyBefore, safetyAfter, detail };
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
assertLocalDemoDatabase(databaseUrl);

const apply = process.argv.includes("--apply");
const confirmation = process.argv.find((value) => value.startsWith("--confirm="))?.slice("--confirm=".length);
if (apply && confirmation !== CONFIRMATION) {
  throw new Error(`Apply requires --confirm=${CONFIRMATION}`);
}

const prepared = await createBackup();
const sourceFields = prepared.sourcePackage.fields as SourceField[];
const { groups } = makeMappedGroupsAndShots(prepared.sourcePackage.shots as SourceShot[]);
const preview = {
  ok: true,
  mode: apply ? "APPLY" : "DRY_RUN",
  target: {
    videoId: TARGET.videoId,
    authorName: TARGET.targetAuthorName,
    currentRevision: TARGET.targetRevision,
    nextRevision: TARGET.targetRevision + 1,
  },
  source: {
    authorName: TARGET.sourceAuthorName,
    workingRevision: TARGET.sourceRevision,
    immutableSnapshotRevision: TARGET.sourceSnapshotRevision,
    packageHash: prepared.backup.hashes.sourcePackage,
  },
  mapping: {
    shots: prepared.sourcePackage.shots.length,
    groups: groups.length,
    legacyFields: sourceFields.length,
    deterministicV03: {
      primaryCreativePath: "LOVE",
      storyReferenceType: sourceFields.find((field) => field.field_code === "B2")?.answer,
      storyArchetype: sourceFields.find((field) => field.field_code === "B3")?.answer,
    },
  },
  preserved: {
    activeRelease: `R${TARGET.activeReleaseNumber}`,
    approvedSnapshots: true,
    reviewHistory: true,
    otherAnnotations: true,
  },
  backupPath: prepared.backupPath,
  safetyHash: prepared.backup.hashes.safety,
};

if (!apply) {
  console.log(JSON.stringify(preview, null, 2));
} else {
  const result = await applyMapping(
    prepared.backupPath,
    prepared.safety,
    prepared.backup.hashes.targetPackage,
  );
  console.log(JSON.stringify({
    ...preview,
    result: {
      committed: true,
      status: result.afterPackage.annotation.status,
      reviewStatus: result.afterPackage.annotation.review_status,
      revision: result.afterPackage.annotation.revision,
      shots: result.afterPackage.shots.length,
      groups: result.afterPackage.groups.length,
      legacyFields: result.afterPackage.fields.length,
      activeRelease: `R${TARGET.activeReleaseNumber}`,
      otherBusinessSummaryUnchanged: sha256(result.safetyBefore) === sha256(result.safetyAfter),
    },
  }, null, 2));
}
