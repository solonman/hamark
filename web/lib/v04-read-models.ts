import type { DbClient, QueryResultRow } from "@/db";
import {
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
      original_name, file_size, status, created_by_name, created_by_user_id,
      created_at, deleted_at, deletion_state
    FROM videos WHERE id = ?`,
  ).bind(videoId).first<{
    id: string;
    title: string;
    brand: string;
    description: string;
    tags_json: string;
    thumbnail_key: string | null;
    original_name: string;
    file_size: number;
    status: string;
    created_by_name: string;
    created_by_user_id: string | null;
    created_at: string;
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
    `SELECT r.id, r.submission_snapshot_id, r.grade, r.reason,
      r.granted_by_user_id, u.display_name AS granted_by_name, r.granted_at
    FROM expert_analysis_releases r
    INNER JOIN users u ON u.id = r.granted_by_user_id
    WHERE r.workspace_id = ? AND r.status = 'ACTIVE'`,
  ).bind(workspaceId).first<{
    id: string;
    submission_snapshot_id: string;
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
      l.lease_version, l.last_heartbeat_at, l.expires_at
    FROM collaboration_edit_leases l
    INNER JOIN users u ON u.id = l.holder_user_id
    WHERE l.workspace_id = ? AND l.status = 'ACTIVE' AND l.expires_at > now()`,
  ).bind(workspaceId).first<{
    id: string;
    holder_user_id: string;
    holder_name: string;
    lease_version: number;
    last_heartbeat_at: string;
    expires_at: string;
  } & QueryResultRow>();
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

export async function loadV04WorkspaceReadModel(db: DbClient, videoId: string) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  const payload = await currentPayload(db, workspace);
  const rows = workspace ? await submissions(db, workspace.id) : [];
  const [expert, lease, comments] = workspace
    ? await Promise.all([
        activeExpert(db, workspace.id),
        activeLease(db, workspace.id),
        commentTasks(db, workspace.canonical_annotation_id),
      ])
    : [null, null, []];
  const facts = workflowFacts(payload, workspace, rows);
  const publication = validateV04Publication(payload);
  return {
    video: {
      id: video.id,
      title: video.title,
      brand: video.brand,
      description: video.description,
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
  };
}

export async function loadV04CaseDetailReadModel(db: DbClient, videoId: string) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  if (!workspace) {
    return {
      video: { id: video.id, title: video.title, brand: video.brand, description: video.description },
      latestSubmission: null,
      expertPreferredSubmission: null,
      isSameVersion: false,
      availableSubmissionVersions: [],
      currentDraftStateSummary: { state: "NOT_STARTED" as const, draftRevision: 0 },
    };
  }
  const [rows, expert, payload] = await Promise.all([
    submissions(db, workspace.id),
    activeExpert(db, workspace.id),
    currentPayload(db, workspace),
  ]);
  const latest = rows.at(-1) ?? null;
  const expertSubmission = expert
    ? rows.find((row) => row.id === expert.submission_snapshot_id) ?? null
    : null;
  const facts = workflowFacts(payload, workspace, rows);
  return {
    video: { id: video.id, title: video.title, brand: video.brand, description: video.description },
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
  };
}

export async function loadV04CaseCardReadModel(db: DbClient, videoId: string) {
  const video = await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  const payload = await currentPayload(db, workspace);
  const rows = workspace ? await submissions(db, workspace.id) : [];
  const [expert, lease] = workspace
    ? await Promise.all([activeExpert(db, workspace.id), activeLease(db, workspace.id)])
    : [null, null];
  const facts = workflowFacts(payload, workspace, rows);
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(video.tags_json);
    if (Array.isArray(parsed)) tags = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    tags = [];
  }
  return {
    id: video.id,
    title: video.title,
    brand: video.brand,
    description: video.description,
    tags,
    thumbnailKey: video.thumbnail_key,
    originalName: video.original_name,
    fileSize: Number(video.file_size),
    status: video.status,
    createdByName: video.created_by_name,
    createdAt: video.created_at,
    ...facts,
    latestSubmission: submissionSummary(rows.at(-1)),
    expertPreference: expert ? {
      submissionId: expert.submission_snapshot_id,
      grade: expert.grade,
      grantedAt: expert.granted_at,
    } : null,
    currentEditor: lease ? {
      userId: lease.holder_user_id,
      displayName: lease.holder_name,
      expiresAt: lease.expires_at,
    } : null,
  };
}

export async function loadV04HistoryReadModel(db: DbClient, videoId: string) {
  await getVideo(db, videoId);
  const workspace = await workspaceRow(db, videoId);
  if (!workspace) return {
    workspaceId: null,
    state: "NOT_STARTED" as const,
    sessions: [],
    events: [],
  };

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
  return {
    workspaceId: workspace.id,
    state: workflowFacts(payload, workspace, rows).state,
    sessions,
    events,
  };
}
