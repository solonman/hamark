import { createHash } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import type { AnnotationDraft } from "@/lib/types";
import {
  V04_WORKFLOW_VERSION,
  type V04DraftPayloadV1,
} from "@/lib/v04-contract";
import {
  assertV04PayloadContract,
  hashV04Payload,
} from "@/lib/v04-domain";
import { V04ServiceError } from "@/lib/v04-errors";

export const WELCOME_HOME_V19_AUDIT_VIDEO_ID =
  "video_e2d5dbab-fc35-4e81-9d8e-0ab1a0a90435" as const;
export const WELCOME_HOME_V19_AUDIT_CONTRACT_VERSION =
  "WELCOME_HOME_V19_DIRECT_MAPPING_V1_1" as const;
export const WELCOME_HOME_V19_SOURCE_ROUND = 1 as const;
export const WELCOME_HOME_V19_SOURCE_REVISION = 153 as const;

export const WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT = [
  ["SCRIPT_BRIDGE_NAME", "桥段标题", 7],
  ["SCRIPT_KEY_CREATIVE_DESCRIPTION", "本桥段关键创意描述", 7],
  ["SHOT_START_TIME", "开始时间", 22],
  ["SHOT_END_TIME", "结束时间", 22],
  ["SHOT_SCALE", "景别", 22],
  ["SHOT_CAMERA_ANGLE", "机位／角度", 10],
  ["SHOT_VISUAL_CONTENT", "画面内容", 23],
  ["SHOT_SCREEN_COPY", "字幕／屏幕文案", 11],
  ["SHOT_DIALOGUE", "对白", 20],
  ["SHOT_VOICE_OVER", "旁白", 19],
  ["SHOT_SOUND_EFFECT", "声效", 9],
  ["SHOT_MUSIC", "音乐", 17],
  ["FACT_COMMERCIAL_INTENT", "商业意图", 1],
  ["FACT_STORY_SYNOPSIS", "故事梗概", 1],
  ["FACT_CREATIVE_MOTIF", "创意母题", 1],
  ["FACT_TENSION_BUTTON", "创意按钮", 1],
  ["FACT_CREATIVE_THINKING_CHAIN", "创意思维链", 1],
  ["PATH_PRIMARY_TYPE", "主导感知路径", 1],
  ["RATING_REASON", "评价理由", 1],
] as const;

export type WelcomeHomeV19AuditFieldKey =
  (typeof WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT)[number][0];
export type WelcomeHomeV19Classification =
  | "TARGET_EMPTY"
  | "TARGET_SAME"
  | "TARGET_DIFFERENT"
  | "UNADDRESSABLE";
export type WelcomeHomeV19AuditStopReason =
  | "SOURCE_MISSING"
  | "SOURCE_MULTIPLE"
  | "SOURCE_ROUND_DRIFT"
  | "SOURCE_REVISION_DRIFT"
  | "SOURCE_HASH_DRIFT"
  | "SOURCE_CONTRACT_DRIFT"
  | "TARGET_WORKSPACE_MISSING"
  | "TARGET_WORKSPACE_MULTIPLE"
  | "TARGET_PAYLOAD_MISSING"
  | "TARGET_PAYLOAD_CONTRACT_DRIFT"
  | "TARGET_HASH_DRIFT"
  | "STRUCTURE_DRIFT"
  | "UNADDRESSABLE_INSTANCES"
  | "READ_FINGERPRINT_CHANGED";
export type WelcomeHomeV19AuditStage =
  | "READ_ONLY_BEGIN"
  | "ADMIN"
  | "FINGERPRINT_BEFORE"
  | "SOURCE"
  | "TARGET"
  | "COMPARE"
  | "FINGERPRINT_AFTER";

type FieldCount = Record<WelcomeHomeV19Classification, number>;

type ComparisonEntry = {
  fieldKey: WelcomeHomeV19AuditFieldKey;
  stableLocator: string;
  sourceValue: string;
  targetValue: string | null;
  classification: WelcomeHomeV19Classification;
};

