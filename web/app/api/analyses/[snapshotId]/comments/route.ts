import { getDbClient } from "@/db";
import {
  COMMENT_QUOTE_MAX_LENGTH,
  COMMENT_TARGET_MAX_LENGTH,
  normalizeCommentTarget,
  normalizeCommentText,
  validateCommentBody,
} from "@/lib/analysis-comments";
import { isAppAdmin, isFinalReviewer } from "@/lib/admin";
import { analysisTargetValue } from "@/lib/analysis-targets";
import { ensureReviewRoundForSnapshot } from "@/lib/review-workflow";
import {
  newId,
  requireApiUser,
  requireSameOriginMutation,
} from "@/lib/current-user";
import type {
  AnalysisComment,
  AnalysisCommentKind,
  AnalysisCommentReply,
} from "@/lib/types";

type SnapshotRow = {
  id: string;
  annotation_id: string;
  video_id: string;
  author_email: string;
  taxonomy_version: string;
  payload_json: string;
};

type CommentRow = {
  id: string;
  submission_id: string;
  parent_id: string | null;
  author_email: string;
  author_name: string;
  target_key: string;
  target_label: string;
  selected_text: string;
  anchor_start: number;
  anchor_end: number;
  body: string;
  kind: AnalysisCommentKind;
  status: "OPEN" | "AUTHOR_MARKED_HANDLED" | "RESOLVED" | "REOPENED";
  is_excellent: number;
  marked_by_name: string | null;
  resolved_by_name: string | null;
  final_conclusion: string | null;
  linked_revision_event_id: string | null;
  handled_in_snapshot_id: string | null;
  created_at: string;
  updated_at: string;
};

