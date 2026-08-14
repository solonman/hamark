import { createHash } from "node:crypto";
import { getDbClient, withDbTransaction, type DbClient } from "@/db";
import { annotationFields } from "@/lib/annotation-fields";
import { emptyAnnotation, loadAnnotationById } from "@/lib/annotation-server";
import type { CurrentUser } from "@/lib/auth/types";
import {
  emptyCreativeStructure,
  V03_TAXONOMY_VERSION,
  V03_VOCABULARY_VERSION,
  V03_WORKFLOW_VERSION,
} from "@/lib/taxonomy-v0.3";
import type {
  AnnotationDraft,
  CreativeStructureDraft,
  RevisionValueType,
} from "@/lib/types";

export type CollaborationRoundStatus =
  | "ACTIVE"
  | "FINALIZED"
  | "SUPERSEDED"
  | "SOFT_DELETED";

export type V03CollaborationContext = {
  streamId: string;
  videoId: string;
  annotationId: string;
  sourceAuthorName: string;
  sourceAuthorEmail: string;
  status: "ACTIVE" | "ARCHIVED";
  initialBaselineId: string;
  currentSnapshotId: string | null;
  activeReleaseId: string | null;
  activeReleaseNumber: number | null;
  roundId: string;
  roundNumber: number;
  roundStatus: CollaborationRoundStatus;
  roundBaseType:
    | "INITIAL_BASELINE"
    | "APPROVED_RELEASE"
    | "RESTORED_RELEASE"
    | "EMPTY_INITIAL";
  candidateSnapshotId: string | null;
  lastEditorName: string | null;
  lastEditedAt: string | null;
};

type CollaborationRow = {
  stream_id: string;
  video_id: string;
  annotation_id: string;
  source_author_email: string;
  source_author_name: string;
  stream_status: "ACTIVE" | "ARCHIVED";
  initial_baseline_id: string | null;
  current_snapshot_id: string | null;
  active_release_id: string | null;
  active_release_number: number | null;
  round_id: string | null;
  round_number: number | null;
  round_status: CollaborationRoundStatus | null;
  base_type: V03CollaborationContext["roundBaseType"] | null;
  candidate_snapshot_id: string | null;
  last_editor_name: string | null;
  last_edited_at: string | null;
};

export class V03CollaborationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
    public readonly serverRevision?: number,
  ) {
    super(message);
    this.name = "V03CollaborationError";
  }
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function jsonHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// 提交前判断"这份快照是否就是当前工作稿"时，只能比内容，不能比字节。
// 工作快照的 payload 是把客户端传来的对象展开拼装出来的，键序随客户端；
// 重新读库得到的对象走的是库内固定键序。同一份内容在两边序列化成不同的字节，
// 直接比 content_hash 会判成不一致，而提示里的"刷新后重试"永远修不好它 ——
// 刷新只会重新读库，改变不了已经冻结在快照里的键序。
const VOLATILE_CONTENT_KEYS = new Set([
  "status",
  "reviewStatus",
  "activeBaseSnapshotId",
  "updatedAt",
]);

function canonicalizeContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeContent);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      canonical[key] = canonicalizeContent(source[key]);
    }
    return canonical;
  }
  return value;
}

/**
 * 内容指纹：键序无关，且忽略提交动作本身就会改写的流转字段
 * （status / reviewStatus / activeBaseSnapshotId / updatedAt）。
 * 仅用于一致性判定，不用来替代 annotation_snapshots.content_hash 的存储值。
 */
export function sharedContentFingerprint(draft: unknown) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return jsonHash(canonicalizeContent(draft));
  }
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft as Record<string, unknown>)) {
    if (VOLATILE_CONTENT_KEYS.has(key)) continue;
    content[key] = value;
  }
  return jsonHash(canonicalizeContent(content));
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function loadV03CollaborationContext(
  videoId: string,
  db: DbClient = getDbClient(),
  lock = false,
) {
  let row: CollaborationRow | null;
  try {
    row = await db.prepare(
    `SELECT stream.id AS stream_id, stream.video_id,
      stream.canonical_annotation_id AS annotation_id,
      stream.source_author_email, stream.source_author_name,
      stream.status AS stream_status, stream.initial_baseline_id,
      stream.current_snapshot_id, stream.active_release_id,
      release.release_number AS active_release_number,
      round.id AS round_id, round.round_number, round.status AS round_status,
      round.base_type, round.candidate_snapshot_id,
      latest.actor_name AS last_editor_name,
      latest.created_at AS last_edited_at
    FROM v03_collaboration_streams stream
    LEFT JOIN v03_collaboration_rounds round ON round.id = stream.active_round_id
    LEFT JOIN approved_analysis_releases release ON release.id = stream.active_release_id
    LEFT JOIN LATERAL (
      SELECT actor_name, created_at
      FROM v03_collaboration_revision_events event
      WHERE event.stream_id = stream.id
      ORDER BY event.created_at DESC, event.id DESC LIMIT 1
    ) latest ON TRUE
    WHERE stream.video_id = ? AND stream.taxonomy_version = 'V0.3-PILOT'
      AND stream.status = 'ACTIVE'${lock ? " FOR UPDATE OF stream" : ""}`,
    ).bind(videoId).first<CollaborationRow>();
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "42P01" || code === "42703") return null;
    throw error;
  }
  if (!row || !row.initial_baseline_id || !row.round_id || row.round_number == null || !row.round_status || !row.base_type) {
    return null;
  }
  return {
    streamId: row.stream_id,
    videoId: row.video_id,
    annotationId: row.annotation_id,
    sourceAuthorName: row.source_author_name,
    sourceAuthorEmail: row.source_author_email,
    status: row.stream_status,
    initialBaselineId: row.initial_baseline_id,
    currentSnapshotId: row.current_snapshot_id,
    activeReleaseId: row.active_release_id,
    activeReleaseNumber: row.active_release_number == null
      ? null
      : Number(row.active_release_number),
    roundId: row.round_id,
    roundNumber: Number(row.round_number),
    roundStatus: row.round_status,
    roundBaseType: row.base_type,
    candidateSnapshotId: row.candidate_snapshot_id,
    lastEditorName: row.last_editor_name,
    lastEditedAt: row.last_edited_at,
  } satisfies V03CollaborationContext;
}

export async function loadSharedV03Annotation(
  videoId: string,
  db: DbClient = getDbClient(),
) {
  const collaboration = await loadV03CollaborationContext(videoId, db);
  if (!collaboration) return null;
  const annotation = await loadAnnotationById(collaboration.annotationId, db);
  if (!annotation || annotation.taxonomyVersion !== V03_TAXONOMY_VERSION) return null;
  return { collaboration, annotation };
}

type LegacyV03FallbackRow = {
  id: string;
  author_email: string;
  author_name: string;
  revision: number;
  updated_at: string;
};

function isNonEmptyV03(draft: AnnotationDraft) {
  return Boolean(
    draft.shots.length ||
    draft.shotGroups?.length ||
    draft.fields.some((field) => field.answer.trim() || field.evidence.trim()) ||
    [
      draft.analysisTitle,
      draft.commercialIntent,
      draft.creativeTheme,
      draft.synopsis,
      draft.thinkingChain,
      draft.shotCommentary,
      draft.summary,
    ].some((value) => value.trim()),
  );
}

