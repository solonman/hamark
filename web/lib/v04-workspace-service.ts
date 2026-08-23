import { createHash, randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { hashToken, randomToken } from "@/lib/auth/security";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04Change,
  type V04ChoiceValue,
  type V04DraftPayloadV1,
} from "./v04-contract";
import {
  applyV04ChangeSet,
  applyV04ChangeSetUnchecked,
  assertV04PayloadContract,
  canonicalV04ChangeSet,
  decideV04ChangeSet,
  deriveV04WorkflowState,
  emptyV04DraftPayload,
  hashV04Payload,
  hasAnyV04DraftData,
  listV04ContractViolations,
  v04ValueConflictTargets,
  validateV04Publication,
} from "./v04-domain";
import { V04ServiceError } from "./v04-errors";

const WORKFLOW = V04_WORKFLOW_VERSION;
const LEASE_TTL_MS = 120_000;

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const iso = (value: Date) => value.toISOString();
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// V0.3 and V0.4 share the legacy relational shot tables whose primary keys are
// global. V0.4 logical stable IDs live in immutable payloads and may legitimately
// equal their V0.3 source IDs. Keep those logical IDs unchanged in the payload,
// while projecting deterministic annotation-scoped physical IDs into the shared
// relational tables so a direct adapter never collides with its source rows.
function v04RelationalId(kind: "group" | "shot", annotationId: string, logicalId: string) {
  return `v04_${kind}_${createHash("sha256")
    .update(`${annotationId}\0${logicalId}`, "utf8").digest("hex").slice(0, 40)}`;
}

export type V04Actor = {
  userId: string;
  identityKey: string;
  displayName: string;
  sessionId: string;
  requestId: string;
};

export type V04LeaseProof = {
  tabToken: string;
  leaseToken: string;
  leaseVersion: number;
};

export type V04WorkspacePersistenceRow = QueryResultRow & {
  id: string;
  video_id: string;
  canonical_annotation_id: string;
  active_round_id: string;
  current_working_snapshot_id: string | null;
  latest_submission_snapshot_id: string | null;
  active_expert_release_id: string | null;
  status: "ACTIVE" | "ARCHIVED" | "TRASHED";
  revision: number;
  content_hash: string | null;
  updated_at: string;
};

type WorkspaceRow = V04WorkspacePersistenceRow;

type LeaseRow = QueryResultRow & {
  id: string;
  holder_user_id: string;
  session_id: string;
  tab_token_hash: string;
  lease_token_hash: string;
  lease_version: number;
  status: "ACTIVE" | "RELEASED" | "EXPIRED";
  acquired_at: string;
  last_heartbeat_at: string;
  expires_at: string;
};

type WorkingSnapshotRow = QueryResultRow & {
  id: string;
  revision: number;
  payload_json: string;
  content_hash: string;
  created_at: string;
};

type SubmissionRow = QueryResultRow & {
  id: string;
  submission_number: number;
  source_revision: number;
  source_content_hash: string;
  payload_json: V04DraftPayloadV1 | string;
  content_hash: string;
  submitted_by_user_id: string;
  idempotency_key: string;
  submitted_at: string;
};

export type V04SaveInput = {
  videoId: string;
  expectedRevision: number;
  expectedHash: string;
  changeSetId: string;
  changes: V04Change[];
  lease: V04LeaseProof;
  sourceKind?: "HUMAN_DIRECT" | "COMMENT_APPLY";
  now?: Date;
};

export type V04SubmitInput = {
  videoId: string;
  expectedDraftRevision: number;
  expectedDraftHash: string;
  idempotencyKey: string;
  lease: V04LeaseProof;
  now?: Date;
};

export type V04SubmitHooks = {
  afterSubmissionInsert?: () => void | Promise<void>;
  afterPointerUpdate?: () => void | Promise<void>;
};

export type V04ExpertHooks = {
  afterReleaseInsert?: () => void | Promise<void>;
  afterPointerUpdate?: () => void | Promise<void>;
};

export type V04RestoreHooks = {
  afterSnapshotInsert?: () => void | Promise<void>;
  afterPointerUpdate?: () => void | Promise<void>;
};

function assertLeaseProofShape(proof: V04LeaseProof) {
  if (
    !proof || !proof.tabToken?.trim() || !proof.leaseToken?.trim() ||
    !Number.isInteger(Number(proof.leaseVersion)) || Number(proof.leaseVersion) <= 0
  ) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "编辑权凭证结构无效。");
  }
}

function parsePayload(value: V04DraftPayloadV1 | string): V04DraftPayloadV1 {
  const payload = typeof value === "string" ? JSON.parse(value) as V04DraftPayloadV1 : value;
  assertV04PayloadContract(payload);
  return payload;
}