export type WelcomeHomeV19PayloadComparison = {
  entries: ComparisonEntry[];
  fieldTypes: Array<{
    fieldKey: WelcomeHomeV19AuditFieldKey;
    label: string;
    expectedInstances: number;
    sourceInstances: number;
    counts: FieldCount;
  }>;
  totals: FieldCount & { expected: number; sourceInstances: number };
  structure: {
    sourceShotGroupCount: number;
    sourceShotCount: number;
    targetShotGroupCount: number;
    targetShotCount: number;
    stableLocatorsAligned: boolean;
  };
  sourceDigest: string;
  targetDigest: string;
  stopReasons: WelcomeHomeV19AuditStopReason[];
};

export type WelcomeHomeV19ConflictAudit = {
  generatedAt: string;
  contract: {
    version: typeof WELCOME_HOME_V19_AUDIT_CONTRACT_VERSION;
    hash: string;
    fieldTypeCount: number;
    instanceCount: number;
  };
  source: {
    state: "EXACT" | "MISSING" | "MULTIPLE" | "DRIFT";
    roundNumber: number | null;
    revision: number | null;
    snapshotKind: string | null;
    digest: string;
  };
  target: {
    workspaceCount: number;
    activeWorkspaceCount: number;
    statuses: Array<{ status: string; count: number }>;
    revision: number | null;
    submissionCount: number;
    revisionEventCount: number;
    lease: {
      totalCount: number;
      activeCount: number;
      expiredCount: number;
    };
    digest: string;
  };
  structure: WelcomeHomeV19PayloadComparison["structure"];
  fieldTypes: WelcomeHomeV19PayloadComparison["fieldTypes"];
  totals: WelcomeHomeV19PayloadComparison["totals"];
  previewDigest: string;
  readFingerprint: {
    before: string;
    after: string;
    unchanged: boolean;
  };
  ready: boolean;
  stopReasons: WelcomeHomeV19AuditStopReason[];
};

type SourceRow = QueryResultRow & {
  round_number: number;
  round_status: string;
  annotation_revision: number;
  annotation_content_hash: string;
  snapshot_revision: number;
  snapshot_kind: string;
  workflow_status: string;
  payload_json: AnnotationDraft | string;
  content_hash: string;
};

type TargetRow = QueryResultRow & {
  workspace_id: string;
  workspace_status: string;
  annotation_revision: number | null;
  annotation_content_hash: string | null;
  snapshot_revision: number | null;
  snapshot_payload_json: V04DraftPayloadV1 | string | null;
  snapshot_content_hash: string | null;
};

const emptyCounts = (): FieldCount => ({
  TARGET_EMPTY: 0,
  TARGET_SAME: 0,
  TARGET_DIFFERENT: 0,
  UNADDRESSABLE: 0,
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, current]) => [key, canonicalize(current)]));
  }
  return value;
}

const sha256 = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)), "utf8")
  .digest("hex");

export const WELCOME_HOME_V19_AUDIT_CONTRACT_HASH = sha256({
  version: WELCOME_HOME_V19_AUDIT_CONTRACT_VERSION,
  videoId: WELCOME_HOME_V19_AUDIT_VIDEO_ID,
  source: {
    taxonomyVersion: "V0.3-PILOT",
    roundNumber: WELCOME_HOME_V19_SOURCE_ROUND,
    revision: WELCOME_HOME_V19_SOURCE_REVISION,
  },
  fields: WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT,
  policy: {
    empty: "TARGET_EMPTY",
    same: "TARGET_SAME",
    different: "TARGET_DIFFERENT_PRESERVE_TARGET",
    unaddressable: "STOP",
    structureDrift: "STOP",
  },
});

export function loadWelcomeHomeV19AuditConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return { enabled: env.V04_WELCOME_HOME_V19_AUDIT_ENABLED === "true" };
}

const text = (value: unknown) => typeof value === "string" ? value : "";
const nonEmpty = (value: unknown) => text(value).trim().length > 0;
const parseJson = <T>(value: T | string): T => typeof value === "string"
  ? JSON.parse(value) as T
  : value;

function classify(sourceValue: string, targetValue: string | null) {
  if (targetValue === null) return "UNADDRESSABLE" as const;
  if (!targetValue.trim()) return "TARGET_EMPTY" as const;
  return targetValue === sourceValue ? "TARGET_SAME" as const : "TARGET_DIFFERENT" as const;
}

function orderedUniqueIds<T extends { id: string; orderIndex: number }>(items: T[]) {
  const ordered = [...items].sort((left, right) => left.orderIndex - right.orderIndex);
  const ids = ordered.map((item) => item.id);
  return { ordered, ids, unique: new Set(ids).size === ids.length };
}