/**
 * Read-only compatibility for the deployment window between installing the
 * shared schema and applying the controlled per-work backfill. The ordering is
 * the same deterministic preference used by the backfill preview. It never
 * creates or updates a row.
 */
export async function loadLegacyV03Fallback(
  videoId: string,
  db: DbClient = getDbClient(),
) {
  const rows = await db.prepare(
    `SELECT a.id, a.author_email, a.author_name, a.revision, a.updated_at
    FROM annotations a
    INNER JOIN videos video ON video.id = a.video_id
    WHERE a.video_id = ? AND a.taxonomy_version = 'V0.3-PILOT'
      AND a.deleted_at IS NULL AND video.deleted_at IS NULL
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1 FROM approved_analysis_releases active_release
        WHERE active_release.annotation_id = a.id AND active_release.status = 'ACTIVE'
      ) THEN 0 ELSE 1 END,
      CASE WHEN EXISTS (
        SELECT 1 FROM annotation_snapshots submitted
        WHERE submitted.annotation_id = a.id AND submitted.workflow_status = 'SUBMITTED'
      ) THEN 0 ELSE 1 END,
      a.updated_at DESC, a.revision DESC, a.id`,
  ).bind(videoId).all<LegacyV03FallbackRow>();
  for (const row of rows.results) {
    const annotation = await loadAnnotationById(row.id, db);
    if (!annotation || annotation.taxonomyVersion !== V03_TAXONOMY_VERSION || !isNonEmptyV03(annotation)) {
      continue;
    }
    return {
      annotation,
      annotationId: row.id,
      sourceAuthorEmail: row.author_email,
      sourceAuthorName: row.author_name,
      revision: Number(row.revision),
      updatedAt: row.updated_at,
    };
  }
  return null;
}

async function loadSnapshotDraft(
  snapshotId: string | null,
  db: DbClient,
) {
  if (!snapshotId) return null;
  const row = await db.prepare(
    `SELECT payload_json FROM annotation_snapshots WHERE id = ?`,
  ).bind(snapshotId).first<{ payload_json: unknown }>();
  if (!row) return null;
  return (typeof row.payload_json === "string"
    ? JSON.parse(row.payload_json)
    : row.payload_json) as AnnotationDraft;
}

export async function loadSharedV03ReadModel(
  videoId: string,
  db: DbClient = getDbClient(),
) {
  const collaboration = await loadV03CollaborationContext(videoId, db);
  if (!collaboration) {
    const fallback = await loadLegacyV03Fallback(videoId, db);
    if (!fallback) return null;
    return {
      collaboration: null,
      annotation: fallback.annotation,
      mutableAvailable: false,
      displaySource: "LEGACY_V03_FALLBACK" as const,
      pendingSharedBackfill: true,
      sourceAuthorName: fallback.sourceAuthorName,
      sourceUpdatedAt: fallback.updatedAt,
      contentHash: jsonHash(fallback.annotation),
    };
  }
  const live = await loadAnnotationById(collaboration.annotationId, db);
  if (live?.taxonomyVersion === V03_TAXONOMY_VERSION) {
    return {
      collaboration,
      annotation: live,
      mutableAvailable: true,
      displaySource: "WORKING" as const,
      pendingSharedBackfill: false,
      sourceAuthorName: collaboration.sourceAuthorName,
      sourceUpdatedAt: live.updatedAt,
      contentHash: jsonHash(live),
    };
  }
  const currentSnapshot = await loadSnapshotDraft(collaboration.currentSnapshotId, db);
  if (currentSnapshot?.taxonomyVersion === V03_TAXONOMY_VERSION) {
    return {
      collaboration,
      annotation: currentSnapshot,
      mutableAvailable: false,
      displaySource: "IMMUTABLE_SNAPSHOT" as const,
      pendingSharedBackfill: false,
      sourceAuthorName: collaboration.sourceAuthorName,
      sourceUpdatedAt: currentSnapshot.updatedAt,
      contentHash: jsonHash(currentSnapshot),
    };
  }
  if (collaboration.activeReleaseId) {
    const release = await db.prepare(
      `SELECT payload_json FROM approved_analysis_releases WHERE id = ?`,
    ).bind(collaboration.activeReleaseId).first<{ payload_json: unknown }>();
    const payload = release
      ? (typeof release.payload_json === "string"
          ? JSON.parse(release.payload_json)
          : release.payload_json) as AnnotationDraft
      : null;
    if (payload?.taxonomyVersion === V03_TAXONOMY_VERSION) {
      return {
        collaboration,
        annotation: payload,
        mutableAvailable: false,
        displaySource: "APPROVED_RELEASE" as const,
        pendingSharedBackfill: false,
        sourceAuthorName: collaboration.sourceAuthorName,
        sourceUpdatedAt: payload.updatedAt,
        contentHash: jsonHash(payload),
      };
    }
  }
  const baseline = await db.prepare(
    `SELECT payload_json FROM v03_collaboration_baselines WHERE id = ?`,
  ).bind(collaboration.initialBaselineId).first<{ payload_json: unknown }>();
  const payload = baseline
    ? (typeof baseline.payload_json === "string"
        ? JSON.parse(baseline.payload_json)
        : baseline.payload_json) as AnnotationDraft
    : null;
  if (!payload || payload.taxonomyVersion !== V03_TAXONOMY_VERSION) return null;
  return {
    collaboration,
    annotation: payload,
    mutableAvailable: false,
    displaySource: "INITIAL_BASELINE" as const,
    pendingSharedBackfill: false,
    sourceAuthorName: collaboration.sourceAuthorName,
    sourceUpdatedAt: payload.updatedAt,
    contentHash: jsonHash(payload),
  };
}

type FlatValue = {
  label: string;
  valueType: RevisionValueType | "STRUCTURE";
  value: unknown;
};

