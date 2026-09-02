// 「集成版」：每个案例一份，内容按处取各版本里最新的一次修改。
// 见 docs/20_最终版与评论跨版本_实施规格_V0.1.md 二（数据）/ 三（汇入算法）/ 四、4.1-4.3。
//
// 与 lib/v19-version-chain.ts 互相引用（该文件的写路径在写完修订事件后调用本文件的
// intakeIntoFinal；createV19VersionFrom 在 baseVersionId === "final" 时调用本文件的
// ensureFinalVersion）。两个模块的引用只发生在函数体内部（从不在模块顶层求值对方的
// 导出），所以这个双向 import 是安全的——与 tests/v19-version-chain.test.ts 已经在做的
// 「只导入纯函数，不触发任何数据库副作用」完全一致。

import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { isCaseReviewer } from "./case-review";
import type { V04Change, V04DraftPayloadV1, V04RevisionValueType, V04ShotGroupPayload, V04ShotPayload } from "./v04-contract";
import {
  applyV04ChangeSetLastWriteWins,
  assertV04PayloadContract,
  canonicalV04ChangeSet,
  hashV04Payload,
  listV04ContractViolations,
  locateTarget,
} from "./v04-domain";
import { V04ServiceError } from "./v04-errors";
import { V04_UI_SHOT_FIELDS } from "./v04-ui-model";
import type { V04Actor } from "./v04-workspace-service";
import {
  insertAudit,
  materializeV19FirstVersion,
  parseJsonPayload,
  resolveWorkspaceForWrite,
  type WorkspaceRow,
} from "./v19-version-chain";

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const iso = (value: Date) => value.toISOString();
// pg's default type parsing already turns a jsonb column into its JS value,
// so a JSONB text field's *content* being a string ("" or "李晓芸的商业意图")
// is indistinguishable at this layer from "still-encoded JSON that needs one
// more JSON.parse". Falling back to the raw value on a parse failure resolves
// that ambiguity the same way lib/v03-collaboration.ts's parseJsonValue does.
function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Pure types & helpers — no I/O, unit-tested directly in tests/final-version.test.ts.
// ---------------------------------------------------------------------------

export type FinalIntakeKind = "FIELD" | "INSERT_GROUP" | "INSERT_SHOT" | "REMOVE_GROUP" | "REMOVE_SHOT";
export type FinalIntakeSource = "VERSION" | "FINAL_DIRECT";

/** One "某处的一次修改" before it has a database identity (id/seq/applied). */
export type FinalIntakeDraft = {
  kind: FinalIntakeKind;
  targetKey: string;
  targetLabel: string;
  value: unknown;
};

export type FinalApplyEffect = "APPLIED" | "NOOP";

/**
 * 3.1 — decomposes one save's applied change set into final-version intake
 * drafts. `script.structure` (the whole-shotGroups replace v04PayloadChanges
 * sends when the script's shape changed) is exploded per spec so a structural
 * edit never blindly overwrites everyone else's script content; every other
 * change (facts.* / path.* / shotGroup:<id>.<field> / shot:<id>.<field>) maps
 * 1:1 to a FIELD record.
 */
export function decomposeV19ChangesForFinal(changes: readonly V04Change[]): FinalIntakeDraft[] {
  const drafts: FinalIntakeDraft[] = [];
  for (const change of changes) {
    if (change.targetKey === "script.structure") {
      drafts.push(...decomposeStructureChange(
        (change.beforeValue ?? []) as V04ShotGroupPayload[],
        (change.afterValue ?? []) as V04ShotGroupPayload[],
      ));
    } else {
      drafts.push({ kind: "FIELD", targetKey: change.targetKey, targetLabel: change.targetLabel, value: change.afterValue });
    }
  }
  return drafts;
}

function changed(before: unknown, after: unknown) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function pushField(
  drafts: FinalIntakeDraft[],
  targetKey: string,
  targetLabel: string,
  before: unknown,
  after: unknown,
) {
  if (changed(before, after)) drafts.push({ kind: "FIELD", targetKey, targetLabel, value: after });
}