async function loadSnapshot(snapshotId: string) {
  return getDbClient()
    .prepare(
      `SELECT s.id, s.annotation_id, s.video_id, s.author_email,
        s.taxonomy_version, s.payload_json
      FROM annotation_snapshots s
      INNER JOIN videos v ON v.id = s.video_id
      WHERE s.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  }

  const [result, admin] = await Promise.all([
    getDbClient()
      .prepare(
        `SELECT id, submission_id, parent_id, author_email, author_name,
          target_key, target_label, selected_text, anchor_start, anchor_end,
          body, kind,
          CASE WHEN ? = 'V0.3-PILOT' THEN workflow_status ELSE status END AS status,
          is_excellent, marked_by_name, resolved_by_name, final_conclusion,
          linked_revision_event_id, handled_in_snapshot_id, created_at, updated_at
        FROM analysis_comments c
        WHERE c.deleted_at IS NULL AND (
          c.submission_id = ? OR (
            ? = 'V0.3-PILOT' AND EXISTS (
              SELECT 1 FROM annotation_snapshots linked_snapshot
              WHERE linked_snapshot.id = c.submission_id
                AND linked_snapshot.annotation_id = ?
            )
          )
        )
        ORDER BY created_at ASC`,
      )
      .bind(
        snapshot.taxonomy_version,
        snapshotId,
        snapshot.taxonomy_version,
        snapshot.annotation_id,
      )
      .all<CommentRow>(),
    isAppAdmin(user),
  ]);

  const replies = new Map<string, AnalysisCommentReply[]>();
  for (const row of result.results) {
    if (!row.parent_id) continue;
    const current = replies.get(row.parent_id) ?? [];
    current.push({
      id: row.id,
      authorName: row.author_name,
      body: row.body,
      kind: row.kind,
      createdAt: row.created_at,
    });
    replies.set(row.parent_id, current);
  }

  const comments: AnalysisComment[] = result.results
    .filter((row) => !row.parent_id)
    .map((row) => ({
      id: row.id,
      submissionId: row.submission_id,
      targetKey: row.target_key,
      targetLabel: row.target_label,
      selectedText: row.selected_text,
      anchorStart: Number(row.anchor_start),
      anchorEnd: Number(row.anchor_end),
      body: row.body,
      authorName: row.author_name,
      kind: row.kind,
      status: row.status,
      isExcellent: Boolean(row.is_excellent),
      markedByName: row.marked_by_name,
      resolvedByName: row.resolved_by_name,
      finalConclusion: row.final_conclusion,
      linkedRevisionEventId: row.linked_revision_event_id,
      handledInSnapshotId: row.handled_in_snapshot_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canResolve:
        snapshot.taxonomy_version === "V0.3-PILOT"
          ? admin
          : admin ||
            row.author_email === user.identityKey ||
            snapshot.author_email === user.identityKey,
      canMarkHandled:
        snapshot.taxonomy_version === "V0.3-PILOT" &&
        snapshot.author_email === user.identityKey &&
        row.status !== "RESOLVED",
      replies: replies.get(row.id) ?? [],
    }));

  return Response.json({ comments, isAdmin: admin });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  }
  if (snapshot.taxonomy_version === "V0.2") {
    return Response.json(
      { error: "V0.2 已归档为历史体系，批注记录只读保留。" },
      { status: 409 },
    );
  }

  const payload = (await request.json()) as {
    parentId?: unknown;
    targetKey?: unknown;
    targetLabel?: unknown;
    selectedText?: unknown;
    anchorStart?: unknown;
    anchorEnd?: unknown;
    body?: unknown;
    kind?: unknown;
  };
  const { body, error } = validateCommentBody(payload.body);
  if (error) return Response.json({ error }, { status: 400 });

  const db = getDbClient();
  const parentId = normalizeCommentText(payload.parentId, 100);
  let targetKey = normalizeCommentTarget(payload.targetKey);
  let targetLabel = normalizeCommentText(
    payload.targetLabel,
    COMMENT_TARGET_MAX_LENGTH,
  );
  let selectedText = normalizeCommentText(
    payload.selectedText,
    COMMENT_QUOTE_MAX_LENGTH,
  );
  let anchorStart = Number.isInteger(payload.anchorStart)
    ? Number(payload.anchorStart)
    : -1;
  let anchorEnd = Number.isInteger(payload.anchorEnd)
    ? Number(payload.anchorEnd)
    : -1;

  if (parentId) {
    const parent = await db
      .prepare(
        `SELECT id, target_key, target_label, selected_text, anchor_start, anchor_end
        FROM analysis_comments parent_comment
        WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL
          AND (
            submission_id = ? OR (
              ? = 'V0.3-PILOT' AND EXISTS (
                SELECT 1 FROM annotation_snapshots parent_snapshot
                WHERE parent_snapshot.id = parent_comment.submission_id
                  AND parent_snapshot.annotation_id = ?
              )
            )
          )`,
      )
      .bind(
        parentId,
        snapshotId,
        snapshot.taxonomy_version,
        snapshot.annotation_id,
      )
      .first<{
        id: string;
        target_key: string;
        target_label: string;
        selected_text: string;
        anchor_start: number;
        anchor_end: number;
      }>();
    if (!parent) {
      return Response.json({ error: "原批注不存在。" }, { status: 404 });
    }
    targetKey = parent.target_key;
    targetLabel = parent.target_label;
    selectedText = parent.selected_text;
    anchorStart = Number(parent.anchor_start);
    anchorEnd = Number(parent.anchor_end);
  } else if (!targetKey) {
    return Response.json({ error: "请选择需要批注的内容。" }, { status: 400 });
  } else if (selectedText) {
    const targetValue = analysisTargetValue(
      JSON.parse(snapshot.payload_json),
      targetKey,
    );
    if (
      targetValue == null ||
      anchorStart < 0 ||
      anchorEnd < anchorStart ||
      targetValue.slice(anchorStart, anchorEnd) !== selectedText
    ) {
      return Response.json(
        { error: "所选文字已变化，请重新选中后批注。" },
        { status: 409 },
      );
    }
  } else {
    anchorStart = -1;
    anchorEnd = -1;
  }

  const admin = await isAppAdmin(user);
  const finalReviewer = await isFinalReviewer(user);
  let reviewRoundId: string | null = null;
  if (snapshot.taxonomy_version === "V0.3-PILOT") {
    if (!parentId && !finalReviewer) {
      return Response.json(
        { error: "当前体系的正式批注由终审者发起；作者可回复并处理批注。" },
        { status: 403 },
      );
    }
    if (parentId && !finalReviewer && snapshot.author_email !== user.identityKey) {
      return Response.json({ error: "只有作者或终审者可以回复批注。" }, { status: 403 });
    }
    const annotationState = await db.prepare(
      `SELECT review_status, active_base_snapshot_id FROM annotations WHERE id = ?`,
    ).bind(snapshot.annotation_id).first<{
      review_status: string; active_base_snapshot_id: string | null;
    }>();
    if (
      annotationState?.review_status === "APPROVED" &&
      annotationState.active_base_snapshot_id === snapshotId
    ) {
      return Response.json(
        { error: "该版本已经批准入库；请从标准版建立新草稿后再开启审核。" },
        { status: 409 },
      );
    }
    const round = await ensureReviewRoundForSnapshot(db, {
      annotationId: snapshot.annotation_id,
      videoId: snapshot.video_id,
      snapshotId,
    });
    reviewRoundId = round.id;
    const state = await db
      .prepare(`SELECT status FROM analysis_review_rounds WHERE id = ?`)
      .bind(round.id)
      .first<{ status: string }>();
    if (!state || !["PENDING", "IN_REVIEW"].includes(state.status)) {
      return Response.json({ error: "当前审核轮次已经结束。" }, { status: 409 });
    }
  }
  const requestedKind = payload.kind === "EXPERT_NOTE" ? "EXPERT_NOTE" : "COMMENT";
  if (requestedKind === "EXPERT_NOTE" && !admin) {
    return Response.json({ error: "只有管理员可以添加专家精修意见。" }, { status: 403 });
  }

  const commentId = newId("comment");
  await db
    .prepare(
      `INSERT INTO analysis_comments (
        id, submission_id, video_id, parent_id, author_email, author_name,
        target_key, target_label, selected_text, anchor_start, anchor_end,
        body, kind, review_round_id, base_version_id, workflow_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
    )
    .bind(
      commentId,
      snapshotId,
      snapshot.video_id,
      parentId || null,
      user.identityKey,
      user.displayName,
      targetKey,
      targetLabel,
      selectedText,
      anchorStart,
      anchorEnd,
      body,
      requestedKind,
      reviewRoundId,
      snapshotId,
    )
    .run();

  if (reviewRoundId && !parentId) {
    await db
      .prepare(
        `UPDATE analysis_review_rounds
        SET status = 'IN_REVIEW', reviewer_email = ?, reviewer_name = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('PENDING', 'IN_REVIEW')`,
      )
      .bind(user.identityKey, user.displayName, reviewRoundId)
      .run();
  }

  return Response.json({ ok: true, commentId }, { status: 201 });
}