export function compareWelcomeHomeV19Payloads(
  source: AnnotationDraft,
  target: V04DraftPayloadV1 | null,
): WelcomeHomeV19PayloadComparison {
  const entries: ComparisonEntry[] = [];
  const stopReasons = new Set<WelcomeHomeV19AuditStopReason>();
  const sourceGroups = orderedUniqueIds(source.shotGroups ?? []);
  const targetGroups = orderedUniqueIds(target?.script.shotGroups ?? []);
  const sourceShots = orderedUniqueIds(source.shots);
  const targetShots = orderedUniqueIds(target?.script.shotGroups.flatMap((group) => group.shots) ?? []);
  const targetGroupMap = new Map(targetGroups.ordered.map((group) => [group.id, group]));
  const targetShotMap = new Map<string, { groupId: string; shot: V04DraftPayloadV1["script"]["shotGroups"][number]["shots"][number] }>();
  let targetShotDuplicate = false;
  for (const group of targetGroups.ordered) {
    for (const shot of group.shots) {
      if (targetShotMap.has(shot.id)) targetShotDuplicate = true;
      targetShotMap.set(shot.id, { groupId: group.id, shot });
    }
  }
  const sourceShotGroupById = new Map(sourceGroups.ordered.flatMap((group) =>
    source.shots.filter((shot) => shot.shotGroupId === group.id).map((shot) => [shot.id, group.id] as const)));

  const sourceStructure = sourceGroups.ordered.map((group) => ({
    id: group.id,
    orderIndex: group.orderIndex,
    shotIds: source.shots.filter((shot) => shot.shotGroupId === group.id)
      .sort((left, right) => left.orderIndex - right.orderIndex).map((shot) => shot.id),
  }));
  const targetStructure = targetGroups.ordered.map((group) => ({
    id: group.id,
    orderIndex: group.orderIndex,
    shotIds: [...group.shots].sort((left, right) => left.orderIndex - right.orderIndex)
      .map((shot) => shot.id),
  }));
  const stableLocatorsAligned = Boolean(target)
    && sourceGroups.unique && targetGroups.unique && sourceShots.unique && targetShots.unique
    && !targetShotDuplicate
    && JSON.stringify(sourceStructure) === JSON.stringify(targetStructure)
    && sourceGroups.ids.length === targetGroups.ids.length
    && sourceShots.ids.length === targetShots.ids.length;
  if (!stableLocatorsAligned) stopReasons.add("STRUCTURE_DRIFT");

  const add = (
    fieldKey: WelcomeHomeV19AuditFieldKey,
    stableLocator: string,
    sourceValue: unknown,
    targetValue: unknown,
    addressable = true,
  ) => {
    if (!nonEmpty(sourceValue)) return;
    const sourceText = text(sourceValue);
    const targetText = addressable && typeof targetValue === "string" ? targetValue : null;
    entries.push({
      fieldKey,
      stableLocator,
      sourceValue: sourceText,
      targetValue: targetText,
      classification: classify(sourceText, targetText),
    });
  };

  for (const group of sourceGroups.ordered) {
    const targetGroup = targetGroupMap.get(group.id);
    const groupAddressable = Boolean(targetGroup && targetGroup.orderIndex === group.orderIndex);
    add("SCRIPT_BRIDGE_NAME", `shotGroup:${group.id}.bridgeName`, group.title,
      targetGroup?.bridgeName, groupAddressable);
    add("SCRIPT_KEY_CREATIVE_DESCRIPTION", `shotGroup:${group.id}.keyCreativeDescription`,
      group.note, targetGroup?.keyCreativeDescription, groupAddressable);
  }

  const shotFields = [
    ["SHOT_START_TIME", "startTime", "startTime"],
    ["SHOT_END_TIME", "endTime", "endTime"],
    ["SHOT_SCALE", "shotSize", "shotScale"],
    ["SHOT_CAMERA_ANGLE", "cameraAngle", "cameraAngle"],
    ["SHOT_VISUAL_CONTENT", "visualContent", "visualContent"],
    ["SHOT_SCREEN_COPY", "screenText", "screenCopy"],
    ["SHOT_DIALOGUE", "dialogue", "dialogue"],
    ["SHOT_VOICE_OVER", "voiceover", "voiceOver"],
    ["SHOT_SOUND_EFFECT", "soundEffect", "soundEffect"],
    ["SHOT_MUSIC", "music", "music"],
  ] as const;
  for (const shot of sourceShots.ordered) {
    const targetEntry = targetShotMap.get(shot.id);
    const expectedGroupId = sourceShotGroupById.get(shot.id);
    const addressable = Boolean(targetEntry && expectedGroupId && targetEntry.groupId === expectedGroupId
      && targetEntry.shot.orderIndex === shot.orderIndex);
    for (const [fieldKey, sourceKey, targetKey] of shotFields) {
      add(fieldKey, `shot:${shot.id}.${targetKey}`, shot[sourceKey],
        targetEntry?.shot[targetKey], addressable);
    }
  }

  const structure = source.creativeStructure;
  const primaryType = structure?.primaryCreativePath === "LOVE" ? "LOVE" : text(structure?.primaryCreativePath);
  const facts = target?.factsAndCoreJudgement;
  add("FACT_COMMERCIAL_INTENT", "facts.commercialIntent", source.commercialIntent,
    facts?.commercialIntent, Boolean(target));
  add("FACT_STORY_SYNOPSIS", "facts.storySynopsis", source.synopsis,
    facts?.storySynopsis, Boolean(target));
  add("FACT_CREATIVE_MOTIF", "facts.creativeMotif", source.creativeTheme,
    facts?.creativeMotif, Boolean(target));
  add("FACT_TENSION_BUTTON", "facts.tensionButton", structure?.creativeButton,
    facts?.tensionButton, Boolean(target));
  add("FACT_CREATIVE_THINKING_CHAIN", "facts.creativeThinkingChain", source.thinkingChain,
    facts?.creativeThinkingChain, Boolean(target));
  add("PATH_PRIMARY_TYPE", "path.primaryType", primaryType,
    target?.perceptionPath.primaryType, Boolean(target));
  add("RATING_REASON", "facts.ratingReason", source.summary,
    facts?.ratingReason, Boolean(target));

  const fieldTypes = WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT.map(([fieldKey, label, expectedInstances]) => {
    const current = entries.filter((entry) => entry.fieldKey === fieldKey);
    const counts = emptyCounts();
    for (const entry of current) counts[entry.classification] += 1;
    if (current.length !== expectedInstances) stopReasons.add("SOURCE_CONTRACT_DRIFT");
    return { fieldKey, label, expectedInstances, sourceInstances: current.length, counts };
  });
  const totals = fieldTypes.reduce((result, field) => {
    result.expected += field.expectedInstances;
    result.sourceInstances += field.sourceInstances;
    for (const key of Object.keys(emptyCounts()) as WelcomeHomeV19Classification[]) {
      result[key] += field.counts[key];
    }
    return result;
  }, { ...emptyCounts(), expected: 0, sourceInstances: 0 });
  if (totals.UNADDRESSABLE > 0) stopReasons.add("UNADDRESSABLE_INSTANCES");

  return {
    entries,
    fieldTypes,
    totals,
    structure: {
      sourceShotGroupCount: sourceGroups.ids.length,
      sourceShotCount: sourceShots.ids.length,
      targetShotGroupCount: targetGroups.ids.length,
      targetShotCount: targetShots.ids.length,
      stableLocatorsAligned,
    },
    sourceDigest: sha256({
      structure: sourceStructure,
      values: entries.map((entry) => [entry.fieldKey, entry.stableLocator, entry.sourceValue]),
    }),
    targetDigest: sha256(target ? {
      structure: targetStructure,
      values: entries.map((entry) => [entry.fieldKey, entry.stableLocator, entry.targetValue]),
    } : "TARGET_WORKSPACE_ABSENT"),
    stopReasons: [...stopReasons].sort(),
  };
}