function flatDraft(draft: AnnotationDraft) {
  const values = new Map<string, FlatValue>();
  const text = (key: string, label: string, value: string) =>
    values.set(key, { label, valueType: "TEXT", value });
  const single = (key: string, label: string, value: string) =>
    values.set(key, { label, valueType: "SINGLE_SELECT", value });
  const multi = (key: string, label: string, value: string[]) =>
    values.set(key, { label, valueType: "MULTI_SELECT", value });
  const structure = (key: string, label: string, value: unknown) =>
    values.set(key, { label, valueType: "STRUCTURE", value });

  text("core:analysis-title", "分析标题", draft.analysisTitle);
  text("core:commercial-intent", "商业意图", draft.commercialIntent);
  text("core:creative-theme", "创意母题", draft.creativeTheme);
  text("core:story-synopsis", "故事梗概", draft.synopsis);
  text("core:thinking-chain", "创意思维链", draft.thinkingChain);
  text("core:shot-commentary", "镜头创意点评", draft.shotCommentary);
  text("core:full-summary", "全篇创意总结", draft.summary);

  structure(
    "groups:order",
    "桥段顺序",
    (draft.shotGroups ?? []).map((group) => group.id),
  );
  for (const group of draft.shotGroups ?? []) {
    text(`group:${group.id}:title`, `${group.title || "桥段"} · 名称`, group.title);
    text(`group:${group.id}:note`, `${group.title || "桥段"} · 创意作用`, group.note);
    text(`group:${group.id}:custom-role`, `${group.title || "桥段"} · 自定义作用`, group.customRole);
    single(`group:${group.id}:primary-role`, `${group.title || "桥段"} · 主要作用`, group.primaryRole);
    multi(`group:${group.id}:auxiliary-roles`, `${group.title || "桥段"} · 辅助作用`, group.auxiliaryRoles);
  }

  structure("shots:order", "镜头顺序", draft.shots.map((shot) => shot.id));
  const shotTextKeys = [
    ["group-name", "groupName", "镜头组"],
    ["start-time", "startTime", "开始时间"],
    ["end-time", "endTime", "结束时间"],
    ["shot-size", "shotSize", "景别"],
    ["camera-angle", "cameraAngle", "机位／角度"],
    ["camera-movement", "cameraMovement", "镜头运动"],
    ["visual-content", "visualContent", "画面内容"],
    ["dialogue", "dialogue", "对白"],
    ["voiceover", "voiceover", "旁白"],
    ["screen-text", "screenText", "字幕／屏幕文案"],
    ["sound-effect", "soundEffect", "声效"],
    ["music", "music", "音乐"],
    ["creative-comment", "creativeComment", "创意点评"],
  ] as const;
  for (const shot of draft.shots) {
    structure(`shot:${shot.id}:placement`, `镜头 ${shot.shotNumber} · 位置`, {
      orderIndex: shot.orderIndex,
      shotNumber: shot.shotNumber,
      shotGroupId: shot.shotGroupId ?? null,
    });
    for (const [suffix, property, label] of shotTextKeys) {
      text(`shot:${shot.id}:${suffix}`, `镜头 ${shot.shotNumber} · ${label}`, shot[property]);
    }
  }

  for (const field of draft.fields) {
    text(`field:${field.code}:answer`, `${field.code} 标注答案`, field.answer);
    text(`field:${field.code}:evidence`, `${field.code} 标注依据`, field.evidence);
  }

  const creative = draft.creativeStructure ?? emptyCreativeStructure();
  const creativeText = [
    ["creative-button", "creativeButton", "创意按钮"],
    ["mechanism-statement", "mechanismStatement", "机制说明"],
    ["mechanism-custom", "mechanismCustom", "自定义机制"],
    ["creative-realization-path", "creativeRealizationPath", "创意兑现路径"],
    ["brand-product-landing", "brandProductLanding", "品牌／产品落点"],
    ["story-reference-type", "storyReferenceType", "故事参照类型"],
    ["story-archetype", "storyArchetype", "故事原型"],
    ["composite-state-reason", "compositeStateReason", "复合状态理由"],
    ["formation-statement", "formationStatement", "全片形成方式说明"],
    ["creative-carriers", "creativeCarriers", "创意载体"],
    ["establishment-conditions", "establishmentConditions", "成立条件"],
    ["strength-sources", "strengthSources", "力量来源"],
    ["acceptance-contract", "acceptanceContract", "接受契约"],
    ["audiovisual-mechanism", "audiovisualMechanism", "视听机制"],
    ["information-release-turning", "informationReleaseTurning", "信息释放转折"],
    ["creative-grade-reason", "creativeGradeReason", "创意等级理由"],
  ] as const;
  for (const [suffix, property, label] of creativeText) {
    const value = property === "creativeRealizationPath"
      ? creative.creativeRealizationPath || creative.realizationSkeleton
      : String(creative[property] ?? "");
    text(`structure:${suffix}`, label, value);
  }
  single("structure:mechanism-primary", "主机制", creative.mechanismPrimary);
  multi("structure:mechanism-auxiliary", "辅助机制", creative.mechanismAuxiliary);
  single("structure:formation-primary", "全片主形成方式", creative.formationPrimary);
  multi("structure:formation-auxiliary", "全片辅助形成方式", creative.formationAuxiliary);
  multi("structure:formation-related-groups", "相关桥段", creative.formationRelatedGroupIds);
  single("structure:primary-creative-path", "主导创意路径", creative.primaryCreativePath);
  multi("structure:auxiliary-creative-paths", "辅助创意路径", creative.auxiliaryCreativePaths);
  structure("structure:main-path-payload", "主路径内容", creative.mainPathPayload);
  structure("structure:auxiliary-path-notes", "辅助路径说明", creative.auxiliaryPathNotes);
  structure("structure:condition-flags", "条件显示标记", creative.conditionFlags);
  single("structure:creative-grade", "作品创意等级自评", creative.creativeGrade);
  return values;
}

export type CollaborationChange = {
  targetKey: string;
  targetLabel: string;
  valueType: RevisionValueType | "STRUCTURE";
  beforeValue: unknown;
  afterValue: unknown;
};

export function diffSharedDraft(
  before: AnnotationDraft,
  after: AnnotationDraft,
): CollaborationChange[] {
  const left = flatDraft(before);
  const right = flatDraft(after);
  const keys = new Set([...left.keys(), ...right.keys()]);
  const changes: CollaborationChange[] = [];
  for (const key of keys) {
    const beforeValue = left.get(key);
    const afterValue = right.get(key);
    if (JSON.stringify(beforeValue?.value ?? null) === JSON.stringify(afterValue?.value ?? null)) continue;
    changes.push({
      targetKey: key,
      targetLabel: afterValue?.label ?? beforeValue?.label ?? key,
      valueType: afterValue?.valueType ?? beforeValue?.valueType ?? "STRUCTURE",
      beforeValue: beforeValue?.value ?? null,
      afterValue: afterValue?.value ?? null,
    });
  }
  return changes;
}

function normalizedStructure(
  value: CreativeStructureDraft | undefined,
  validGroupIds: Set<string>,
) {
  const structure = value ?? emptyCreativeStructure();
  return {
    ...structure,
    vocabularyVersion: V03_VOCABULARY_VERSION,
    creativeButton: structure.creativeButton.trim(),
    mechanismStatement: structure.mechanismStatement.trim(),
    mechanismAuxiliary: [...new Set(structure.mechanismAuxiliary)].slice(0, 2),
    mechanismCustom: structure.mechanismCustom.trim(),
    creativeRealizationPath: (structure.creativeRealizationPath || structure.realizationSkeleton).trim(),
    realizationSkeleton: (structure.creativeRealizationPath || structure.realizationSkeleton).trim(),
    brandProductLanding: structure.brandProductLanding.trim(),
    storyReferenceType: structure.storyReferenceType.trim(),
    storyArchetype: structure.storyArchetype.trim(),
    auxiliaryCreativePaths: [...new Set(structure.auxiliaryCreativePaths)].slice(0, 2),
    compositeStateReason: structure.compositeStateReason.trim(),
    formationAuxiliary: [...new Set(structure.formationAuxiliary)].slice(0, 2),
    formationStatement: structure.formationStatement.trim(),
    formationRelatedGroupIds: [...new Set(structure.formationRelatedGroupIds)]
      .filter((id) => validGroupIds.has(id)),
    creativeCarriers: structure.creativeCarriers.trim(),
    establishmentConditions: structure.establishmentConditions.trim(),
    strengthSources: structure.strengthSources.trim(),
    acceptanceContract: structure.acceptanceContract.trim(),
    audiovisualMechanism: structure.audiovisualMechanism.trim(),
    informationReleaseTurning: structure.informationReleaseTurning.trim(),
    creativeGradeReason: structure.creativeGradeReason.trim(),
  } satisfies CreativeStructureDraft;
}

