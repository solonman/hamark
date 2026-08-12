import { getDbClient } from "@/db";
import { requireApiUser } from "@/lib/current-user";
import type {
  AnalysisComment,
  AnalysisCommentKind,
  AnalysisCommentStatus,
  AnalysisRevisionSuggestion,
  AnalysisRevisionSuggestionStatus,
  RevisionEditType,
  RevisionValueType,
  VocabularyVersion,
} from "@/lib/types";

function parseValue(value: string | null) {
  if (!value) return undefined;
  try { return JSON.parse(value) as string | string[]; } catch { return undefined; }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ releaseId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { releaseId } = await context.params;
  const db = getDbClient();
  const release = await db.prepare(
    `SELECT r.id, r.annotation_id, r.source_snapshot_id, r.source_review_round_id,
      r.approved_snapshot_id, r.status, round.round_number,
      round.status AS round_status, round.reviewer_name,
      round.decision_note, round.decided_at
    FROM approved_analysis_releases r
    INNER JOIN videos v ON v.id = r.video_id
    INNER JOIN analysis_review_rounds round ON round.id = r.source_review_round_id
    WHERE r.id = ? AND v.deleted_at IS NULL`,
  ).bind(releaseId).first<{
    id: string; annotation_id: string; source_snapshot_id: string; source_review_round_id: string;
    approved_snapshot_id: string; status: string;
    round_number: number; round_status: string; reviewer_name: string | null;
    decision_note: string | null; decided_at: string | null;
  }>();
  if (!release) return Response.json({ error: "标准版本不存在。" }, { status: 404 });
  const [rounds, events, comments] = await Promise.all([
    db.prepare(
      `SELECT id, round_number, status, reviewer_name, decision_note,
        created_at, decided_at
      FROM analysis_review_rounds
      WHERE annotation_id = ? AND round_number <= ?
      ORDER BY round_number ASC`,
    ).bind(release.annotation_id, release.round_number).all<Record<string, string | number | null>>(),
    db.prepare(
      `SELECT id, review_round_id, base_snapshot_id, actor_name, actor_role, edit_type,
        target_key, target_label, original_text, anchor_start, anchor_end,
        replacement_text, COALESCE(reason, '') AS reason, status,
        applied_revision, linked_comment_id, original_text_hash, value_type,
        original_value_json, replacement_value_json, vocabulary_version,
        change_set_id, created_at, updated_at
      FROM analysis_revision_events
      WHERE review_round_id IN (
        SELECT id FROM analysis_review_rounds
        WHERE annotation_id = ? AND round_number <= ?
      ) AND status = 'APPLIED'
      ORDER BY created_at ASC`,
    ).bind(release.annotation_id, release.round_number).all<Record<string, string | number | null>>(),
    db.prepare(
      `SELECT id, review_round_id, submission_id, parent_id, author_name, target_key,
        target_label, selected_text, anchor_start, anchor_end, body, kind,
        workflow_status, linked_revision_event_id, final_conclusion,
        resolved_by_name, created_at, updated_at
      FROM analysis_comments
      WHERE review_round_id IN (
        SELECT id FROM analysis_review_rounds
        WHERE annotation_id = ? AND round_number <= ?
      ) AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    ).bind(release.annotation_id, release.round_number).all<Record<string, string | number | null>>(),
  ]);
  const mappedComments = comments.results.map((row) => ({
    id: String(row.id),
    reviewRoundId: String(row.review_round_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    submissionId: String(row.submission_id),
    targetKey: String(row.target_key),
    targetLabel: String(row.target_label),
    selectedText: String(row.selected_text ?? ""),
    anchorStart: Number(row.anchor_start),
    anchorEnd: Number(row.anchor_end),
    body: String(row.body),
    authorName: String(row.author_name),
    kind: String(row.kind) as AnalysisCommentKind,
    status: String(row.workflow_status) as AnalysisCommentStatus,
    isExcellent: false,
    markedByName: null,
    resolvedByName: row.resolved_by_name ? String(row.resolved_by_name) : null,
    finalConclusion: row.final_conclusion ? String(row.final_conclusion) : null,
    linkedRevisionEventId: row.linked_revision_event_id ? String(row.linked_revision_event_id) : null,
    handledInSnapshotId: null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    canResolve: false,
    replies: [],
  }));
  const rootComments: AnalysisComment[] = mappedComments
    .filter((comment) => !comment.parentId)
    .map((comment) => ({
      ...comment,
      replies: mappedComments
        .filter((reply) => reply.parentId === comment.id)
        .map((reply) => ({
          id: reply.id,
          authorName: reply.authorName,
          body: reply.body,
          kind: reply.kind,
          createdAt: reply.createdAt,
        })),
    }));
  return Response.json({
    releaseId,
    sourceSnapshotId: release.source_snapshot_id,
    approvedSnapshotId: release.approved_snapshot_id,
    reviewRounds: rounds.results.map((row) => ({
      id: String(row.id),
      roundNumber: Number(row.round_number),
      status: String(row.status),
      reviewerName: row.reviewer_name ? String(row.reviewer_name) : null,
      decisionNote: row.decision_note ? String(row.decision_note) : null,
      createdAt: String(row.created_at),
      decidedAt: row.decided_at ? String(row.decided_at) : null,
    })),
    reviewRound: {
      id: release.source_review_round_id,
      roundNumber: Number(release.round_number),
      status: release.round_status,
      reviewerName: release.reviewer_name,
      decisionNote: release.decision_note,
      decidedAt: release.decided_at,
    },
    revisions: events.results.map((row) => ({
      id: String(row.id),
      reviewRoundId: String(row.review_round_id),
      submissionId: String(row.base_snapshot_id),
      targetKey: String(row.target_key),
      targetLabel: String(row.target_label),
      selectedText: String(row.original_text ?? ""),
      anchorStart: Number(row.anchor_start),
      anchorEnd: Number(row.anchor_end),
      replacementText: String(row.replacement_text ?? ""),
      reason: String(row.reason ?? ""),
      authorName: String(row.actor_name),
      actorRole: String(row.actor_role) as "AUTHOR" | "FINAL_REVIEWER",
      editType: String(row.edit_type) as RevisionEditType,
      valueType: String(row.value_type) as RevisionValueType,
      originalValue: parseValue(row.original_value_json as string | null),
      replacementValue: parseValue(row.replacement_value_json as string | null),
      vocabularyVersion: String(row.vocabulary_version) as VocabularyVersion,
      changeSetId: row.change_set_id ? String(row.change_set_id) : null,
      originalTextHash: String(row.original_text_hash ?? ""),
      linkedCommentId: row.linked_comment_id ? String(row.linked_comment_id) : null,
      status: String(row.status) as AnalysisRevisionSuggestionStatus,
      appliedRevision: Number(row.applied_revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      decidedByName: null,
      canDecide: false,
    })) satisfies AnalysisRevisionSuggestion[],
    comments: rootComments,
  });
}