async function workspaceForVideo(
  db: DbClient,
  videoId: string,
  lock = false,
) {
  return db.prepare(
    `SELECT w.id, w.video_id, w.canonical_annotation_id, w.active_round_id,
      w.current_working_snapshot_id, w.latest_submission_snapshot_id,
      w.active_expert_release_id, w.status, w.updated_at,
      a.revision, a.content_hash
    FROM collaboration_workspaces w
    INNER JOIN annotations a ON a.id = w.canonical_annotation_id
    WHERE w.video_id = ? AND w.workflow_version = ?
    ${lock ? "FOR UPDATE OF w, a" : ""}`,
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
  return row;
}

async function insertAudit(
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

async function currentPayload(db: DbClient, workspace: WorkspaceRow) {
  if (!workspace.current_working_snapshot_id) return emptyV04DraftPayload();
  const row = await db.prepare(
    `SELECT id, revision, payload_json, content_hash, created_at
    FROM annotation_snapshots WHERE id = ?`,
  ).bind(workspace.current_working_snapshot_id).first<WorkingSnapshotRow>();
  if (!row) throw new V04ServiceError("VERSION_NOT_FOUND", "当前工作稿快照不存在。");
  return parsePayload(row.payload_json);
}

async function insertChoice(
  db: DbClient,
  annotationId: string,
  targetType: "ANNOTATION" | "SHOT_GROUP",
  targetId: string,
  valueSlot: "PRIMARY" | "AUXILIARY",
  fieldKey: "bridgeCreativeRole" | "generalMechanism" | "storyReferenceType",
  value: V04ChoiceValue,
  actor: V04Actor,
  now: string,
) {
  await db.prepare(
    `INSERT INTO annotation_choice_values (
      id, annotation_id, target_type, target_id, value_slot, field_key,
      selected_option_ids, custom_text, advanced_text, vocabulary_version,
      legacy_raw_value, updated_by_user_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?, ?::timestamptz)`,
  ).bind(
    id("choice"), annotationId, targetType, targetId, valueSlot, fieldKey,
    JSON.stringify(value.selectedOptionIds), value.customText, value.advancedText ?? "",
    value.vocabularyVersion,
    value.legacyRawValue === undefined ? null : JSON.stringify(value.legacyRawValue),
    actor.userId, now,
  ).run();
}

export async function persistV04RelationalDraft(
  db: DbClient,
  workspace: V04WorkspacePersistenceRow,
  payload: V04DraftPayloadV1,
  revision: number,
  contentHash: string,
  actor: V04Actor,
  now: string,
) {
  const annotationId = workspace.canonical_annotation_id;
  const facts = payload.factsAndCoreJudgement;

  await db.prepare(`DELETE FROM annotation_choice_values WHERE annotation_id = ?`)
    .bind(annotationId).run();
  await db.prepare(`DELETE FROM shots WHERE annotation_id = ?`).bind(annotationId).run();
  await db.prepare(`DELETE FROM shot_groups WHERE annotation_id = ?`).bind(annotationId).run();

  for (const group of payload.script.shotGroups) {
    const physicalGroupId = v04RelationalId("group", annotationId, group.id);
    await db.prepare(
      `INSERT INTO shot_groups (
        id, annotation_id, order_index, title, primary_role_id,
        primary_role_name_snapshot, auxiliary_roles_json, custom_role,
        note, taxonomy_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      physicalGroupId, annotationId, group.orderIndex, group.bridgeName,
      group.primaryCreativeRole.selectedOptionIds[0] ?? "",
      group.primaryCreativeRole.selectedOptionIds[0] ?? "",
      JSON.stringify(group.auxiliaryCreativeRole.selectedOptionIds),
      group.primaryCreativeRole.customText, group.keyCreativeDescription,
      V04_TAXONOMY_VERSION, now, now,
    ).run();
    await insertChoice(
      db, annotationId, "SHOT_GROUP", physicalGroupId, "PRIMARY",
      "bridgeCreativeRole", group.primaryCreativeRole, actor, now,
    );
    await insertChoice(
      db, annotationId, "SHOT_GROUP", physicalGroupId, "AUXILIARY",
      "bridgeCreativeRole", group.auxiliaryCreativeRole, actor, now,
    );
    for (const shot of group.shots) {
      const physicalShotId = v04RelationalId("shot", annotationId, shot.id);
      await db.prepare(
        `INSERT INTO shots (
          id, annotation_id, order_index, group_name, shot_group_id, shot_number,
          start_time, end_time, shot_size, camera_angle, camera_movement,
          visual_content, screen_text, subtitle_effect, dialogue, voiceover,
          sound_effect, music, creative_comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      ).bind(
        physicalShotId, annotationId, shot.orderIndex, group.bridgeName, physicalGroupId,
        String(shot.orderIndex + 1), shot.startTime, shot.endTime, shot.shotScale,
        shot.cameraAngle, shot.cameraMovement, shot.visualContent, shot.screenCopy,
        shot.subtitleEffect, shot.dialogue, shot.voiceOver, shot.soundEffect, shot.music,
      ).run();
    }
  }

  await insertChoice(
    db, annotationId, "ANNOTATION", annotationId, "PRIMARY",
    "generalMechanism", facts.mainMechanism, actor, now,
  );
  await insertChoice(
    db, annotationId, "ANNOTATION", annotationId, "AUXILIARY",
    "generalMechanism", facts.auxiliaryMechanism, actor, now,
  );
  await insertChoice(
    db, annotationId, "ANNOTATION", annotationId, "PRIMARY",
    "storyReferenceType", facts.storyReference, actor, now,
  );

  await db.prepare(
    `INSERT INTO annotation_creative_structures (
      annotation_id, creative_button, mechanism_statement, mechanism_primary,
      mechanism_auxiliary_json, mechanism_custom, story_reference_type,
      primary_creative_path, auxiliary_creative_paths_json, creative_carriers,
      acceptance_contract, creative_grade, creative_grade_reason,
      main_path_payload_json, auxiliary_path_notes_json, condition_flags_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (annotation_id) DO UPDATE SET
      creative_button = EXCLUDED.creative_button,
      mechanism_statement = EXCLUDED.mechanism_statement,
      mechanism_primary = EXCLUDED.mechanism_primary,
      mechanism_auxiliary_json = EXCLUDED.mechanism_auxiliary_json,
      mechanism_custom = EXCLUDED.mechanism_custom,
      story_reference_type = EXCLUDED.story_reference_type,
      primary_creative_path = EXCLUDED.primary_creative_path,
      auxiliary_creative_paths_json = EXCLUDED.auxiliary_creative_paths_json,
      creative_carriers = EXCLUDED.creative_carriers,
      acceptance_contract = EXCLUDED.acceptance_contract,
      creative_grade = EXCLUDED.creative_grade,
      creative_grade_reason = EXCLUDED.creative_grade_reason,
      main_path_payload_json = EXCLUDED.main_path_payload_json,
      auxiliary_path_notes_json = EXCLUDED.auxiliary_path_notes_json,
      condition_flags_json = EXCLUDED.condition_flags_json,
      updated_at = EXCLUDED.updated_at`,
  ).bind(
    annotationId, facts.tensionButton, facts.mainMechanism.advancedText ?? "",
    facts.mainMechanism.selectedOptionIds[0] ?? "",
    JSON.stringify(facts.auxiliaryMechanism.selectedOptionIds),
    facts.mainMechanism.customText,
    facts.storyReference.selectedOptionIds[0] ?? "",
    payload.perceptionPath.primaryType,
    JSON.stringify(payload.perceptionPath.auxiliaryTypes.map((item) => item.type)),
    JSON.stringify(facts.creativeCarriers), facts.acceptanceContract,
    facts.overallCreativeRating, facts.ratingReason,
    JSON.stringify(payload.perceptionPath),
    JSON.stringify(payload.perceptionPath.auxiliaryTypes),
    JSON.stringify(facts), now,
  ).run();

  await db.prepare(
    `UPDATE annotations SET
      revision = ?, commercial_intent = ?, creative_theme = ?, synopsis = ?,
      thinking_chain = ?, summary = ?, status = 'DRAFT', updated_at = ?,
      vocabulary_version = ?, payload_schema_version = ?, content_hash = ?,
      updated_by_user_id = ?
    WHERE id = ?`,
  ).bind(
    revision, facts.commercialIntent, facts.creativeMotif, facts.storySynopsis,
    facts.creativeThinkingChain, facts.ratingReason, now,
    V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION, contentHash,
    actor.userId, annotationId,
  ).run();
}

async function requireValidLease(
  db: DbClient,
  workspace: WorkspaceRow,
  actor: V04Actor,
  proof: V04LeaseProof,
  now: Date,
) {
  assertLeaseProofShape(proof);
  const lease = await db.prepare(
    `SELECT id, holder_user_id, session_id, tab_token_hash, lease_token_hash,
      lease_version, status, acquired_at, last_heartbeat_at, expires_at
    FROM collaboration_edit_leases
    WHERE workspace_id = ? AND status = 'ACTIVE' FOR UPDATE`,
  ).bind(workspace.id).first<LeaseRow>();
  if (!lease) throw new V04ServiceError("LEASE_REQUIRED", "请先取得当前工作稿的编辑权。");
  if (Date.parse(lease.expires_at) <= now.getTime()) {
    throw new V04ServiceError("LEASE_EXPIRED", "编辑权已过期，请重新取得。");
  }
  const [tabHash, leaseHash] = await Promise.all([
    hashToken(proof.tabToken),
    hashToken(proof.leaseToken),
  ]);
  if (
    lease.holder_user_id !== actor.userId || lease.session_id !== actor.sessionId ||
    lease.tab_token_hash !== tabHash || lease.lease_token_hash !== leaseHash ||
    Number(lease.lease_version) !== Number(proof.leaseVersion)
  ) {
    throw new V04ServiceError(
      "LEASE_HELD_BY_OTHER",
      "当前工作稿正由另一个编辑端维护。",
      { holderUserId: lease.holder_user_id },
    );
  }
  return lease;
}

export async function materializeV04Workspace(db: DbClient, videoId: string, actor: V04Actor) {
  return db.withTransaction(async (transaction) => {
    await assertCaseAvailable(transaction, videoId, true);
    const existing = await workspaceForVideo(transaction, videoId, true);
    if (existing) return { workspaceId: existing.id, created: false };

    const annotationId = id("annotation");
    const workspaceId = id("workspace");
    const baselineId = id("baseline");
    const roundId = id("round");
    const payload = emptyV04DraftPayload();
    const contentHash = hashV04Payload(payload);
    const now = new Date().toISOString();

    await transaction.prepare(
      `INSERT INTO annotations (
        id, video_id, author_email, author_name, taxonomy_version, workflow_version,
        status, revision, created_at, updated_at, vocabulary_version,
        payload_schema_version, content_hash, updated_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      annotationId, videoId, actor.identityKey, actor.displayName,
      V04_TAXONOMY_VERSION, WORKFLOW, now, now, V04_VOCABULARY_VERSION,
      V04_PAYLOAD_SCHEMA_VERSION, contentHash, actor.userId,
    ).run();
    await transaction.prepare(
      `INSERT INTO collaboration_workspaces (
        id, video_id, domain_key, taxonomy_version, workflow_version,
        vocabulary_version, canonical_annotation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, 'AD_VIDEO', ?, ?, ?, ?, 'ACTIVE', ?, ?::timestamptz, ?::timestamptz)`,
    ).bind(
      workspaceId, videoId, V04_TAXONOMY_VERSION, WORKFLOW,
      V04_VOCABULARY_VERSION, annotationId, actor.userId, now, now,
    ).run();
    await transaction.prepare(
      `INSERT INTO collaboration_baselines (
        id, workspace_id, annotation_id, source_kind, payload_json, content_hash,
        taxonomy_version, workflow_version, payload_schema_version,
        created_by_user_id, created_at
      ) VALUES (?, ?, ?, 'EMPTY', ?::jsonb, ?, ?, ?, ?, ?, ?::timestamptz)`,
    ).bind(
      baselineId, workspaceId, annotationId, JSON.stringify(payload), contentHash,
      V04_TAXONOMY_VERSION, WORKFLOW, V04_PAYLOAD_SCHEMA_VERSION, actor.userId, now,
    ).run();
    await transaction.prepare(
      `INSERT INTO collaboration_rounds (
        id, workspace_id, annotation_id, round_number, status, base_type,
        base_baseline_id, starting_revision, created_by_user_id, created_at
      ) VALUES (?, ?, ?, 1, 'ACTIVE', 'BASELINE', ?, 0, ?, ?::timestamptz)`,
    ).bind(roundId, workspaceId, annotationId, baselineId, actor.userId, now).run();
    await transaction.prepare(
      `UPDATE collaboration_workspaces SET active_round_id = ?, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(roundId, now, workspaceId).run();
    await insertAudit(transaction, actor, "V04_WORKSPACE_MATERIALIZED", "V04_WORKSPACE", workspaceId, {
      videoId,
      baselineId,
      roundId,
    });
    return { workspaceId, created: true };
  });
}

export async function acquireV04Lease(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { tabToken: string; existingLeaseToken?: string; existingLeaseVersion?: number; now?: Date },
) {
  if (!input.tabToken?.trim()) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "编辑端标识不能为空。");
  }
  const tabHash = await hashToken(input.tabToken);
  const existingLeaseHash = input.existingLeaseToken
    ? await hashToken(input.existingLeaseToken)
    : null;
  const now = input.now ?? new Date();
  return db.withTransaction(async (transaction) => {
    await assertCaseAvailable(transaction, videoId);
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    const active = await transaction.prepare(
      `SELECT id, holder_user_id, session_id, tab_token_hash, lease_token_hash,
        lease_version, status, acquired_at, last_heartbeat_at, expires_at
      FROM collaboration_edit_leases
      WHERE workspace_id = ? AND status = 'ACTIVE' FOR UPDATE`,
    ).bind(workspace.id).first<LeaseRow>();

    if (active && Date.parse(active.expires_at) <= now.getTime()) {
      await transaction.prepare(
        `UPDATE collaboration_edit_leases SET status = 'EXPIRED', released_at = ?::timestamptz,
          release_reason = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'`,
      ).bind(iso(now), active.id).run();
    } else if (active) {
      const sameStableTab = active.holder_user_id === actor.userId &&
        active.session_id === actor.sessionId && active.tab_token_hash === tabHash;
      if (sameStableTab && active.lease_token_hash === existingLeaseHash &&
        Number(active.lease_version) === Number(input.existingLeaseVersion)) {
        const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
        await transaction.prepare(
          `UPDATE collaboration_edit_leases SET last_heartbeat_at = ?::timestamptz,
            expires_at = ?::timestamptz WHERE id = ?`,
        ).bind(iso(now), iso(expiresAt), active.id).run();
        return {
          leaseId: active.id,
          leaseToken: input.existingLeaseToken!,
          leaseVersion: Number(active.lease_version),
          expiresAt: iso(expiresAt),
          reused: true,
        };
      }
      if (sameStableTab) {
        // The server may have committed the first acquisition after the
        // browser timed out and discarded its response. Only the same stable
        // actor, auth session and exact per-tab token may rotate that orphaned
        // proof; another tab or user remains fail-closed.
        const recoveredLeaseToken = randomToken();
        const recoveredLeaseTokenHash = await hashToken(recoveredLeaseToken);
        const recoveredLeaseVersion = Number(active.lease_version) + 1;
        const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
        await transaction.prepare(
          `UPDATE collaboration_edit_leases SET lease_token_hash = ?, lease_version = ?,
            last_heartbeat_at = ?::timestamptz, expires_at = ?::timestamptz
          WHERE id = ? AND status = 'ACTIVE'`,
        ).bind(
          recoveredLeaseTokenHash, recoveredLeaseVersion, iso(now), iso(expiresAt), active.id,
        ).run();
        await insertAudit(transaction, actor, "V04_LEASE_PROOF_RECOVERED", "V04_WORKSPACE", workspace.id, {
          leaseId: active.id,
          leaseVersion: recoveredLeaseVersion,
        });
        return {
          leaseId: active.id,
          leaseToken: recoveredLeaseToken,
          leaseVersion: recoveredLeaseVersion,
          expiresAt: iso(expiresAt),
          reused: true,
          recovered: true,
        };
      }
      throw new V04ServiceError(
        "LEASE_HELD_BY_OTHER",
        "当前工作稿正由另一个编辑端维护。",
        { holderUserId: active.holder_user_id },
      );
    }

    const versionRow = await transaction.prepare(
      `SELECT COALESCE(MAX(lease_version), 0) + 1 AS next_version
      FROM collaboration_edit_leases WHERE workspace_id = ?`,
    ).bind(workspace.id).first<{ next_version: number } & QueryResultRow>();
    const leaseToken = randomToken();
    const leaseTokenHash = await hashToken(leaseToken);
    const leaseId = id("lease");
    const leaseVersion = Number(versionRow?.next_version ?? 1);
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    await transaction.prepare(
      `INSERT INTO collaboration_edit_leases (
        id, workspace_id, round_id, holder_user_id, session_id,
        tab_token_hash, lease_token_hash, lease_version, status,
        acquired_at, last_heartbeat_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?::timestamptz, ?::timestamptz, ?::timestamptz)`,
    ).bind(
      leaseId, workspace.id, workspace.active_round_id, actor.userId, actor.sessionId,
      tabHash, leaseTokenHash, leaseVersion, iso(now), iso(now), iso(expiresAt),
    ).run();
    await insertAudit(transaction, actor, "V04_LEASE_ACQUIRED", "V04_WORKSPACE", workspace.id, {
      leaseId,
      leaseVersion,
    });
    return {
      leaseId,
      leaseToken,
      leaseVersion,
      expiresAt: iso(expiresAt),
      reused: false,
    };
  });
}

export async function heartbeatV04Lease(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  proof: V04LeaseProof,
  now = new Date(),
) {
  return db.withTransaction(async (transaction) => {
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    const lease = await requireValidLease(transaction, workspace, actor, proof, now);
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    await transaction.prepare(
      `UPDATE collaboration_edit_leases SET last_heartbeat_at = ?::timestamptz,
        expires_at = ?::timestamptz WHERE id = ?`,
    ).bind(iso(now), iso(expiresAt), lease.id).run();
    return { leaseId: lease.id, leaseVersion: Number(lease.lease_version), expiresAt: iso(expiresAt) };
  });
}

export async function releaseV04Lease(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  proof: V04LeaseProof,
  now = new Date(),
) {
  return db.withTransaction(async (transaction) => {
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    const lease = await requireValidLease(transaction, workspace, actor, proof, now);
    await transaction.prepare(
      `UPDATE collaboration_edit_leases SET status = 'RELEASED', released_at = ?::timestamptz,
        release_reason = 'USER_EXIT' WHERE id = ?`,
    ).bind(iso(now), lease.id).run();
    await insertAudit(transaction, actor, "V04_LEASE_RELEASED", "V04_WORKSPACE", workspace.id, {
      leaseId: lease.id,
      leaseVersion: Number(lease.lease_version),
    });
    return { released: true };
  });
}

export async function forceReleaseV04Lease(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { reason: string; confirmed: boolean; idempotencyKey: string; now?: Date },
) {
  if (!input.confirmed || !input.reason.trim() || !input.idempotencyKey.trim()) {
    throw new V04ServiceError("FORBIDDEN", "强制释放需要原因和二次确认。");
  }
  const now = input.now ?? new Date();
  return db.withTransaction(async (transaction) => {
    const role = await transaction.prepare(
      `SELECT 1 FROM app_role_memberships
      WHERE user_id = ? AND role_key = 'SYSTEM_ADMIN' AND status = 'ACTIVE'`,
    ).bind(actor.userId).first();
    if (!role) throw new V04ServiceError("ADMIN_REQUIRED", "仅系统管理员可强制释放编辑权。");
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    const replay = await transaction.prepare(
      `SELECT 1 FROM audit_logs WHERE request_id = ?
        AND action = 'V04_LEASE_FORCE_RELEASED' AND object_id = ? LIMIT 1`,
    ).bind(input.idempotencyKey, workspace.id).first();
    if (replay) return { released: true, idempotentReplay: true };
    const lease = await transaction.prepare(
      `SELECT id, holder_user_id, session_id, tab_token_hash, lease_token_hash,
        lease_version, status, acquired_at, last_heartbeat_at, expires_at
      FROM collaboration_edit_leases
      WHERE workspace_id = ? AND status = 'ACTIVE' FOR UPDATE`,
    ).bind(workspace.id).first<LeaseRow>();
    if (!lease) return { released: false, idempotentReplay: false };
    await transaction.prepare(
      `UPDATE collaboration_edit_leases SET status = 'RELEASED', released_at = ?::timestamptz,
        release_reason = 'ADMIN_FORCE' WHERE id = ?`,
    ).bind(iso(now), lease.id).run();
    await insertAudit(transaction, { ...actor, requestId: input.idempotencyKey },
      "V04_LEASE_FORCE_RELEASED", "V04_WORKSPACE", workspace.id, {
      leaseId: lease.id,
      holderUserId: lease.holder_user_id,
      reason: input.reason.trim(),
    });
    return { released: true, idempotentReplay: false };
  });
}

export async function saveV04Draft(db: DbClient, actor: V04Actor, input: V04SaveInput) {
  const now = input.now ?? new Date();
  if (!input.changeSetId.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "保存请求缺少稳定变更集标识。");
  }
  if (
    !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 ||
    !HASH_PATTERN.test(input.expectedHash) || !Array.isArray(input.changes)
  ) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "保存请求的版本、哈希或变更集无效。");
  }
  let inputChangeSet: string;
  try {
    inputChangeSet = canonicalV04ChangeSet(input.changes);
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_CHANGE_TARGET") {
      throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "同一变更集不能重复修改同一稳定内容单元。");
    }
    throw error;
  }
  return db.withTransaction(async (transaction) => {
    await assertCaseAvailable(transaction, input.videoId);
    const workspace = await workspaceForVideo(transaction, input.videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    await requireValidLease(transaction, workspace, actor, input.lease, now);

    const alreadyApplied = await transaction.prepare(
      `SELECT applied_revision, target_key, target_label_snapshot, value_type,
        before_value_json, after_value_json, reason
      FROM collaboration_revision_events
      WHERE workspace_id = ? AND change_set_id = ?
      ORDER BY target_key ASC`,
    ).bind(workspace.id, input.changeSetId).all<{
      applied_revision: number;
      target_key: string;
      target_label_snapshot: string;
      value_type: V04Change["valueType"];
      before_value_json: unknown;
      after_value_json: unknown;
      reason: string | null;
    } & QueryResultRow>();
    if (alreadyApplied.results.length > 0) {
      const storedChangeSet = canonicalV04ChangeSet(alreadyApplied.results.map((row) => ({
        targetKey: row.target_key,
        targetLabel: row.target_label_snapshot,
        valueType: row.value_type,
        beforeValue: row.before_value_json,
        afterValue: row.after_value_json,
        reason: row.reason ?? undefined,
      })));
      if (storedChangeSet !== inputChangeSet) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "该变更集标识已用于不同内容。");
      }
      const appliedRevision = Math.max(...alreadyApplied.results.map(
        (row) => Number(row.applied_revision),
      ));
      const appliedSnapshot = await transaction.prepare(
        `SELECT content_hash FROM annotation_snapshots
        WHERE annotation_id = ? AND workflow_version = ?
          AND snapshot_kind = 'WORKING' AND revision = ?`,
      ).bind(
        workspace.canonical_annotation_id, WORKFLOW, appliedRevision,
      ).first<{ content_hash: string } & QueryResultRow>();
      if (!appliedSnapshot) {
        throw new V04ServiceError("VERSION_NOT_FOUND", "幂等保存对应的工作稿快照不存在。");
      }
      return {
        revision: appliedRevision,
        contentHash: appliedSnapshot.content_hash,
        idempotentReplay: true,
      };
    }

    const serverRevision = Number(workspace.revision);
    const serverHash = workspace.content_hash ?? hashV04Payload(emptyV04DraftPayload());
    const before = await currentPayload(transaction, workspace);
    const serverChanges = input.expectedRevision < serverRevision
      ? (await transaction.prepare(
          `SELECT target_key, value_type FROM collaboration_revision_events
          WHERE workspace_id = ? AND applied_revision > ? ORDER BY applied_revision ASC`,
        ).bind(workspace.id, input.expectedRevision).all<{
          target_key: string;
          value_type: V04Change["valueType"];
        } & QueryResultRow>()).results.map((row) => ({
          targetKey: row.target_key,
          valueType: row.value_type,
        }))
      : [];
    const decision = decideV04ChangeSet(
      input.expectedRevision,
      serverRevision,
      input.changes,
      serverChanges,
    );
    // A workspace that moved on only blocks this change set where a target's
    // recorded original value no longer matches the stored one. A revision or
    // hash difference on its own — including a structural change elsewhere in
    // the case — rebases instead, and applyV04ChangeSet below still fails
    // closed per target. Reporting only the targets that truly collide is what
    // makes the conflict resolvable: the editor can choose between two real
    // values per target instead of being told the whole edit conflicts.
    const staleBase = input.expectedRevision !== serverRevision ||
      input.expectedHash !== serverHash;
    if (staleBase || decision.kind === "CONFLICT") {
      const conflictTargets = v04ValueConflictTargets(before, input.changes);
      if (conflictTargets.length > 0) {
        throw new V04ServiceError(
          "REVISION_CONFLICT",
          "工作稿已经发生变化，请处理冲突后重试。",
          {
            serverRevision,
            serverHash,
            conflictTargets,
            serverSummary: {
              currentRevision: serverRevision,
              changedTargets: serverChanges.map((item) => item.targetKey),
            },
          },
        );
      }
    }

    let after: V04DraftPayloadV1;
    try {
      after = applyV04ChangeSet(before, input.changes);
      assertV04PayloadContract(after);
    } catch (error) {
      if (error instanceof Error && error.message === "REVISION_CONFLICT") {
        throw new V04ServiceError(
          "REVISION_CONFLICT",
          "变更的原值与服务器当前值不一致。",
          {
            serverRevision,
            serverHash,
            conflictTargets: v04ValueConflictTargets(before, input.changes),
          },
        );
      }
      if (error instanceof Error &&
        (error.message === "CHOICE_RULE_VIOLATION" || error.message === "INVALID_PAYLOAD_SCHEMA")) {
        // A contract violation is final for this draft: no retry can pass
        // until the editor changes the named field. Name it.
        const violations = listV04ContractViolations(applyV04ChangeSetUnchecked(before, input.changes));
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
    if (nextHash === serverHash) {
      return { revision: serverRevision, contentHash: serverHash, idempotentReplay: false };
    }
    const nextRevision = serverRevision + 1;
    const snapshotId = id("snapshot");
    const savedAt = iso(now);
    await persistV04RelationalDraft(
      transaction, workspace, after, nextRevision, nextHash, actor, savedAt,
    );
    await transaction.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name, taxonomy_version,
        revision, payload_json, content_hash, created_at, workflow_status,
        snapshot_kind, workflow_version, vocabulary_version,
        payload_schema_version, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'WORKING', ?, ?, ?, ?)`,
    ).bind(
      snapshotId, workspace.canonical_annotation_id, workspace.video_id,
      actor.identityKey, actor.displayName, V04_TAXONOMY_VERSION,
      nextRevision, JSON.stringify(after), nextHash, savedAt, WORKFLOW,
      V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION, actor.userId,
    ).run();

    for (const change of input.changes) {
      await transaction.prepare(
        `INSERT INTO collaboration_revision_events (
          id, workspace_id, round_id, annotation_id, change_set_id,
          base_revision, applied_revision, target_key, target_label_snapshot,
          value_type, before_value_json, after_value_json, source_kind,
          reason, actor_user_id, actor_name_snapshot, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?::timestamptz)`,
      ).bind(
        id("revision_event"), workspace.id, workspace.active_round_id,
        workspace.canonical_annotation_id, input.changeSetId,
        input.expectedRevision, nextRevision, change.targetKey, change.targetLabel,
        change.valueType, JSON.stringify(change.beforeValue ?? null),
        JSON.stringify(change.afterValue ?? null), input.sourceKind ?? "HUMAN_DIRECT",
        change.reason ?? null, actor.userId, actor.displayName, savedAt,
      ).run();
    }
    await transaction.prepare(
      `UPDATE collaboration_workspaces
      SET current_working_snapshot_id = ?, updated_at = ?::timestamptz WHERE id = ?`,
    ).bind(snapshotId, savedAt, workspace.id).run();
    await insertAudit(transaction, actor, "V04_DRAFT_SAVED", "V04_WORKSPACE", workspace.id, {
      changeSetId: input.changeSetId,
      baseRevision: input.expectedRevision,
      appliedRevision: nextRevision,
      rebased: input.expectedRevision !== serverRevision,
      targets: input.changes.map((item) => item.targetKey),
      contentHash: nextHash,
    });
    const latest = await latestSubmission(transaction, workspace.id);
    const count = await submissionCount(transaction, workspace.id);
    return {
      revision: nextRevision,
      contentHash: nextHash,
      savedAt,
      idempotentReplay: false,
      rebased: input.expectedRevision !== serverRevision,
      workflowState: deriveV04WorkflowState({
        hasAnyDraftData: hasAnyV04DraftData(after),
        currentDraftRevision: nextRevision,
        currentDraftContentHash: nextHash,
        successfulSubmissionCount: count,
        latestSubmissionSourceRevision: latest?.source_revision ?? null,
        latestSubmissionContentHash: latest?.content_hash ?? null,
      }),
    };
  });
}

async function submissionCount(db: DbClient, workspaceId: string) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM annotation_submission_snapshots WHERE workspace_id = ?`,
  ).bind(workspaceId).first<{ count: number } & QueryResultRow>();
  return Number(row?.count ?? 0);
}