export function normalizeSharedDraft(
  payload: AnnotationDraft,
  current: AnnotationDraft,
  nextRevision: number,
  updatedAt: string,
) {
  const groups = (payload.shotGroups ?? []).slice(0, 100).map((group, index) => ({
    ...group,
    orderIndex: index,
    title: group.title.trim(),
    primaryRole: group.primaryRole.trim(),
    auxiliaryRoles: [...new Set(group.auxiliaryRoles)].slice(0, 2),
    customRole: group.customRole.trim(),
    note: group.note.trim(),
  }));
  const groupIds = new Set(groups.map((group) => group.id));
  const shots = payload.shots.slice(0, 500).map((shot, index) => ({
    ...shot,
    orderIndex: index,
    shotNumber: shot.shotNumber || String(index + 1),
    shotGroupId: shot.shotGroupId && groupIds.has(shot.shotGroupId)
      ? shot.shotGroupId
      : null,
    groupName: groups.find((group) => group.id === shot.shotGroupId)?.title ?? "",
    creativeComment: "",
  }));
  const fieldMap = new Map(payload.fields.map((field) => [field.code, field]));
  return {
    ...current,
    id: current.id,
    videoId: current.videoId,
    authorName: current.authorName,
    taxonomyVersion: V03_TAXONOMY_VERSION,
    workflowVersion: V03_WORKFLOW_VERSION,
    status: "DRAFT" as const,
    reviewStatus: "DRAFT" as const,
    activeBaseSnapshotId: null,
    revision: nextRevision,
    analysisTitle: payload.analysisTitle.trim(),
    commercialIntent: payload.commercialIntent.trim(),
    creativeTheme: payload.creativeTheme.trim(),
    synopsis: payload.synopsis.trim(),
    thinkingChain: payload.thinkingChain.trim(),
    shotCommentary: payload.shotCommentary.trim(),
    summary: payload.summary.trim(),
    shots,
    shotGroups: groups,
    fields: annotationFields.map((field) => ({
      code: field.code,
      answer: fieldMap.get(field.code)?.answer ?? "",
      evidence: fieldMap.get(field.code)?.evidence ?? "",
      source: fieldMap.get(field.code)?.source ?? "HUMAN_ORIGINAL",
    })),
    creativeStructure: normalizedStructure(payload.creativeStructure, groupIds),
    updatedAt,
  } satisfies AnnotationDraft;
}

