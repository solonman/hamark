import { getDbClient } from "@/db";
import { analysisTargetValue, parseAnalysisTarget } from "@/lib/analysis-targets";
import {
  COMMENT_TARGET_MAX_LENGTH,
  normalizeCommentTarget,
  normalizeCommentText,
} from "@/lib/analysis-comments";
import { isAppAdmin, isFinalReviewer } from "@/lib/admin";
import {
  ensureReviewRoundForSnapshot,
  inferRevisionEditType,
  sha256Text,
} from "@/lib/review-workflow";
import {
  newId,
  requireApiUser,
  requireSameOriginMutation,
} from "@/lib/current-user";
import type {
  AnalysisRevisionSuggestion,
  AnalysisRevisionSuggestionStatus,
  AnnotationDraft,
} from "@/lib/types";

const REVISION_CONTENT_MAX_LENGTH = 50_000;

type SnapshotRow = {
  id: string;
  annotation_id: string;
  video_id: string;
  author_email: string;
  taxonomy_version: string;
  payload_json: string;
};

type SuggestionRow = {
  id: string;
  submission_id: string;
  author_name: string;
  target_key: string;
  target_label: string;
  selected_text: string;
  anchor_start: number;
  anchor_end: number;
  replacement_text: string;
  reason: string;
  status: AnalysisRevisionSuggestionStatus;
  decided_by_name: string | null;
  applied_revision: number | null;
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

  const finalReviewer = await isFinalReviewer(user);
  if (snapshot.taxonomy_version === "V0.3-PILOT") {
    const result = await getDbClient()
      .prepare(
        `SELECT id, base_snapshot_id AS submission_id, actor_name AS author_name,
          actor_role, edit_type, target_key, target_label,
          original_text AS selected_text, anchor_start, anchor_end,
          replacement_text, COALESCE(reason, '') AS reason, status,
          applied_revision, linked_comment_id, original_text_hash,
          created_at, updated_at
        FROM analysis_revision_events
        WHERE base_snapshot_id = ? AND status <> 'SUPERSEDED'
        ORDER BY created_at ASC`,
      )
      .bind(snapshotId)
      .all<{
        id: string; submission_id: string; author_name: string;
        actor_role: "AUTHOR" | "FINAL_REVIEWER";
        edit_type: "RANGE_REPLACE" | "UNIT_REPLACE" | "INSERT" | "DELETE";
        target_key: string; target_label: string; selected_text: string;
        anchor_start: number; anchor_end: number; replacement_text: string;
        reason: string; status: "DRAFT" | "APPLIED"; applied_revision: number | null;
        linked_comment_id: string | null; original_text_hash: string;
        created_at: string; updated_at: string;
      }>();
    const suggestions: AnalysisRevisionSuggestion[] = result.results.map((row) => ({
      id: row.id,
      submissionId: row.submission_id,
      targetKey: row.target_key,
      targetLabel: row.target_label,
      selectedText: row.selected_text,
      anchorStart: Number(row.anchor_start),
      anchorEnd: Number(row.anchor_end),
      replacementText: row.replacement_text,
      reason: row.reason,
      authorName: row.author_name,
      actorRole: row.actor_role,
      editType: row.edit_type,
      originalTextHash: row.original_text_hash,
      linkedCommentId: row.linked_comment_id,
      status: row.status,
      decidedByName: null,
      appliedRevision: row.applied_revision == null ? null : Number(row.applied_revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canDecide: false,
    }));
    return Response.json({
      suggestions,
      canDecide: false,
      isFinalReviewer: finalReviewer,
    });
  }

  const [result, admin] = await Promise.all([
    getDbClient()
      .prepare(
        `SELECT id, submission_id, author_name, target_key, target_label,
          selected_text, anchor_start, anchor_end, replacement_text, reason,
          status, decided_by_name, applied_revision, created_at, updated_at
        FROM analysis_revision_suggestions
        WHERE submission_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      )
      .bind(snapshotId)
      .all<SuggestionRow>(),
    isAppAdmin(user),
  ]);
  const canDecide = admin || snapshot.author_email === user.identityKey;
  const suggestions: AnalysisRevisionSuggestion[] = result.results.map((row) => ({
    id: row.id,
    submissionId: row.submission_id,
    targetKey: row.target_key,
    targetLabel: row.target_label,
    selectedText: row.selected_text,
    anchorStart: Number(row.anchor_start),
    anchorEnd: Number(row.anchor_end),
    replacementText: row.replacement_text,
    reason: row.reason,
    authorName: row.author_name,
    status: row.status,
    decidedByName: row.decided_by_name,
    appliedRevision:
      row.applied_revision == null ? null : Number(row.applied_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canDecide,
  }));
  return Response.json({ suggestions, canDecide });
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
      { error: "V0.2 已归档为历史体系，修订记录只读保留。" },
      { status: 409 },
    );
  }

  const payload = (await request.json()) as {
    targetKey?: unknown;
    targetLabel?: unknown;
    selectedText?: unknown;
    anchorStart?: unknown;
    anchorEnd?: unknown;
    replacementText?: unknown;
    reason?: unknown;
    editType?: unknown;
    linkedCommentId?: unknown;
  };
  const targetKey = normalizeCommentTarget(payload.targetKey);
  const targetLabel = normalizeCommentText(
    payload.targetLabel,
    COMMENT_TARGET_MAX_LENGTH,
  );
  const selectedText =
    typeof payload.selectedText === "string"
      ? payload.selectedText.slice(0, REVISION_CONTENT_MAX_LENGTH)
      : "";
  const anchorStart = Number(payload.anchorStart);
  const anchorEnd = Number(payload.anchorEnd);
  const replacementText =
    typeof payload.replacementText === "string"
      ? payload.replacementText.slice(0, REVISION_CONTENT_MAX_LENGTH)
      : null;
  const reason =
    typeof payload.reason === "string"
      ? payload.reason.trim().slice(0, 4000)
      : "";
  const target = parseAnalysisTarget(targetKey);
  const targetValue = target
    ? analysisTargetValue(
        JSON.parse(snapshot.payload_json) as AnnotationDraft,
        targetKey,
      )
    : null;

  if (!target || targetValue == null) {
    return Response.json({ error: "当前内容项不支持修订。" }, { status: 400 });
  }
  if (replacementText == null) {
    return Response.json({ error: "请填写修订后的内容。" }, { status: 400 });
  }
  if (
    !Number.isInteger(anchorStart) ||
    !Number.isInteger(anchorEnd) ||
    anchorStart < 0 ||
    anchorEnd < anchorStart ||
    targetValue.slice(anchorStart, anchorEnd) !== selectedText
  ) {
    return Response.json(
      { error: "所选文字已变化，请重新选中后修订。" },
      { status: 409 },
    );
  }
  if (selectedText === replacementText) {
    return Response.json({ error: "修订前后内容相同。" }, { status: 400 });
  }

  if (snapshot.taxonomy_version === "V0.3-PILOT") {
    const finalReviewer = await isFinalReviewer(user);
    if (!finalReviewer) {
      return Response.json(
        { error: "提交后的正文只有终审者可以直接修订；作者请在退回后的草稿中修改。" },
        { status: 403 },
      );
    }
    const db = getDbClient();
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
        { error: "该版本已经批准入库；请从标准版建立新草稿后再修订。" },
        { status: 409 },
      );
    }
    const round = await ensureReviewRoundForSnapshot(db, {
      annotationId: snapshot.annotation_id,
      videoId: snapshot.video_id,
      snapshotId,
    });
    const roundRow = await db
      .prepare(`SELECT status FROM analysis_review_rounds WHERE id = ?`)
      .bind(round.id)
      .first<{ status: string }>();
    if (!roundRow || !["PENDING", "IN_REVIEW"].includes(roundRow.status)) {
      return Response.json({ error: "当前审核轮次已经结束。" }, { status: 409 });
    }
    const requestedDelete = payload.editType === "DELETE";
    if (!requestedDelete && !replacementText.trim()) {
      return Response.json({ error: "请填写修订后的内容。" }, { status: 400 });
    }
    const editType = requestedDelete
      ? "DELETE"
      : inferRevisionEditType({
          targetValue,
          selectedText,
          anchorStart,
          anchorEnd,
          replacementText,
        });
    const revisionId = newId("revision_event");
    const originalTextHash = await sha256Text(selectedText);
    let linkedCommentId = normalizeCommentText(payload.linkedCommentId, 100) || null;
    if (!linkedCommentId) {
      const matchingComment = await db.prepare(
        `SELECT id FROM analysis_comments
        WHERE review_round_id = ? AND parent_id IS NULL AND target_key = ?
          AND selected_text = ? AND anchor_start = ? AND anchor_end = ?
          AND workflow_status <> 'RESOLVED' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      ).bind(
        round.id,
        targetKey,
        selectedText,
        anchorStart,
        anchorEnd,
      ).first<{ id: string }>();
      linkedCommentId = matchingComment?.id ?? null;
    }
    const statements = [
      db.prepare(
        `UPDATE analysis_revision_events
        SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
        WHERE review_round_id = ? AND target_key = ? AND status = 'DRAFT'`,
      ).bind(round.id, targetKey),
      db.prepare(
        `INSERT INTO analysis_revision_events (
          id, annotation_id, video_id, review_round_id, base_snapshot_id,
          target_key, target_label, edit_type, anchor_start, anchor_end,
          original_text, original_text_hash, replacement_text, reason,
          actor_email, actor_name, actor_role, source, linked_comment_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'FINAL_REVIEWER', 'FINAL_DIRECT_REVISION', ?)`,
      ).bind(
        revisionId,
        snapshot.annotation_id,
        snapshot.video_id,
        round.id,
        snapshotId,
        targetKey,
        targetLabel,
        editType,
        anchorStart,
        anchorEnd,
        selectedText,
        originalTextHash,
        requestedDelete ? "" : replacementText,
        reason || null,
        user.identityKey,
        user.displayName,
        linkedCommentId,
      ),
      db.prepare(
        `UPDATE analysis_review_rounds
        SET status = 'IN_REVIEW', reviewer_email = ?, reviewer_name = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('PENDING', 'IN_REVIEW')`,
      ).bind(user.identityKey, user.displayName, round.id),
      db.prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'FINAL_DIRECT_REVISION_SAVED', 'REVISION_EVENT', ?, ?)`,
      ).bind(
        newId("audit"),
        user.identityKey,
        revisionId,
        JSON.stringify({ snapshotId, reviewRoundId: round.id, targetKey, editType }),
      ),
    ];
    if (linkedCommentId) {
      statements.push(
        db.prepare(
          `UPDATE analysis_comments SET linked_revision_event_id = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).bind(revisionId, linkedCommentId),
      );
    }
    await db.batch(statements);
    return Response.json(
      { ok: true, suggestionId: revisionId, canDecide: false },
      { status: 201 },
    );
  }

  const suggestionId = newId("suggestion");
  await getDbClient()
    .prepare(
      `INSERT INTO analysis_revision_suggestions (
        id, submission_id, video_id, author_email, author_name,
        target_key, target_label, selected_text, anchor_start, anchor_end,
        replacement_text, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      suggestionId,
      snapshotId,
      snapshot.video_id,
      user.identityKey,
      user.displayName,
      targetKey,
      targetLabel,
      selectedText,
      anchorStart,
      anchorEnd,
      replacementText,
      reason,
    )
    .run();

  const canDecide =
    snapshot.author_email === user.identityKey || (await isAppAdmin(user));
  return Response.json({ ok: true, suggestionId, canDecide }, { status: 201 });
}
