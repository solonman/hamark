import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { loadAnnotationById } from "@/lib/annotation-server";
import { sharedContentFingerprint } from "@/lib/v03-collaboration";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04DraftPayloadV1,
} from "@/lib/v04-contract";
import {
  assertV04PayloadContract,
  emptyV04ChoiceValue,
  hashV04Payload,
} from "@/lib/v04-domain";
import { V04ServiceError } from "@/lib/v04-errors";
import { v04TargetCodeSha } from "@/lib/v04-schema-catalog";
import {
  persistV04RelationalDraft,
  type V04Actor,
  type V04WorkspacePersistenceRow,
} from "@/lib/v04-workspace-service";
import type { AnnotationDraft } from "@/lib/types";
import {
  assertWelcomeHomeV19AuditAdmin,
  compareWelcomeHomeV19Payloads,
  WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
  WELCOME_HOME_V19_AUDIT_CONTRACT_VERSION,
  WELCOME_HOME_V19_AUDIT_VIDEO_ID,
  WELCOME_HOME_V19_SOURCE_REVISION,
  WELCOME_HOME_V19_SOURCE_ROUND,
  type WelcomeHomeV19PayloadComparison,
} from "@/lib/welcome-home-v19-conflict-audit";
import {
  WELCOME_HOME_V19_MAPPING_CONFIRMATION,
  type WelcomeHomeV19MappingApplyInput,
  type WelcomeHomeV19MappingApplyResult,
  type WelcomeHomeV19MappingPreview,
} from "@/lib/welcome-home-v19-mapping-contract";

export {
  WELCOME_HOME_V19_MAPPING_CONFIRMATION,
  type WelcomeHomeV19MappingApplyInput,
  type WelcomeHomeV19MappingApplyResult,
  type WelcomeHomeV19MappingPreview,
} from "@/lib/welcome-home-v19-mapping-contract";

export const WELCOME_HOME_V19_MAPPING_OPERATION_TYPE = "WELCOME_HOME_V19_DIRECT_MAPPING_V1_1";
export const WELCOME_HOME_V19_MAPPING_TOKEN_TTL_MS = 30 * 60 * 1000;
export const WELCOME_HOME_V19_MAPPING_LOCK_KEY = "HAMARK:WELCOME_HOME:V19:MAPPING:V1_1";

type Environment = Record<string, string | undefined>;
export function loadWelcomeHomeV19MappingConfig(env: Environment = process.env) {
  return {
    previewEnabled: env.V04_WELCOME_HOME_V19_MAPPING_PREVIEW_ENABLED === "true",
    applyEnabled: env.V04_WELCOME_HOME_V19_MAPPING_APPLY_ENABLED === "true",
  };
}

type SourceRow = QueryResultRow & {
  stream_id: string;
  round_id: string;
  round_number: number | string;
  round_status: string;
  snapshot_id: string;
  snapshot_revision: number | string;
  snapshot_kind: string;
  workflow_status: string;
  snapshot_payload_json: AnnotationDraft | string;
  snapshot_content_hash: string;
  annotation_id: string;
  annotation_revision: number | string;
};

type TargetRow = V04WorkspacePersistenceRow & {
  domain_key: string;
  workspace_taxonomy_version: string;
  workspace_workflow_version: string;
  workspace_vocabulary_version: string;
  annotation_taxonomy_version: string;
  annotation_workflow_version: string;
  round_status: string;
  snapshot_id: string;
  snapshot_revision: number | string;
  snapshot_kind: string;
  snapshot_workflow_status: string;
  snapshot_taxonomy_version: string;
  snapshot_workflow_version: string;
  snapshot_vocabulary_version: string;
  snapshot_payload_schema_version: string;
  snapshot_payload_json: V04DraftPayloadV1 | string;
  snapshot_content_hash: string;
};

type SourceFacts = {
  row: SourceRow;
  snapshotPayload: AnnotationDraft;
  livePayload: AnnotationDraft;
  canonicalFingerprint: string;
  sourceDigest: string;
};

type TargetFacts = {
  row: TargetRow;
  payload: V04DraftPayloadV1;
  submissionCount: number;
  expertReleaseCount: number;
  activeLeaseCount: number;
};

type MappingPlan = {
  payload: V04DraftPayloadV1;
  initializedStructure: boolean;
  before: WelcomeHomeV19PayloadComparison;
  after: WelcomeHomeV19PayloadComparison;
  appliedLocators: string[];
};

type PreviewTokenPayload = {
  version: "WELCOME_HOME_V19_MAPPING_PREVIEW_V1_1";
  actorDigest: string;
  targetCodeSha: string;
  previewHash: string;
  generatedAt: string;
  expiresAt: string;
  streamId: string;
  roundId: string;
  snapshotId: string;
  annotationId: string;
  storedContentHash: string;
  canonicalFingerprint: string;
  sourceDigest: string;
  workspaceId: string;
  targetSnapshotId: string;
  targetRevision: number;
  targetHash: string;
};

type LedgerRow = QueryResultRow & {
  operation_key: string;
  status: "RUNNING" | "COMPLETED";
  actor_identity: string;
  source_hash: string;
  target_hash: string;
  non_target_hash: string;
  backup_json: Record<string, unknown> | string;
  result_json: WelcomeHomeV19MappingApplyResult | string | null;
};