export async function replaceMutablePackage(
  db: DbClient,
  annotationId: string,
  draft: AnnotationDraft,
) {
  const groups = draft.shotGroups ?? [];
  const structure = draft.creativeStructure ?? emptyCreativeStructure();
  await db.prepare(
    `UPDATE annotations SET workflow_version = ?, status = 'DRAFT',
      review_status = 'DRAFT', active_base_snapshot_id = NULL,
      revision = ?, analysis_title = ?, commercial_intent = ?, creative_theme = ?,
      synopsis = ?, thinking_chain = ?, shot_commentary = ?, summary = ?,
      updated_at = ? WHERE id = ? AND taxonomy_version = 'V0.3-PILOT'`,
  ).bind(
    V03_WORKFLOW_VERSION,
    draft.revision,
    draft.analysisTitle,
    draft.commercialIntent,
    draft.creativeTheme,
    draft.synopsis,
    draft.thinkingChain,
    draft.shotCommentary,
    draft.summary,
    draft.updatedAt,
    annotationId,
  ).run();
  await db.prepare(`DELETE FROM shots WHERE annotation_id = ?`).bind(annotationId).run();
  await db.prepare(`DELETE FROM shot_groups WHERE annotation_id = ?`).bind(annotationId).run();
  await db.prepare(`DELETE FROM field_answers WHERE annotation_id = ?`).bind(annotationId).run();
  await db.prepare(`DELETE FROM annotation_creative_structures WHERE annotation_id = ?`).bind(annotationId).run();

  for (const group of groups) {
    await db.prepare(
      `INSERT INTO shot_groups (
        id, annotation_id, order_index, title, primary_role_id,
        primary_role_name_snapshot, auxiliary_roles_json, custom_role,
        note, taxonomy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'V0.3-PILOT')`,
    ).bind(
      group.id,
      annotationId,
      group.orderIndex,
      group.title,
      group.primaryRole,
      group.primaryRole,
      JSON.stringify(group.auxiliaryRoles),
      group.customRole,
      group.note,
    ).run();
  }
  for (const shot of draft.shots) {
    await db.prepare(
      `INSERT INTO shots (
        id, annotation_id, order_index, group_name, shot_number,
        start_time, end_time, shot_size, camera_angle, camera_movement,
        visual_content, dialogue, voiceover, screen_text, sound_effect,
        music, creative_comment, shot_group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    ).bind(
      shot.id,
      annotationId,
      shot.orderIndex,
      shot.groupName,
      shot.shotNumber,
      shot.startTime,
      shot.endTime,
      shot.shotSize,
      shot.cameraAngle,
      shot.cameraMovement,
      shot.visualContent,
      shot.dialogue,
      shot.voiceover,
      shot.screenText,
      shot.soundEffect,
      shot.music,
      shot.shotGroupId ?? null,
    ).run();
  }
  for (const field of draft.fields) {
    await db.prepare(
      `INSERT INTO field_answers (id, annotation_id, field_code, answer, evidence, source)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId("field"), annotationId, field.code, field.answer, field.evidence,
      field.source ?? "HUMAN_ORIGINAL",
    ).run();
  }
  await db.prepare(
    `INSERT INTO annotation_creative_structures (
      annotation_id, vocabulary_version, creative_button, mechanism_statement,
      mechanism_primary, mechanism_auxiliary_json, mechanism_custom,
      realization_skeleton, brand_product_landing, story_reference_type,
      story_archetype, primary_creative_path, auxiliary_creative_paths_json,
      composite_state_reason, formation_primary, formation_auxiliary_json,
      formation_statement, formation_related_group_ids_json, creative_carriers,
      establishment_conditions, strength_sources, acceptance_contract,
      audiovisual_mechanism, information_release_turning, creative_grade,
      creative_grade_reason, creative_grade_version, main_path_payload_json,
      auxiliary_path_notes_json, condition_flags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    annotationId,
    V03_VOCABULARY_VERSION,
    structure.creativeButton,
    structure.mechanismStatement,
    structure.mechanismPrimary,
    JSON.stringify(structure.mechanismAuxiliary),
    structure.mechanismCustom,
    structure.creativeRealizationPath || structure.realizationSkeleton,
    structure.brandProductLanding,
    structure.storyReferenceType,
    structure.storyArchetype,
    structure.primaryCreativePath,
    JSON.stringify(structure.auxiliaryCreativePaths),
    structure.compositeStateReason,
    structure.formationPrimary,
    JSON.stringify(structure.formationAuxiliary),
    structure.formationStatement,
    JSON.stringify(structure.formationRelatedGroupIds),
    structure.creativeCarriers,
    structure.establishmentConditions,
    structure.strengthSources,
    structure.acceptanceContract,
    structure.audiovisualMechanism,
    structure.informationReleaseTurning,
    structure.creativeGrade,
    structure.creativeGradeReason,
    structure.creativeGradeVersion,
    JSON.stringify(structure.mainPathPayload),
    JSON.stringify(structure.auxiliaryPathNotes),
    JSON.stringify(structure.conditionFlags),
  ).run();
}

function cloneReleasePayload(
  source: AnnotationDraft,
  current: AnnotationDraft,
) {
  const groupIdMap = new Map<string, string>();
  const groups = (source.shotGroups ?? []).map((group, index) => {
    const id = newId("group");
    groupIdMap.set(group.id, id);
    return { ...group, id, orderIndex: index };
  });
  return {
    ...structuredClone(source),
    id: current.id,
    videoId: current.videoId,
    authorName: current.authorName,
    shots: source.shots.map((shot, index) => ({
      ...shot,
      id: newId("shot"),
      orderIndex: index,
      shotGroupId: shot.shotGroupId
        ? groupIdMap.get(shot.shotGroupId) ?? null
        : null,
    })),
    shotGroups: groups,
    creativeStructure: source.creativeStructure
      ? {
          ...structuredClone(source.creativeStructure),
          formationRelatedGroupIds:
            source.creativeStructure.formationRelatedGroupIds.flatMap((id) => {
              const mapped = groupIdMap.get(id);
              return mapped ? [mapped] : [];
            }),
        }
      : emptyCreativeStructure(),
  } satisfies AnnotationDraft;
}

export async function restoreSharedV03FromRelease(input: {
  releaseId: string;
  actor: CurrentUser;
}) {
  return withDbTransaction(async (db) => {
    const release = await db.prepare(
      `SELECT release.id, release.video_id, release.release_number,
        release.approved_snapshot_id, release.source_snapshot_id,
        release.payload_json, release.content_hash, release.status
      FROM approved_analysis_releases release
      INNER JOIN videos video ON video.id = release.video_id
      WHERE release.id = ? AND release.status <> 'WITHDRAWN'
        AND video.deleted_at IS NULL FOR UPDATE OF release`,
    ).bind(input.releaseId).first<{
      id: string;
      video_id: string;
      release_number: number;
      approved_snapshot_id: string;
      source_snapshot_id: string;
      payload_json: string | AnnotationDraft;
      content_hash: string;
      status: string;
    }>();
    if (!release) {
      throw new V03CollaborationError("RELEASE_NOT_FOUND", "批准版本不存在或不可恢复。", 404);
    }
    const collaboration = await loadV03CollaborationContext(release.video_id, db, true);
    if (!collaboration) {
      throw new V03CollaborationError("SHARED_STREAM_MISSING", "该作品尚未接入公共 V0.3。", 409);
    }
    const locked = await db.prepare(
      `SELECT revision FROM annotations WHERE id = ? FOR UPDATE`,
    ).bind(collaboration.annotationId).first<{ revision: number }>();
    const current = await loadAnnotationById(collaboration.annotationId, db)
      ?? await loadSnapshotDraft(collaboration.currentSnapshotId, db)
      ?? await loadSnapshotDraft(release.approved_snapshot_id, db);
    if (!locked || !current) {
      throw new V03CollaborationError("CANONICAL_MISSING", "公共 V0.3 工作稿不存在。", 409);
    }
    const source = typeof release.payload_json === "string"
      ? JSON.parse(release.payload_json) as AnnotationDraft
      : release.payload_json;
    const updatedAt = new Date().toISOString();
    const nextRevision = Number(locked.revision) + 1;
    const restored = normalizeSharedDraft(
      cloneReleasePayload(source, current),
      current,
      nextRevision,
      updatedAt,
    );
    restored.baseReleaseId = release.id;
    restored.baseReleaseNumber = Number(release.release_number);
    restored.baseSnapshotId = release.approved_snapshot_id;
    restored.sourcePublicSnapshotId = release.source_snapshot_id;
    const changes = diffSharedDraft(current, restored);
    await replaceMutablePackage(db, collaboration.annotationId, restored);
    await db.prepare(
      `UPDATE annotations SET base_release_id = ?, base_snapshot_id = ?,
        source_public_snapshot_id = ?, deleted_at = NULL WHERE id = ?`,
    ).bind(
      release.id,
      release.approved_snapshot_id,
      release.source_snapshot_id,
      collaboration.annotationId,
    ).run();

    const newRoundId = newId("collaboration_round");
    const snapshotId = newId("working_snapshot");
    const changeSetId = newId("collaboration_restore");
    const payloadJson = JSON.stringify(restored);
    await db.prepare(
      `UPDATE v03_collaboration_rounds SET status = 'SUPERSEDED',
        ended_by_email = ?, ended_by_name = ?, ended_at = ?
      WHERE id = ? AND status = 'ACTIVE'`,
    ).bind(
      input.actor.identityKey,
      input.actor.displayName,
      updatedAt,
      collaboration.roundId,
    ).run();
    await db.prepare(
      `INSERT INTO v03_collaboration_rounds (
        id, stream_id, annotation_id, round_number, status, base_type,
        base_release_id, base_snapshot_id, starting_revision,
        created_by_email, created_by_name
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 'RESTORED_RELEASE', ?, ?, ?, ?, ?)`,
    ).bind(
      newRoundId,
      collaboration.streamId,
      collaboration.annotationId,
      collaboration.roundNumber + 1,
      release.id,
      release.approved_snapshot_id,
      Number(locked.revision),
      input.actor.identityKey,
      input.actor.displayName,
    ).run();
    await db.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name,
        taxonomy_version, revision, payload_json, content_hash,
        base_snapshot_id, revision_cause, workflow_status, snapshot_kind,
        base_release_id, source_public_snapshot_id
      ) VALUES (?, ?, ?, ?, ?, 'V0.3-PILOT', ?, ?, ?, ?,
        'RESTORED_RELEASE', 'WORKING', 'WORKING', ?, ?)`,
    ).bind(
      snapshotId,
      collaboration.annotationId,
      release.video_id,
      input.actor.identityKey,
      input.actor.displayName,
      nextRevision,
      payloadJson,
      jsonHash(restored),
      release.approved_snapshot_id,
      release.id,
      release.source_snapshot_id,
    ).run();
    for (const change of changes) {
      await db.prepare(
        `INSERT INTO v03_collaboration_revision_events (
          id, stream_id, round_id, annotation_id, change_set_id,
          base_revision, applied_revision, target_key, target_label,
          value_type, before_value_json, after_value_json, reason,
          actor_email, actor_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)`,
      ).bind(
        newId("collaboration_revision"),
        collaboration.streamId,
        newRoundId,
        collaboration.annotationId,
        changeSetId,
        Number(locked.revision),
        nextRevision,
        change.targetKey,
        change.targetLabel,
        change.valueType,
        JSON.stringify(change.beforeValue),
        JSON.stringify(change.afterValue),
        `从历史批准版 R${release.release_number} 创建恢复轮`,
        input.actor.identityKey,
        input.actor.displayName,
      ).run();
    }
    await db.prepare(
      `UPDATE approved_analysis_releases SET status = 'SUPERSEDED'
      WHERE video_id = ? AND status = 'ACTIVE' AND id <> ?`,
    ).bind(release.video_id, release.id).run();
    await db.prepare(
      `UPDATE approved_analysis_releases SET status = 'ACTIVE' WHERE id = ?`,
    ).bind(release.id).run();
    await db.prepare(
      `UPDATE v03_collaboration_streams SET active_round_id = ?,
        active_release_id = ?, current_snapshot_id = ?, updated_at = ?
      WHERE id = ?`,
    ).bind(newRoundId, release.id, snapshotId, updatedAt, collaboration.streamId).run();
    await db.prepare(
      `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
      VALUES (?, ?, 'SHARED_V03_RELEASE_RESTORED', 'APPROVED_RELEASE', ?, ?)`,
    ).bind(newId("audit"), input.actor.identityKey, release.id, JSON.stringify({
      streamId: collaboration.streamId,
      previousRoundId: collaboration.roundId,
      newRoundId,
      snapshotId,
      baseRevision: Number(locked.revision),
      appliedRevision: nextRevision,
    })).run();
    return {
      ok: true,
      videoId: release.video_id,
      releaseId: release.id,
      releaseNumber: Number(release.release_number),
      roundId: newRoundId,
      roundNumber: collaboration.roundNumber + 1,
      revision: nextRevision,
      snapshotId,
    };
  });
}

