import type { DbClient, QueryResultRow } from "@/db";
import { hashToken } from "@/lib/auth/security";
import {
  V04_SHOT_FIELD_KEYS,
  V04_WORKFLOW_VERSION,
  type V04DraftPayloadV1,
} from "./v04-contract";
import {
  assertV04PayloadContract,
  deriveV04WorkflowState,
  emptyV04DraftPayload,
  hashV04Payload,
  hasAnyV04DraftData,
  validateV04Publication,
} from "./v04-domain";
import { V04ServiceError } from "./v04-errors";
import type { V04Actor } from "./v04-workspace-service";

export type V04ViewerContext = {
  actor: Pick<V04Actor, "userId" | "sessionId">;
  tabToken?: string | null;
};

type VideoReadRow = QueryResultRow & {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  thumbnail_key: string | null;
  original_name: string;
  content_type: string;
  file_size: number;
  status: string;
  created_by_name: string;
  created_by_user_id: string | null;
  created_at: string;
  deleted_at: string | null;
  deletion_state: string | null;
};

type WorkspaceReadRow = QueryResultRow & {
  id: string;
  video_id: string;
  canonical_annotation_id: string;
  active_round_id: string | null;
  current_working_snapshot_id: string | null;
  latest_submission_snapshot_id: string | null;
  active_expert_release_id: string | null;
  revision: number;
  content_hash: string | null;
  updated_at: string;
};

type LeaseReadRow = QueryResultRow & {
  id: string;
  holder_user_id: string;
  holder_name: string;
  session_id: string;
  tab_token_hash: string;
  lease_version: number;
  last_heartbeat_at: string;
  expires_at: string;
};

type SubmissionReadRow = QueryResultRow & {
  id: string;
  submission_number: number;
  source_revision: number;
  payload_json: V04DraftPayloadV1 | string;
  content_hash: string;
  submitted_by_user_id: string;
  submitter_name: string;
  submitted_at: string;
};

const parseJson = <T>(value: string | T): T =>
  typeof value === "string" ? JSON.parse(value) as T : value;

async function getVideo(db: DbClient, videoId: string) {
  const row = await db.prepare(
    `SELECT id, title, brand, description, tags_json, thumbnail_key,
      original_name, content_type, file_size, status, created_by_name, created_by_user_id,
      created_at, deleted_at, deletion_state
    FROM videos WHERE id = ?`,
  ).bind(videoId).first<VideoReadRow>();
  if (!row) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
  if (row.deletion_state === "ASSET_PURGED") {
    throw new V04ServiceError("ASSET_PURGED", "案例原始资产已经清理。");
  }
  if (row.deleted_at || row.deletion_state === "TRASHED") {
    throw new V04ServiceError("CASE_IN_TRASH", "案例已进入回收站。");
  }
  return row;
}

function stableMediaReference(video: VideoReadRow) {
  const encodedId = encodeURIComponent(video.id);
  return {
    videoId: video.id,
    streamPath: `/api/videos/${encodedId}/stream`,
    posterPath: video.thumbnail_key
      ? `/api/videos/${encodedId}/stream?asset=thumbnail`
      : null,
    metadataPath: `/api/videos/${encodedId}`,
    thumbnailKey: video.thumbnail_key,
    originalName: video.original_name,
    contentType: video.content_type,
    fileSize: Number(video.file_size),
    status: video.status,
  };
}