async function latestSubmission(db: DbClient, workspaceId: string) {
  return db.prepare(
    `SELECT id, submission_number, source_revision, source_content_hash,
      payload_json, content_hash, submitted_by_user_id, idempotency_key, submitted_at
    FROM annotation_submission_snapshots
    WHERE workspace_id = ? ORDER BY submission_number DESC LIMIT 1`,
  ).bind(workspaceId).first<SubmissionRow>();
}

export async function submitV04Draft(
  db: DbClient,
  actor: V04Actor,
  input: V04SubmitInput,
  hooks: V04SubmitHooks = {},
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "提交请求缺少幂等键。");
  }
  if (
    !Number.isInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 0 ||
    !HASH_PATTERN.test(input.expectedDraftHash)
  ) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "提交请求的工作稿版本或哈希无效。");
  }
  return db.withTransaction(async (transaction) => {
    await assertCaseAvailable(transaction, input.videoId);
    const workspace = await workspaceForVideo(transaction, input.videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    await requireValidLease(transaction, workspace, actor, input.lease, now);

    const existing = await transaction.prepare(
      `SELECT id, submission_number, source_revision, source_content_hash,
        payload_json, content_hash, submitted_by_user_id, idempotency_key, submitted_at
      FROM annotation_submission_snapshots
      WHERE workspace_id = ? AND idempotency_key = ?`,
    ).bind(workspace.id, input.idempotencyKey).first<SubmissionRow>();
    if (existing) {
      if (
        Number(existing.source_revision) !== Number(input.expectedDraftRevision) ||
        existing.source_content_hash !== input.expectedDraftHash
      ) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "该幂等键已用于另一次提交。");
      }
      return {
        submissionId: existing.id,
        submissionNumber: Number(existing.submission_number),
        contentHash: existing.content_hash,
        submittedAt: existing.submitted_at,
        idempotentReplay: true,
      };
    }

    const serverRevision = Number(workspace.revision);
    const serverHash = workspace.content_hash ?? hashV04Payload(emptyV04DraftPayload());
    if (
      serverRevision !== Number(input.expectedDraftRevision) ||
      serverHash !== input.expectedDraftHash
    ) {
      throw new V04ServiceError(
        "REVISION_CONFLICT",
        "最新工作稿尚未保存或已发生变化。",
        { serverRevision, serverHash },
      );
    }
    if (!workspace.current_working_snapshot_id) {
      throw new V04ServiceError("PUBLICATION_INCOMPLETE", "当前工作稿尚无可提交内容。");
    }
    const payload = await currentPayload(transaction, workspace);
    const publication = validateV04Publication(payload);
    if (!publication.publicationReady) {
      throw new V04ServiceError(
        "PUBLICATION_INCOMPLETE",
        "发布必填项尚未完成。",
        { missingItems: publication.missingItems },
      );
    }
    const latest = await latestSubmission(transaction, workspace.id);
    if (latest?.content_hash === serverHash) {
      throw new V04ServiceError("NO_CHANGES_TO_SUBMIT", "当前工作稿与最新提交版一致。");
    }
    const numberRow = await transaction.prepare(
      `SELECT COALESCE(MAX(submission_number), 0) + 1 AS next_number
      FROM annotation_submission_snapshots WHERE workspace_id = ?`,
    ).bind(workspace.id).first<{ next_number: number } & QueryResultRow>();
    const submissionNumber = Number(numberRow?.next_number ?? 1);
    const submissionId = id("submission");
    const submittedAt = iso(now);
    await transaction.prepare(
      `INSERT INTO annotation_submission_snapshots (
        id, workspace_id, round_id, annotation_id, video_id, submission_number,
        source_working_snapshot_id, source_revision, source_content_hash,
        payload_json, content_hash, taxonomy_version, workflow_version,
        vocabulary_version, payload_schema_version, submitted_by_user_id,
        idempotency_key, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz)`,
    ).bind(
      submissionId, workspace.id, workspace.active_round_id,
      workspace.canonical_annotation_id, workspace.video_id, submissionNumber,
      workspace.current_working_snapshot_id, serverRevision, serverHash,
      JSON.stringify(payload), serverHash, V04_TAXONOMY_VERSION, WORKFLOW,
      V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION, actor.userId,
      input.idempotencyKey, submittedAt,
    ).run();
    await hooks.afterSubmissionInsert?.();
    await transaction.prepare(
      `UPDATE collaboration_workspaces
      SET latest_submission_snapshot_id = ?, updated_at = ?::timestamptz WHERE id = ?`,
    ).bind(submissionId, submittedAt, workspace.id).run();
    await hooks.afterPointerUpdate?.();
    await insertAudit(transaction, actor, "V04_SUBMISSION_CREATED", "V04_SUBMISSION", submissionId, {
      workspaceId: workspace.id,
      submissionNumber,
      sourceRevision: serverRevision,
      contentHash: serverHash,
    });
    return {
      submissionId,
      submissionNumber,
      contentHash: serverHash,
      submittedAt,
      idempotentReplay: false,
    };
  });
}