function parsedLedgerResult(row: LedgerRow) {
  return row.result_json ? parseJson<WelcomeHomeV19MappingApplyResult>(row.result_json) : null;
}

function exactAppliedLedger(
  row: LedgerRow,
  sourceDigest: string,
  currentTargetHash: string,
  actorUserId: string,
) {
  const result = parsedLedgerResult(row);
  return Boolean(result
    && row.status === "COMPLETED"
    && row.actor_identity === actorUserId
    && row.source_hash === sourceDigest
    && result.contentHash === currentTargetHash
    && result.outcome === "APPLIED"
    && result.structure.shotGroupCount === 7
    && result.structure.shotCount === 23
    && result.totals.TARGET_SAME === 196
    && result.totals.TARGET_EMPTY === 0
    && result.totals.TARGET_DIFFERENT === 0
    && result.totals.UNADDRESSABLE === 0
    && result.submissionCount === 0
    && result.expertReleaseCount === 0);
}

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const parseJson = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) as T : value;
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, current]) => [key, canonical(current)]),
  );
  return value;
};
const hash = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(canonical(value)), "utf8").digest("hex");
const actorDigest = (userId: string) => hash(`hamark:welcome-home:v19-mapping:actor:v1\0${userId}`);
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

function requireText(value: string, label: string, min: number, max: number) {
  const result = value?.trim() ?? "";
  if (result.length < min || result.length > max || /[\u0000-\u001f]/u.test(result)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", `${label}格式不正确。`);
  }
  return result;
}