/** 顺序：先 REMOVE（桥段、镜头），再 INSERT（按 after 顺序，桥段、镜头），再 FIELD。 */
function decomposeStructureChange(
  before: readonly V04ShotGroupPayload[],
  after: readonly V04ShotGroupPayload[],
): FinalIntakeDraft[] {
  const drafts: FinalIntakeDraft[] = [];
  const beforeGroupIds = new Set(before.map((group) => group.id));
  const afterGroupIds = new Set(after.map((group) => group.id));
  const beforeGroupById = new Map(before.map((group) => [group.id, group]));
  const afterGroupById = new Map(after.map((group) => [group.id, group]));

  for (const group of before) {
    if (!afterGroupIds.has(group.id)) {
      drafts.push({
        kind: "REMOVE_GROUP",
        targetKey: `shotGroup:${group.id}`,
        targetLabel: group.bridgeName || "桥段",
        value: {},
      });
    }
  }
  for (const group of before) {
    if (!afterGroupIds.has(group.id)) continue; // whole group already recorded as REMOVE_GROUP above
    const afterGroup = afterGroupById.get(group.id)!;
    const afterShotIds = new Set(afterGroup.shots.map((shot) => shot.id));
    for (const shot of group.shots) {
      if (!afterShotIds.has(shot.id)) {
        drafts.push({ kind: "REMOVE_SHOT", targetKey: `shot:${shot.id}`, targetLabel: "镜头", value: {} });
      }
    }
  }

  after.forEach((group, index) => {
    if (beforeGroupIds.has(group.id)) return;
    const afterId = index === 0 ? null : after[index - 1].id;
    drafts.push({
      kind: "INSERT_GROUP",
      targetKey: `shotGroup:${group.id}`,
      targetLabel: group.bridgeName || "桥段",
      value: { item: group, afterId },
    });
  });
  for (const group of after) {
    if (!beforeGroupIds.has(group.id)) continue; // new shots inside a brand-new group ship with the group's own item
    const beforeGroup = beforeGroupById.get(group.id)!;
    const beforeShotIds = new Set(beforeGroup.shots.map((shot) => shot.id));
    group.shots.forEach((shot, index) => {
      if (beforeShotIds.has(shot.id)) return;
      const afterId = index === 0 ? null : group.shots[index - 1].id;
      drafts.push({
        kind: "INSERT_SHOT",
        targetKey: `shot:${shot.id}`,
        targetLabel: "镜头",
        value: { item: shot, parentGroupId: group.id, afterId },
      });
    });
  }

  for (const group of after) {
    if (!beforeGroupIds.has(group.id)) continue;
    const beforeGroup = beforeGroupById.get(group.id)!;
    pushField(drafts, `shotGroup:${group.id}.bridgeName`, "桥段名称", beforeGroup.bridgeName, group.bridgeName);
    pushField(
      drafts, `shotGroup:${group.id}.primaryCreativeRole`, "桥段主创意作用",
      beforeGroup.primaryCreativeRole, group.primaryCreativeRole,
    );
    pushField(
      drafts, `shotGroup:${group.id}.auxiliaryCreativeRole`, "桥段辅助创意作用",
      beforeGroup.auxiliaryCreativeRole, group.auxiliaryCreativeRole,
    );
    pushField(
      drafts, `shotGroup:${group.id}.keyCreativeDescription`, "本桥段关键创意描述",
      beforeGroup.keyCreativeDescription, group.keyCreativeDescription,
    );
    const beforeShotById = new Map(beforeGroup.shots.map((shot) => [shot.id, shot]));
    for (const shot of group.shots) {
      const beforeShot = beforeShotById.get(shot.id);
      if (!beforeShot) continue; // inserted shot already recorded as INSERT_SHOT above
      for (const field of V04_UI_SHOT_FIELDS) {
        pushField(drafts, `shot:${shot.id}.${field.key}`, field.label, beforeShot[field.key], shot[field.key]);
      }
    }
  }

  return drafts;
}

function insertAfter<T extends { id: string }>(list: T[], item: T, afterId: string | null) {
  if (afterId === null) {
    list.unshift(item);
    return;
  }
  const index = list.findIndex((entry) => entry.id === afterId);
  if (index === -1) {
    list.push(item);
    return;
  }
  list.splice(index + 1, 0, item);
}

/** 桥段 orderIndex = 下标；镜头 orderIndex = 全局累计下标 — 与 lib/v04-ui-model.ts 一致。 */
function reindexScript(payload: V04DraftPayloadV1) {
  let shotCursor = 0;
  payload.script.shotGroups.forEach((group, groupIndex) => {
    group.orderIndex = groupIndex;
    for (const shot of group.shots) {
      shot.orderIndex = shotCursor;
      shotCursor += 1;
    }
  });
}

function finalizeApply(next: V04DraftPayloadV1, original: V04DraftPayloadV1): { payload: V04DraftPayloadV1; effect: FinalApplyEffect } {
  try {
    assertV04PayloadContract(next);
  } catch {
    // 落库前契约不通过 → NOOP。绝不能让别人的保存因为集成版失败（spec 3.2）。
    return { payload: original, effect: "NOOP" };
  }
  return { payload: next, effect: "APPLIED" };
}

/** 3.2 — applies one intake draft to a final-version payload. */
export function applyFinalIntake(
  payload: V04DraftPayloadV1,
  intake: Pick<FinalIntakeDraft, "kind" | "targetKey" | "value">,
): { payload: V04DraftPayloadV1; effect: FinalApplyEffect } {
  const next = structuredClone(payload);
  switch (intake.kind) {
    case "FIELD": {
      const target = locateTarget(next, intake.targetKey);
      if (!target) return { payload, effect: "NOOP" };
      target.object[target.key] = structuredClone(intake.value);
      return finalizeApply(next, payload);
    }
    case "INSERT_GROUP": {
      const { item, afterId } = intake.value as { item: V04ShotGroupPayload; afterId: string | null };
      if (next.script.shotGroups.some((group) => group.id === item.id)) return { payload, effect: "NOOP" };
      insertAfter(next.script.shotGroups, structuredClone(item), afterId);
      reindexScript(next);
      return finalizeApply(next, payload);
    }
    case "INSERT_SHOT": {
      const { item, parentGroupId, afterId } = intake.value as {
        item: V04ShotPayload; parentGroupId: string; afterId: string | null;
      };
      if (next.script.shotGroups.some((group) => group.shots.some((shot) => shot.id === item.id))) {
        return { payload, effect: "NOOP" };
      }
      const parent = next.script.shotGroups.find((group) => group.id === parentGroupId);
      if (!parent) return { payload, effect: "NOOP" };
      insertAfter(parent.shots, structuredClone(item), afterId);
      reindexScript(next);
      return finalizeApply(next, payload);
    }
    case "REMOVE_GROUP": {
      const groupId = intake.targetKey.slice("shotGroup:".length);
      const index = next.script.shotGroups.findIndex((group) => group.id === groupId);
      if (index === -1) return { payload, effect: "NOOP" };
      next.script.shotGroups.splice(index, 1);
      reindexScript(next);
      return finalizeApply(next, payload);
    }
    case "REMOVE_SHOT": {
      const shotId = intake.targetKey.slice("shot:".length);
      let found = false;
      for (const group of next.script.shotGroups) {
        const index = group.shots.findIndex((shot) => shot.id === shotId);
        if (index !== -1) {
          group.shots.splice(index, 1);
          found = true;
          break;
        }
      }
      if (!found) return { payload, effect: "NOOP" };
      reindexScript(next);
      return finalizeApply(next, payload);
    }
    default:
      return { payload, effect: "NOOP" };
  }
}