export async function grantV04ExpertPreference(
  db: DbClient,
  videoId: string,
  submissionId: string,
  actor: V04Actor,
  input: { grade: "S" | "A" | "B" | "C"; reason?: string; idempotencyKey: string; now?: Date },
  hooks: V04ExpertHooks = {},
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "专家优选请求缺少幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    const expert = await transaction.prepare(
      `SELECT 1 FROM app_role_memberships
      WHERE user_id = ? AND role_key = 'EXPERT' AND status = 'ACTIVE'`,
    ).bind(actor.userId).first();
    if (!expert) throw new V04ServiceError("EXPERT_REQUIRED", "仅稳定专家成员可设置专家优选。");
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    const submission = await transaction.prepare(
      `SELECT id FROM annotation_submission_snapshots WHERE id = ? AND workspace_id = ?`,
    ).bind(submissionId, workspace.id).first<{ id: string } & QueryResultRow>();
    if (!submission) throw new V04ServiceError("VERSION_NOT_FOUND", "目标提交版不属于该案例。");
    const replay = await transaction.prepare(
      `SELECT object_id, detail_json FROM audit_logs
      WHERE request_id = ? AND action = 'V04_EXPERT_PREFERENCE_GRANTED'
        AND workflow_version = ? LIMIT 1`,
    ).bind(input.idempotencyKey, WORKFLOW).first<{
      object_id: string;
      detail_json: string | Record<string, unknown>;
    } & QueryResultRow>();
    if (replay) {
      const detail = typeof replay.detail_json === "string"
        ? JSON.parse(replay.detail_json) as Record<string, unknown>
        : replay.detail_json;
      if (detail.submissionId !== submissionId || detail.grade !== input.grade) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "该幂等键已用于另一次专家优选。");
      }
      return { releaseId: replay.object_id, idempotentReplay: true };
    }

    const active = await transaction.prepare(
      `SELECT id, submission_snapshot_id FROM expert_analysis_releases
      WHERE workspace_id = ? AND status = 'ACTIVE' FOR UPDATE`,
    ).bind(workspace.id).first<{
      id: string;
      submission_snapshot_id: string;
    } & QueryResultRow>();
    if (active) {
      await transaction.prepare(
        `UPDATE expert_analysis_releases
        SET status = 'SUPERSEDED', ended_by_user_id = ?, ended_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(actor.userId, iso(now), active.id).run();
    }
    const releaseId = id("expert_release");
    await transaction.prepare(
      `INSERT INTO expert_analysis_releases (
        id, workspace_id, submission_snapshot_id, grade, reason, status,
        granted_by_user_id, granted_at, supersedes_release_id
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?::timestamptz, ?)`,
    ).bind(
      releaseId, workspace.id, submissionId, input.grade, input.reason?.trim() ?? "",
      actor.userId, iso(now), active?.id ?? null,
    ).run();
    await hooks.afterReleaseInsert?.();
    await transaction.prepare(
      `UPDATE collaboration_workspaces
      SET active_expert_release_id = ?, updated_at = ?::timestamptz WHERE id = ?`,
    ).bind(releaseId, iso(now), workspace.id).run();
    await hooks.afterPointerUpdate?.();
    await insertAudit(transaction, { ...actor, requestId: input.idempotencyKey },
      "V04_EXPERT_PREFERENCE_GRANTED", "V04_EXPERT_RELEASE", releaseId, {
        workspaceId: workspace.id,
        submissionId,
        grade: input.grade,
        supersedesReleaseId: active?.id ?? null,
      });
    return { releaseId, idempotentReplay: false };
  });
}

export async function withdrawV04ExpertPreference(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { idempotencyKey: string; reason?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "撤回专家优选缺少幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    const expert = await transaction.prepare(
      `SELECT 1 FROM app_role_memberships
      WHERE user_id = ? AND role_key = 'EXPERT' AND status = 'ACTIVE'`,
    ).bind(actor.userId).first();
    if (!expert) throw new V04ServiceError("EXPERT_REQUIRED", "仅稳定专家成员可撤回专家优选。");
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    const replay = await transaction.prepare(
      `SELECT object_id FROM audit_logs
      WHERE request_id = ? AND action = 'V04_EXPERT_PREFERENCE_WITHDRAWN'
        AND workflow_version = ? LIMIT 1`,
    ).bind(input.idempotencyKey, WORKFLOW).first<{ object_id: string } & QueryResultRow>();
    if (replay) return { releaseId: replay.object_id, idempotentReplay: true };
    const active = await transaction.prepare(
      `SELECT id FROM expert_analysis_releases
      WHERE workspace_id = ? AND status = 'ACTIVE' FOR UPDATE`,
    ).bind(workspace.id).first<{ id: string } & QueryResultRow>();
    if (!active) return { releaseId: null, idempotentReplay: false };
    await transaction.prepare(
      `UPDATE expert_analysis_releases
      SET status = 'WITHDRAWN', ended_by_user_id = ?, ended_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(actor.userId, iso(now), active.id).run();
    await transaction.prepare(
      `UPDATE collaboration_workspaces
      SET active_expert_release_id = NULL, updated_at = ?::timestamptz WHERE id = ?`,
    ).bind(iso(now), workspace.id).run();
    await insertAudit(transaction, { ...actor, requestId: input.idempotencyKey },
      "V04_EXPERT_PREFERENCE_WITHDRAWN", "V04_EXPERT_RELEASE", active.id, {
        workspaceId: workspace.id,
        reason: input.reason?.trim() ?? "",
      });
    return { releaseId: active.id, idempotentReplay: false };
  });
}

