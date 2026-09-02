// V1.9 二合一工作台重构：每人一个版本的服务层唯一入口。
// 见 docs/18_V1.9_二合一工作台重构实施规格_V0.1.md 三、数据架构 / 四、接口。
//
// 不复用 v04-workspace-service.ts 里跟乐观锁 / 租约绑定的写路径（saveV04Draft），
// 只复用它已经导出的 materializeV04Workspace 完成「首写物化公共工作区」这一步，
// payload 契约、词表校验、变更应用则直接复用 v04-domain.ts，与旧链路保持同一套真相。

import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04Change,
  type V04DraftPayloadV1,
} from "./v04-contract";
import {
  applyV04ChangeSetLastWriteWins,
  assertV04PayloadContract,
  canonicalV04ChangeSet,
  emptyV04DraftPayload,
  hashV04Payload,
  listV04ContractViolations,
} from "./v04-domain";
import { V04ServiceError } from "./v04-errors";
import { materializeV04Workspace, type V04Actor } from "./v04-workspace-service";
import {
  intakeIntoFinal,
  loadFinalTrace,
  loadFinalVersion,
  type FinalSummary,
  type FinalTraceIntake,
  type LoadedFinalVersion,
} from "./final-version";

const WORKFLOW = V04_WORKFLOW_VERSION;

export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const iso = (value: Date) => value.toISOString();

// ---------------------------------------------------------------------------
// Pure helpers (no I/O) — exported so unit tests can exercise the decision
// logic without a live database.
// ---------------------------------------------------------------------------

/** `version_number` for a workspace's next version: max existing + 1, gaps ignored. */
export function nextV19VersionNumber(existingNumbers: readonly number[]): number {
  if (existingNumbers.length === 0) return 1;
  return Math.max(...existingNumbers) + 1;
}

/**
 * The version a viewer sees by default: the one most recently modified.
 * Ties (equal `updatedAt`) fall back to the highest version number so the
 * choice is deterministic even when two saves land in the same instant.
 */
export function resolveV19DefaultVersion<T extends { number: number; updatedAt: string }>(
  versions: readonly T[],
): T {
  if (versions.length === 0) {
    throw new Error("EMPTY_VERSION_LIST");
  }
  return versions.reduce((best, candidate) => {
    const bestTime = Date.parse(best.updatedAt);
    const candidateTime = Date.parse(candidate.updatedAt);
    if (candidateTime > bestTime) return candidate;
    if (candidateTime === bestTime && candidate.number > best.number) return candidate;
    return best;
  });
}

/** `v3（基于v1，张三）` / `v1（初始版本，王大明·上传者）`, per spec 二、2.5. */
export function formatV19VersionLabel(input: {
  number: number;
  baseNumber: number | null;
  ownerName: string;
  ownerIsUploader: boolean;
}): string {
  const ownerLabel = input.ownerIsUploader ? `${input.ownerName}·上传者` : input.ownerName;
  const basis = input.baseNumber === null ? "初始版本" : `基于v${input.baseNumber}`;
  return `v${input.number}（${basis}，${ownerLabel}）`;
}