/**
 * Applies a whole batch of intake drafts (one save's worth, or one adoption
 * batch) in order — but only when `status` is OPEN. `DONE` never touches the
 * payload; the drafts still get recorded by the caller, just with
 * `applied = false` (spec 3.2 / 3.4). Adoption (spec 3.6) always passes
 * "OPEN" here regardless of the final version's own status, since both
 * states allow adopting individual pending records.
 */
export function applyFinalIntakeBatch(
  payload: V04DraftPayloadV1,
  drafts: readonly FinalIntakeDraft[],
  status: "OPEN" | "DONE",
): { payload: V04DraftPayloadV1; applied: boolean } {
  if (status !== "OPEN") return { payload, applied: false };
  let next = payload;
  for (const draft of drafts) {
    next = applyFinalIntake(next, draft).payload;
  }
  return { payload: next, applied: true };
}

/** One `collaboration_revision_events` row, flattened for replay (spec 3.3). */
export type FinalHistoryEvent = {
  id: string;
  createdAt: string;
  versionId: string;
  versionNumber: number;
  changeSetId: string;
  targetKey: string;
  targetLabel: string;
  valueType: V04RevisionValueType | string;
  beforeValue: unknown;
  afterValue: unknown;
  actorUserId: string;
  actorName: string;
};

export type FinalComputedIntake = FinalIntakeDraft & {
  source: "VERSION";
  sourceVersionId: string;
  sourceVersionNumber: number;
  actorUserId: string;
  actorName: string;
  changeSetId: string;
  applied: true;
  createdAt: string;
};

/**
 * 3.3 — replays a workspace's entire revision history (every version,
 * v1's own included — see the module comment on why that replay is required
 * to correctly order v1's edits against everyone else's) on top of an origin
 * payload, producing the resulting final-version payload plus the ordered
 * intake ledger. `applied` is always true here: OPEN is the only state a
 * final version can be freshly computed/backfilled in.
 */