type RestoreSourceType = "BASELINE" | "WORKING" | "SUBMISSION";

async function loadRestoreSource(
  db: DbClient,
  workspace: WorkspaceRow,
  sourceType: RestoreSourceType,
  sourceId: string,
) {
  if (sourceType === "BASELINE") {
    return db.prepare(
      `SELECT id, payload_json, content_hash FROM collaboration_baselines
      WHERE id = ? AND workspace_id = ?`,
    ).bind(sourceId, workspace.id).first<{
      id: string;
      payload_json: V04DraftPayloadV1 | string;
      content_hash: string;
    } & QueryResultRow>();
  }
  if (sourceType === "WORKING") {
    return db.prepare(
      `SELECT s.id, s.payload_json, s.content_hash FROM annotation_snapshots s
      WHERE s.id = ? AND s.annotation_id = ? AND s.workflow_version = ?
        AND s.snapshot_kind = 'WORKING'`,
    ).bind(sourceId, workspace.canonical_annotation_id, WORKFLOW).first<{
      id: string;
      payload_json: V04DraftPayloadV1 | string;
      content_hash: string;
    } & QueryResultRow>();
  }
  return db.prepare(
    `SELECT id, payload_json, content_hash FROM annotation_submission_snapshots
    WHERE id = ? AND workspace_id = ?`,
  ).bind(sourceId, workspace.id).first<{
    id: string;
    payload_json: V04DraftPayloadV1 | string;
    content_hash: string;
  } & QueryResultRow>();
}