function parseTags(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function workspaceRow(db: DbClient, videoId: string) {
  return db.prepare(
    `SELECT w.id, w.video_id, w.canonical_annotation_id, w.active_round_id,
      w.current_working_snapshot_id, w.latest_submission_snapshot_id,
      w.active_expert_release_id, w.updated_at, a.revision, a.content_hash
    FROM collaboration_workspaces w
    INNER JOIN annotations a ON a.id = w.canonical_annotation_id
    WHERE w.video_id = ? AND w.workflow_version = ? AND w.status = 'ACTIVE'`,
  ).bind(videoId, V04_WORKFLOW_VERSION).first<WorkspaceReadRow>();
}

async function currentPayload(db: DbClient, workspace: WorkspaceReadRow | null) {
  if (!workspace?.current_working_snapshot_id) return emptyV04DraftPayload();
  const row = await db.prepare(
    `SELECT payload_json FROM annotation_snapshots WHERE id = ?`,
  ).bind(workspace.current_working_snapshot_id).first<{
    payload_json: string;
  } & QueryResultRow>();
  if (!row) throw new V04ServiceError("VERSION_NOT_FOUND", "当前工作稿快照不存在。");
  const payload = parseJson<V04DraftPayloadV1>(row.payload_json);
  assertV04PayloadContract(payload);
  return payload;
}

async function submissions(db: DbClient, workspaceId: string) {
  return (await db.prepare(
    `SELECT s.id, s.submission_number, s.source_revision, s.payload_json,
      s.content_hash, s.submitted_by_user_id, u.display_name AS submitter_name,
      s.submitted_at
    FROM annotation_submission_snapshots s
    INNER JOIN users u ON u.id = s.submitted_by_user_id
    WHERE s.workspace_id = ? ORDER BY s.submission_number ASC`,
  ).bind(workspaceId).all<SubmissionReadRow>()).results;
}

async function activeExpert(db: DbClient, workspaceId: string) {
  return db.prepare(
    `SELECT r.id, r.submission_snapshot_id, s.submission_number, r.grade, r.reason,
      r.granted_by_user_id, u.display_name AS granted_by_name, r.granted_at
    FROM expert_analysis_releases r
    INNER JOIN annotation_submission_snapshots s ON s.id = r.submission_snapshot_id
    INNER JOIN users u ON u.id = r.granted_by_user_id
    WHERE r.workspace_id = ? AND r.status = 'ACTIVE'`,
  ).bind(workspaceId).first<{
    id: string;
    submission_snapshot_id: string;
    submission_number: number;
    grade: "S" | "A" | "B" | "C";
    reason: string;
    granted_by_user_id: string;
    granted_by_name: string;
    granted_at: string;
  } & QueryResultRow>();
}

async function activeLease(db: DbClient, workspaceId: string) {
  return db.prepare(
    `SELECT l.id, l.holder_user_id, u.display_name AS holder_name,
      l.session_id, l.tab_token_hash, l.lease_version,
      l.last_heartbeat_at, l.expires_at
    FROM collaboration_edit_leases l
    INNER JOIN users u ON u.id = l.holder_user_id
    WHERE l.workspace_id = ? AND l.status = 'ACTIVE' AND l.expires_at > now()`,
  ).bind(workspaceId).first<LeaseReadRow>();
}

async function viewerRoles(db: DbClient, viewer?: V04ViewerContext) {
  if (!viewer) return { member: false, expert: false, systemAdmin: false };
  const rows = await db.prepare(
    `SELECT role_key FROM app_role_memberships
    WHERE user_id = ? AND status = 'ACTIVE'
      AND role_key IN ('EXPERT', 'SYSTEM_ADMIN')`,
  ).bind(viewer.actor.userId).all<{ role_key: "EXPERT" | "SYSTEM_ADMIN" } & QueryResultRow>();
  const roles = new Set(rows.results.map((row) => row.role_key));
  return {
    member: true,
    expert: roles.has("EXPERT"),
    systemAdmin: roles.has("SYSTEM_ADMIN"),
  };
}

async function viewerCapabilities(
  video: Pick<VideoReadRow, "created_by_user_id">,
  workspace: WorkspaceReadRow | null,
  lease: LeaseReadRow | null,
  publicationReady: boolean,
  roles: Awaited<ReturnType<typeof viewerRoles>>,
  viewer?: V04ViewerContext,
) {
  const tabHash = viewer?.tabToken?.trim()
    ? await hashToken(viewer.tabToken.trim())
    : null;
  const holdsLease = Boolean(
    viewer && lease && tabHash &&
    lease.holder_user_id === viewer.actor.userId &&
    lease.session_id === viewer.actor.sessionId &&
    lease.tab_token_hash === tabHash,
  );
  const uploader = Boolean(
    viewer && video.created_by_user_id &&
    video.created_by_user_id === viewer.actor.userId,
  );
  return {
    roles: {
      member: roles.member,
      uploader,
      expert: roles.expert,
      systemAdmin: roles.systemAdmin,
    },
    canRead: roles.member,
    canComment: roles.member && Boolean(workspace?.current_working_snapshot_id),
    canMaterialize: roles.member && !workspace,
    canAcquireLease: roles.member && Boolean(workspace) && !lease,
    canEdit: roles.member && holdsLease,
    canSubmit: roles.member && holdsLease && publicationReady,
    canExpertReview: roles.expert,
    canForceRelease: roles.systemAdmin && Boolean(lease),
  };
}

function valueText(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("、");
  if (value && typeof value === "object") {
    const choice = value as { selectedOptionIds?: unknown; customText?: unknown; advancedText?: unknown };
    if (Array.isArray(choice.selectedOptionIds)) {
      return [
        ...choice.selectedOptionIds.map(String),
        typeof choice.customText === "string" ? choice.customText : "",
        typeof choice.advancedText === "string" ? choice.advancedText : "",
      ].filter(Boolean).join("；");
    }
    return JSON.stringify(value);
  }
  return value == null ? "" : String(value);
}

export function resolveV04CommentTarget(payload: V04DraftPayloadV1, targetKey: string) {
  const shotMatch = targetKey.match(/^shot:([^.]+)\.([a-zA-Z][a-zA-Z0-9]*)$/);
  if (shotMatch && V04_SHOT_FIELD_KEYS.includes(shotMatch[2] as typeof V04_SHOT_FIELD_KEYS[number])) {
    const shot = payload.script.shotGroups.flatMap((group) => group.shots)
      .find((item) => item.id === shotMatch[1]);
    if (!shot) return null;
    return {
      moduleKey: "SCRIPT" as const,
      moduleLabel: "第一模块｜脚本反写",
      targetKey,
      value: valueText(shot[shotMatch[2] as typeof V04_SHOT_FIELD_KEYS[number]]),
    };
  }
  const groupMatch = targetKey.match(/^shotGroup:([^.]+)\.(bridgeName|primaryCreativeRole|auxiliaryCreativeRole|keyCreativeDescription|shots)$/);
  if (groupMatch) {
    const group = payload.script.shotGroups.find((item) => item.id === groupMatch[1]);
    if (!group) return null;
    return {
      moduleKey: "SCRIPT" as const,
      moduleLabel: "第一模块｜脚本反写",
      targetKey,
      value: valueText(group[groupMatch[2] as keyof typeof group]),
    };
  }
  const factsMatch = targetKey.match(/^facts\.([a-zA-Z][a-zA-Z0-9]*)(?:\.(advancedText|customText))?$/);
  if (factsMatch) {
    const fact = payload.factsAndCoreJudgement[
      factsMatch[1] as keyof typeof payload.factsAndCoreJudgement
    ];
    if (fact === undefined) return null;
    const nested = factsMatch[2] && fact && typeof fact === "object"
      ? (fact as unknown as Record<string, unknown>)[factsMatch[2]]
      : fact;
    if (nested === undefined) return null;
    return {
      moduleKey: "FACTS" as const,
      moduleLabel: "第二模块｜全片事实与核心判断",
      targetKey,
      value: valueText(nested),
    };
  }
  if (targetKey === "path.primaryType") {
    return {
      moduleKey: "PERCEPTION" as const,
      moduleLabel: "第三模块｜主导感知类型发生路径",
      targetKey,
      value: payload.perceptionPath.primaryType,
    };
  }
  const primaryPathMatch = targetKey.match(/^path\.primaryDetails\.([a-zA-Z][a-zA-Z0-9]*)$/);
  if (primaryPathMatch && Object.hasOwn(payload.perceptionPath.primaryDetails, primaryPathMatch[1])) {
    return {
      moduleKey: "PERCEPTION" as const,
      moduleLabel: "第三模块｜主导感知类型发生路径",
      targetKey,
      value: valueText(payload.perceptionPath.primaryDetails[primaryPathMatch[1]]),
    };
  }
  const auxiliaryPathMatch = targetKey.match(/^path\.auxiliary:([A-Z]+)\.(description|creativeRole)$/);
  if (auxiliaryPathMatch) {
    const item = payload.perceptionPath.auxiliaryTypes.find((entry) => entry.type === auxiliaryPathMatch[1]);
    if (!item) return null;
    return {
      moduleKey: "PERCEPTION" as const,
      moduleLabel: "第三模块｜主导感知类型发生路径",
      targetKey,
      value: valueText(item[auxiliaryPathMatch[2] as "description" | "creativeRole"]),
    };
  }
  return null;
}

async function commentTasks(db: DbClient, annotationId: string) {
  return (await db.prepare(
    `SELECT c.id, c.parent_id, c.target_key, c.target_label, c.selected_text,
      c.body, c.kind, c.workflow_status, c.author_name, c.created_at, c.updated_at
    FROM analysis_comments c
    INNER JOIN annotation_snapshots s ON s.id = c.submission_id
    WHERE s.annotation_id = ? AND s.workflow_version = ?
      AND c.deleted_at IS NULL AND c.parent_id IS NULL
    ORDER BY c.created_at ASC`,
  ).bind(annotationId, V04_WORKFLOW_VERSION).all<{
    id: string;
    parent_id: string | null;
    target_key: string;
    target_label: string;
    selected_text: string;
    body: string;
    kind: string;
    workflow_status: string;
    author_name: string;
    created_at: string;
    updated_at: string;
  } & QueryResultRow>()).results.map((row) => ({
    id: row.id,
    targetKey: row.target_key,
    targetLabel: row.target_label,
    selectedText: row.selected_text,
    body: row.body,
    kind: row.kind,
    status: row.workflow_status,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function submissionSummary(row: SubmissionReadRow | null | undefined) {
  return row ? {
    id: row.id,
    submissionNumber: Number(row.submission_number),
    sourceRevision: Number(row.source_revision),
    contentHash: row.content_hash,
    submittedByUserId: row.submitted_by_user_id,
    submittedByName: row.submitter_name,
    submittedAt: row.submitted_at,
  } : null;
}

function workflowFacts(
  payload: V04DraftPayloadV1,
  workspace: WorkspaceReadRow | null,
  rows: SubmissionReadRow[],
) {
  const latest = rows.at(-1) ?? null;
  const draftHash = workspace?.content_hash ?? hashV04Payload(payload);
  return {
    state: deriveV04WorkflowState({
      hasAnyDraftData: hasAnyV04DraftData(payload),
      currentDraftRevision: Number(workspace?.revision ?? 0),
      currentDraftContentHash: draftHash,
      successfulSubmissionCount: rows.length,
      latestSubmissionSourceRevision: latest ? Number(latest.source_revision) : null,
      latestSubmissionContentHash: latest?.content_hash ?? null,
    }),
    draftRevision: Number(workspace?.revision ?? 0),
    draftContentHash: draftHash,
    submissionCount: rows.length,
  };
}

function workflowFactsFromAggregate(
  payload: V04DraftPayloadV1,
  workspace: Pick<WorkspaceReadRow, "revision" | "content_hash"> | null,
  aggregate: {
    submissionCount: number;
    latestSourceRevision: number | null;
    latestContentHash: string | null;
  },
) {
  const draftHash = workspace?.content_hash ?? hashV04Payload(payload);
  return {
    state: deriveV04WorkflowState({
      hasAnyDraftData: hasAnyV04DraftData(payload),
      currentDraftRevision: Number(workspace?.revision ?? 0),
      currentDraftContentHash: draftHash,
      successfulSubmissionCount: aggregate.submissionCount,
      latestSubmissionSourceRevision: aggregate.latestSourceRevision,
      latestSubmissionContentHash: aggregate.latestContentHash,
    }),
    draftRevision: Number(workspace?.revision ?? 0),
    draftContentHash: draftHash,
    submissionCount: aggregate.submissionCount,
  };
}

export async function loadV04WorkspaceReadModel(
  db: DbClient,
  videoId: string,
  viewer?: V04ViewerContext,
) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  const payload = await currentPayload(db, workspace);
  const rows = workspace ? await submissions(db, workspace.id) : [];
  const [expert, lease, comments, roles] = workspace
    ? await Promise.all([
        activeExpert(db, workspace.id),
        activeLease(db, workspace.id),
        commentTasks(db, workspace.canonical_annotation_id),
        viewerRoles(db, viewer),
      ])
    : [null, null, [], await viewerRoles(db, viewer)];
  const facts = workflowFacts(payload, workspace, rows);
  const publication = validateV04Publication(payload);
  const capabilities = await viewerCapabilities(
    video,
    workspace,
    lease,
    publication.publicationReady,
    roles,
    viewer,
  );
  return {
    video: {
      id: video.id,
      title: video.title,
      brand: video.brand,
      description: video.description,
      tags: parseTags(video.tags_json),
      media: stableMediaReference(video),
    },
    logicalEmpty: !workspace,
    workspaceId: workspace?.id ?? null,
    roundId: workspace?.active_round_id ?? null,
    payload,
    ...facts,
    publication,
    latestSubmission: submissionSummary(rows.at(-1)),
    expertPreference: expert ? {
      id: expert.id,
      submissionId: expert.submission_snapshot_id,
      submissionNumber: Number(expert.submission_number),
      grade: expert.grade,
      reason: expert.reason,
      grantedByUserId: expert.granted_by_user_id,
      grantedByName: expert.granted_by_name,
      grantedAt: expert.granted_at,
    } : null,
    lease: lease ? {
      id: lease.id,
      holderUserId: lease.holder_user_id,
      holderName: lease.holder_name,
      leaseVersion: Number(lease.lease_version),
      lastHeartbeatAt: lease.last_heartbeat_at,
      expiresAt: lease.expires_at,
    } : null,
    lastSavedAt: workspace?.updated_at ?? null,
    commentTasks: comments,
    viewerCapabilities: capabilities,
  };
}

export async function loadV04CaseDetailReadModel(
  db: DbClient,
  videoId: string,
  viewer?: V04ViewerContext,
) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  if (!workspace) {
    const roles = await viewerRoles(db, viewer);
    return {
      video: {
        id: video.id,
        title: video.title,
        brand: video.brand,
        description: video.description,
        tags: parseTags(video.tags_json),
        media: stableMediaReference(video),
      },
      latestSubmission: null,
      expertPreferredSubmission: null,
      isSameVersion: false,
      availableSubmissionVersions: [],
      currentDraftStateSummary: { state: "NOT_STARTED" as const, draftRevision: 0 },
      viewerCapabilities: await viewerCapabilities(video, null, null, false, roles, viewer),
    };
  }
  const [rows, expert, payload, lease, roles] = await Promise.all([
    submissions(db, workspace.id),
    activeExpert(db, workspace.id),
    currentPayload(db, workspace),
    activeLease(db, workspace.id),
    viewerRoles(db, viewer),
  ]);
  const latest = rows.at(-1) ?? null;
  const expertSubmission = expert
    ? rows.find((row) => row.id === expert.submission_snapshot_id) ?? null
    : null;
  const facts = workflowFacts(payload, workspace, rows);
  const publication = validateV04Publication(payload);
  return {
    video: {
      id: video.id,
      title: video.title,
      brand: video.brand,
      description: video.description,
      tags: parseTags(video.tags_json),
      media: stableMediaReference(video),
    },
    latestSubmission: latest ? {
      ...submissionSummary(latest)!,
      payload: parseJson<V04DraftPayloadV1>(latest.payload_json),
    } : null,
    expertPreferredSubmission: expert && expertSubmission ? {
      ...submissionSummary(expertSubmission)!,
      payload: parseJson<V04DraftPayloadV1>(expertSubmission.payload_json),
      expertReleaseId: expert.id,
      grade: expert.grade,
      reason: expert.reason,
    } : null,
    isSameVersion: Boolean(latest && expertSubmission && latest.id === expertSubmission.id),
    availableSubmissionVersions: rows.map(submissionSummary),
    currentDraftStateSummary: { state: facts.state, draftRevision: facts.draftRevision },
    viewerCapabilities: await viewerCapabilities(
      video,
      workspace,
      lease,
      publication.publicationReady,
      roles,
      viewer,
    ),
  };
}

export async function loadV04CaseCardReadModel(
  db: DbClient,
  videoId: string,
  viewer?: V04ViewerContext,
) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  const payload = await currentPayload(db, workspace);
  const rows = workspace ? await submissions(db, workspace.id) : [];
  const [expert, lease, roles] = workspace
    ? await Promise.all([
        activeExpert(db, workspace.id),
        activeLease(db, workspace.id),
        viewerRoles(db, viewer),
      ])
    : [null, null, await viewerRoles(db, viewer)];
  const facts = workflowFacts(payload, workspace, rows);
  const publication = validateV04Publication(payload);
  return {
    id: video.id,
    title: video.title,
    brand: video.brand,
    description: video.description,
    tags: parseTags(video.tags_json),
    thumbnailKey: video.thumbnail_key,
    originalName: video.original_name,
    fileSize: Number(video.file_size),
    status: video.status,
    createdByName: video.created_by_name,
    createdAt: video.created_at,
    media: stableMediaReference(video),
    ...facts,
    latestSubmission: submissionSummary(rows.at(-1)),
    expertPreference: expert ? {
      submissionId: expert.submission_snapshot_id,
      submissionNumber: Number(expert.submission_number),
      grade: expert.grade,
      grantedAt: expert.granted_at,
    } : null,
    currentEditor: lease ? {
      userId: lease.holder_user_id,
      displayName: lease.holder_name,
      expiresAt: lease.expires_at,
    } : null,
    viewerCapabilities: await viewerCapabilities(
      video,
      workspace,
      lease,
      publication.publicationReady,
      roles,
      viewer,
    ),
  };
}

type BatchCardProjectionRow = QueryResultRow & {
  video_id: string;
  created_by_user_id: string | null;
  workspace_id: string | null;
  canonical_annotation_id: string | null;
  active_round_id: string | null;
  current_working_snapshot_id: string | null;
  latest_submission_snapshot_id: string | null;
  active_expert_release_id: string | null;
  workspace_updated_at: string | null;
  draft_revision: number | null;
  draft_content_hash: string | null;
  draft_payload_json: V04DraftPayloadV1 | string | null;
  submission_count: number;
  latest_submission_id: string | null;
  latest_submission_number: number | null;
  latest_source_revision: number | null;
  latest_content_hash: string | null;
  latest_submitted_by_user_id: string | null;
  latest_submitter_name: string | null;
  latest_submitted_at: string | null;
  expert_submission_id: string | null;
  expert_submission_number: number | null;
  expert_grade: "S" | "A" | "B" | "C" | null;
  expert_granted_at: string | null;
  lease_id: string | null;
  lease_holder_user_id: string | null;
  lease_holder_name: string | null;
  lease_session_id: string | null;
  lease_tab_token_hash: string | null;
  lease_version: number | null;
  lease_last_heartbeat_at: string | null;
  lease_expires_at: string | null;
};

/**
 * Projects V0.4 state and capabilities onto video IDs supplied by the existing
 * video library. This deliberately does not return titles, tags, thumbnails or
 * media metadata: `/api/videos` remains the sole case-catalog source.
 */
export async function loadV04CaseCardsReadModel(
  db: DbClient,
  videoIds: string[],
  viewer: V04ViewerContext,
) {
  const uniqueVideoIds = [...new Set(videoIds.map((item) => item.trim()).filter(Boolean))];
  if (!uniqueVideoIds.length) return { projections: [] };
  const placeholders = uniqueVideoIds.map(() => "?").join(", ");
  const [roles, result] = await Promise.all([
    viewerRoles(db, viewer),
    db.prepare(
      `SELECT v.id AS video_id, v.created_by_user_id,
        w.id AS workspace_id, w.canonical_annotation_id, w.active_round_id,
        w.current_working_snapshot_id, w.latest_submission_snapshot_id,
        w.active_expert_release_id, w.updated_at AS workspace_updated_at,
        a.revision AS draft_revision, a.content_hash AS draft_content_hash,
        working.payload_json AS draft_payload_json,
        COALESCE(submission_stats.submission_count, 0) AS submission_count,
        latest.id AS latest_submission_id,
        latest.submission_number AS latest_submission_number,
        latest.source_revision AS latest_source_revision,
        latest.content_hash AS latest_content_hash,
        latest.submitted_by_user_id AS latest_submitted_by_user_id,
        latest_user.display_name AS latest_submitter_name,
        latest.submitted_at AS latest_submitted_at,
        expert.submission_snapshot_id AS expert_submission_id,
        expert_submission.submission_number AS expert_submission_number,
        expert.grade AS expert_grade, expert.granted_at AS expert_granted_at,
        lease.id AS lease_id, lease.holder_user_id AS lease_holder_user_id,
        lease_user.display_name AS lease_holder_name,
        lease.session_id AS lease_session_id,
        lease.tab_token_hash AS lease_tab_token_hash,
        lease.lease_version, lease.last_heartbeat_at AS lease_last_heartbeat_at,
        lease.expires_at AS lease_expires_at
      FROM videos v
      LEFT JOIN collaboration_workspaces w
        ON w.video_id = v.id AND w.workflow_version = ? AND w.status = 'ACTIVE'
      LEFT JOIN annotations a ON a.id = w.canonical_annotation_id
      LEFT JOIN annotation_snapshots working ON working.id = w.current_working_snapshot_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS submission_count
        FROM annotation_submission_snapshots item WHERE item.workspace_id = w.id
      ) submission_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT item.id, item.submission_number, item.source_revision,
          item.content_hash, item.submitted_by_user_id, item.submitted_at
        FROM annotation_submission_snapshots item
        WHERE item.workspace_id = w.id
        ORDER BY item.submission_number DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN users latest_user ON latest_user.id = latest.submitted_by_user_id
      LEFT JOIN expert_analysis_releases expert
        ON expert.id = w.active_expert_release_id AND expert.status = 'ACTIVE'
      LEFT JOIN annotation_submission_snapshots expert_submission
        ON expert_submission.id = expert.submission_snapshot_id
      LEFT JOIN collaboration_edit_leases lease
        ON lease.workspace_id = w.id AND lease.status = 'ACTIVE' AND lease.expires_at > now()
      LEFT JOIN users lease_user ON lease_user.id = lease.holder_user_id
      WHERE v.id IN (${placeholders})
        AND v.deleted_at IS NULL
        AND COALESCE(v.deletion_state, 'ACTIVE') NOT IN ('TRASHED', 'ASSET_PURGED')
      ORDER BY v.id ASC`,
    ).bind(V04_WORKFLOW_VERSION, ...uniqueVideoIds).all<BatchCardProjectionRow>(),
  ]);

  const byVideoId = new Map(result.results.map((row) => [row.video_id, row]));
  const rowsInInputOrder = uniqueVideoIds.flatMap((videoId) => {
    const row = byVideoId.get(videoId);
    return row ? [row] : [];
  });
  const projections = await Promise.all(rowsInInputOrder.map(async (row) => {
    const payload = row.draft_payload_json
      ? parseJson<V04DraftPayloadV1>(row.draft_payload_json)
      : emptyV04DraftPayload();
    assertV04PayloadContract(payload);
    const workspace = row.workspace_id ? {
      id: row.workspace_id,
      video_id: row.video_id,
      canonical_annotation_id: row.canonical_annotation_id ?? "",
      active_round_id: row.active_round_id,
      current_working_snapshot_id: row.current_working_snapshot_id,
      latest_submission_snapshot_id: row.latest_submission_snapshot_id,
      active_expert_release_id: row.active_expert_release_id,
      revision: Number(row.draft_revision ?? 0),
      content_hash: row.draft_content_hash,
      updated_at: row.workspace_updated_at ?? "",
    } satisfies WorkspaceReadRow : null;
    const lease = row.lease_id ? {
      id: row.lease_id,
      holder_user_id: row.lease_holder_user_id ?? "",
      holder_name: row.lease_holder_name ?? "",
      session_id: row.lease_session_id ?? "",
      tab_token_hash: row.lease_tab_token_hash ?? "",
      lease_version: Number(row.lease_version ?? 0),
      last_heartbeat_at: row.lease_last_heartbeat_at ?? "",
      expires_at: row.lease_expires_at ?? "",
    } satisfies LeaseReadRow : null;
    const aggregate = {
      submissionCount: Number(row.submission_count ?? 0),
      latestSourceRevision: row.latest_source_revision == null
        ? null
        : Number(row.latest_source_revision),
      latestContentHash: row.latest_content_hash,
    };
    const facts = workflowFactsFromAggregate(payload, workspace, aggregate);
    const publication = validateV04Publication(payload);
    return {
      videoId: row.video_id,
      ...facts,
      latestSubmission: row.latest_submission_id ? {
        id: row.latest_submission_id,
        submissionNumber: Number(row.latest_submission_number),
        sourceRevision: Number(row.latest_source_revision),
        contentHash: row.latest_content_hash ?? "",
        submittedByUserId: row.latest_submitted_by_user_id ?? "",
        submittedByName: row.latest_submitter_name ?? "",
        submittedAt: row.latest_submitted_at ?? "",
      } : null,
      expertPreference: row.expert_submission_id ? {
        submissionId: row.expert_submission_id,
        submissionNumber: Number(row.expert_submission_number),
        grade: row.expert_grade,
        grantedAt: row.expert_granted_at,
      } : null,
      currentEditor: lease ? {
        userId: lease.holder_user_id,
        displayName: lease.holder_name,
        expiresAt: lease.expires_at,
      } : null,
      viewerCapabilities: await viewerCapabilities(
        { created_by_user_id: row.created_by_user_id },
        workspace,
        lease,
        publication.publicationReady,
        roles,
        viewer,
      ),
    };
  }));
  return { projections };
}

export async function loadV04HistoryReadModel(
  db: DbClient,
  videoId: string,
  viewer?: V04ViewerContext,
) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  if (!workspace) {
    const roles = await viewerRoles(db, viewer);
    return {
      workspaceId: null,
      state: "NOT_STARTED" as const,
      sessions: [],
      events: [],
      viewerCapabilities: await viewerCapabilities(video, null, null, false, roles, viewer),
    };
  }

  const [baselines, working, submissionRows, releases, revisions, comments, payload, rows] = await Promise.all([
    db.prepare(
      `SELECT id, source_kind, source_object_type, source_object_id, content_hash,
        created_by_user_id AS actor_user_id, created_at
      FROM collaboration_baselines WHERE workspace_id = ?`,
    ).bind(workspace.id).all<QueryResultRow>(),
    db.prepare(
      `SELECT id, revision, content_hash, created_by_user_id AS actor_user_id, created_at
      FROM annotation_snapshots
      WHERE annotation_id = ? AND workflow_version = ? AND snapshot_kind = 'WORKING'`,
    ).bind(workspace.canonical_annotation_id, V04_WORKFLOW_VERSION).all<QueryResultRow>(),
    db.prepare(
      `SELECT id, submission_number, source_revision, content_hash,
        submitted_by_user_id AS actor_user_id, submitted_at AS created_at
      FROM annotation_submission_snapshots WHERE workspace_id = ?`,
    ).bind(workspace.id).all<QueryResultRow>(),
    db.prepare(
      `SELECT id, submission_snapshot_id, grade, status,
        granted_by_user_id AS actor_user_id, granted_at AS created_at,
        ended_by_user_id, ended_at
      FROM expert_analysis_releases WHERE workspace_id = ?`,
    ).bind(workspace.id).all<QueryResultRow>(),
    db.prepare(
      `SELECT id, applied_revision, target_key, target_label_snapshot,
        source_kind, source_object_type, source_object_id, actor_user_id,
        actor_name_snapshot, created_at
      FROM collaboration_revision_events WHERE workspace_id = ?`,
    ).bind(workspace.id).all<QueryResultRow>(),
    db.prepare(
      `SELECT c.id, c.target_key, c.target_label, c.kind, c.workflow_status,
        c.author_name AS actor_name_snapshot, c.created_at
      FROM analysis_comments c
      INNER JOIN annotation_snapshots s ON s.id = c.submission_id
      WHERE s.annotation_id = ? AND s.workflow_version = ? AND c.deleted_at IS NULL`,
    ).bind(workspace.canonical_annotation_id, V04_WORKFLOW_VERSION).all<QueryResultRow>(),
    currentPayload(db, workspace),
    submissions(db, workspace.id),
  ]);
  const events: Array<QueryResultRow & { createdAt: string; eventType: string }> = [
    ...baselines.results.map((row) => ({ ...row, createdAt: String(row.created_at), eventType: "INITIAL_BASELINE" })),
    ...working.results.map((row) => ({ ...row, createdAt: String(row.created_at), eventType: "WORKING_SESSION" })),
    ...submissionRows.results.map((row) => ({ ...row, createdAt: String(row.created_at), eventType: "SUBMISSION" })),
    ...releases.results.map((row) => ({ ...row, createdAt: String(row.created_at), eventType: "EXPERT" })),
    ...revisions.results.map((row) => ({
      ...row,
      createdAt: String(row.created_at),
      eventType: row.source_kind === "HISTORY_RESTORE" ? "RESTORE" : "REVISION",
    })),
    ...comments.results.map((row) => ({
      ...row,
      createdAt: String(row.created_at),
      eventType: "COMMENT",
    })),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const sessions: Array<{
    actorUserId: string | null;
    actorName: string;
    startedAt: string;
    endedAt: string;
    eventIds: string[];
  }> = [];
  for (const event of events) {
    const actorUserId = typeof event.actor_user_id === "string" ? event.actor_user_id : null;
    const actorName = typeof event.actor_name_snapshot === "string"
      ? event.actor_name_snapshot
      : actorUserId ?? "系统";
    const last = sessions.at(-1);
    if (
      last && last.actorUserId === actorUserId &&
      Date.parse(event.createdAt) - Date.parse(last.endedAt) <= 30 * 60 * 1000
    ) {
      last.endedAt = event.createdAt;
      last.eventIds.push(String(event.id));
    } else {
      sessions.push({
        actorUserId,
        actorName,
        startedAt: event.createdAt,
        endedAt: event.createdAt,
        eventIds: [String(event.id)],
      });
    }
  }
  const [lease, roles] = await Promise.all([
    activeLease(db, workspace.id),
    viewerRoles(db, viewer),
  ]);
  const publication = validateV04Publication(payload);
  return {
    workspaceId: workspace.id,
    state: workflowFacts(payload, workspace, rows).state,
    sessions,
    events,
    viewerCapabilities: await viewerCapabilities(
      video,
      workspace,
      lease,
      publication.publicationReady,
      roles,
      viewer,
    ),
  };
}