/** The version owned by `actorUserId`, or null — every person owns at most one. */
export function pickV19ActorVersion<T extends { ownerUserId: string }>(
  versions: readonly T[],
  actorUserId: string,
): T | null {
  return versions.find((version) => version.ownerUserId === actorUserId) ?? null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type V19VersionSummary = {
  id: string | null;
  number: number;
  ownerUserId: string;
  ownerName: string;
  baseNumber: number | null;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
  isVirtual: boolean;
  baseIsFinal: boolean;
};

export type V19CurrentVersion = V19VersionSummary & {
  payload: V04DraftPayloadV1;
  basePayload: V04DraftPayloadV1 | null;
  revision: number;
  contentHash: string;
  isFinal: boolean;
};

export type V19VersionChain = {
  versions: V19VersionSummary[];
  current: V19CurrentVersion;
  myVersionId: string | null;
  final: FinalSummary | null;
  finalTrace?: { originPayload: V04DraftPayloadV1; intakes: FinalTraceIntake[] };
};

export type V19SaveInput = {
  videoId: string;
  basedOnVersionId: string | null;
  changeSetId: string;
  changes: V04Change[];
  now?: Date;
};

export type V19SaveResult = {
  versionId: string;
  versionNumber: number;
  revision: number;
  contentHash: string;
  updatedAt: string;
  createdVersion: boolean;
  skippedTargets?: string[];
  finalIntake: { merged: boolean; pending: number };
};

export type V19CreateFromInput = {
  videoId: string;
  baseVersionId: string;
  now?: Date;
};

// ---------------------------------------------------------------------------
// Row shapes and small DB helpers
// ---------------------------------------------------------------------------

export type WorkspaceRow = QueryResultRow & {
  id: string;
  video_id: string;
  canonical_annotation_id: string;
  active_round_id: string;
  current_working_snapshot_id: string | null;
  created_by_user_id: string;
  status: "ACTIVE" | "ARCHIVED" | "TRASHED";
  updated_at: string;
};

export type AnalysisVersionRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  video_id: string;
  version_number: number;
  owner_user_id: string;
  owner_name_snapshot: string;
  base_version_id: string | null;
  base_version_number: number | null;
  base_payload_json: V04DraftPayloadV1 | string | null;
  base_captured_at: string | null;
  payload_json: V04DraftPayloadV1 | string;
  content_hash: string;
  revision: number;
  taxonomy_version: string;
  workflow_version: string;
  vocabulary_version: string;
  payload_schema_version: string;
  base_is_final: boolean;
  created_at: string;
  updated_at: string;
};

export const VERSION_COLUMNS = `id, workspace_id, video_id, version_number, owner_user_id, owner_name_snapshot,
  base_version_id, base_version_number, base_payload_json, base_captured_at,
  payload_json, content_hash, revision, taxonomy_version, workflow_version,
  vocabulary_version, payload_schema_version, base_is_final, created_at, updated_at`;

export function parseJsonPayload(value: V04DraftPayloadV1 | string): V04DraftPayloadV1 {
  return typeof value === "string" ? JSON.parse(value) as V04DraftPayloadV1 : value;
}

export async function workspaceForVideo(db: DbClient, videoId: string, lock = false) {
  return db.prepare(
    `SELECT id, video_id, canonical_annotation_id, active_round_id,
      current_working_snapshot_id, created_by_user_id, status, updated_at
    FROM collaboration_workspaces
    WHERE video_id = ? AND workflow_version = ?
    ${lock ? "FOR UPDATE" : ""}`,
  ).bind(videoId, WORKFLOW).first<WorkspaceRow>();
}

async function assertCaseAvailable(db: DbClient, videoId: string, lock = false) {
  const row = await db.prepare(
    `SELECT id, deleted_at, deletion_state FROM videos
    WHERE id = ? ${lock ? "FOR UPDATE" : ""}`,
  ).bind(videoId).first<{
    id: string;
    deleted_at: string | null;
    deletion_state: string | null;
  } & QueryResultRow>();
  if (!row) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
  if (row.deletion_state === "ASSET_PURGED") {
    throw new V04ServiceError("ASSET_PURGED", "案例原始资产已经清理。");
  }
  if (row.deleted_at || row.deletion_state === "TRASHED") {
    throw new V04ServiceError("CASE_IN_TRASH", "案例已进入回收站。");
  }
}

async function currentWorkspacePayload(db: DbClient, workspace: WorkspaceRow) {
  if (!workspace.current_working_snapshot_id) return emptyV04DraftPayload();
  const row = await db.prepare(
    `SELECT payload_json FROM annotation_snapshots WHERE id = ?`,
  ).bind(workspace.current_working_snapshot_id).first<
    { payload_json: V04DraftPayloadV1 | string } & QueryResultRow
  >();
  if (!row) throw new V04ServiceError("VERSION_NOT_FOUND", "当前工作稿快照不存在。");
  const payload = parseJsonPayload(row.payload_json);
  assertV04PayloadContract(payload);
  return payload;
}