export function computeFinalFromHistory(
  origin: V04DraftPayloadV1,
  events: readonly FinalHistoryEvent[],
): { payload: V04DraftPayloadV1; intakes: FinalComputedIntake[] } {
  let payload = structuredClone(origin);
  const intakes: FinalComputedIntake[] = [];
  const sorted = [...events].sort((left, right) => {
    const diff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (diff !== 0) return diff;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  for (const event of sorted) {
    const drafts = decomposeV19ChangesForFinal([{
      targetKey: event.targetKey,
      targetLabel: event.targetLabel,
      valueType: event.valueType as V04Change["valueType"],
      beforeValue: event.beforeValue,
      afterValue: event.afterValue,
    }]);
    for (const draft of drafts) {
      const { payload: next } = applyFinalIntake(payload, draft);
      payload = next;
      intakes.push({
        ...draft,
        source: "VERSION",
        sourceVersionId: event.versionId,
        sourceVersionNumber: event.versionNumber,
        actorUserId: event.actorUserId,
        actorName: event.actorName,
        changeSetId: event.changeSetId,
        applied: true,
        createdAt: event.createdAt,
      });
    }
  }
  return { payload, intakes };
}

/**
 * The backfill's true starting point: v1's *own* payload before any of its
 * own edits, not its current (already-edited) state. Undoes v1's own
 * `collaboration_revision_events` in reverse (latest first) on top of v1's
 * current payload — each FIELD-shaped event's target goes back to its
 * `beforeValue`; a `script.structure` event's before is the whole prior
 * shotGroups array, replaced wholesale (this is reconstructing v1's own
 * linear history, not merging with anyone else's concurrent edits, so a
 * straight array replace is correct and needs no per-item decomposition).
 *
 * Getting this wrong previously made the 溯源 (trace) view's "v1 原稿" row
 * show v1's *latest* value relabeled as if it were the original — e.g.
 * "v1 原稿 侧面平视 → v1 08-26 17:34 特写 → 当前采用 v1 17:35 侧面平视",
 * where "原稿" was actually a copy of the last-applied entry, not what v1
 * started from.
 *
 * `v1OwnEvents` may be given in any order and may include events for other
 * versions too (the caller doesn't have to pre-filter) — only those whose
 * `versionId` matches `v1Id` are undone. A target that no longer resolves
 * (`locateTarget` returns null) is skipped rather than failing the whole
 * backfill. If undoing everything leaves a payload that fails the payload
 * contract, that result is untrustworthy, so this falls back to the old
 * behaviour: origin = v1's current payload, unchanged.
 */
export function deriveFinalOrigin(
  v1Payload: V04DraftPayloadV1,
  v1Id: string,
  events: readonly FinalHistoryEvent[],
): V04DraftPayloadV1 {
  const ownEvents = events.filter((event) => event.versionId === v1Id);
  const descending = [...ownEvents].sort((left, right) => {
    const diff = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (diff !== 0) return diff;
    return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
  });
  const candidate = structuredClone(v1Payload);
  for (const event of descending) {
    if (event.targetKey === "script.structure") {
      candidate.script.shotGroups = structuredClone(event.beforeValue as V04ShotGroupPayload[]);
      continue;
    }
    const target = locateTarget(candidate, event.targetKey);
    if (!target) continue;
    target.object[target.key] = structuredClone(event.beforeValue);
  }
  try {
    assertV04PayloadContract(candidate);
  } catch {
    return v1Payload;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Row shapes and small DB helpers.
// ---------------------------------------------------------------------------

type FinalVersionRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  video_id: string;
  status: "OPEN" | "DONE";
  done_at: string | null;
  done_by_user_id: string | null;
  done_by_name: string | null;
  origin_payload_json: V04DraftPayloadV1 | string;
  payload_json: V04DraftPayloadV1 | string;
  content_hash: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

type FinalIntakeRow = QueryResultRow & {
  id: string;
  final_id: string;
  workspace_id: string;
  video_id: string;
  seq: number | string;
  kind: FinalIntakeKind;
  target_key: string;
  target_label: string;
  value_json: unknown;
  source: FinalIntakeSource;
  source_version_id: string | null;
  source_version_number: number | null;
  actor_user_id: string;
  actor_name: string;
  change_set_id: string | null;
  applied: boolean;
  applied_at: string | null;
  created_at: string;
};

const FINAL_VERSION_COLUMNS = `id, workspace_id, video_id, status, done_at, done_by_user_id, done_by_name,
  origin_payload_json, payload_json, content_hash, revision, created_at, updated_at`;

const FINAL_INTAKE_COLUMNS = `id, final_id, workspace_id, video_id, seq, kind, target_key, target_label,
  value_json, source, source_version_id, source_version_number, actor_user_id, actor_name,
  change_set_id, applied, applied_at, created_at`;

async function loadWorkspaceHistoryEvents(db: DbClient, workspaceId: string): Promise<FinalHistoryEvent[]> {
  const rows = (await db.prepare(
    `SELECT e.id, e.created_at, e.version_id, v.version_number, e.change_set_id,
      e.target_key, e.target_label_snapshot, e.value_type,
      e.before_value_json, e.after_value_json, e.actor_user_id, e.actor_name_snapshot
    FROM collaboration_revision_events e
    INNER JOIN analysis_versions v ON v.id = e.version_id
    WHERE e.workspace_id = ? AND e.version_id IS NOT NULL
    ORDER BY e.created_at ASC, e.id ASC`,
  ).bind(workspaceId).all<QueryResultRow & {
    id: string; created_at: string; version_id: string; version_number: number; change_set_id: string;
    target_key: string; target_label_snapshot: string; value_type: string;
    before_value_json: unknown; after_value_json: unknown;
    actor_user_id: string; actor_name_snapshot: string;
  }>()).results;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    versionId: row.version_id,
    versionNumber: Number(row.version_number),
    changeSetId: row.change_set_id,
    targetKey: row.target_key,
    targetLabel: row.target_label_snapshot,
    valueType: row.value_type,
    beforeValue: parseJsonValue(row.before_value_json),
    afterValue: parseJsonValue(row.after_value_json),
    actorUserId: row.actor_user_id,
    actorName: row.actor_name_snapshot,
  }));
}

async function countPending(db: DbClient, finalId: string) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM analysis_final_intakes WHERE final_id = ? AND applied = false`,
  ).bind(finalId).first<{ count: number } & QueryResultRow>();
  return Number(row?.count ?? 0);
}

async function insertIntakeRow(
  db: DbClient,
  finalId: string,
  workspace: WorkspaceRow,
  draft: FinalIntakeDraft,
  meta: {
    source: FinalIntakeSource;
    sourceVersionId: string | null;
    sourceVersionNumber: number | null;
    actorUserId: string;
    actorName: string;
    changeSetId: string | null;
    applied: boolean;
    appliedAt: string | null;
    createdAt: string;
  },
) {
  await db.prepare(
    `INSERT INTO analysis_final_intakes (
      id, final_id, workspace_id, video_id, kind, target_key, target_label, value_json,
      source, source_version_id, source_version_number, actor_user_id, actor_name,
      change_set_id, applied, applied_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)`,
  ).bind(
    id("final_intake"), finalId, workspace.id, workspace.video_id,
    draft.kind, draft.targetKey, draft.targetLabel, JSON.stringify(draft.value ?? {}),
    meta.source, meta.sourceVersionId, meta.sourceVersionNumber, meta.actorUserId, meta.actorName,
    meta.changeSetId, meta.applied, meta.appliedAt, meta.createdAt,
  ).run();
}

// ---------------------------------------------------------------------------
// Creation & backfill (spec 3.3).
// ---------------------------------------------------------------------------

/**
 * Materializes the workspace's final version the first time anything needs
 * it, backfilling from v1's current payload plus the workspace's entire
 * revision history. Idempotent: a concurrent creator's row wins and this
 * call just re-reads it, never inserting a duplicate intake ledger.
 */
export async function ensureFinalVersion(
  db: DbClient,
  workspace: WorkspaceRow,
  now: Date,
): Promise<FinalVersionRow> {
  const existing = await db.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE workspace_id = ?`)
    .bind(workspace.id).first<FinalVersionRow>();
  if (existing) return existing;

  const countRow = await db.prepare(`SELECT COUNT(*) AS count FROM analysis_versions WHERE workspace_id = ?`)
    .bind(workspace.id).first<{ count: number } & QueryResultRow>();
  if (Number(countRow?.count ?? 0) === 0) {
    await materializeV19FirstVersion(db, workspace, now);
  }
  const v1 = await db.prepare(
    `SELECT id, payload_json FROM analysis_versions WHERE workspace_id = ? AND version_number = 1`,
  ).bind(workspace.id).first<{ id: string; payload_json: V04DraftPayloadV1 | string } & QueryResultRow>();
  if (!v1) throw new V04ServiceError("VERSION_NOT_FOUND", "案例还没有任何版本，无法生成集成版。");

  const events = await loadWorkspaceHistoryEvents(db, workspace.id);
  // 原稿是 v1 修改前的样子，不是 v1 现在的样子——先把 v1 自己的修订事件倒着撤销掉。
  const origin = deriveFinalOrigin(parseJsonPayload(v1.payload_json), v1.id, events);
  const { payload, intakes } = computeFinalFromHistory(origin, events);

  const newId = id("final");
  const savedAt = iso(now);
  const inserted = await db.prepare(
    `INSERT INTO analysis_final_versions (
      id, workspace_id, video_id, status, origin_payload_json, payload_json, content_hash, revision,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'OPEN', ?::jsonb, ?::jsonb, ?, 1, ?::timestamptz, ?::timestamptz)
    ON CONFLICT (workspace_id) DO NOTHING
    RETURNING ${FINAL_VERSION_COLUMNS}`,
  ).bind(
    newId, workspace.id, workspace.video_id,
    JSON.stringify(origin), JSON.stringify(payload), hashV04Payload(payload),
    savedAt, savedAt,
  ).first<FinalVersionRow>();

  if (!inserted) {
    // Someone else materialized it first — use their row, discard our replay.
    const winner = await db.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE workspace_id = ?`)
      .bind(workspace.id).first<FinalVersionRow>();
    if (!winner) throw new V04ServiceError("VERSION_NOT_FOUND", "集成版创建未完成，请重试。");
    return winner;
  }

  for (const intake of intakes) {
    await insertIntakeRow(db, inserted.id, workspace, intake, {
      source: "VERSION",
      sourceVersionId: intake.sourceVersionId,
      sourceVersionNumber: intake.sourceVersionNumber,
      actorUserId: intake.actorUserId,
      actorName: intake.actorName,
      changeSetId: intake.changeSetId,
      applied: true,
      appliedAt: intake.createdAt,
      createdAt: intake.createdAt,
    });
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// 3.4 — intake from a normal version save.
// ---------------------------------------------------------------------------

export type FinalIntakeResult = { merged: boolean; pending: number };

/**
 * Called from lib/v19-version-chain.ts's saveV19VersionChanges, inside the
 * same transaction, right after the save's own revision events are written.
 * Any failure here must never fail the caller's save — this function only
 * throws for programmer errors (e.g. a workspace with no v1 at all), never
 * for a payload that doesn't apply cleanly (that becomes a per-record NOOP).
 */
export async function intakeIntoFinal(
  db: DbClient,
  workspace: WorkspaceRow,
  input: {
    changes: readonly V04Change[];
    sourceVersionId: string;
    sourceVersionNumber: number;
    actorUserId: string;
    actorName: string;
    changeSetId: string;
    now: Date;
  },
): Promise<FinalIntakeResult> {
  const finalRow = await ensureFinalVersion(db, workspace, input.now);
  const drafts = decomposeV19ChangesForFinal(input.changes);
  if (drafts.length === 0) {
    return { merged: true, pending: await countPending(db, finalRow.id) };
  }

  // 幂等重放：同一 change_set_id + source_version_id 已经写过汇入记录，不重复写。
  const dup = await db.prepare(
    `SELECT applied FROM analysis_final_intakes
    WHERE final_id = ? AND change_set_id = ? AND source_version_id = ? LIMIT 1`,
  ).bind(finalRow.id, input.changeSetId, input.sourceVersionId).first<{ applied: boolean } & QueryResultRow>();
  if (dup) {
    return { merged: Boolean(dup.applied), pending: await countPending(db, finalRow.id) };
  }

  const savedAt = iso(input.now);
  const { payload, applied: applyNow } = applyFinalIntakeBatch(
    parseJsonPayload(finalRow.payload_json), drafts, finalRow.status,
  );
  for (const draft of drafts) {
    await insertIntakeRow(db, finalRow.id, workspace, draft, {
      source: "VERSION",
      sourceVersionId: input.sourceVersionId,
      sourceVersionNumber: input.sourceVersionNumber,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      changeSetId: input.changeSetId,
      applied: applyNow,
      appliedAt: applyNow ? savedAt : null,
      createdAt: savedAt,
    });
  }
  if (applyNow) {
    const contentHash = hashV04Payload(payload);
    await db.prepare(
      `UPDATE analysis_final_versions
      SET payload_json = ?::jsonb, content_hash = ?, revision = revision + 1, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(JSON.stringify(payload), contentHash, savedAt, finalRow.id).run();
  }
  return { merged: applyNow, pending: await countPending(db, finalRow.id) };
}