export async function restoreSharedV03FromBaseline(input: {
  baselineId: string;
  actor: CurrentUser;
}) {
  return withDbTransaction(async (db) => {
    const baseline = await db.prepare(
      `SELECT baseline.id, baseline.stream_id, baseline.payload_json,
        baseline.source_snapshot_id, stream.video_id,
        stream.canonical_annotation_id
      FROM v03_collaboration_baselines baseline
      INNER JOIN v03_collaboration_streams stream ON stream.id = baseline.stream_id
      INNER JOIN videos video ON video.id = stream.video_id
      WHERE baseline.id = ? AND stream.status = 'ACTIVE'
        AND video.deleted_at IS NULL FOR UPDATE OF baseline, stream`,
    ).bind(input.baselineId).first<{
      id: string;
      stream_id: string;
      payload_json: unknown;
      source_snapshot_id: string | null;
      video_id: string;
      canonical_annotation_id: string;
    }>();
    if (!baseline) {
      throw new V03CollaborationError("BASELINE_NOT_FOUND", "公共初始基线不存在或不可恢复。", 404);
    }
    const collaboration = await loadV03CollaborationContext(baseline.video_id, db, true);
    if (!collaboration || collaboration.streamId !== baseline.stream_id) {
      throw new V03CollaborationError("SHARED_STREAM_MISSING", "该作品尚未接入公共 V0.3。", 409);
    }
    const locked = await db.prepare(
      `SELECT revision FROM annotations WHERE id = ? FOR UPDATE`,
    ).bind(collaboration.annotationId).first<{ revision: number }>();
    const current = await loadAnnotationById(collaboration.annotationId, db)
      ?? await loadSnapshotDraft(collaboration.currentSnapshotId, db)
      ?? (typeof baseline.payload_json === "string"
        ? JSON.parse(baseline.payload_json) as AnnotationDraft
        : baseline.payload_json as AnnotationDraft);
    if (!locked || !current) {
      throw new V03CollaborationError("CANONICAL_MISSING", "公共 V0.3 工作记录不存在。", 409);
    }
    const source = typeof baseline.payload_json === "string"
      ? JSON.parse(baseline.payload_json) as AnnotationDraft
      : baseline.payload_json as AnnotationDraft;
    const updatedAt = new Date().toISOString();
    const nextRevision = Number(locked.revision) + 1;
    const restored = normalizeSharedDraft(
      cloneReleasePayload(source, current),
      current,
      nextRevision,
      updatedAt,
    );
    restored.baseReleaseId = null;
    restored.baseReleaseNumber = null;
    restored.baseSnapshotId = baseline.source_snapshot_id;
    restored.sourcePublicSnapshotId = baseline.source_snapshot_id;
    const changes = diffSharedDraft(current, restored);
    await replaceMutablePackage(db, collaboration.annotationId, restored);
    await db.prepare(
      `UPDATE annotations SET base_release_id = NULL, base_snapshot_id = ?,
        source_public_snapshot_id = ?, deleted_at = NULL WHERE id = ?`,
    ).bind(
      baseline.source_snapshot_id,
      baseline.source_snapshot_id,
      collaboration.annotationId,
    ).run();

    const newRoundId = newId("collaboration_round");
    const snapshotId = newId("working_snapshot");
    const changeSetId = newId("collaboration_restore");
    const payloadJson = JSON.stringify(restored);
    await db.prepare(
      `UPDATE v03_collaboration_rounds SET status = 'SUPERSEDED',
        ended_by_email = ?, ended_by_name = ?, ended_at = ?
      WHERE id = ? AND status = 'ACTIVE'`,
    ).bind(input.actor.identityKey, input.actor.displayName, updatedAt, collaboration.roundId).run();
    await db.prepare(
      `INSERT INTO v03_collaboration_rounds (
        id, stream_id, annotation_id, round_number, status, base_type,
        base_baseline_id, base_snapshot_id, starting_revision,
        created_by_email, created_by_name
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 'INITIAL_BASELINE', ?, ?, ?, ?, ?)`,
    ).bind(
      newRoundId,
      collaboration.streamId,
      collaboration.annotationId,
      collaboration.roundNumber + 1,
      baseline.id,
      baseline.source_snapshot_id,
      Number(locked.revision),
      input.actor.identityKey,
      input.actor.displayName,
    ).run();
    await db.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name,
        taxonomy_version, revision, payload_json, content_hash,
        base_snapshot_id, revision_cause, workflow_status, snapshot_kind,
        source_public_snapshot_id
      ) VALUES (?, ?, ?, ?, ?, 'V0.3-PILOT', ?, ?, ?, ?,
        'RESTORED_INITIAL_BASELINE', 'WORKING', 'WORKING', ?)`,
    ).bind(
      snapshotId,
      collaboration.annotationId,
      baseline.video_id,
      input.actor.identityKey,
      input.actor.displayName,
      nextRevision,
      payloadJson,
      jsonHash(restored),
      baseline.source_snapshot_id,
      baseline.source_snapshot_id,
    ).run();
    for (const change of changes) {
      await db.prepare(
        `INSERT INTO v03_collaboration_revision_events (
          id, stream_id, round_id, annotation_id, change_set_id,
          base_revision, applied_revision, target_key, target_label,
          value_type, before_value_json, after_value_json, reason,
          actor_email, actor_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)`,
      ).bind(
        newId("collaboration_revision"), collaboration.streamId, newRoundId,
        collaboration.annotationId, changeSetId, Number(locked.revision),
        nextRevision, change.targetKey, change.targetLabel, change.valueType,
        JSON.stringify(change.beforeValue), JSON.stringify(change.afterValue),
        "从永久保留的公共初始基线创建恢复轮",
        input.actor.identityKey, input.actor.displayName,
      ).run();
    }
    await db.prepare(
      `UPDATE approved_analysis_releases SET status = 'SUPERSEDED'
      WHERE video_id = ? AND status = 'ACTIVE'`,
    ).bind(baseline.video_id).run();
    await db.prepare(
      `UPDATE v03_collaboration_streams SET active_round_id = ?,
        active_release_id = NULL, current_snapshot_id = ?, updated_at = ?
      WHERE id = ?`,
    ).bind(newRoundId, snapshotId, updatedAt, collaboration.streamId).run();
    await db.prepare(
      `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
      VALUES (?, ?, 'SHARED_V03_BASELINE_RESTORED', 'V03_COLLABORATION_BASELINE', ?, ?)`,
    ).bind(newId("audit"), input.actor.identityKey, baseline.id, JSON.stringify({
      streamId: collaboration.streamId,
      previousRoundId: collaboration.roundId,
      newRoundId,
      snapshotId,
      baseRevision: Number(locked.revision),
      appliedRevision: nextRevision,
    })).run();
    return {
      ok: true,
      videoId: baseline.video_id,
      baselineId: baseline.id,
      roundId: newRoundId,
      roundNumber: collaboration.roundNumber + 1,
      revision: nextRevision,
      snapshotId,
    };
  });
}

export async function saveSharedV03Draft(input: {
  videoId: string;
  payload: AnnotationDraft;
  actor: CurrentUser;
  reason?: string;
  expectedSnapshotId?: string;
}) {
  return withDbTransaction(async (db) => {
    await db.prepare(
      `SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`,
    ).bind(`v03-logical-workspace:${input.videoId}`).run();
    let collaboration = await loadV03CollaborationContext(input.videoId, db, true);
    if (!collaboration) {
      const legacy = await loadLegacyV03Fallback(input.videoId, db);
      if (legacy) {
        throw new V03CollaborationError(
          "SHARED_STREAM_PENDING_BACKFILL",
          "这份既有 V0.3 尚未接入公共主线，原文保持只读；请稍后重试。",
          409,
        );
      }
      const video = await db.prepare(
        `SELECT id FROM videos WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      ).bind(input.videoId).first<{ id: string }>();
      if (!video) {
        throw new V03CollaborationError("VIDEO_MISSING", "视频不存在。", 404);
      }
      if (Number(input.payload.revision) !== 0 || input.payload.id) {
        throw new V03CollaborationError(
          "INITIAL_REVISION_CONFLICT",
          "公共工作区状态已经变化；本页内容仍保留，请刷新后重试。",
          409,
          0,
        );
      }

      const createdAt = new Date().toISOString();
      const annotationId = newId("annotation");
      const streamId = newId("collaboration_stream");
      const baselineId = newId("collaboration_baseline");
      const roundId = newId("collaboration_round");
      const blank = emptyAnnotation(
        input.videoId,
        input.actor.displayName,
        V03_TAXONOMY_VERSION,
      );
      blank.id = annotationId;
      blank.updatedAt = createdAt;

      await db.prepare(
        `INSERT INTO annotations (
          id, video_id, author_email, author_name, taxonomy_version,
          workflow_version, status, review_status, revision,
          analysis_title, commercial_intent, creative_theme, synopsis,
          thinking_chain, shot_commentary, summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'V0.3-PILOT', ?, 'DRAFT', 'DRAFT', 0,
          '', '', '', '', '', '', '', ?, ?)`,
      ).bind(
        annotationId,
        input.videoId,
        input.actor.identityKey,
        input.actor.displayName,
        V03_WORKFLOW_VERSION,
        createdAt,
        createdAt,
      ).run();
      await db.prepare(
        `INSERT INTO v03_collaboration_streams (
          id, video_id, taxonomy_version, canonical_annotation_id,
          initial_baseline_id, active_round_id, active_release_id,
          current_snapshot_id, source_author_email, source_author_name,
          status, created_by_email, created_by_name, created_at, updated_at
        ) VALUES (?, ?, 'V0.3-PILOT', ?, NULL, NULL, NULL, NULL,
          ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
      ).bind(
        streamId,
        input.videoId,
        annotationId,
        input.actor.identityKey,
        input.actor.displayName,
        input.actor.identityKey,
        input.actor.displayName,
        createdAt,
        createdAt,
      ).run();
      await db.prepare(
        `INSERT INTO v03_collaboration_sources (
          id, stream_id, annotation_id, relation_type,
          source_author_email, source_author_name
        ) VALUES (?, ?, ?, 'CANONICAL', ?, ?)`,
      ).bind(
        newId("collaboration_source"),
        streamId,
        annotationId,
        input.actor.identityKey,
        input.actor.displayName,
      ).run();
      await db.prepare(
        `INSERT INTO v03_collaboration_baselines (
          id, stream_id, annotation_id, source_type, source_snapshot_id,
          source_operation_key, payload_json, content_hash,
          source_author_email, source_author_name, created_by_email, created_by_name
        ) VALUES (?, ?, ?, 'EXISTING_V03', NULL, 'EMPTY_INITIAL', ?::jsonb, ?, ?, ?, ?, ?)`,
      ).bind(
        baselineId,
        streamId,
        annotationId,
        JSON.stringify(blank),
        jsonHash(blank),
        input.actor.identityKey,
        input.actor.displayName,
        input.actor.identityKey,
        input.actor.displayName,
      ).run();
      await db.prepare(
        `INSERT INTO v03_collaboration_rounds (
          id, stream_id, annotation_id, round_number, status, base_type,
          base_baseline_id, base_release_id, base_snapshot_id,
          starting_revision, created_by_email, created_by_name
        ) VALUES (?, ?, ?, 1, 'ACTIVE', 'EMPTY_INITIAL', ?, NULL, NULL, 0, ?, ?)`,
      ).bind(
        roundId,
        streamId,
        annotationId,
        baselineId,
        input.actor.identityKey,
        input.actor.displayName,
      ).run();
      await db.prepare(
        `UPDATE v03_collaboration_streams SET initial_baseline_id = ?,
          active_round_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(baselineId, roundId, createdAt, streamId).run();
      await db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
        VALUES (?, ?, 'SHARED_V03_INITIALIZED', 'V03_COLLABORATION_STREAM', ?, ?)`,
      ).bind(
        newId("audit"),
        input.actor.identityKey,
        streamId,
        JSON.stringify({
          videoId: input.videoId,
          annotationId,
          baselineId,
          roundId,
          baseType: "EMPTY_INITIAL",
          initialRevision: 0,
        }),
      ).run();
      collaboration = await loadV03CollaborationContext(input.videoId, db, true);
      if (!collaboration) {
        throw new V03CollaborationError(
          "INITIALIZATION_FAILED",
          "公共 V0.3 工作区初始化失败，事务已回滚。",
          500,
        );
      }
    }
    if (collaboration.roundStatus !== "ACTIVE") {
      throw new V03CollaborationError("ROUND_NOT_ACTIVE", "当前共享修订轮不可写。", 423);
    }
    if (
      input.expectedSnapshotId &&
      collaboration.currentSnapshotId !== input.expectedSnapshotId
    ) {
      throw new V03CollaborationError(
        "WORKING_SNAPSHOT_CHANGED",
        "公共工作稿已经变化，请刷新后重新修订。",
        409,
      );
    }
    const locked = await db.prepare(
      `SELECT revision FROM annotations
      WHERE id = ? AND taxonomy_version = 'V0.3-PILOT' AND deleted_at IS NULL
      FOR UPDATE`,
    ).bind(collaboration.annotationId).first<{ revision: number }>();
    if (!locked) {
      throw new V03CollaborationError("CANONICAL_MISSING", "公共 V0.3 工作稿不存在。", 409);
    }
    if (Number(locked.revision) !== Number(input.payload.revision)) {
      throw new V03CollaborationError(
        "REVISION_CONFLICT",
        "公共工作稿已由其他成员更新；本页内容仍保留，请选择如何处理。",
        409,
        Number(locked.revision),
      );
    }
    const current = await loadAnnotationById(collaboration.annotationId, db);
    if (!current) {
      throw new V03CollaborationError("CANONICAL_MISSING", "公共 V0.3 工作稿不存在。", 409);
    }
    const updatedAt = new Date().toISOString();
    const nextRevision = Number(locked.revision) + 1;
    const next = normalizeSharedDraft(input.payload, current, nextRevision, updatedAt);
    const changes = diffSharedDraft(current, next);
    if (!changes.length) {
      return { annotation: current, collaboration, changeSetId: null };
    }
    await replaceMutablePackage(db, collaboration.annotationId, next);
    const payloadJson = JSON.stringify(next);
    const contentHash = jsonHash(next);
    const snapshotId = newId("working_snapshot");
    const changeSetId = newId("collaboration_change_set");
    await db.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name,
        taxonomy_version, revision, payload_json, content_hash,
        base_snapshot_id, revision_cause, workflow_status, snapshot_kind,
        base_release_id, source_public_snapshot_id
      ) VALUES (?, ?, ?, ?, ?, 'V0.3-PILOT', ?, ?, ?, ?,
        'SHARED_DIRECT_REVISION', 'WORKING', 'WORKING', ?, ?)`,
    ).bind(
      snapshotId,
      collaboration.annotationId,
      input.videoId,
      input.actor.identityKey,
      input.actor.displayName,
      nextRevision,
      payloadJson,
      contentHash,
      collaboration.currentSnapshotId ?? next.baseSnapshotId ?? null,
      next.baseReleaseId ?? null,
      next.sourcePublicSnapshotId ?? null,
    ).run();
    for (const change of changes) {
      await db.prepare(
        `INSERT INTO v03_collaboration_revision_events (
          id, stream_id, round_id, annotation_id, change_set_id,
          base_revision, applied_revision, target_key, target_label,
          value_type, before_value_json, after_value_json, reason,
          actor_email, actor_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)`,
      ).bind(
        newId("collaboration_revision"),
        collaboration.streamId,
        collaboration.roundId,
        collaboration.annotationId,
        changeSetId,
        Number(locked.revision),
        nextRevision,
        change.targetKey,
        change.targetLabel,
        change.valueType,
        JSON.stringify(change.beforeValue),
        JSON.stringify(change.afterValue),
        input.reason?.trim().slice(0, 4000) || null,
        input.actor.identityKey,
        input.actor.displayName,
      ).run();
    }
    await db.prepare(
      `UPDATE v03_collaboration_streams SET current_snapshot_id = ?,
        updated_at = ? WHERE id = ?`,
    ).bind(snapshotId, updatedAt, collaboration.streamId).run();
    if (collaboration.candidateSnapshotId) {
      await db.prepare(
        `UPDATE analysis_review_rounds SET status = 'CHANGES_REQUESTED',
          decision_note = COALESCE(decision_note, '共享工作稿在候选后继续修订'),
          decided_at = COALESCE(decided_at, ?), updated_at = ?
        WHERE annotation_id = ? AND submitted_snapshot_id = ?
          AND status IN ('PENDING', 'IN_REVIEW')`,
      ).bind(updatedAt, updatedAt, collaboration.annotationId, collaboration.candidateSnapshotId).run();
    }
    await db.prepare(
      `UPDATE v03_collaboration_rounds SET candidate_snapshot_id = NULL
      WHERE id = ?`,
    ).bind(collaboration.roundId).run();
    await db.prepare(
      `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
      VALUES (?, ?, 'SHARED_V03_REVISION_APPLIED', 'COLLABORATION_CHANGE_SET', ?, ?)`,
    ).bind(
      newId("audit"),
      input.actor.identityKey,
      changeSetId,
      JSON.stringify({
        videoId: input.videoId,
        streamId: collaboration.streamId,
        roundId: collaboration.roundId,
        baseRevision: Number(locked.revision),
        appliedRevision: nextRevision,
        targets: changes.map((change) => change.targetKey),
        snapshotId,
      }),
    ).run();
    return {
      annotation: next,
      collaboration: {
        ...collaboration,
        currentSnapshotId: snapshotId,
        lastEditorName: input.actor.displayName,
        lastEditedAt: updatedAt,
      },
      changeSetId,
      snapshotId,
    };
  });
}

