import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "@/db";
import { getDbClient } from "@/db";
import { installAdminDataOperationSchema } from "@/lib/admin-data-operations";
import type { CurrentUser } from "@/lib/current-user";
import { V03_VOCABULARY_VERSION, V03_WORKFLOW_VERSION } from "@/lib/taxonomy-v0.3";
import {
  WELCOME_HOME_MAPPING_CONFIRMATION,
  WELCOME_HOME_MAPPING_OPERATION_KEY,
  WELCOME_HOME_MAPPING_VIDEO_ID,
  type WelcomeHomeMappingPreview,
  type WelcomeHomeMappingResult,
} from "@/lib/welcome-home-mapping-contract";

type Row = Record<string, unknown>;
type BindValue = string | number | boolean | null;

const LEGACY_FIELD_CODES = [
  "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9",
  "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10",
] as const;

export type WelcomeHomeMappingConfig = {
  videoId: string;
  operationKey: string;
  sourceAuthorName: string;
  targetAuthorName: string;
  sourceSnapshotVersionNumber: number;
  confirmation: string;
  dataScope: "BUSINESS" | "TEST_ONLY";
};

export const WELCOME_HOME_MAPPING_CONFIG: WelcomeHomeMappingConfig = {
  videoId: WELCOME_HOME_MAPPING_VIDEO_ID,
  operationKey: WELCOME_HOME_MAPPING_OPERATION_KEY,
  sourceAuthorName: "演示用户",
  targetAuthorName: "老孙",
  sourceSnapshotVersionNumber: 2,
  confirmation: WELCOME_HOME_MAPPING_CONFIRMATION,
  dataScope: "BUSINESS",
};

export class WelcomeHomeMappingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "WelcomeHomeMappingError";
  }
}

type MutablePackage = {
  annotation: Row;
  shots: Row[];
  groups: Row[];
  fields: Row[];
  structures: Row[];
};

type Inspection = {
  actor: CurrentUser;
  video: Row | null;
  sourceCandidates: Row[];
  targetCandidates: Row[];
  source: Row | null;
  target: Row | null;
  sourceSnapshot: Row | null;
  sourceSnapshotVersionNumber: number | null;
  sourcePackage: MutablePackage | null;
  targetPackage: MutablePackage | null;
  derivedGroups: MappedGroup[];
  sourceFields: Row[];
  ledgerAvailable: boolean;
  ledger: Row | null;
  preservationCounts: {
    snapshots: number;
    reviewRounds: number;
    comments: number;
    revisionEvents: number;
    releases: number;
  };
  nonTargetSummary: Record<string, Row>;
};