export async function restoreV04Draft(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: {
    sourceType: RestoreSourceType;
    sourceId: string;
    reason?: string;
    idempotencyKey: string;
    lease: V04LeaseProof;
    now?: Date;
  },
  hooks: V04RestoreHooks = {},
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim() || !input.sourceId.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "历史恢复缺少稳定来源或幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    await assertCaseAvailable(transaction, videoId);
    const workspace = await workspaceForVideo(transaction, videoId, true);
    if (!workspace) throw new V04ServiceError("VERSION_NOT_FOUND", "公共工作稿尚未物化。");
    await requireValidLease(transaction, workspace, actor, input.lease, now);
    const replay = await transaction.prepare(
      `SELECT applied_revision, source_object_type, source_object_id
      FROM collaboration_revision_events
      WHERE workspace_id = ? AND change_set_id = ? AND source_kind = 'HISTORY_RESTORE'
      LIMIT 1`,
    ).bind(workspace.id, input.idempotencyKey).first<{
      applied_revision: number;
      source_object_type: string;
      source_object_id: string;
    } & QueryResultRow>();
    if (replay) {
      if (replay.source_object_type !== input.sourceType || replay.source_object_id !== input.sourceId) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "该幂等键已用于另一次历史恢复。");
      }
      const appliedSnapshot = await transaction.prepare(
        `SELECT content_hash FROM annotation_snapshots
        WHERE annotation_id = ? AND workflow_version = ? AND snapshot_kind = 'WORKING'
          AND revision = ?`,
      ).bind(
        workspace.canonical_annotation_id, WORKFLOW, Number(replay.applied_revision),
      ).first<{ content_hash: string } & QueryResultRow>();
      if (!appliedSnapshot) throw new V04ServiceError("VERSION_NOT_FOUND", "恢复产生的工作稿快照不存在。");
      return {
        revision: Number(replay.applied_revision),
        contentHash: appliedSnapshot.content_hash,
        idempotentReplay: true,
      };
    }
    const source = await loadRestoreSource(transaction, workspace, input.sourceType, input.sourceId);
    if (!source) throw new V04ServiceError("VERSION_NOT_FOUND", "待恢复版本不存在或不属于该案例。");
    const payload = parsePayload(source.payload_json);
    const nextRevision = Number(workspace.revision) + 1;
    const contentHash = hashV04Payload(payload);
    const snapshotId = id("snapshot");
    const savedAt = iso(now);
    await persistV04RelationalDraft(
      transaction, workspace, payload, nextRevision, contentHash,
      actor, savedAt,
    );
    await transaction.prepare(
      `INSERT INTO annotation_snapshots (
        id, annotation_id, video_id, author_email, author_name, taxonomy_version,
        revision, payload_json, content_hash, created_at, workflow_status,
        snapshot_kind, revision_cause, workflow_version, vocabulary_version,
        payload_schema_version, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'WORKING', 'HISTORY_RESTORE', ?, ?, ?, ?)`,
    ).bind(
      snapshotId, workspace.canonical_annotation_id, workspace.video_id,
      actor.identityKey, actor.displayName, V04_TAXONOMY_VERSION,
      nextRevision, JSON.stringify(payload), contentHash, savedAt, WORKFLOW,
      V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION, actor.userId,
    ).run();
    await hooks.afterSnapshotInsert?.();
    await transaction.prepare(
      `INSERT INTO collaboration_revision_events (
        id, workspace_id, round_id, annotation_id, change_set_id,
        base_revision, applied_revision, target_key, target_label_snapshot,
        value_type, before_value_json, after_value_json, source_kind,
        source_object_type, source_object_id, reason, actor_user_id,
        actor_name_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'script.structure', '历史版本恢复',
        'STRUCTURE', ?::jsonb, ?::jsonb, 'HISTORY_RESTORE', ?, ?, ?, ?, ?, ?::timestamptz)`,
    ).bind(
      id("revision_event"), workspace.id, workspace.active_round_id,
      workspace.canonical_annotation_id, input.idempotencyKey,
      Number(workspace.revision), nextRevision,
      JSON.stringify(await currentPayload(transaction, workspace)),
      JSON.stringify(payload), input.sourceType, input.sourceId,
      input.reason?.trim() ?? null, actor.userId, actor.displayName, savedAt,
    ).run();
    await transaction.prepare(
      `UPDATE collaboration_workspaces
      SET current_working_snapshot_id = ?, updated_at = ?::timestamptz WHERE id = ?`,
    ).bind(snapshotId, savedAt, workspace.id).run();
    await hooks.afterPointerUpdate?.();
    await insertAudit(transaction, { ...actor, requestId: input.idempotencyKey },
      "V04_DRAFT_RESTORED", "V04_WORKSPACE", workspace.id, {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        appliedRevision: nextRevision,
        contentHash,
      });
    return { revision: nextRevision, contentHash, idempotentReplay: false };
  });
}