// ---------------------------------------------------------------------------
// 3.5 — 老孙直接编辑集成版.
// ---------------------------------------------------------------------------

export type V19FinalSaveResult = {
  versionId: string;
  versionNumber: 0;
  revision: number;
  contentHash: string;
  updatedAt: string;
  createdVersion: false;
  skippedTargets?: string[];
  finalIntake: FinalIntakeResult;
};

export async function saveFinalVersionDirect(
  db: DbClient,
  actor: V04Actor,
  input: { videoId: string; changeSetId: string; changes: V04Change[]; now?: Date },
): Promise<V19FinalSaveResult> {
  if (!isCaseReviewer(actor.displayName)) {
    throw new V04ServiceError("FORBIDDEN", "集成版只有老孙可以编辑。");
  }
  const now = input.now ?? new Date();
  if (!input.changeSetId?.trim()) {
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
    await ensureFinalVersion(tx, workspace, now);
    const current = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE workspace_id = ? FOR UPDATE`)
      .bind(workspace.id).first<FinalVersionRow>();
    if (!current) throw new V04ServiceError("VERSION_NOT_FOUND", "集成版不存在。");

    const dup = await tx.prepare(
      `SELECT 1 FROM analysis_final_intakes
      WHERE final_id = ? AND change_set_id = ? AND source = 'FINAL_DIRECT' LIMIT 1`,
    ).bind(current.id, input.changeSetId).first();
    if (dup) {
      return {
        versionId: current.id, versionNumber: 0 as const, revision: Number(current.revision),
        contentHash: current.content_hash, updatedAt: current.updated_at, createdVersion: false as const,
        finalIntake: { merged: true, pending: await countPending(tx, current.id) },
      };
    }

    const before = parseJsonPayload(current.payload_json);
    const { payload: after, appliedChanges, skippedTargets } = applyV04ChangeSetLastWriteWins(before, input.changes);
    try {
      assertV04PayloadContract(after);
    } catch (error) {
      if (error instanceof Error &&
        (error.message === "CHOICE_RULE_VIOLATION" || error.message === "INVALID_PAYLOAD_SCHEMA")) {
        const violations = listV04ContractViolations(after);
        throw new V04ServiceError(
          error.message,
          violations.length
            ? `集成版不符合冻结规则：${violations.map((item) => `${item.targetLabel}（${item.message}）`).join("；")}`
            : "集成版不符合冻结规则。",
          { violations },
        );
      }
      throw error;
    }

    const nextHash = hashV04Payload(after);
    if (nextHash === current.content_hash) {
      return {
        versionId: current.id, versionNumber: 0 as const, revision: Number(current.revision),
        contentHash: current.content_hash, updatedAt: current.updated_at, createdVersion: false as const, skippedTargets,
        finalIntake: { merged: true, pending: await countPending(tx, current.id) },
      };
    }

    const nextRevision = Number(current.revision) + 1;
    const savedAt = iso(now);
    await tx.prepare(
      `UPDATE analysis_final_versions
      SET payload_json = ?::jsonb, content_hash = ?, revision = ?, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(JSON.stringify(after), nextHash, nextRevision, savedAt, current.id).run();

    // 按 3.1 拆解写汇入记录：这里不是「靠汇入应用变更」，变更已经直接生效——
    // 记录只是为了让溯源视图能显示「集成版·直接修改」。
    const drafts = decomposeV19ChangesForFinal(appliedChanges);
    for (const draft of drafts) {
      await insertIntakeRow(tx, current.id, workspace, draft, {
        source: "FINAL_DIRECT",
        sourceVersionId: null,
        sourceVersionNumber: null,
        actorUserId: actor.userId,
        actorName: actor.displayName,
        changeSetId: input.changeSetId,
        applied: true,
        appliedAt: savedAt,
        createdAt: savedAt,
      });
    }

    await insertAudit(tx, actor, "V19_FINAL_SAVED", "V19_FINAL", current.id, {
      workspaceId: workspace.id,
      changeSetId: input.changeSetId,
      appliedRevision: nextRevision,
      targets: appliedChanges.map((item) => item.targetKey),
      skippedTargets,
      contentHash: nextHash,
    });

    return {
      versionId: current.id, versionNumber: 0 as const, revision: nextRevision, contentHash: nextHash,
      updatedAt: savedAt, createdVersion: false as const, skippedTargets,
      finalIntake: { merged: true, pending: await countPending(tx, current.id) },
    };
  });
}