export async function loadCollaborationRevisionHistory(
  videoId: string,
  limit = 200,
) {
  const collaboration = await loadV03CollaborationContext(videoId);
  if (!collaboration) return { collaboration: null, revisions: [] };
  const result = await getDbClient().prepare(
    `SELECT id, change_set_id, base_revision, applied_revision,
      target_key, target_label, value_type, before_value_json,
      after_value_json, reason, actor_name, created_at
    FROM v03_collaboration_revision_events
    WHERE stream_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(collaboration.streamId, Math.max(1, Math.min(limit, 500))).all<{
    id: string;
    change_set_id: string;
    base_revision: number;
    applied_revision: number;
    target_key: string;
    target_label: string;
    value_type: string;
    before_value_json: unknown;
    after_value_json: unknown;
    reason: string | null;
    actor_name: string;
    created_at: string;
  }>();
  return {
    collaboration,
    revisions: result.results.map((row) => ({
      id: row.id,
      changeSetId: row.change_set_id,
      baseRevision: Number(row.base_revision),
      appliedRevision: Number(row.applied_revision),
      targetKey: row.target_key,
      targetLabel: row.target_label,
      valueType: row.value_type,
      beforeValue: parseJsonValue(row.before_value_json),
      afterValue: parseJsonValue(row.after_value_json),
      reason: row.reason,
      actorName: row.actor_name,
      createdAt: row.created_at,
    })),
  };
}

export async function loadCollaborationBaseline(baselineId: string) {
  const row = await getDbClient().prepare(
    `SELECT baseline.id, baseline.stream_id, baseline.payload_json,
      baseline.content_hash, baseline.source_type, baseline.source_author_name,
      baseline.created_at, stream.video_id
    FROM v03_collaboration_baselines baseline
    INNER JOIN v03_collaboration_streams stream ON stream.id = baseline.stream_id
    INNER JOIN videos video ON video.id = stream.video_id
    WHERE baseline.id = ? AND video.deleted_at IS NULL`,
  ).bind(baselineId).first<{
    id: string;
    stream_id: string;
    payload_json: unknown;
    content_hash: string;
    source_type: string;
    source_author_name: string;
    created_at: string;
    video_id: string;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    streamId: row.stream_id,
    videoId: row.video_id,
    payload: typeof row.payload_json === "string"
      ? JSON.parse(row.payload_json) as AnnotationDraft
      : row.payload_json as AnnotationDraft,
    contentHash: row.content_hash,
    sourceType: row.source_type,
    sourceAuthorName: row.source_author_name,
    createdAt: row.created_at,
  };
}