function signToken(payload: PreviewTokenPayload, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function parseToken(token: string, secret: string) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new V04ServiceError("STALE_PREVIEW", "映射 PREVIEW token 无效。");
  const expected = Buffer.from(createHmac("sha256", secret).update(encoded).digest("base64url"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new V04ServiceError("STALE_PREVIEW", "映射 PREVIEW token 无效。");
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PreviewTokenPayload;
    if (payload.version !== "WELCOME_HOME_V19_MAPPING_PREVIEW_V1_1") throw new Error("version");
    return payload;
  } catch {
    throw new V04ServiceError("STALE_PREVIEW", "映射 PREVIEW token 无效。");
  }
}

function sourceShotGroupId(source: AnnotationDraft, shotId: string) {
  return source.shots.find((shot) => shot.id === shotId)?.shotGroupId ?? null;
}

function initializeStableStructure(source: AnnotationDraft, target: V04DraftPayloadV1) {
  if (target.script.shotGroups.length > 0) return false;
  const orderedGroups = [...(source.shotGroups ?? [])].sort((a, b) => a.orderIndex - b.orderIndex);
  target.script.shotGroups = orderedGroups.map((group) => ({
    id: group.id,
    orderIndex: group.orderIndex,
    bridgeName: "",
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "",
    shots: source.shots.filter((shot) => shot.shotGroupId === group.id)
      .sort((a, b) => a.orderIndex - b.orderIndex).map((shot) => ({
        id: shot.id,
        orderIndex: shot.orderIndex,
        startTime: "",
        endTime: "",
        shotScale: "",
        cameraAngle: "",
        cameraMovement: "",
        visualContent: "",
        screenCopy: "",
        subtitleEffect: "",
        dialogue: "",
        voiceOver: "",
        soundEffect: "",
        music: "",
      })),
  }));
  return true;
}

function applyEntry(payload: V04DraftPayloadV1, source: AnnotationDraft, locator: string, value: string) {
  if (locator.startsWith("shotGroup:")) {
    const separator = locator.lastIndexOf(".");
    const groupId = locator.slice("shotGroup:".length, separator);
    const key = locator.slice(separator + 1) as "bridgeName" | "keyCreativeDescription";
    const group = payload.script.shotGroups.find((item) => item.id === groupId);
    if (!group) throw new Error("STRUCTURE_DRIFT");
    group[key] = value;
    return;
  }
  if (locator.startsWith("shot:")) {
    const separator = locator.lastIndexOf(".");
    const shotId = locator.slice("shot:".length, separator);
    const key = locator.slice(separator + 1) as keyof V04DraftPayloadV1["script"]["shotGroups"][number]["shots"][number];
    const groupId = sourceShotGroupId(source, shotId);
    const group = payload.script.shotGroups.find((item) => item.id === groupId);
    const shot = group?.shots.find((item) => item.id === shotId);
    if (!shot || key === "id" || key === "orderIndex") throw new Error("STRUCTURE_DRIFT");
    (shot[key] as string) = value;
    return;
  }
  const facts = payload.factsAndCoreJudgement;
  const factKeys: Record<string, keyof typeof facts> = {
    "facts.commercialIntent": "commercialIntent",
    "facts.storySynopsis": "storySynopsis",
    "facts.creativeMotif": "creativeMotif",
    "facts.tensionButton": "tensionButton",
    "facts.creativeThinkingChain": "creativeThinkingChain",
    "facts.ratingReason": "ratingReason",
  };
  if (locator in factKeys) {
    const key = factKeys[locator];
    (facts[key] as string) = value;
    return;
  }
  if (locator === "path.primaryType") {
    payload.perceptionPath.primaryType = value as V04DraftPayloadV1["perceptionPath"]["primaryType"];
    return;
  }
  throw new Error("UNADDRESSABLE_INSTANCE");
}

export function planWelcomeHomeV19Mapping(
  source: AnnotationDraft,
  currentTarget: V04DraftPayloadV1,
): MappingPlan {
  const payload = structuredClone(currentTarget);
  const initializedStructure = initializeStableStructure(source, payload);
  const before = compareWelcomeHomeV19Payloads(source, payload);
  const appliedLocators: string[] = [];
  for (const entry of before.entries) {
    if (entry.classification !== "TARGET_EMPTY") continue;
    applyEntry(payload, source, entry.stableLocator, entry.sourceValue);
    appliedLocators.push(entry.stableLocator);
  }
  assertV04PayloadContract(payload);
  const after = compareWelcomeHomeV19Payloads(source, payload);
  return { payload, initializedStructure, before, after, appliedLocators };
}

async function loadSource(db: DbClient, lock = false): Promise<SourceFacts> {
  const rows = (await db.prepare(`SELECT stream.id AS stream_id,
      round.id AS round_id, round.round_number, round.status AS round_status,
      snapshot.id AS snapshot_id, snapshot.revision AS snapshot_revision,
      snapshot.snapshot_kind, snapshot.workflow_status,
      snapshot.payload_json AS snapshot_payload_json,
      snapshot.content_hash AS snapshot_content_hash,
      annotation.id AS annotation_id, annotation.revision AS annotation_revision
    FROM v03_collaboration_streams stream
    INNER JOIN v03_collaboration_rounds round ON round.id=stream.active_round_id
    INNER JOIN annotation_snapshots snapshot ON snapshot.id=stream.current_snapshot_id
    INNER JOIN annotations annotation ON annotation.id=stream.canonical_annotation_id
    WHERE stream.video_id=? AND stream.taxonomy_version='V0.3-PILOT' AND stream.status='ACTIVE'
    ${lock ? "FOR UPDATE OF stream,round,snapshot,annotation" : ""}`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID).all<SourceRow>()).results;
  if (rows.length !== 1) throw new V04ServiceError("STALE_PREVIEW", "V0.3 权威源数量不符合固定合同。", { reason: rows.length ? "SOURCE_MULTIPLE" : "SOURCE_MISSING" });
  const row = rows[0];
  const snapshotPayload = parseJson<AnnotationDraft>(row.snapshot_payload_json);
  const livePayload = await loadAnnotationById(row.annotation_id, db);
  if (!livePayload) throw new V04ServiceError("STALE_PREVIEW", "V0.3 权威源当前不可读取。", { reason: "SOURCE_MISSING" });
  const canonicalFingerprint = sharedContentFingerprint(snapshotPayload);
  const liveFingerprint = sharedContentFingerprint(livePayload);
  const contractComparison = compareWelcomeHomeV19Payloads(snapshotPayload, null);
  const contractOk = contractComparison.totals.sourceInstances === 196
    && contractComparison.fieldTypes.length === 19;
  if (Number(row.round_number) !== WELCOME_HOME_V19_SOURCE_ROUND || row.round_status !== "ACTIVE"
    || Number(row.snapshot_revision) !== WELCOME_HOME_V19_SOURCE_REVISION
    || Number(row.annotation_revision) !== WELCOME_HOME_V19_SOURCE_REVISION
    || row.snapshot_kind !== "WORKING" || row.workflow_status !== "WORKING"
    || !HASH_PATTERN.test(row.snapshot_content_hash)
    || snapshotPayload.videoId !== WELCOME_HOME_V19_AUDIT_VIDEO_ID
    || snapshotPayload.taxonomyVersion !== "V0.3-PILOT"
    || Number(snapshotPayload.revision) !== WELCOME_HOME_V19_SOURCE_REVISION
    || snapshotPayload.creativeStructure?.primaryCreativePath !== "LOVE"
    || canonicalFingerprint !== liveFingerprint || !contractOk) {
    throw new V04ServiceError("STALE_PREVIEW", "V0.3 权威源与固定合同不一致。", {
      reason: canonicalFingerprint !== liveFingerprint ? "SOURCE_CANONICAL_DRIFT" : "SOURCE_CONTRACT_DRIFT",
    });
  }
  const sourceDigest = hash({
    streamId: row.stream_id,
    roundId: row.round_id,
    snapshotId: row.snapshot_id,
    annotationId: row.annotation_id,
    storedContentHash: row.snapshot_content_hash,
    canonicalFingerprint,
    contractHash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
  });
  return { row, snapshotPayload, livePayload, canonicalFingerprint, sourceDigest };
}

async function scalarCount(db: DbClient, sql: string, values: Array<string> = []) {
  const row = await db.prepare(sql).bind(...values).first<{ count: number | string } & QueryResultRow>();
  return Number(row?.count ?? 0);
}

async function loadTarget(db: DbClient, lock = false): Promise<TargetFacts> {
  const rows = (await db.prepare(`SELECT w.id,w.video_id,w.canonical_annotation_id,w.active_round_id,
      w.current_working_snapshot_id,w.latest_submission_snapshot_id,w.active_expert_release_id,
      w.status,w.updated_at,w.domain_key,
      w.taxonomy_version AS workspace_taxonomy_version,
      w.workflow_version AS workspace_workflow_version,
      w.vocabulary_version AS workspace_vocabulary_version,
      a.taxonomy_version AS annotation_taxonomy_version,
      a.workflow_version AS annotation_workflow_version,
      a.revision,a.content_hash,
      round.status AS round_status,snapshot.id AS snapshot_id,
      snapshot.revision AS snapshot_revision,snapshot.snapshot_kind,
      snapshot.workflow_status AS snapshot_workflow_status,
      snapshot.taxonomy_version AS snapshot_taxonomy_version,
      snapshot.workflow_version AS snapshot_workflow_version,
      snapshot.vocabulary_version AS snapshot_vocabulary_version,
      snapshot.payload_schema_version AS snapshot_payload_schema_version,
      snapshot.payload_json AS snapshot_payload_json,
      snapshot.content_hash AS snapshot_content_hash
    FROM collaboration_workspaces w
    INNER JOIN annotations a ON a.id=w.canonical_annotation_id
    INNER JOIN collaboration_rounds round ON round.id=w.active_round_id
    INNER JOIN annotation_snapshots snapshot ON snapshot.id=w.current_working_snapshot_id
    WHERE w.video_id=? AND w.workflow_version=?
    ${lock ? "FOR UPDATE OF w,a,round,snapshot" : ""}`)
    .bind(WELCOME_HOME_V19_AUDIT_VIDEO_ID, V04_WORKFLOW_VERSION).all<TargetRow>()).results;
  const active = rows.filter((row) => row.status === "ACTIVE");
  if (rows.length !== 1 || active.length !== 1) throw new V04ServiceError("STALE_PREVIEW", "V1.9 公共工作区数量不符合固定合同。", { reason: rows.length ? "TARGET_MULTIPLE" : "TARGET_MISSING" });
  const row = active[0];
  const payload = parseJson<V04DraftPayloadV1>(row.snapshot_payload_json);
  assertV04PayloadContract(payload);
  const payloadHash = hashV04Payload(payload);
  if (row.domain_key !== "AD_VIDEO"
    || row.workspace_taxonomy_version !== V04_TAXONOMY_VERSION
    || row.workspace_workflow_version !== V04_WORKFLOW_VERSION
    || row.workspace_vocabulary_version !== V04_VOCABULARY_VERSION
    || row.annotation_taxonomy_version !== V04_TAXONOMY_VERSION
    || row.annotation_workflow_version !== V04_WORKFLOW_VERSION
    || row.snapshot_taxonomy_version !== V04_TAXONOMY_VERSION
    || row.snapshot_workflow_version !== V04_WORKFLOW_VERSION
    || row.snapshot_vocabulary_version !== V04_VOCABULARY_VERSION
    || row.snapshot_payload_schema_version !== V04_PAYLOAD_SCHEMA_VERSION
    || row.round_status !== "ACTIVE" || row.snapshot_kind !== "WORKING"
    || row.snapshot_workflow_status !== "DRAFT"
    || Number(row.snapshot_revision) !== Number(row.revision)
    || payloadHash !== row.snapshot_content_hash || payloadHash !== row.content_hash) {
    throw new V04ServiceError("STALE_PREVIEW", "V1.9 当前工作稿事实漂移。", { reason: "TARGET_HASH_DRIFT" });
  }
  const [submissionCount, expertReleaseCount, activeLeaseCount] = await Promise.all([
    scalarCount(db, "SELECT COUNT(*) AS count FROM annotation_submission_snapshots WHERE workspace_id=?", [row.id]),
    scalarCount(db, "SELECT COUNT(*) AS count FROM expert_analysis_releases WHERE workspace_id=? AND status='ACTIVE'", [row.id]),
    scalarCount(db, "SELECT COUNT(*) AS count FROM collaboration_edit_leases WHERE workspace_id=? AND status='ACTIVE' AND expires_at>now()", [row.id]),
  ]);
  return { row, payload, submissionCount, expertReleaseCount, activeLeaseCount };
}

async function p10Facts(db: DbClient) {
  const [physical, orphan, objectKey] = await Promise.all([
    scalarCount(db, "SELECT COUNT(*) AS count FROM audit_logs WHERE action ILIKE '%PHYSICAL_DELETE%'"),
    scalarCount(db, `SELECT
      (SELECT COUNT(*) FROM annotations a LEFT JOIN videos v ON v.id=a.video_id WHERE v.id IS NULL)
      + (SELECT COUNT(*) FROM annotation_snapshots s LEFT JOIN annotations a ON a.id=s.annotation_id WHERE a.id IS NULL)
      + (SELECT COUNT(*) FROM annotation_snapshots s LEFT JOIN videos v ON v.id=s.video_id WHERE v.id IS NULL)
      + (SELECT COUNT(*) FROM shots s LEFT JOIN annotations a ON a.id=s.annotation_id WHERE a.id IS NULL)
      + (SELECT COUNT(*) FROM audit_logs l LEFT JOIN videos v ON v.id=l.object_id
          WHERE l.object_type='VIDEO' AND v.id IS NULL) AS count`),
    scalarCount(db, `SELECT COUNT(*) AS count FROM videos WHERE object_key IS NULL OR btrim(object_key)=''`),
  ]);
  return { physical, orphan, objectKey };
}

async function nonTargetFingerprint(db: DbClient, targetWorkspaceId?: string) {
  const [business, otherWorkspaces, p10] = await Promise.all([
    db.prepare(`SELECT id,status,COALESCE(data_scope,'BUSINESS') AS scope,
        COALESCE(content_type,''),file_size,COALESCE(deletion_state,'ACTIVE')
      FROM videos WHERE COALESCE(data_scope,'BUSINESS')='BUSINESS' ORDER BY id`).all(),
    db.prepare(`SELECT w.video_id,w.status,a.revision,COALESCE(a.content_hash,'') AS content_hash
      FROM collaboration_workspaces w INNER JOIN annotations a ON a.id=w.canonical_annotation_id
      WHERE w.workflow_version=? AND (?='' OR w.id<>?) ORDER BY w.video_id,w.id`)
      .bind(V04_WORKFLOW_VERSION, targetWorkspaceId ?? "", targetWorkspaceId ?? "").all(),
    p10Facts(db),
  ]);
  return hash({ business: business.results, otherWorkspaces: otherWorkspaces.results, p10 });
}

async function aggregateFingerprint(db: DbClient) {
  const rows = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM annotation_snapshots WHERE video_id=?) AS snapshots,
      (SELECT COUNT(*) FROM collaboration_revision_events e INNER JOIN collaboration_workspaces w ON w.id=e.workspace_id WHERE w.video_id=?) AS revisions,
      (SELECT COUNT(*) FROM annotation_submission_snapshots s INNER JOIN collaboration_workspaces w ON w.id=s.workspace_id WHERE w.video_id=?) AS submissions,
      (SELECT COUNT(*) FROM expert_analysis_releases e INNER JOIN collaboration_workspaces w ON w.id=e.workspace_id WHERE w.video_id=?) AS experts,
      (SELECT COALESCE(MAX(a.revision),0) FROM annotations a WHERE a.video_id=?) AS annotation_revision`)
    .bind(...Array(5).fill(WELCOME_HOME_V19_AUDIT_VIDEO_ID)).first();
  return hash(rows);
}

function expectedBefore(plan: MappingPlan) {
  return plan.initializedStructure
    && plan.before.structure.sourceShotGroupCount === 7
    && plan.before.structure.sourceShotCount === 23
    && plan.before.structure.targetShotGroupCount === 7
    && plan.before.structure.targetShotCount === 23
    && plan.before.totals.TARGET_EMPTY === 195
    && plan.before.totals.TARGET_SAME === 1
    && plan.before.totals.TARGET_DIFFERENT === 0
    && plan.before.totals.UNADDRESSABLE === 0
    && plan.after.totals.TARGET_SAME === 196;
}

function exactApplied(plan: MappingPlan) {
  return !plan.initializedStructure
    && plan.after.totals.TARGET_SAME === 196
    && plan.after.totals.TARGET_EMPTY === 0
    && plan.after.totals.TARGET_DIFFERENT === 0
    && plan.after.totals.UNADDRESSABLE === 0;
}

async function buildPreview(
  db: DbClient,
  actor: Pick<V04Actor, "userId">,
  options: { tokenSecret: string; now?: Date; targetCodeSha?: string; lock?: boolean },
): Promise<WelcomeHomeV19MappingPreview> {
  const now = options.now ?? new Date();
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  const windowStart = Math.floor(now.getTime() / WELCOME_HOME_V19_MAPPING_TOKEN_TTL_MS)
    * WELCOME_HOME_V19_MAPPING_TOKEN_TTL_MS;
  const generatedAt = new Date(windowStart).toISOString();
  const expiresAt = new Date(windowStart + WELCOME_HOME_V19_MAPPING_TOKEN_TTL_MS).toISOString();
  await assertWelcomeHomeV19AuditAdmin(db, actor.userId);
  const beforeHash = await aggregateFingerprint(db);
  const source = await loadSource(db, options.lock);
  const target = await loadTarget(db, options.lock);
  const plan = planWelcomeHomeV19Mapping(source.snapshotPayload, target.payload);
  const appliedRows = (await db.prepare(`SELECT operation_key,status,actor_identity,source_hash,target_hash,
      non_target_hash,backup_json,result_json FROM admin_data_operations
    WHERE operation_type=? AND target_video_id=? AND status='COMPLETED' ORDER BY created_at`)
    .bind(WELCOME_HOME_V19_MAPPING_OPERATION_TYPE, WELCOME_HOME_V19_AUDIT_VIDEO_ID).all<LedgerRow>()).results;
  const alreadyApplied = exactApplied(plan) && appliedRows.length === 1
    && exactAppliedLedger(
      appliedRows[0], source.sourceDigest, target.row.content_hash ?? "", actor.userId,
    );
  const stopReasons = new Set<string>();
  if (target.submissionCount !== 0) stopReasons.add("TARGET_SUBMISSION_PRESENT");
  if (target.expertReleaseCount !== 0) stopReasons.add("TARGET_EXPERT_RELEASE_PRESENT");
  if (target.activeLeaseCount !== 0) stopReasons.add("TARGET_ACTIVE_LEASE");
  if (appliedRows.length > 1) stopReasons.add("MULTIPLE_MAPPING_LEDGER_ROWS");
  if (!expectedBefore(plan) && !alreadyApplied) stopReasons.add("EXPECTED_CLASSIFICATION_DRIFT");
  plan.before.stopReasons.filter((reason) => reason !== "STRUCTURE_DRIFT").forEach((reason) => stopReasons.add(reason));
  const afterHash = await aggregateFingerprint(db);
  if (beforeHash !== afterHash) stopReasons.add("PREVIEW_WROTE_DATABASE");
  const nonTargetHash = await nonTargetFingerprint(db, target.row.id);
  const previewFacts = {
    contractHash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
    targetCodeSha,
    actorDigest: actorDigest(actor.userId),
    generatedAt,
    expiresAt,
    source: {
      streamId: source.row.stream_id, roundId: source.row.round_id,
      snapshotId: source.row.snapshot_id, annotationId: source.row.annotation_id,
      storedContentHash: source.row.snapshot_content_hash,
      canonicalFingerprint: source.canonicalFingerprint, sourceDigest: source.sourceDigest,
    },
    target: {
      workspaceId: target.row.id, snapshotId: target.row.snapshot_id,
      revision: Number(target.row.revision), contentHash: target.row.content_hash,
      submissionCount: target.submissionCount, expertReleaseCount: target.expertReleaseCount,
      activeLeaseCount: target.activeLeaseCount,
    },
    totals: plan.before.totals,
    postTotals: plan.after.totals,
    structure: plan.before.structure,
    nonTargetHash,
    alreadyApplied,
    stopReasons: [...stopReasons].sort(),
  };
  const previewHash = hash(previewFacts);
  const tokenPayload: PreviewTokenPayload = {
    version: "WELCOME_HOME_V19_MAPPING_PREVIEW_V1_1",
    actorDigest: actorDigest(actor.userId), targetCodeSha, previewHash, generatedAt, expiresAt,
    streamId: source.row.stream_id, roundId: source.row.round_id,
    snapshotId: source.row.snapshot_id, annotationId: source.row.annotation_id,
    storedContentHash: source.row.snapshot_content_hash,
    canonicalFingerprint: source.canonicalFingerprint, sourceDigest: source.sourceDigest,
    workspaceId: target.row.id, targetSnapshotId: target.row.snapshot_id,
    targetRevision: Number(target.row.revision), targetHash: target.row.content_hash ?? "",
  };
  const previewToken = signToken(tokenPayload, options.tokenSecret);
  return {
    mode: "FIXED_SINGLE_CASE_V1_1",
    ready: stopReasons.size === 0,
    alreadyApplied,
    generatedAt, expiresAt, targetCodeSha,
    contract: { version: WELCOME_HOME_V19_AUDIT_CONTRACT_VERSION, hash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH, fieldTypeCount: 19, instanceCount: 196 },
    source: {
      roundNumber: Number(source.row.round_number), revision: Number(source.row.snapshot_revision),
      storedHashDigest: hash(source.row.snapshot_content_hash),
      canonicalFingerprint: source.canonicalFingerprint, sourceDigest: source.sourceDigest,
    },
    target: {
      revision: Number(target.row.revision), contentHash: target.row.content_hash ?? "",
      workspaceStatus: target.row.status, submissionCount: target.submissionCount,
      expertReleaseCount: target.expertReleaseCount, activeLeaseCount: target.activeLeaseCount,
    },
    structure: plan.before.structure, totals: plan.before.totals,
    fieldTypes: plan.before.fieldTypes, postApplyTotals: plan.after.totals,
    previewHash, previewToken, previewTokenDigest: hash(previewToken),
    zeroWrite: { beforeHash, afterHash, unchanged: beforeHash === afterHash },
    stopReasons: [...stopReasons].sort(),
  };
}

export async function previewWelcomeHomeV19Mapping(
  db: DbClient,
  actor: Pick<V04Actor, "userId">,
  options: { tokenSecret: string; now?: Date; targetCodeSha?: string },
) {
  try {
    return await db.withTransaction(async (tx) => {
      await tx.prepare("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").run();
      return buildPreview(tx, actor, options);
    });
  } catch (error) {
    if (error instanceof V04ServiceError) throw error;
    throw new V04ServiceError("INTERNAL_ERROR", "《欢迎回家》映射 PREVIEW 未完成。", { stage: "PREVIEW_READ" });
  }
}

function resultFromLedger(row: LedgerRow): WelcomeHomeV19MappingApplyResult {
  const result = parsedLedgerResult(row);
  if (!result) throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "映射操作仍在执行或结果缺失。");
  return { ...result, outcome: "ALREADY_APPLIED" };
}

export async function applyWelcomeHomeV19Mapping(
  db: DbClient,
  actor: V04Actor,
  input: WelcomeHomeV19MappingApplyInput,
  options: { tokenSecret: string; now?: Date; targetCodeSha?: string; failAt?: string },
): Promise<WelcomeHomeV19MappingApplyResult> {
  const now = options.now ?? new Date();
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  if (input.action !== "APPLY_WELCOME_HOME_V19_MAPPING"
    || input.confirmation !== WELCOME_HOME_V19_MAPPING_CONFIRMATION
    || requireText(input.targetCodeSha, "目标代码 SHA", 7, 64) !== targetCodeSha) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "映射执行确认不正确。");
  }
  const idempotencyKey = requireText(input.idempotencyKey, "幂等键", 16, 128);
  const approvalReference = requireText(input.approvalReference, "批准引用", 12, 512);
  const token = parseToken(input.previewToken, options.tokenSecret);
  if (token.actorDigest !== actorDigest(actor.userId) || token.targetCodeSha !== targetCodeSha
    || Date.parse(token.expiresAt) <= now.getTime()) {
    throw new V04ServiceError("STALE_PREVIEW", "映射 PREVIEW 已失效。");
  }
  const operationKey = `${WELCOME_HOME_V19_MAPPING_OPERATION_TYPE}:${hash({ idempotencyKey, actorDigest: token.actorDigest, previewHash: token.previewHash })}`;
  return db.withTransaction(async (tx) => {
    await tx.prepare("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE").run();
    await tx.prepare("SET LOCAL lock_timeout='5s'").run();
    await tx.prepare("SET LOCAL statement_timeout='55s'").run();
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))").bind(WELCOME_HOME_V19_MAPPING_LOCK_KEY).run();
    const existing = await tx.prepare(`SELECT operation_key,status,actor_identity,source_hash,target_hash,
        non_target_hash,backup_json,result_json FROM admin_data_operations WHERE operation_key=? FOR UPDATE`)
      .bind(operationKey).first<LedgerRow>();
    if (existing) {
      if (existing.actor_identity !== actor.userId) throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已绑定其他操作者。");
      return resultFromLedger(existing);
    }
    const completed = (await tx.prepare(`SELECT operation_key,status,actor_identity,source_hash,target_hash,
        non_target_hash,backup_json,result_json FROM admin_data_operations
      WHERE operation_type=? AND target_video_id=? AND status='COMPLETED' FOR UPDATE`)
      .bind(WELCOME_HOME_V19_MAPPING_OPERATION_TYPE, WELCOME_HOME_V19_AUDIT_VIDEO_ID).all<LedgerRow>()).results;
    const preview = await buildPreview(tx, actor, { ...options, now, targetCodeSha, lock: true });
    if (preview.alreadyApplied && completed.length === 1
      && exactAppliedLedger(
        completed[0], preview.source.sourceDigest, preview.target.contentHash, actor.userId,
      )) {
      return resultFromLedger(completed[0]);
    }
    if (!preview.ready || preview.alreadyApplied || preview.previewHash !== token.previewHash
      || preview.source.sourceDigest !== token.sourceDigest
      || preview.source.canonicalFingerprint !== token.canonicalFingerprint
      || preview.source.storedHashDigest !== hash(token.storedContentHash)
      || preview.target.revision !== token.targetRevision
      || preview.target.contentHash !== token.targetHash) {
      throw new V04ServiceError("STALE_PREVIEW", "映射事实已经变化。", { stopReasons: preview.stopReasons });
    }
    const source = await loadSource(tx, true);
    const target = await loadTarget(tx, true);
    if (source.row.stream_id !== token.streamId || source.row.round_id !== token.roundId
      || source.row.snapshot_id !== token.snapshotId || source.row.annotation_id !== token.annotationId
      || source.row.snapshot_content_hash !== token.storedContentHash
      || source.canonicalFingerprint !== token.canonicalFingerprint
      || source.sourceDigest !== token.sourceDigest
      || target.row.id !== token.workspaceId || target.row.snapshot_id !== token.targetSnapshotId
      || Number(target.row.revision) !== token.targetRevision
      || target.row.content_hash !== token.targetHash) {
      throw new V04ServiceError("STALE_PREVIEW", "映射稳定对象或版本指针已经变化。");
    }
    const plan = planWelcomeHomeV19Mapping(source.snapshotPayload, target.payload);
    if (!expectedBefore(plan) || plan.appliedLocators.length !== 195) {
      throw new V04ServiceError("STALE_PREVIEW", "映射分类不再符合固定 195+1 合同。");
    }
    const nonTargetBefore = await nonTargetFingerprint(tx, target.row.id);
    const previewTokenDigest = hash(input.previewToken);
    await tx.prepare(`INSERT INTO admin_data_operations (
      operation_key,operation_type,target_video_id,status,actor_identity,actor_name,
      preview_token,source_hash,target_hash,non_target_hash,backup_json,result_json,
      created_at,completed_at
    ) VALUES (?,?,?,'RUNNING',?,?,?,?,?,?,?::jsonb,NULL,?,NULL)`)
      .bind(operationKey, WELCOME_HOME_V19_MAPPING_OPERATION_TYPE, WELCOME_HOME_V19_AUDIT_VIDEO_ID,
        actor.userId, actor.displayName, previewTokenDigest, source.sourceDigest,
        target.row.content_hash ?? "", nonTargetBefore, JSON.stringify({
          approvalReference, previewTokenDigest, previewHash: preview.previewHash,
          targetCodeSha, sourceSnapshotId: source.row.snapshot_id,
          targetWorkspaceId: target.row.id, targetSnapshotId: target.row.snapshot_id,
          targetRevision: Number(target.row.revision), targetHash: target.row.content_hash,
          contractHash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
        }), now.toISOString()).run();
    if (options.failAt === "AFTER_LEDGER") throw new Error("TEST_ONLY_FAIL_AFTER_LEDGER");
    const nextRevision = Number(target.row.revision) + 1;
    const nextHash = hashV04Payload(plan.payload);
    const nextSnapshotId = id("snapshot");
    const changedAt = now.toISOString();
    await persistV04RelationalDraft(tx, target.row, plan.payload, nextRevision, nextHash, actor, changedAt);
    await tx.prepare(`INSERT INTO annotation_snapshots (
      id,annotation_id,video_id,author_email,author_name,taxonomy_version,revision,
      payload_json,content_hash,created_at,workflow_status,snapshot_kind,workflow_version,
      vocabulary_version,payload_schema_version,created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,'DRAFT','WORKING',?,?,?,?)`)
      .bind(nextSnapshotId, target.row.canonical_annotation_id, target.row.video_id,
        actor.identityKey, actor.displayName, V04_TAXONOMY_VERSION, nextRevision,
        JSON.stringify(plan.payload), nextHash, changedAt, V04_WORKFLOW_VERSION,
        V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION, actor.userId).run();
    const changeSetId = `welcome_home_v19_${hash({ operationKey, nextRevision }).slice(0, 32)}`;
    await tx.prepare(`INSERT INTO collaboration_revision_events (
      id,workspace_id,round_id,annotation_id,change_set_id,base_revision,applied_revision,
      target_key,target_label_snapshot,value_type,before_value_json,after_value_json,
      source_kind,source_object_type,source_object_id,reason,actor_user_id,actor_name_snapshot,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,'STRUCTURE',?::jsonb,?::jsonb,'SYSTEM_MIGRATION','ANNOTATION_SNAPSHOT',?,?,?, ?,?::timestamptz)`)
      .bind(id("revision_event"), target.row.id, target.row.active_round_id,
        target.row.canonical_annotation_id, changeSetId, Number(target.row.revision), nextRevision,
        "script.structure", "初始化 7 桥段／23 镜头稳定容器", JSON.stringify([]),
        JSON.stringify({ shotGroupIds: plan.payload.script.shotGroups.map((group) => group.id),
          shotIds: plan.payload.script.shotGroups.flatMap((group) => group.shots.map((shot) => shot.id)) }),
        source.row.snapshot_id, "V1.1 直接映射：仅初始化批准的稳定结构并填充空白项。",
        actor.userId, actor.displayName, changedAt).run();
    for (const entry of plan.before.entries.filter((item) => item.classification === "TARGET_EMPTY")) {
      await tx.prepare(`INSERT INTO collaboration_revision_events (
        id,workspace_id,round_id,annotation_id,change_set_id,base_revision,applied_revision,
        target_key,target_label_snapshot,value_type,before_value_json,after_value_json,
        source_kind,source_object_type,source_object_id,reason,actor_user_id,actor_name_snapshot,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'TEXT',?::jsonb,?::jsonb,'SYSTEM_MIGRATION','ANNOTATION_SNAPSHOT',?,?,?, ?,?::timestamptz)`)
        .bind(id("revision_event"), target.row.id, target.row.active_round_id,
          target.row.canonical_annotation_id, changeSetId, Number(target.row.revision), nextRevision,
          entry.stableLocator, entry.fieldKey, JSON.stringify(""), JSON.stringify(entry.sourceValue),
          source.row.snapshot_id, "V1.1 直接映射：目标为空时填充。",
          actor.userId, actor.displayName, changedAt).run();
    }
    await tx.prepare("UPDATE collaboration_workspaces SET current_working_snapshot_id=?,updated_at=?::timestamptz WHERE id=?")
      .bind(nextSnapshotId, changedAt, target.row.id).run();
    await tx.prepare(`INSERT INTO audit_logs (
      id,actor_email,action,object_type,object_id,detail_json,actor_user_id,request_id,workflow_version
    ) VALUES (?,?,?,?,?,?,?, ?,?)`)
      .bind(id("audit"), actor.identityKey, "WELCOME_HOME_V19_DIRECT_MAPPING_APPLIED",
        "V04_WORKSPACE", target.row.id, JSON.stringify({ operationKey, contractHash: WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
          sourceDigest: source.sourceDigest, mappedEmptyCount: 195, sameNoopCount: 1,
          structure: { shotGroupCount: 7, shotCount: 23 } }), actor.userId, actor.requestId,
        V04_WORKFLOW_VERSION).run();
    if (options.failAt === "AFTER_SNAPSHOT") throw new Error("TEST_ONLY_FAIL_AFTER_SNAPSHOT");
    const postSource = await loadSource(tx, false);
    const postTarget = await loadTarget(tx, false);
    const postComparison = compareWelcomeHomeV19Payloads(postSource.snapshotPayload, postTarget.payload);
    const nonTargetAfter = await nonTargetFingerprint(tx, postTarget.row.id);
    if (postSource.sourceDigest !== source.sourceDigest || nonTargetAfter !== nonTargetBefore
      || postTarget.submissionCount !== target.submissionCount
      || postTarget.expertReleaseCount !== target.expertReleaseCount
      || postTarget.row.status !== "ACTIVE"
      || postComparison.totals.TARGET_SAME !== 196
      || postComparison.totals.TARGET_EMPTY !== 0
      || postComparison.totals.TARGET_DIFFERENT !== 0
      || postComparison.totals.UNADDRESSABLE !== 0
      || postComparison.structure.sourceShotGroupCount !== 7
      || postComparison.structure.sourceShotCount !== 23) {
      throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "映射写后不变量校验未通过。", { stage: "POSTCHECK" });
    }
    const result: WelcomeHomeV19MappingApplyResult = {
      outcome: "APPLIED", operationKey, revision: nextRevision, contentHash: nextHash,
      structure: { shotGroupCount: 7, shotCount: 23 }, totals: postComparison.totals,
      submissionCount: postTarget.submissionCount, expertReleaseCount: postTarget.expertReleaseCount,
      sourceDigest: source.sourceDigest, previewTokenDigest, completedAt: changedAt,
    };
    await tx.prepare(`UPDATE admin_data_operations SET status='COMPLETED',result_json=?::jsonb,completed_at=?
      WHERE operation_key=?`).bind(JSON.stringify(result), changedAt, operationKey).run();
    return result;
  });
}