// ---------------------------------------------------------------------------
// 3.6 — 定稿 / 取消定稿 / 采纳.
// ---------------------------------------------------------------------------

export type FinalSummary = {
  id: string | null;
  status: "OPEN" | "DONE";
  doneAt: string | null;
  doneByName: string | null;
  updatedAt: string;
  pendingCount: number;
  isVirtual: boolean;
};

function toFinalSummary(row: FinalVersionRow, pending: number): FinalSummary {
  return {
    id: row.id,
    status: row.status,
    doneAt: row.done_at,
    doneByName: row.done_by_name,
    updatedAt: row.updated_at,
    pendingCount: pending,
    isVirtual: false,
  };
}

function requireReviewerActor(actor: V04Actor, message: string) {
  if (!isCaseReviewer(actor.displayName)) {
    throw new V04ServiceError("FORBIDDEN", message);
  }
}

export async function setFinalVersionStatus(
  db: DbClient,
  actor: V04Actor,
  input: { videoId: string; status: "OPEN" | "DONE"; now?: Date },
): Promise<FinalSummary> {
  requireReviewerActor(actor, "只有老孙可以定稿或取消定稿。");
  const now = input.now ?? new Date();
  return db.withTransaction(async (tx) => {
    const workspace = await resolveWorkspaceForWrite(tx, actor, input.videoId);
    // A case migrated in without ever being saved through the V1.9 surface
    // still has only a virtual final version (no analysis_final_versions
    // row) — 老孙's very first action on it can be "定稿", so this has to
    // materialize (with backfill) rather than 404 on a row that just hasn't
    // been created yet.
    await ensureFinalVersion(tx, workspace, now);
    const finalRow = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE workspace_id = ? FOR UPDATE`)
      .bind(workspace.id).first<FinalVersionRow>();
    if (!finalRow) throw new V04ServiceError("VERSION_NOT_FOUND", "集成版尚不存在，无法定稿。");

    const savedAt = iso(now);
    if (input.status === "DONE") {
      await tx.prepare(
        `UPDATE analysis_final_versions
        SET status = 'DONE', done_at = ?::timestamptz, done_by_user_id = ?, done_by_name = ?, updated_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(savedAt, actor.userId, actor.displayName, savedAt, finalRow.id).run();
    } else {
      await tx.prepare(
        `UPDATE analysis_final_versions
        SET status = 'OPEN', done_at = NULL, done_by_user_id = NULL, done_by_name = NULL, updated_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(savedAt, finalRow.id).run();
    }
    await insertAudit(tx, actor, "V19_FINAL_STATUS_CHANGED", "V19_FINAL", finalRow.id, { status: input.status });

    const refreshed = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE id = ?`)
      .bind(finalRow.id).first<FinalVersionRow>();
    return toFinalSummary(refreshed!, await countPending(tx, finalRow.id));
  });
}