type MappedGroup = {
  title: string;
  note: string;
  shots: Row[];
};

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function numberValue(value: unknown) {
  return Number(value ?? 0);
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

async function queryRows(db: DbClient, sql: string, ...values: BindValue[]) {
  return (await db.prepare(sql).bind(...values).all<Row>()).results;
}

async function tableExists(db: DbClient, table: string) {
  const result = await db.prepare(`SELECT to_regclass(?) AS name`).bind(`public.${table}`)
    .first<{ name: string | null }>();
  return Boolean(result?.name);
}

async function loadPackage(db: DbClient, annotationId: string): Promise<MutablePackage> {
  const annotation = await db.prepare(`SELECT * FROM annotations WHERE id = ?`)
    .bind(annotationId).first<Row>();
  if (!annotation) throw new WelcomeHomeMappingError("ANNOTATION_MISSING", "作业记录不存在。");
  const shots = await queryRows(db,
    `SELECT * FROM shots WHERE annotation_id = ? ORDER BY order_index, id`, annotationId);
  const groups = await queryRows(db,
    `SELECT * FROM shot_groups WHERE annotation_id = ? ORDER BY order_index, id`, annotationId);
  const fields = await queryRows(db,
    `SELECT * FROM field_answers WHERE annotation_id = ? ORDER BY field_code, id`, annotationId);
  const structures = await queryRows(db,
    `SELECT * FROM annotation_creative_structures WHERE annotation_id = ?`, annotationId);
  return { annotation, shots, groups, fields, structures };
}

function packageFromSubmittedSnapshot(snapshot: Row | null): MutablePackage | null {
  if (!snapshot) return null;
  try {
    const raw = typeof snapshot.payload_json === "string"
      ? JSON.parse(snapshot.payload_json) as Row
      : snapshot.payload_json as Row;
    if (!raw || typeof raw !== "object") return null;
    const rawShots = Array.isArray(raw.shots) ? raw.shots as Row[] : [];
    const rawFields = Array.isArray(raw.fields) ? raw.fields as Row[] : [];
    return {
      annotation: {
        analysis_title: raw.analysisTitle,
        commercial_intent: raw.commercialIntent,
        creative_theme: raw.creativeTheme,
        synopsis: raw.synopsis,
        thinking_chain: raw.thinkingChain,
        shot_commentary: raw.shotCommentary,
        summary: raw.summary,
        payload_video_id: raw.videoId,
        payload_taxonomy_version: raw.taxonomyVersion,
      },
      shots: rawShots.map((shot, index) => ({
        id: shot.id,
        order_index: shot.orderIndex ?? index,
        group_name: shot.groupName,
        shot_number: shot.shotNumber,
        start_time: shot.startTime,
        end_time: shot.endTime,
        shot_size: shot.shotSize,
        camera_angle: shot.cameraAngle,
        camera_movement: shot.cameraMovement,
        visual_content: shot.visualContent,
        dialogue: shot.dialogue,
        voiceover: shot.voiceover,
        screen_text: shot.screenText,
        sound_effect: shot.soundEffect,
        music: shot.music,
        creative_comment: shot.creativeComment,
      })),
      groups: [],
      fields: rawFields.map((field) => ({
        field_code: field.code,
        answer: field.answer,
        evidence: field.evidence,
        source: field.source,
      })),
      structures: [],
    };
  } catch {
    return null;
  }
}

export function deriveWelcomeHomeGroups(sourceShots: Row[]): MappedGroup[] {
  const groups: MappedGroup[] = [];
  for (const shot of sourceShots) {
    const title = stringValue(shot.group_name) || `桥段 ${groups.length + 1}`;
    let group = groups.at(-1);
    if (!group || group.title !== title) {
      group = { title, note: "", shots: [] };
      groups.push(group);
    }
    group.shots.push(shot);
    if (!group.note && stringValue(shot.creative_comment)) {
      group.note = stringValue(shot.creative_comment);
    }
  }
  return groups;
}

async function preservationCounts(db: DbClient, videoId: string) {
  const row = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM annotation_snapshots WHERE video_id = ?) AS snapshots,
      (SELECT COUNT(*) FROM analysis_review_rounds WHERE video_id = ?) AS review_rounds,
      (SELECT COUNT(*) FROM analysis_comments WHERE video_id = ?) AS comments,
      (SELECT COUNT(*) FROM analysis_revision_events WHERE video_id = ?) AS revision_events,
      (SELECT COUNT(*) FROM approved_analysis_releases WHERE video_id = ?) AS releases`,
  ).bind(videoId, videoId, videoId, videoId, videoId).first<Row>();
  return {
    snapshots: numberValue(row?.snapshots),
    reviewRounds: numberValue(row?.review_rounds),
    comments: numberValue(row?.comments),
    revisionEvents: numberValue(row?.revision_events),
    releases: numberValue(row?.releases),
  };
}

async function digestQuery(db: DbClient, sql: string, ...values: BindValue[]) {
  return (await db.prepare(sql).bind(...values).first<Row>()) ?? {};
}

async function nonTargetSummary(db: DbClient, targetAnnotationId: string | null) {
  // Each digest covers both row count and content. The target mutable row and its
  // four mutable child tables are the only exclusions; history is never excluded.
  // Before a CREATE operation there is no target row, so the baseline covers all
  // existing business rows. After creation the new target is excluded explicitly.
  const summary: Record<string, Row> = {};
  const exclusion = targetAnnotationId ? " WHERE %s <> ?" : "";
  const mutableDigests = [
    ["annotations", "annotations", "a", "a.id", "a.id"],
    ["shots", "shots", "s", "s.id", "s.annotation_id"],
    ["groups", "shot_groups", "g", "g.id", "g.annotation_id"],
    ["fields", "field_answers", "f", "f.id", "f.annotation_id"],
    ["structures", "annotation_creative_structures", "c", "c.annotation_id", "c.annotation_id"],
  ] as const;
  for (const [key, table, alias, order, targetColumn] of mutableDigests) {
    const where = exclusion.replace("%s", targetColumn);
    summary[key] = await digestQuery(db,
      `SELECT COUNT(*) AS count,
        md5(COALESCE(string_agg(md5(row_to_json(${alias})::text), '' ORDER BY ${order}), '')) AS digest
      FROM ${table} ${alias}${where}`,
      ...(targetAnnotationId ? [targetAnnotationId] : []));
  }
  for (const [key, table, order] of [
    ["videos", "videos", "id"],
    ["snapshots", "annotation_snapshots", "id"],
    ["reviewRounds", "analysis_review_rounds", "id"],
    ["comments", "analysis_comments", "id"],
    ["revisionEvents", "analysis_revision_events", "id"],
    ["releases", "approved_analysis_releases", "id"],
  ] as const) {
    summary[key] = await digestQuery(db,
      `SELECT COUNT(*) AS count,
        md5(COALESCE(string_agg(md5(row_to_json(t)::text), '' ORDER BY t.${order}), '')) AS digest
      FROM ${table} t`);
  }
  return summary;
}

async function inspect(
  db: DbClient,
  config: WelcomeHomeMappingConfig,
  actor: CurrentUser,
  lock: boolean,
): Promise<Inspection> {
  const lockSuffix = lock ? " FOR UPDATE" : "";
  const video = await db.prepare(
    `SELECT id, title, COALESCE(data_scope, 'BUSINESS') AS data_scope
    FROM videos WHERE id = ? AND deleted_at IS NULL${lockSuffix}`,
  ).bind(config.videoId).first<Row>();
  const sourceCandidates = await queryRows(db,
    `SELECT * FROM annotations
    WHERE video_id = ? AND taxonomy_version = 'V0.2' AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM annotation_snapshots source_snapshot
        WHERE source_snapshot.annotation_id = annotations.id
          AND source_snapshot.video_id = annotations.video_id
          AND source_snapshot.taxonomy_version = 'V0.2'
          AND source_snapshot.workflow_status = 'SUBMITTED'
          AND source_snapshot.author_name = ?
      )
    ORDER BY created_at${lockSuffix}`,
    config.videoId, config.sourceAuthorName);
  const targetCandidates = await queryRows(db,
    `SELECT * FROM annotations
    WHERE video_id = ? AND taxonomy_version = 'V0.3-PILOT' AND author_email = ?
      AND deleted_at IS NULL ORDER BY created_at${lockSuffix}`,
    config.videoId, actor.identityKey);
  const source = sourceCandidates.length === 1 ? sourceCandidates[0] : null;
  const target = targetCandidates.length === 1 ? targetCandidates[0] : null;
  const sourceSnapshot = source
    ? await db.prepare(
      `SELECT id, annotation_id, video_id, author_name, taxonomy_version, revision,
        version_number, workflow_status, payload_json, content_hash, created_at,
        (SELECT COUNT(*) FROM annotation_snapshots submitted
          WHERE submitted.annotation_id = annotation_snapshots.annotation_id
            AND submitted.taxonomy_version = 'V0.2'
            AND submitted.workflow_status = 'SUBMITTED') AS submitted_version_count
      FROM annotation_snapshots
      WHERE annotation_id = ? AND taxonomy_version = 'V0.2'
        AND workflow_status = 'SUBMITTED' AND video_id = ? AND author_name = ?
      ORDER BY created_at DESC, revision DESC LIMIT 1${lockSuffix}`,
    ).bind(String(source.id), config.videoId, config.sourceAuthorName).first<Row>()
    : null;
  const sourceSnapshotVersionNumber = sourceSnapshot
    ? numberValue(sourceSnapshot.submitted_version_count) : null;
  const sourcePackage = packageFromSubmittedSnapshot(sourceSnapshot);
  const targetPackage = target ? await loadPackage(db, String(target.id)) : null;
  const ledgerAvailable = await tableExists(db, "admin_data_operations");
  const ledger = ledgerAvailable
    ? await db.prepare(
      `SELECT operation_key, status, completed_at, result_json
      FROM admin_data_operations WHERE operation_key = ?${lockSuffix}`,
    ).bind(config.operationKey).first<Row>()
    : null;
  return {
    actor,
    video,
    sourceCandidates,
    targetCandidates,
    source,
    target,
    sourceSnapshot,
    sourceSnapshotVersionNumber,
    sourcePackage,
    targetPackage,
    derivedGroups: deriveWelcomeHomeGroups(sourcePackage?.shots ?? []),
    sourceFields: sourcePackage?.fields ?? [],
    ledgerAvailable,
    ledger,
    preservationCounts: await preservationCounts(db, config.videoId),
    nonTargetSummary: await nonTargetSummary(db, target ? String(target.id) : null),
  };
}

export function validateWelcomeHomeInspection(
  inspection: Pick<Inspection,
    "actor" | "video" | "sourceCandidates" | "targetCandidates" | "source" | "target" |
    "sourceSnapshot" | "sourceSnapshotVersionNumber" | "sourcePackage" |
    "derivedGroups" | "sourceFields" | "ledger">,
  config: WelcomeHomeMappingConfig,
) {
  const reasons: string[] = [];
  if (!inspection.video) reasons.push("固定案例不存在或已进入回收站。");
  if (inspection.video && stringValue(inspection.video.data_scope) !== config.dataScope) {
    reasons.push(`固定案例的数据范围不是 ${config.dataScope}。`);
  }
  if (inspection.sourceCandidates.length !== 1) {
    reasons.push(`未唯一识别“${config.sourceAuthorName}”的 V0.2 当前记录。`);
  }
  if (inspection.actor.displayName !== config.targetAuthorName) {
    reasons.push(`当前管理员不是目标作者“${config.targetAuthorName}”。`);
  }
  if (inspection.targetCandidates.length !== 0) {
    reasons.push(`“${config.targetAuthorName}”已经存在 V0.3 工作稿，禁止覆盖。`);
  }
  if (!inspection.sourceSnapshot) reasons.push("找不到 V0.2 最近一次已提交不可变快照。");
  if (inspection.sourceSnapshot && stringValue(inspection.sourceSnapshot.author_name) !== config.sourceAuthorName) {
    reasons.push("V0.2 来源快照作者不匹配。");
  }
  if (inspection.sourceSnapshot && (
    stringValue(inspection.sourceSnapshot.video_id) !== config.videoId ||
    stringValue(inspection.sourceSnapshot.taxonomy_version) !== "V0.2" ||
    stringValue(inspection.sourceSnapshot.workflow_status) !== "SUBMITTED"
  )) {
    reasons.push("V0.2 来源快照的案例、体系或提交状态不匹配。");
  }
  if (inspection.sourceSnapshotVersionNumber !== config.sourceSnapshotVersionNumber) {
    reasons.push(`V0.2 最新公开版本不是 V${config.sourceSnapshotVersionNumber}。`);
  }
  if (!inspection.sourcePackage) {
    reasons.push("V0.2 最新公开版本的快照内容无法解析。");
  } else if (
    stringValue(inspection.sourcePackage.annotation.payload_video_id) !== config.videoId ||
    stringValue(inspection.sourcePackage.annotation.payload_taxonomy_version) !== "V0.2"
  ) {
    reasons.push("V0.2 快照载荷的案例或体系标识不匹配。");
  }
  if ((inspection.sourcePackage?.shots.length ?? 0) !== 23) reasons.push("V0.2 来源镜头数不是 23。");
  if (inspection.derivedGroups.length !== 7) reasons.push("V0.2 来源连续桥段数不是 7。");
  const codes = inspection.sourceFields.map((field) => stringValue(field.field_code)).sort();
  const expectedCodes = [...LEGACY_FIELD_CODES].sort();
  if (JSON.stringify(codes) !== JSON.stringify(expectedCodes)) reasons.push("V0.2 来源不是完整 19 项 A/B 字段。");
  const byCode = new Map(inspection.sourceFields.map((field) => [stringValue(field.field_code), field]));
  if (!stringValue(byCode.get("B2")?.answer)) reasons.push("B2 故事参照类型为空，无法确定性映射。");
  if (!stringValue(byCode.get("B3")?.answer)) reasons.push("B3 故事原型为空，无法确定性映射。");
  if (stringValue(inspection.ledger?.status) === "COMPLETED") reasons.push("该一次性操作已经完成，入口永久只读。");
  return reasons;
}

function makePreview(inspection: Inspection, config: WelcomeHomeMappingConfig): WelcomeHomeMappingPreview {
  const reasons = validateWelcomeHomeInspection(inspection, config);
  const applied = stringValue(inspection.ledger?.status) === "COMPLETED";
  const fieldByCode = new Map(
    inspection.sourceFields.map((field) => [stringValue(field.field_code), field]),
  );
  const tokenPayload = {
    operationKey: config.operationKey,
    actorIdentity: inspection.actor.identityKey,
    source: inspection.sourcePackage ? sha256(inspection.sourcePackage) : null,
    targetAbsent: inspection.targetCandidates.length === 0,
    sourceSnapshot: inspection.sourceSnapshot,
    sourceSnapshotVersionNumber: inspection.sourceSnapshotVersionNumber,
    nonTarget: inspection.nonTargetSummary,
  };
  return {
    ready: reasons.length === 0,
    applied,
    reasons,
    previewToken: reasons.length === 0 ? sha256(tokenPayload) : null,
    operation: {
      key: config.operationKey,
      ledgerAvailable: inspection.ledgerAvailable,
      status: applied ? "COMPLETED" : "NOT_RUN",
      completedAt: applied ? stringValue(inspection.ledger?.completed_at) || null : null,
    },
    case: {
      title: stringValue(inspection.video?.title) || "《欢迎回家》",
      videoId: config.videoId,
      dataScope: stringValue(inspection.video?.data_scope) || "—",
    },
    source: {
      authorName: config.sourceAuthorName,
      taxonomyVersion: "V0.2",
      status: stringValue(inspection.source?.status) || "—",
      reviewStatus: stringValue(inspection.source?.review_status) || "—",
      workingRevision: numberValue(inspection.source?.revision),
      submittedSnapshotRevision: inspection.sourceSnapshot
        ? numberValue(inspection.sourceSnapshot.revision) : null,
      submittedSnapshotVersionNumber: inspection.sourceSnapshotVersionNumber,
    },
    target: {
      authorName: config.targetAuthorName,
      taxonomyVersion: "V0.3-PILOT",
      mode: "CREATE",
      exists: Boolean(inspection.target),
      status: stringValue(inspection.target?.status) || "—",
      reviewStatus: stringValue(inspection.target?.review_status) || "—",
      currentRevision: numberValue(inspection.target?.revision),
      nextRevision: numberValue(inspection.target?.revision) + 1,
    },
    mapping: {
      shots: inspection.sourcePackage?.shots.length ?? 0,
      groups: inspection.derivedGroups.length,
      legacyFields: inspection.sourceFields.length,
      primaryCreativePath: "LOVE",
      storyReferenceTypePresent: Boolean(stringValue(fieldByCode.get("B2")?.answer)),
      storyArchetypePresent: Boolean(stringValue(fieldByCode.get("B3")?.answer)),
      explanatoryFieldsRemainBlank: true,
    },
    preserved: inspection.preservationCounts,
  };
}

export async function previewWelcomeHomeMapping(
  actor: CurrentUser,
  db = getDbClient(),
  config = WELCOME_HOME_MAPPING_CONFIG,
) {
  return makePreview(await inspect(db, config, actor, false), config);
}

function mappedResultFromLedger(ledger: Row, config: WelcomeHomeMappingConfig): WelcomeHomeMappingResult {
  const raw = ledger.result_json;
  const parsed = typeof raw === "string" ? JSON.parse(raw) as WelcomeHomeMappingResult : raw as WelcomeHomeMappingResult;
  return { ...parsed, alreadyApplied: true, operationKey: config.operationKey };
}

async function writeMappedDraft(
  db: DbClient,
  inspection: Inspection,
) {
  const source = inspection.sourcePackage!.annotation;
  const sourceSnapshot = inspection.sourceSnapshot!;
  const targetId = newId("annotation");
  const nextRevision = 1;
  const fieldByCode = new Map(
    inspection.sourceFields.map((field) => [stringValue(field.field_code), field]),
  );
  const insert = await db.prepare(
    `INSERT INTO annotations (
      id, video_id, author_email, author_name, taxonomy_version,
      workflow_version, source_snapshot_id, status, review_status, revision,
      analysis_title, commercial_intent, creative_theme, synopsis,
      thinking_chain, shot_commentary, summary
    ) VALUES (?, ?, ?, ?, 'V0.3-PILOT', ?, ?, 'DRAFT', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    targetId,
    String(inspection.video!.id),
    inspection.actor.identityKey,
    inspection.actor.displayName,
    V03_WORKFLOW_VERSION,
    String(sourceSnapshot.id),
    nextRevision,
    stringValue(source.analysis_title),
    stringValue(source.commercial_intent),
    stringValue(source.creative_theme),
    stringValue(source.synopsis),
    stringValue(source.thinking_chain),
    stringValue(source.shot_commentary),
    stringValue(source.summary),
  ).run();
  if (insert.meta.rows_written !== 1) {
    throw new WelcomeHomeMappingError("TARGET_CREATE_FAILED", "V0.3 新草稿未能建立，事务已回滚。");
  }
  for (const [groupIndex, group] of inspection.derivedGroups.entries()) {
    const groupId = newId("group");
    await db.prepare(
      `INSERT INTO shot_groups (
        id, annotation_id, order_index, title, primary_role_id,
        primary_role_name_snapshot, auxiliary_roles_json, custom_role, note,
        taxonomy_version
      ) VALUES (?, ?, ?, ?, '', '', '[]', '', ?, 'V0.3-PILOT')`,
    ).bind(groupId, targetId, groupIndex, group.title, group.note).run();
    for (const shot of group.shots) {
      await db.prepare(
        `INSERT INTO shots (
          id, annotation_id, order_index, group_name, shot_group_id, shot_number,
          start_time, end_time, shot_size, camera_angle, camera_movement,
          visual_content, dialogue, voiceover, screen_text, sound_effect, music,
          creative_comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      ).bind(
        newId("shot"), targetId, numberValue(shot.order_index), group.title, groupId,
        stringValue(shot.shot_number), stringValue(shot.start_time), stringValue(shot.end_time),
        stringValue(shot.shot_size), stringValue(shot.camera_angle),
        stringValue(shot.camera_movement), stringValue(shot.visual_content),
        stringValue(shot.dialogue), stringValue(shot.voiceover),
        stringValue(shot.screen_text), stringValue(shot.sound_effect), stringValue(shot.music),
      ).run();
    }
  }
  for (const field of inspection.sourceFields) {
    await db.prepare(
      `INSERT INTO field_answers (id, annotation_id, field_code, answer, evidence, source)
      VALUES (?, ?, ?, ?, ?, 'SYSTEM_MAPPED')`,
    ).bind(
      newId("field"), targetId, stringValue(field.field_code),
      stringValue(field.answer), stringValue(field.evidence),
    ).run();
  }
  await db.prepare(
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
    targetId,
    V03_VOCABULARY_VERSION,
    stringValue(fieldByCode.get("B2")?.answer),
    stringValue(fieldByCode.get("B3")?.answer),
    JSON.stringify({
      unconventionalWorld: false,
      audiovisualCarriesIdea: false,
      interestingLoadBearing: false,
    }),
  ).run();
  return { targetId, nextRevision };
}

async function verifyMappedDraft(
  db: DbClient,
  targetId: string,
  nextRevision: number,
  sourceSnapshotId: string,
) {
  const pkg = await loadPackage(db, targetId);
  const annotation = pkg.annotation;
  const structure = pkg.structures[0] ?? {};
  if (stringValue(annotation.status) !== "DRAFT" || stringValue(annotation.review_status) !== "DRAFT") {
    throw new WelcomeHomeMappingError("POSTCHECK_STATUS", "映射后作业状态不正确。");
  }
  if (numberValue(annotation.revision) !== nextRevision ||
    stringValue(annotation.source_snapshot_id) !== sourceSnapshotId) {
    throw new WelcomeHomeMappingError("POSTCHECK_LINEAGE", "映射后版本或来源血缘不正确。");
  }
  if (pkg.shots.length !== 23 || pkg.groups.length !== 7 || pkg.fields.length !== 19 || pkg.structures.length !== 1) {
    throw new WelcomeHomeMappingError("POSTCHECK_COUNTS", "映射后的 23/7/19 数据结构不完整。");
  }
  if (pkg.fields.some((field) => stringValue(field.source) !== "SYSTEM_MAPPED")) {
    throw new WelcomeHomeMappingError("POSTCHECK_FIELDS", "19 项旧字段未全部标记为 SYSTEM_MAPPED。");
  }
  if (stringValue(structure.primary_creative_path) !== "LOVE") {
    throw new WelcomeHomeMappingError("POSTCHECK_PATH", "主创意路径没有映射为 LOVE。");
  }
  const blankColumns = [
    "creative_button", "mechanism_statement", "mechanism_primary", "mechanism_custom",
    "realization_skeleton", "brand_product_landing", "composite_state_reason",
    "formation_primary", "formation_statement", "creative_carriers",
    "establishment_conditions", "strength_sources", "acceptance_contract",
    "audiovisual_mechanism", "information_release_turning", "creative_grade",
    "creative_grade_reason",
  ];
  if (blankColumns.some((column) => stringValue(structure[column]))) {
    throw new WelcomeHomeMappingError("POSTCHECK_L3", "解释性 L3 字段没有保持空白。");
  }
  return pkg;
}

export async function applyWelcomeHomeMapping(args: {
  actor: CurrentUser;
  confirmation: string;
  previewToken: string;
  db?: DbClient;
  config?: WelcomeHomeMappingConfig;
  failAfterMappingForTest?: boolean;
}): Promise<WelcomeHomeMappingResult> {
  const db = args.db ?? getDbClient();
  const config = args.config ?? WELCOME_HOME_MAPPING_CONFIG;
  if (args.confirmation !== config.confirmation) {
    throw new WelcomeHomeMappingError("CONFIRMATION_MISMATCH", "确认口令不匹配。", 400);
  }
  if (args.failAfterMappingForTest && !config.operationKey.startsWith("TEST_ONLY_")) {
    throw new WelcomeHomeMappingError("TEST_HOOK_REJECTED", "生产操作禁止启用测试回滚钩子。", 400);
  }
  return db.withTransaction(async (tx) => {
    await tx.prepare(`SELECT pg_advisory_xact_lock(?)`).bind(734025031).run();
    await installAdminDataOperationSchema(tx);
    const inspection = await inspect(tx, config, args.actor, true);
    if (stringValue(inspection.ledger?.status) === "COMPLETED") {
      return mappedResultFromLedger(inspection.ledger!, config);
    }
    const preview = makePreview(inspection, config);
    if (!preview.ready) {
      throw new WelcomeHomeMappingError("PRECONDITION_FAILED", preview.reasons.join("；"));
    }
    if (!args.previewToken || args.previewToken !== preview.previewToken) {
      throw new WelcomeHomeMappingError("PREVIEW_STALE", "线上数据已变化，请重新执行 PREVIEW。", 409);
    }
    const sourceHash = sha256(inspection.sourcePackage);
    const targetHash = sha256(inspection.targetPackage);
    const nonTargetHash = sha256(inspection.nonTargetSummary);
    const createdAt = new Date().toISOString();
    const backup = {
      kind: "WELCOME_HOME_V02_TO_V03_PREWRITE_BACKUP",
      operationKey: config.operationKey,
      createdAt,
      config: {
        videoId: config.videoId,
        sourceAuthorName: config.sourceAuthorName,
        targetAuthorName: config.targetAuthorName,
        sourceSnapshotVersionNumber: config.sourceSnapshotVersionNumber,
        dataScope: config.dataScope,
      },
      targetMode: "CREATE",
      targetPackage: inspection.targetPackage,
      source: {
        annotationId: inspection.source?.id,
        workingRevision: inspection.source?.revision,
        snapshotId: inspection.sourceSnapshot?.id,
        snapshotRevision: inspection.sourceSnapshot?.revision,
        snapshotVersionNumber: inspection.sourceSnapshotVersionNumber,
        packageHash: sourceHash,
      },
      preservationCounts: inspection.preservationCounts,
      nonTargetSummary: inspection.nonTargetSummary,
    };
    await tx.prepare(
      `INSERT INTO admin_data_operations (
        operation_key, operation_type, target_video_id, status,
        actor_identity, actor_name, preview_token, source_hash, target_hash,
        non_target_hash, backup_json, created_at
      ) VALUES (?, 'V02_TO_V03_CASE_MAPPING', ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
    ).bind(
      config.operationKey, config.videoId, args.actor.identityKey, args.actor.displayName,
      preview.previewToken, sourceHash, targetHash, nonTargetHash,
      JSON.stringify(backup), createdAt,
    ).run();
    const { targetId, nextRevision } = await writeMappedDraft(tx, inspection);
    if (args.failAfterMappingForTest) {
      throw new WelcomeHomeMappingError("TEST_ROLLBACK", "TEST_ONLY 强制回滚。", 409);
    }
    const mappedPackage = await verifyMappedDraft(
      tx, targetId, nextRevision, String(inspection.sourceSnapshot!.id),
    );
    const afterNonTarget = await nonTargetSummary(tx, targetId);
    if (sha256(afterNonTarget) !== nonTargetHash) {
      throw new WelcomeHomeMappingError("NON_TARGET_CHANGED", "非目标业务数据发生变化，已回滚。");
    }
    const completedAt = new Date().toISOString();
    const result: WelcomeHomeMappingResult = {
      alreadyApplied: false,
      operationKey: config.operationKey,
      completedAt,
      target: {
        annotationId: targetId,
        status: "DRAFT",
        reviewStatus: "DRAFT",
        revision: nextRevision,
      },
      mapped: { shots: 23, groups: 7, legacyFields: 19 },
      createdNewTargetDraft: true,
      preservedExistingReleases: true,
      nonTargetBusinessDataUnchanged: true,
    };
    await tx.prepare(
      `INSERT INTO audit_logs (
        id, actor_email, action, object_type, object_id, detail_json
      ) VALUES (?, ?, 'V02_TO_V03_CASE_MAPPING', 'ADMIN_DATA_OPERATION', ?, ?)`,
    ).bind(
      newId("audit"), args.actor.identityKey, config.operationKey,
      JSON.stringify({
        operationKey: config.operationKey,
        targetAnnotationId: targetId,
        sourceWorkingRevision: inspection.source?.revision,
        sourceSnapshotRevision: inspection.sourceSnapshot?.revision,
        sourceSnapshotVersionNumber: inspection.sourceSnapshotVersionNumber,
        previousTargetRevision: null,
        newTargetRevision: nextRevision,
        sourceHash,
        previousTargetHash: targetHash,
        newTargetHash: sha256(mappedPackage),
        nonTargetHash,
        existingReleasesPreserved: true,
      }),
    ).run();
    const completion = await tx.prepare(
      `UPDATE admin_data_operations SET status = 'COMPLETED', result_json = ?::jsonb,
        completed_at = ? WHERE operation_key = ? AND status = 'RUNNING'`,
    ).bind(JSON.stringify(result), completedAt, config.operationKey).run();
    if (completion.meta.rows_written !== 1) {
      throw new WelcomeHomeMappingError("LEDGER_COMPLETION_FAILED", "操作账本未能完成，已回滚。");
    }
    return result;
  });
}