function unavailableComparison(): WelcomeHomeV19PayloadComparison {
  const fieldTypes = WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT.map(([fieldKey, label, expectedInstances]) => ({
    fieldKey,
    label,
    expectedInstances,
    sourceInstances: 0,
    counts: { ...emptyCounts(), UNADDRESSABLE: expectedInstances },
  }));
  return {
    entries: [],
    fieldTypes,
    totals: {
      ...emptyCounts(),
      expected: 196,
      sourceInstances: 0,
      UNADDRESSABLE: 196,
    },
    structure: {
      sourceShotGroupCount: 0,
      sourceShotCount: 0,
      targetShotGroupCount: 0,
      targetShotCount: 0,
      stableLocatorsAligned: false,
    },
    sourceDigest: sha256("SOURCE_UNAVAILABLE"),
    targetDigest: sha256("TARGET_UNAVAILABLE"),
    stopReasons: ["SOURCE_CONTRACT_DRIFT", "STRUCTURE_DRIFT", "UNADDRESSABLE_INSTANCES"],
  };
}

export async function assertWelcomeHomeV19AuditAdmin(db: DbClient, userId: string) {
  const row = await db.prepare(`SELECT 1 FROM app_role_memberships
    WHERE user_id = ? AND role_key = 'SYSTEM_ADMIN' AND status = 'ACTIVE'`)
    .bind(userId).first();
  if (!row) throw new V04ServiceError("ADMIN_REQUIRED", "仅稳定系统管理员可执行只读冲突审计。");
}