export async function adoptFinalIntakes(
  db: DbClient,
  actor: V04Actor,
  input: { videoId: string; intakeIds?: string[]; all?: boolean; now?: Date },
): Promise<{ final: FinalSummary; adopted: number }> {
  requireReviewerActor(actor, "只有老孙可以采纳未纳入的修改。");
  const now = input.now ?? new Date();
  return db.withTransaction(async (tx) => {
    const workspace = await resolveWorkspaceForWrite(tx, actor, input.videoId);
    // Same reasoning as setFinalVersionStatus: a never-saved case's final
    // version is still virtual, so materialize (with backfill) before
    // touching it rather than 404ing on a row that doesn't exist yet.
    await ensureFinalVersion(tx, workspace, now);
    const finalRow = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE workspace_id = ? FOR UPDATE`)
      .bind(workspace.id).first<FinalVersionRow>();
    if (!finalRow) throw new V04ServiceError("VERSION_NOT_FOUND", "集成版尚不存在。");

    let targets: FinalIntakeRow[];
    if (input.all) {
      targets = (await tx.prepare(
        `SELECT ${FINAL_INTAKE_COLUMNS} FROM analysis_final_intakes WHERE final_id = ? AND applied = false ORDER BY seq ASC`,
      ).bind(finalRow.id).all<FinalIntakeRow>()).results;
    } else {
      const ids = Array.isArray(input.intakeIds) ? input.intakeIds.filter((value) => typeof value === "string" && value.trim()) : [];
      if (ids.length === 0) {
        return { final: toFinalSummary(finalRow, await countPending(tx, finalRow.id)), adopted: 0 };
      }
      const placeholders = ids.map(() => "?").join(", ");
      const rows = (await tx.prepare(
        `SELECT ${FINAL_INTAKE_COLUMNS} FROM analysis_final_intakes
        WHERE final_id = ? AND applied = false AND id IN (${placeholders})
        ORDER BY seq ASC`,
      ).bind(finalRow.id, ...ids).all<FinalIntakeRow>()).results;
      targets = rows;
    }

    let payload = parseJsonPayload(finalRow.payload_json);
    const savedAt = iso(now);
    let adopted = 0;
    for (const row of targets) {
      const draft: FinalIntakeDraft = {
        kind: row.kind, targetKey: row.target_key, targetLabel: row.target_label,
        value: parseJsonValue(row.value_json),
      };
      const result = applyFinalIntake(payload, draft);
      payload = result.payload;
      await tx.prepare(
        `UPDATE analysis_final_intakes SET applied = true, applied_at = ?::timestamptz WHERE id = ?`,
      ).bind(savedAt, row.id).run();
      adopted += 1;
    }
    if (adopted > 0) {
      const contentHash = hashV04Payload(payload);
      await tx.prepare(
        `UPDATE analysis_final_versions
        SET payload_json = ?::jsonb, content_hash = ?, revision = revision + 1, updated_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(JSON.stringify(payload), contentHash, savedAt, finalRow.id).run();
    }
    await insertAudit(tx, actor, "V19_FINAL_INTAKE_ADOPTED", "V19_FINAL", finalRow.id, {
      adopted, intakeIds: targets.map((row) => row.id),
    });

    const refreshed = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE id = ?`)
      .bind(finalRow.id).first<FinalVersionRow>();
    return { final: toFinalSummary(refreshed!, await countPending(tx, finalRow.id)), adopted };
  });
}

// ---------------------------------------------------------------------------
// Read path — never writes (spec 3.3: GET never materializes).
// ---------------------------------------------------------------------------

export type LoadedFinalVersion = FinalSummary & {
  createdAt: string;
  payload: V04DraftPayloadV1;
  originPayload: V04DraftPayloadV1;
  contentHash: string;
  revision: number;
};

/**
 * Reads the workspace's final version. When no row exists yet, computes the
 * virtual final version in memory from v1's current payload plus the
 * workspace's revision history — never inserting anything.
 */
export async function loadFinalVersion(
  db: DbClient,
  workspace: WorkspaceRow,
): Promise<LoadedFinalVersion> {
  const row = await db.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM analysis_final_versions WHERE workspace_id = ?`)
    .bind(workspace.id).first<FinalVersionRow>();
  if (row) {
    const pending = await countPending(db, row.id);
    return {
      ...toFinalSummary(row, pending),
      createdAt: row.created_at,
      payload: parseJsonPayload(row.payload_json),
      originPayload: parseJsonPayload(row.origin_payload_json),
      contentHash: row.content_hash,
      revision: Number(row.revision),
    };
  }

  const v1 = await db.prepare(
    `SELECT payload_json, updated_at FROM analysis_versions WHERE workspace_id = ? AND version_number = 1`,
  ).bind(workspace.id).first<{ payload_json: V04DraftPayloadV1 | string; updated_at: string } & QueryResultRow>();
  if (!v1) throw new V04ServiceError("VERSION_NOT_FOUND", "案例还没有任何版本。");

  const origin = parseJsonPayload(v1.payload_json);
  const events = await loadWorkspaceHistoryEvents(db, workspace.id);
  const { payload, intakes } = computeFinalFromHistory(origin, events);
  const updatedAt = intakes.length ? intakes[intakes.length - 1].createdAt : v1.updated_at;

  return {
    id: null,
    status: "OPEN",
    doneAt: null,
    doneByName: null,
    updatedAt,
    pendingCount: 0,
    isVirtual: true,
    createdAt: v1.updated_at,
    payload,
    originPayload: origin,
    contentHash: hashV04Payload(payload),
    revision: 1,
  };
}