async function userDisplayName(db: DbClient, userId: string) {
  const row = await db.prepare(`SELECT display_name FROM users WHERE id = ?`)
    .bind(userId).first<{ display_name: string } & QueryResultRow>();
  return row?.display_name ?? "";
}

export async function insertAudit(
  db: DbClient,
  actor: V04Actor,
  action: string,
  objectType: string,
  objectId: string,
  detail: Record<string, unknown>,
) {
  await db.prepare(
    `INSERT INTO audit_logs (
      id, actor_email, action, object_type, object_id, detail_json,
      actor_user_id, request_id, workflow_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id("audit"), actor.identityKey, action, objectType, objectId,
    JSON.stringify(detail), actor.userId, actor.requestId, WORKFLOW,
  ).run();
}

export async function listVersionRows(db: DbClient, workspaceId: string) {
  return (await db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM analysis_versions
    WHERE workspace_id = ? ORDER BY version_number ASC`,
  ).bind(workspaceId).all<AnalysisVersionRow>()).results;
}

export async function findVersionById(db: DbClient, versionId: string) {
  return db.prepare(`SELECT ${VERSION_COLUMNS} FROM analysis_versions WHERE id = ?`)
    .bind(versionId).first<AnalysisVersionRow>();
}

async function findVersionByOwner(db: DbClient, workspaceId: string, ownerUserId: string) {
  return db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM analysis_versions WHERE workspace_id = ? AND owner_user_id = ?`,
  ).bind(workspaceId, ownerUserId).first<AnalysisVersionRow>();
}

export function toSummary(row: AnalysisVersionRow, actorUserId: string): V19VersionSummary {
  return {
    id: row.id,
    number: Number(row.version_number),
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name_snapshot,
    baseNumber: row.base_version_number === null || row.base_version_number === undefined
      ? null
      : Number(row.base_version_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isMine: row.owner_user_id === actorUserId,
    isVirtual: false,
    baseIsFinal: Boolean(row.base_is_final),
  };
}

function toCurrentVersion(row: AnalysisVersionRow, actorUserId: string): V19CurrentVersion {
  return {
    ...toSummary(row, actorUserId),
    payload: parseJsonPayload(row.payload_json),
    basePayload: row.base_payload_json == null ? null : parseJsonPayload(row.base_payload_json),
    revision: Number(row.revision),
    contentHash: row.content_hash,
    isFinal: false,
  };
}

/** `current` when the viewer is looking at the final version instead of a per-editor one (spec 4.1). */
function finalToCurrentVersion(final: LoadedFinalVersion): V19CurrentVersion {
  return {
    id: final.id,
    number: 0,
    ownerUserId: "",
    ownerName: "最终版",
    baseNumber: null,
    createdAt: final.createdAt,
    updatedAt: final.updatedAt,
    isMine: false,
    isVirtual: final.isVirtual,
    baseIsFinal: false,
    isFinal: true,
    payload: final.payload,
    basePayload: null,
    revision: final.revision,
    contentHash: final.contentHash,
  };
}

function virtualVersion(
  ownerUserId: string,
  ownerName: string,
  actorUserId: string,
  updatedAt: string,
): V19VersionSummary {
  return {
    id: null,
    number: 1,
    ownerUserId,
    ownerName,
    baseNumber: null,
    createdAt: updatedAt,
    updatedAt,
    isMine: ownerUserId === actorUserId,
    isVirtual: true,
    baseIsFinal: false,
  };
}

// ---------------------------------------------------------------------------
// Read path — never writes (spec 3.1 首写物化 / 3.3 懒物化).
// ---------------------------------------------------------------------------

export async function loadV19VersionChain(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  options: { versionId?: string; includeFinalTrace?: boolean } = {},
): Promise<V19VersionChain> {
  const workspace = await workspaceForVideo(db, videoId);
  if (!workspace) {
    // Nobody has touched this case yet: nothing to read but an empty draft.
    // Attribute the not-yet-created v1 to the viewer — it becomes real and
    // theirs the moment they make the first edit. The final version has no
    // meaning until the case has at least one real version (spec 二、11).
    const payload = emptyV04DraftPayload();
    const nowIso = new Date().toISOString();
    const virtual = virtualVersion(actor.userId, actor.displayName, actor.userId, nowIso);
    return {
      versions: [virtual],
      current: { ...virtual, payload, basePayload: null, revision: 1, contentHash: hashV04Payload(payload), isFinal: false },
      myVersionId: null,
      final: null,
    };
  }

  const rows = await listVersionRows(db, workspace.id);
  if (rows.length === 0) {
    const payload = await currentWorkspacePayload(db, workspace);
    const ownerName = await userDisplayName(db, workspace.created_by_user_id);
    const virtual = virtualVersion(workspace.created_by_user_id, ownerName, actor.userId, workspace.updated_at);
    return {
      versions: [virtual],
      current: { ...virtual, payload, basePayload: null, revision: 1, contentHash: hashV04Payload(payload), isFinal: false },
      myVersionId: null,
      final: null,
    };
  }

  const summaries = rows.map((row) => toSummary(row, actor.userId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const mine = rows.find((row) => row.owner_user_id === actor.userId);

  // spec 二、11: whenever the case has any real version, `final` is meaningful
  // (materialized or virtual) and becomes the default `current` unless a
  // specific real version was explicitly requested.
  const finalLoaded = await loadFinalVersion(db, workspace);
  const final: FinalSummary = {
    id: finalLoaded.id,
    status: finalLoaded.status,
    doneAt: finalLoaded.doneAt,
    doneByName: finalLoaded.doneByName,
    updatedAt: finalLoaded.updatedAt,
    pendingCount: finalLoaded.pendingCount,
    isVirtual: finalLoaded.isVirtual,
  };

  const requested = options.versionId && options.versionId !== "final"
    ? byId.get(options.versionId)
    : undefined;
  const current = requested ? toCurrentVersion(requested, actor.userId) : finalToCurrentVersion(finalLoaded);

  const finalTrace = options.includeFinalTrace ? await loadFinalTrace(db, workspace) : undefined;

  return {
    versions: summaries,
    current,
    myVersionId: mine?.id ?? null,
    final,
    finalTrace,
  };
}

// ---------------------------------------------------------------------------
// Write path.
// ---------------------------------------------------------------------------

export async function materializeV19FirstVersion(db: DbClient, workspace: WorkspaceRow, now: Date) {
  const payload = await currentWorkspacePayload(db, workspace);
  const ownerName = await userDisplayName(db, workspace.created_by_user_id);
  const contentHash = hashV04Payload(payload);
  const savedAt = iso(now);
  // ON CONFLICT rather than catching the unique violation: inside a Postgres
  // transaction a raised constraint error aborts the whole transaction, so
  // every statement after the catch would fail. Letting the insert no-op keeps
  // the transaction usable and lets the caller simply re-read the winner.
  await db.prepare(
    `INSERT INTO analysis_versions (
      id, workspace_id, video_id, version_number, owner_user_id, owner_name_snapshot,
      base_version_id, base_version_number, base_payload_json, base_captured_at,
      payload_json, content_hash, revision, taxonomy_version, workflow_version,
      vocabulary_version, payload_schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL, NULL, ?::jsonb, ?, 1, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
    ON CONFLICT DO NOTHING`,
  ).bind(
    id("analysis_version"), workspace.id, workspace.video_id,
    workspace.created_by_user_id, ownerName,
    JSON.stringify(payload), contentHash,
    V04_TAXONOMY_VERSION, V04_WORKFLOW_VERSION, V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION,
    savedAt, savedAt,
  ).run();
}

export async function insertVersionFromBase(
  db: DbClient,
  workspace: WorkspaceRow,
  actor: V04Actor,
  base: AnalysisVersionRow,
  versionNumber: number,
  now: Date,
) {
  const basePayload = parseJsonPayload(base.payload_json);
  const newId = id("analysis_version");
  const savedAt = iso(now);
  const inserted = await db.prepare(
    `INSERT INTO analysis_versions (
      id, workspace_id, video_id, version_number, owner_user_id, owner_name_snapshot,
      base_version_id, base_version_number, base_payload_json, base_captured_at,
      payload_json, content_hash, revision, taxonomy_version, workflow_version,
      vocabulary_version, payload_schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz, ?::jsonb, ?, 1, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING id`,
  ).bind(
    newId, workspace.id, workspace.video_id, versionNumber, actor.userId, actor.displayName,
    base.id, Number(base.version_number), JSON.stringify(basePayload), savedAt,
    JSON.stringify(basePayload), base.content_hash,
    V04_TAXONOMY_VERSION, V04_WORKFLOW_VERSION, V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION,
    savedAt, savedAt,
  ).first<{ id: string } & QueryResultRow>();
  // No row back means a concurrent writer already took this owner slot or
  // version number; the caller re-reads instead of treating it as an error.
  return inserted?.id ?? null;
}

/**
 * "基于最终版" 手动创建（spec 五、13）：以最终版当前 payload 为快照。最终版的 id
 * 不在 analysis_versions 里（不能满足 base_version_id 的外键），所以
 * base_version_id / base_version_number 记 null，改用 base_is_final 标记来源。
 */
export async function insertVersionFromFinal(
  db: DbClient,
  workspace: WorkspaceRow,
  actor: V04Actor,
  finalPayload: V04DraftPayloadV1,
  finalContentHash: string,
  versionNumber: number,
  now: Date,
) {
  const newId = id("analysis_version");
  const savedAt = iso(now);
  const inserted = await db.prepare(
    `INSERT INTO analysis_versions (
      id, workspace_id, video_id, version_number, owner_user_id, owner_name_snapshot,
      base_version_id, base_version_number, base_payload_json, base_captured_at,
      payload_json, content_hash, revision, taxonomy_version, workflow_version,
      vocabulary_version, payload_schema_version, base_is_final, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?::jsonb, ?::timestamptz, ?::jsonb, ?, 1, ?, ?, ?, ?, true, ?::timestamptz, ?::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING id`,
  ).bind(
    newId, workspace.id, workspace.video_id, versionNumber, actor.userId, actor.displayName,
    JSON.stringify(finalPayload), savedAt,
    JSON.stringify(finalPayload), finalContentHash,
    V04_TAXONOMY_VERSION, V04_WORKFLOW_VERSION, V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION,
    savedAt, savedAt,
  ).first<{ id: string } & QueryResultRow>();
  return inserted?.id ?? null;
}

/**
 * Steps 2–3 of spec 3.4: lazily materialize v1 if the workspace has no
 * version yet, then resolve the actor's own version — creating one based on
 * `basedOnVersionId` (or the current default version) the first time they
 * touch this workspace. `createdVersion` reports whether a row was inserted
 * by this call, whether that is v1 itself or a fresh version based on it.
 */
async function resolveOrCreateActorVersion(
  db: DbClient,
  workspace: WorkspaceRow,
  actor: V04Actor,
  basedOnVersionId: string | null,
  now: Date,
): Promise<{ versionRow: AnalysisVersionRow; createdVersion: boolean }> {
  const countRow = await db.prepare(
    `SELECT COUNT(*) AS count FROM analysis_versions WHERE workspace_id = ?`,
  ).bind(workspace.id).first<{ count: number } & QueryResultRow>();
  let materializedV1 = false;
  if (Number(countRow?.count ?? 0) === 0) {
    await materializeV19FirstVersion(db, workspace, now);
    materializedV1 = true;
  }

  // Every person owns at most one version — once they have one, later writes
  // (on any version they happen to be viewing) always land on their own.
  const mine = await findVersionByOwner(db, workspace.id, actor.userId);
  if (mine) return { versionRow: mine, createdVersion: materializedV1 };

  const allRows = await listVersionRows(db, workspace.id);
  const summaries = allRows.map((row) => toSummary(row, actor.userId));
  const requestedBase = basedOnVersionId
    ? allRows.find((row) => row.id === basedOnVersionId)
    : undefined;
  const base = requestedBase ?? allRows.find(
    (row) => row.id === resolveV19DefaultVersion(summaries).id,
  );
  if (!base) throw new V04ServiceError("VERSION_NOT_FOUND", "找不到可作为基版的版本。");
  const versionNumber = nextV19VersionNumber(allRows.map((row) => Number(row.version_number)));

  const newId = await insertVersionFromBase(db, workspace, actor, base, versionNumber, now);
  if (newId) {
    const created = await findVersionById(db, newId);
    if (!created) throw new V04ServiceError("VERSION_NOT_FOUND", "新建版本写入后读取失败。");
    return { versionRow: created, createdVersion: true };
  }
  // The insert no-opped: a concurrent writer took this owner slot or version
  // number first. Whoever won, this actor still writes to their own version —
  // a race must never surface to the person typing.
  const raced = await findVersionByOwner(db, workspace.id, actor.userId);
  if (raced) return { versionRow: raced, createdVersion: false };
  throw new V04ServiceError("VERSION_NOT_FOUND", "版本创建未完成，请重试。");
}

export async function resolveWorkspaceForWrite(db: DbClient, actor: V04Actor, videoId: string) {
  await assertCaseAvailable(db, videoId, true);
  let workspace = await workspaceForVideo(db, videoId, true);
  if (!workspace) {
    await materializeV04Workspace(db, videoId, actor);
    workspace = await workspaceForVideo(db, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作区物化失败。");
  }
  return workspace;
}

/** Service-layer sole write entry point for edits — spec 3.4. */
export async function saveV19VersionChanges(
  db: DbClient,
  actor: V04Actor,
  input: V19SaveInput,
): Promise<V19SaveResult> {
  const now = input.now ?? new Date();
  if (!input.changeSetId.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "保存请求缺少稳定变更集标识。");
  }
  if (!Array.isArray(input.changes)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "保存请求的变更集无效。");
  }
  try {
    canonicalV04ChangeSet(input.changes);
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_CHANGE_TARGET") {
      throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "同一变更集不能重复修改同一稳定内容单元。");
    }
    throw error;
  }

  return db.withTransaction(async (tx) => {
    const workspace = await resolveWorkspaceForWrite(tx, actor, input.videoId);

    // Idempotency: a changeSetId already recorded against a version replays
    // its result instead of being applied twice (spec 3.4, simplified — no
    // three-way merge or conflict path exists any more to reconcile against).
    const replay = await tx.prepare(
      `SELECT version_id FROM collaboration_revision_events
      WHERE workspace_id = ? AND change_set_id = ? AND version_id IS NOT NULL
      LIMIT 1`,
    ).bind(workspace.id, input.changeSetId).first<{ version_id: string } & QueryResultRow>();
    if (replay) {
      const versionRow = await findVersionById(tx, replay.version_id);
      if (!versionRow) throw new V04ServiceError("VERSION_NOT_FOUND", "幂等保存对应的版本不存在。");
      // 3.4: intake 落库以 change_set_id + source_version_id 判重，这里安全地
      // 重放同一次请求——原始保存早已写过汇入记录，这里只是重新读出 merged/pending。
      const finalIntake = await intakeIntoFinal(tx, workspace, {
        changes: input.changes,
        sourceVersionId: versionRow.id,
        sourceVersionNumber: Number(versionRow.version_number),
        actorUserId: actor.userId,
        actorName: actor.displayName,
        changeSetId: input.changeSetId,
        now,
      });
      return {
        versionId: versionRow.id,
        versionNumber: Number(versionRow.version_number),
        revision: Number(versionRow.revision),
        contentHash: versionRow.content_hash,
        updatedAt: versionRow.updated_at,
        createdVersion: false,
        finalIntake,
      };
    }

    const { versionRow, createdVersion } = await resolveOrCreateActorVersion(
      tx, workspace, actor, input.basedOnVersionId, now,
    );

    const before = parseJsonPayload(versionRow.payload_json);
    // Last write wins inside one's own version: a stale before-value is this
    // editor's own lag, never another editor's edit, so it must not cost them
    // the keystroke they just made. Only targets that no longer exist are
    // skipped, and they are named in the result.
    const { payload: after, appliedChanges, skippedTargets } =
      applyV04ChangeSetLastWriteWins(before, input.changes);
    try {
      assertV04PayloadContract(after);
    } catch (error) {
      if (error instanceof Error &&
        (error.message === "CHOICE_RULE_VIOLATION" || error.message === "INVALID_PAYLOAD_SCHEMA")) {
        const violations = listV04ContractViolations(after);
        throw new V04ServiceError(
          error.message,
          violations.length
            ? `工作稿不符合冻结规则：${violations.map((item) => `${item.targetLabel}（${item.message}）`).join("；")}`
            : "工作稿不符合冻结规则。",
          { violations },
        );
      }
      throw error;
    }

    const nextHash = hashV04Payload(after);
    if (nextHash === versionRow.content_hash) {
      const finalIntake = await intakeIntoFinal(tx, workspace, {
        changes: [],
        sourceVersionId: versionRow.id,
        sourceVersionNumber: Number(versionRow.version_number),
        actorUserId: actor.userId,
        actorName: actor.displayName,
        changeSetId: input.changeSetId,
        now,
      });
      return {
        versionId: versionRow.id,
        versionNumber: Number(versionRow.version_number),
        revision: Number(versionRow.revision),
        contentHash: versionRow.content_hash,
        updatedAt: versionRow.updated_at,
        createdVersion,
        skippedTargets,
        finalIntake,
      };
    }
    const nextRevision = Number(versionRow.revision) + 1;
    const savedAt = iso(now);
    await tx.prepare(
      `UPDATE analysis_versions
      SET payload_json = ?::jsonb, content_hash = ?, revision = ?, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(JSON.stringify(after), nextHash, nextRevision, savedAt, versionRow.id).run();

    for (const change of appliedChanges) {
      await tx.prepare(
        `INSERT INTO collaboration_revision_events (
          id, workspace_id, round_id, annotation_id, change_set_id,
          base_revision, applied_revision, target_key, target_label_snapshot,
          value_type, before_value_json, after_value_json, source_kind,
          reason, actor_user_id, actor_name_snapshot, created_at, version_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'HUMAN_DIRECT', ?, ?, ?, ?::timestamptz, ?)`,
      ).bind(
        id("revision_event"), workspace.id, workspace.active_round_id,
        workspace.canonical_annotation_id, input.changeSetId,
        Number(versionRow.revision), nextRevision, change.targetKey, change.targetLabel,
        change.valueType, JSON.stringify(change.beforeValue ?? null),
        JSON.stringify(change.afterValue ?? null),
        change.reason ?? null, actor.userId, actor.displayName, savedAt, versionRow.id,
      ).run();
    }

    await insertAudit(tx, actor, "V19_VERSION_SAVED", "V19_VERSION", versionRow.id, {
      workspaceId: workspace.id,
      changeSetId: input.changeSetId,
      versionNumber: Number(versionRow.version_number),
      appliedRevision: nextRevision,
      createdVersion,
      targets: appliedChanges.map((item) => item.targetKey),
      skippedTargets,
      contentHash: nextHash,
    });

    // spec 三、3.4: 汇入最终版必须发生在修订事件写完之后、同一事务内；任何最终版侧
    // 失败都不能让这次保存本身失败——intakeIntoFinal 内部把落不下去的记录标记为
    // NOOP，从不向外抛出跟内容有关的错误。
    const finalIntake = await intakeIntoFinal(tx, workspace, {
      changes: appliedChanges,
      sourceVersionId: versionRow.id,
      sourceVersionNumber: Number(versionRow.version_number),
      actorUserId: actor.userId,
      actorName: actor.displayName,
      changeSetId: input.changeSetId,
      now,
    });

    return {
      versionId: versionRow.id,
      versionNumber: Number(versionRow.version_number),
      revision: nextRevision,
      contentHash: nextHash,
      updatedAt: savedAt,
      createdVersion,
      skippedTargets,
      finalIntake,
    };
  });
}

/** Manual "create my version from this history version" — spec 四, POST route. */
export async function createV19VersionFrom(
  db: DbClient,
  actor: V04Actor,
  input: V19CreateFromInput,
): Promise<V19SaveResult> {
  const now = input.now ?? new Date();
  if (!input.baseVersionId?.trim()) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "创建版本需要指定基版。");
  }
  const alreadyOwnsVersion = () => new V04ServiceError(
    "FORBIDDEN",
    "你已经拥有本工作区的版本，无法再手动创建新版本；请直接在自己的版本上编辑。",
  );

  return db.withTransaction(async (tx) => {
    const workspace = await resolveWorkspaceForWrite(tx, actor, input.videoId);

    const countRow = await tx.prepare(
      `SELECT COUNT(*) AS count FROM analysis_versions WHERE workspace_id = ?`,
    ).bind(workspace.id).first<{ count: number } & QueryResultRow>();
    if (Number(countRow?.count ?? 0) === 0) {
      await materializeV19FirstVersion(tx, workspace, now);
    }

    const mine = await findVersionByOwner(tx, workspace.id, actor.userId);
    if (mine) throw alreadyOwnsVersion();

    const allRows = await listVersionRows(tx, workspace.id);
    const versionNumber = nextV19VersionNumber(allRows.map((row) => Number(row.version_number)));
    // Always resolved (even off the "final" branch) so the response can report
    // the final version's current pending count either way — spec 4.2's
    // finalIntake is present on every save-shaped response.
    const finalLoaded = await loadFinalVersion(tx, workspace);

    let newId: string | null;
    let contentHash: string;
    if (input.baseVersionId === "final") {
      newId = await insertVersionFromFinal(
        tx, workspace, actor, finalLoaded.payload, finalLoaded.contentHash, versionNumber, now,
      );
      contentHash = finalLoaded.contentHash;
    } else {
      const base = allRows.find((row) => row.id === input.baseVersionId);
      if (!base) throw new V04ServiceError("VERSION_NOT_FOUND", "指定的基版不存在。");
      // A no-op insert means someone else took this owner slot or version
      // number in between; for a manual creation that can only be the actor's
      // own second attempt, so it reports the same "already has a version"
      // outcome.
      newId = await insertVersionFromBase(tx, workspace, actor, base, versionNumber, now);
      contentHash = base.content_hash;
    }
    if (!newId) throw alreadyOwnsVersion();

    const savedAt = iso(now);
    await insertAudit(tx, actor, "V19_VERSION_CREATED", "V19_VERSION", newId, {
      workspaceId: workspace.id,
      baseVersionId: input.baseVersionId,
      versionNumber,
    });

    return {
      versionId: newId,
      versionNumber,
      revision: 1,
      contentHash,
      updatedAt: savedAt,
      createdVersion: true,
      finalIntake: { merged: true, pending: finalLoaded.pendingCount },
    };
  });
}