async function aggregateFingerprint(db: DbClient) {
  const rows: unknown[] = [];
  rows.push(await db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(MAX(current_snapshot_id), '') AS marker
      FROM v03_collaboration_streams
      WHERE video_id = ? AND taxonomy_version = 'V0.3-PILOT'`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID).first());
  rows.push(await db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(MAX(w.current_working_snapshot_id), '') AS marker,
      COALESCE(MAX(a.revision), 0) AS revision
      FROM collaboration_workspaces w
      LEFT JOIN annotations a ON a.id = w.canonical_annotation_id
      WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION).first());
  rows.push(await db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(s.submission_number), 0) AS marker
      FROM annotation_submission_snapshots s
      INNER JOIN collaboration_workspaces w ON w.id = s.workspace_id
      WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION).first());
  rows.push(await db.prepare(`SELECT COUNT(*) AS count,
      COUNT(*) FILTER (WHERE l.status = 'ACTIVE' AND l.expires_at > now()) AS active
      FROM collaboration_edit_leases l
      INNER JOIN collaboration_workspaces w ON w.id = l.workspace_id
      WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION).first());
  rows.push(await db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(e.applied_revision), 0) AS marker
      FROM collaboration_revision_events e
      INNER JOIN collaboration_workspaces w ON w.id = e.workspace_id
      WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION).first());
  return sha256(rows);
}

async function sourceRows(db: DbClient) {
  return (await db.prepare(`SELECT round.round_number, round.status AS round_status,
      annotation.revision AS annotation_revision,
      annotation.content_hash AS annotation_content_hash,
      snapshot.revision AS snapshot_revision, snapshot.snapshot_kind,
      snapshot.workflow_status, snapshot.payload_json, snapshot.content_hash
    FROM v03_collaboration_streams stream
    INNER JOIN v03_collaboration_rounds round ON round.id = stream.active_round_id
    INNER JOIN annotations annotation ON annotation.id = stream.canonical_annotation_id
    INNER JOIN annotation_snapshots snapshot ON snapshot.id = stream.current_snapshot_id
    WHERE stream.video_id = ? AND stream.taxonomy_version = 'V0.3-PILOT'
      AND stream.status = 'ACTIVE'`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID).all<SourceRow>()).results;
}

async function targetRows(db: DbClient) {
  return (await db.prepare(`SELECT w.id AS workspace_id, w.status AS workspace_status,
      a.revision AS annotation_revision, a.content_hash AS annotation_content_hash,
      snapshot.revision AS snapshot_revision,
      snapshot.payload_json AS snapshot_payload_json,
      snapshot.content_hash AS snapshot_content_hash
    FROM collaboration_workspaces w
    LEFT JOIN annotations a ON a.id = w.canonical_annotation_id
    LEFT JOIN annotation_snapshots snapshot ON snapshot.id = w.current_working_snapshot_id
    WHERE w.video_id = ? AND w.workflow_version = ?
    ORDER BY w.created_at, w.id`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION).all<TargetRow>()).results;
}