export type FinalTraceIntake = {
  id: string;
  seq: number;
  kind: FinalIntakeKind;
  targetKey: string;
  targetLabel: string;
  value: unknown;
  source: FinalIntakeSource;
  sourceVersionNumber: number | null;
  actorName: string;
  applied: boolean;
  createdAt: string;
};

/** `?version=final` 时的溯源数据：原稿 + 每处内容按 seq 升序的写法链。 */
export async function loadFinalTrace(
  db: DbClient,
  workspace: WorkspaceRow,
): Promise<{ originPayload: V04DraftPayloadV1; intakes: FinalTraceIntake[] }> {
  const row = await db.prepare(`SELECT id, origin_payload_json FROM analysis_final_versions WHERE workspace_id = ?`)
    .bind(workspace.id).first<{ id: string; origin_payload_json: V04DraftPayloadV1 | string } & QueryResultRow>();
  if (row) {
    const rows = (await db.prepare(
      `SELECT ${FINAL_INTAKE_COLUMNS} FROM analysis_final_intakes WHERE final_id = ? ORDER BY seq ASC`,
    ).bind(row.id).all<FinalIntakeRow>()).results;
    return {
      originPayload: parseJsonPayload(row.origin_payload_json),
      intakes: rows.map((intake) => ({
        id: intake.id,
        seq: Number(intake.seq),
        kind: intake.kind,
        targetKey: intake.target_key,
        targetLabel: intake.target_label,
        value: parseJsonValue(intake.value_json),
        source: intake.source,
        sourceVersionNumber: intake.source_version_number === null ? null : Number(intake.source_version_number),
        actorName: intake.actor_name,
        applied: intake.applied,
        createdAt: intake.created_at,
      })),
    };
  }

  const v1 = await db.prepare(
    `SELECT payload_json FROM analysis_versions WHERE workspace_id = ? AND version_number = 1`,
  ).bind(workspace.id).first<{ payload_json: V04DraftPayloadV1 | string } & QueryResultRow>();
  if (!v1) throw new V04ServiceError("VERSION_NOT_FOUND", "案例还没有任何版本。");
  const origin = parseJsonPayload(v1.payload_json);
  const events = await loadWorkspaceHistoryEvents(db, workspace.id);
  const { intakes } = computeFinalFromHistory(origin, events);
  return {
    originPayload: origin,
    intakes: intakes.map((intake, index) => ({
      id: `virtual_${index}`,
      seq: index + 1,
      kind: intake.kind,
      targetKey: intake.targetKey,
      targetLabel: intake.targetLabel,
      value: intake.value,
      source: intake.source,
      sourceVersionNumber: intake.sourceVersionNumber,
      actorName: intake.actorName,
      applied: intake.applied,
      createdAt: intake.createdAt,
    })),
  };
}