async function targetAggregates(db: DbClient) {
  const statuses = (await db.prepare(`SELECT status, COUNT(*) AS count
    FROM collaboration_workspaces WHERE video_id = ? AND workflow_version = ?
    GROUP BY status ORDER BY status`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION)
    .all<{ status: string; count: number | string } & QueryResultRow>()).results;
  const submission = await db.prepare(`SELECT COUNT(*) AS count
    FROM annotation_submission_snapshots s
    INNER JOIN collaboration_workspaces w ON w.id = s.workspace_id
    WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION)
    .first<{ count: number | string } & QueryResultRow>();
  const revisions = await db.prepare(`SELECT COUNT(*) AS count
    FROM collaboration_revision_events e
    INNER JOIN collaboration_workspaces w ON w.id = e.workspace_id
    WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION)
    .first<{ count: number | string } & QueryResultRow>();
  const leases = await db.prepare(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE l.status = 'ACTIVE' AND l.expires_at > now()) AS active,
      COUNT(*) FILTER (WHERE l.status = 'EXPIRED' OR l.expires_at <= now()) AS expired
    FROM collaboration_edit_leases l
    INNER JOIN collaboration_workspaces w ON w.id = l.workspace_id
    WHERE w.video_id = ? AND w.workflow_version = ?`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION)
    .first<{ total: number | string; active: number | string; expired: number | string } & QueryResultRow>();
  return {
    statuses: statuses.map((row) => ({ status: row.status, count: Number(row.count) })),
    submissionCount: Number(submission?.count ?? 0),
    revisionEventCount: Number(revisions?.count ?? 0),
    lease: {
      totalCount: Number(leases?.total ?? 0),
      activeCount: Number(leases?.active ?? 0),
      expiredCount: Number(leases?.expired ?? 0),
    },
  };
}

export async function auditWelcomeHomeV19Conflict(
  db: DbClient,
  actor: { userId: string },
): Promise<WelcomeHomeV19ConflictAudit> {
  let stage: WelcomeHomeV19AuditStage = "READ_ONLY_BEGIN";
  try {
    return await db.withTransaction(async (readDb) => {
      await readDb.prepare("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").run();
      stage = "ADMIN";
      await assertWelcomeHomeV19AuditAdmin(readDb, actor.userId);
      stage = "FINGERPRINT_BEFORE";
      const before = await aggregateFingerprint(readDb);
      stage = "SOURCE";
      const sources = await sourceRows(readDb);
      stage = "TARGET";
      const targets = await targetRows(readDb);
      const aggregates = await targetAggregates(readDb);
      stage = "COMPARE";

      const stopReasons = new Set<WelcomeHomeV19AuditStopReason>();
      let sourceState: WelcomeHomeV19ConflictAudit["source"]["state"] = "EXACT";
      let sourceDraft: AnnotationDraft | null = null;
      let sourceDigest = sha256("SOURCE_UNAVAILABLE");
      if (sources.length === 0) {
        sourceState = "MISSING";
        stopReasons.add("SOURCE_MISSING");
      } else if (sources.length !== 1) {
        sourceState = "MULTIPLE";
        stopReasons.add("SOURCE_MULTIPLE");
      } else {
        const row = sources[0];
        sourceDraft = parseJson<AnnotationDraft>(row.payload_json);
        sourceDigest = sha256({
          storedContentHash: row.content_hash,
          canonicalPayloadDigest: sha256(sourceDraft),
        });
        if (Number(row.round_number) !== WELCOME_HOME_V19_SOURCE_ROUND || row.round_status !== "ACTIVE") {
          sourceState = "DRIFT";
          stopReasons.add("SOURCE_ROUND_DRIFT");
        }
        if (Number(row.snapshot_revision) !== WELCOME_HOME_V19_SOURCE_REVISION) {
          sourceState = "DRIFT";
          stopReasons.add("SOURCE_REVISION_DRIFT");
        }
        if (!/^[a-f0-9]{64}$/i.test(row.content_hash)
          || row.content_hash !== row.annotation_content_hash
          || Number(row.snapshot_revision) !== Number(row.annotation_revision)) {
          sourceState = "DRIFT";
          stopReasons.add("SOURCE_HASH_DRIFT");
        }
        if (sourceDraft.videoId !== WELCOME_HOME_V19_AUDIT_VIDEO_ID
          || sourceDraft.taxonomyVersion !== "V0.3-PILOT"
          || Number(sourceDraft.revision) !== WELCOME_HOME_V19_SOURCE_REVISION
          || row.snapshot_kind !== "WORKING"
          || row.workflow_status !== "WORKING"
          || sourceDraft.creativeStructure?.primaryCreativePath !== "LOVE") {
          sourceState = "DRIFT";
          stopReasons.add("SOURCE_CONTRACT_DRIFT");
        }
      }

      const activeTargets = targets.filter((row) => row.workspace_status === "ACTIVE");
      if (activeTargets.length === 0) stopReasons.add("TARGET_WORKSPACE_MISSING");
      if (activeTargets.length > 1) stopReasons.add("TARGET_WORKSPACE_MULTIPLE");
      const targetRow = activeTargets.length === 1 ? activeTargets[0] : null;
      let targetPayload: V04DraftPayloadV1 | null = null;
      let targetPayloadValid = false;
      if (targetRow && targetRow.snapshot_payload_json) {
        try {
          targetPayload = parseJson<V04DraftPayloadV1>(targetRow.snapshot_payload_json);
          assertV04PayloadContract(targetPayload);
          targetPayloadValid = true;
          const currentHash = hashV04Payload(targetPayload);
          if (currentHash !== targetRow.snapshot_content_hash
            || currentHash !== targetRow.annotation_content_hash
            || Number(targetRow.snapshot_revision) !== Number(targetRow.annotation_revision)) {
            stopReasons.add("TARGET_HASH_DRIFT");
          }
        } catch {
          stopReasons.add("TARGET_PAYLOAD_CONTRACT_DRIFT");
          targetPayload = null;
        }
      } else if (targetRow) {
        stopReasons.add("TARGET_PAYLOAD_MISSING");
      }

      const comparison = sourceDraft
        ? compareWelcomeHomeV19Payloads(sourceDraft, targetPayloadValid ? targetPayload : null)
        : unavailableComparison();
      comparison.stopReasons.forEach((reason) => stopReasons.add(reason));
      if (comparison.stopReasons.includes("SOURCE_CONTRACT_DRIFT")) sourceState = "DRIFT";
      if (comparison.totals.expected !== 196 || comparison.fieldTypes.length !== 19) {
        stopReasons.add("SOURCE_CONTRACT_DRIFT");
      }

      stage = "FINGERPRINT_AFTER";
      const after = await aggregateFingerprint(readDb);
      if (before !== after) stopReasons.add("READ_FINGERPRINT_CHANGED");
      const sortedStopReasons = [...stopReasons].sort();
      const targetDigest = targetPayload
        ? comparison.targetDigest
        : sha256({ workspaceCount: targets.length, state: "NO_EXACT_TARGET_PAYLOAD" });
      const previewDigest = sha256({
        contractHash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
        sourceDigest: comparison.sourceDigest,
        targetDigest,
        structure: comparison.structure,
        fieldTypes: comparison.fieldTypes,
        totals: comparison.totals,
        stopReasons: sortedStopReasons,
        readFingerprint: before,
      });

      return {
        generatedAt: new Date().toISOString(),
        contract: {
          version: WELCOME_HOME_V19_AUDIT_CONTRACT_VERSION,
          hash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
          fieldTypeCount: 19,
          instanceCount: 196,
        },
        source: {
          state: sourceState,
          roundNumber: sources.length === 1 ? Number(sources[0].round_number) : null,
          revision: sources.length === 1 ? Number(sources[0].snapshot_revision) : null,
          snapshotKind: sources.length === 1 ? sources[0].snapshot_kind : null,
          digest: sourceDigest,
        },
        target: {
          workspaceCount: targets.length,
          activeWorkspaceCount: activeTargets.length,
          statuses: aggregates.statuses,
          revision: targetRow?.annotation_revision == null ? null : Number(targetRow.annotation_revision),
          submissionCount: aggregates.submissionCount,
          revisionEventCount: aggregates.revisionEventCount,
          lease: aggregates.lease,
          digest: targetDigest,
        },
        structure: comparison.structure,
        fieldTypes: comparison.fieldTypes,
        totals: comparison.totals,
        previewDigest,
        readFingerprint: { before, after, unchanged: before === after },
        ready: sortedStopReasons.length === 0,
        stopReasons: sortedStopReasons,
      };
    });
  } catch (error) {
    if (error instanceof V04ServiceError) throw error;
    throw new V04ServiceError(
      "INTERNAL_ERROR",
      "只读冲突审计未完成，请稍后重试。",
      { stage, reason: "READ_FAILED" },
    );
  }
}
