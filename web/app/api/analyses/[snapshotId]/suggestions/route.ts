import { getDbClient } from "@/db";
import { analysisTargetValue, parseAnalysisTarget } from "@/lib/analysis-targets";
import {
  COMMENT_TARGET_MAX_LENGTH,
  normalizeCommentTarget,
  normalizeCommentText,
} from "@/lib/analysis-comments";
import { isAppAdmin, isFinalReviewer } from "@/lib/admin";
import {
  canonicalRevisionValue,
  ensureReviewRoundForSnapshot,
  sha256Text,
} from "@/lib/review-workflow";
import { V03_VOCABULARY_VERSION } from "@/lib/taxonomy-v0.3";
import {
  newId,
  requireApiUser,
  requireSameOriginMutation,
} from "@/lib/current-user";
import type {
  AnalysisRevisionSuggestion,
  AnalysisRevisionSuggestionStatus,
  AnnotationDraft,
  RevisionValueType,
  RevisionEditType,
} from "@/lib/types";

const REVISION_CONTENT_MAX_LENGTH = 50_000;

function parseStoredRevisionValue(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeStructuredValue(
  value: unknown,
  valueType: RevisionValueType,
): string | string[] | null {
  if (valueType === "SINGLE_SELECT") {
    return typeof value === "string" ? value.trim().slice(0, 500) : null;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    .slice(0, 20)
    .map((item) => item.slice(0, 500));
}

function displayStructuredValue(value: string | string[]) {
  return Array.isArray(value) ? value.join(" · ") : value;
}

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
          value_type, original_value_json, replacement_value_json,
          vocabulary_version, change_set_id,
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
        value_type: RevisionValueType;
        original_value_json: string | null;
        replacement_value_json: string | null;
        vocabulary_version: "V0.3.1" | "V0.3.2";
        change_set_id: string | null;
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
      valueType: row.value_type ?? "TEXT",
      originalValue: parseStoredRevisionValue(row.original_value_json),
      replacementValue: parseStoredRevisionValue(row.replacement_value_json),
      vocabularyVersion: row.vocabulary_version,
      changeSetId: row.change_set_id,
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
    valueType?: unknown;
    originalValue?: unknown;
    replacementValue?: unknown;
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

  const requestedValueType = String(payload.valueType ?? "TEXT") as RevisionValueType;
  const structuredRevision = requestedValueType !== "TEXT";
  const requestedEditType = String(
    payload.editType ?? (structuredRevision ? "UNIT_REPLACE" : ""),
  ) as RevisionEditType;
  const effectiveAnchorStart = structuredRevision ? -1 : anchorStart;
  const effectiveAnchorEnd = structuredRevision ? -1 : anchorEnd;

  if (!target || targetValue == null) {
    return Response.json({ error: "当前内容项不支持修订。" }, { status: 400 });
  }
  const structuredTargetValueType = "valueType" in target ? target.valueType : null;
  if (
    structuredRevision &&
    requestedValueType !== "SINGLE_SELECT" &&
    requestedValueType !== "MULTI_SELECT"
  ) {
    return Response.json({ error: "结构化修订类型无效。" }, { status: 400 });
  }
  if (structuredRevision && !structuredTargetValueType) {
    return Response.json({ error: "当前内容项不是结构化修订目标。" }, { status: 400 });
  }
  if (structuredRevision && structuredTargetValueType !== requestedValueType) {
    return Response.json({ error: "结构化修订类型与内容项不一致。" }, { status: 400 });
  }

  const originalStructuredValue = structuredRevision
    ? normalizeStructuredValue(payload.originalValue, requestedValueType)
    : null;
  const replacementStructuredValue = structuredRevision
    ? normalizeStructuredValue(payload.replacementValue, requestedValueType)
    : null;
  if (
    structuredRevision &&
    (originalStructuredValue == null || replacementStructuredValue == null)
  ) {
    return Response.json({ error: "结构化修订值无效。" }, { status: 400 });
  }
  if (
    structuredRevision &&
    canonicalRevisionValue(targetValue) !==
      canonicalRevisionValue(originalStructuredValue!)
  ) {
    return Response.json(
      { error: "当前结构化内容已变化，请刷新后重新修订。" },
      { status: 409 },
    );
  }
  if (
    structuredRevision &&
    canonicalRevisionValue(originalStructuredValue!) ===
      canonicalRevisionValue(replacementStructuredValue!)
  ) {
    return Response.json({ error: "修订前后内容相同。" }, { status: 400 });
  }
  if (structuredRevision && requestedValueType === "SINGLE_SELECT" && !String(replacementStructuredValue).trim()) {
    return Response.json({ error: "请选择修订后的值。" }, { status: 400 });
  }
  if (!structuredRevision && typeof targetValue !== "string") {
    return Response.json({ error: "该内容项必须使用结构化修订。" }, { status: 400 });
  }
  if (!structuredRevision && replacementText == null) {
    return Response.json({ error: "请填写修订后的内容。" }, { status: 400 });
  }
  if (!structuredRevision && !["RANGE_REPLACE", "UNIT_REPLACE", "INSERT", "DELETE"].includes(requestedEditType)) {
    return Response.json({ error: "请选择明确的文本修订方式。" }, { status: 400 });
  }
  const textTarget = typeof targetValue === "string" ? targetValue : "";
  const rangeValid = Number.isInteger(anchorStart) && Number.isInteger(anchorEnd) &&
    anchorStart >= 0 && anchorEnd >= anchorStart &&
    textTarget.slice(anchorStart, anchorEnd) === selectedText;
  if (!structuredRevision && !rangeValid) {
    return Response.json(
      { error: "所选文字已变化，请重新选中后修订。" },
      { status: 409 },
    );
  }
  if (!structuredRevision && requestedEditType === "UNIT_REPLACE" && (
    anchorStart !== 0 || anchorEnd !== textTarget.length || selectedText !== textTarget
  )) {
    return Response.json({ error: "整项替换必须绑定当前内容单元的完整原文。" }, { status: 409 });
  }
  if (!structuredRevision && requestedEditType === "RANGE_REPLACE" && !selectedText) {
    return Response.json({ error: "局部替换需要先选择原文。" }, { status: 400 });
  }
  if (!structuredRevision && requestedEditType === "INSERT" && (
    selectedText !== "" || anchorStart !== anchorEnd
  )) {
    return Response.json({ error: "插入操作必须绑定一个明确光标位置。" }, { status: 400 });
  }
  if (!structuredRevision && requestedEditType === "DELETE" && !selectedText) {
    return Response.json({ error: "删除操作需要先选择原文。" }, { status: 400 });
  }
  if (!structuredRevision && requestedEditType === "DELETE" && replacementText !== "") {
    return Response.json({ error: "删除操作不能携带替代文字。" }, { status: 400 });
  }
  if (!structuredRevision && selectedText === replacementText) {
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
    const requestedDelete = !structuredRevision && requestedEditType === "DELETE";
    if (!structuredRevision && !requestedDelete && !replacementText!.trim()) {
      return Response.json({ error: "请填写修订后的内容。" }, { status: 400 });
    }
    const editType = structuredRevision
      ? "UNIT_REPLACE"
      : requestedEditType;
    const revisionId = newId("revision_event");
    const originalTextHash = await sha256Text(
      structuredRevision
        ? canonicalRevisionValue(originalStructuredValue!)
        : selectedText,
    );
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
        effectiveAnchorStart,
        effectiveAnchorEnd,
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
          actor_email, actor_name, actor_role, source, linked_comment_id,
          value_type, original_value_json, replacement_value_json,
          vocabulary_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'FINAL_REVIEWER', 'FINAL_DIRECT_REVISION', ?, ?, ?, ?, ?)`,
      ).bind(
        revisionId,
        snapshot.annotation_id,
        snapshot.video_id,
        round.id,
        snapshotId,
        targetKey,
        targetLabel,
        editType,
        effectiveAnchorStart,
        effectiveAnchorEnd,
        structuredRevision ? "" : selectedText,
        originalTextHash,
        structuredRevision
          ? displayStructuredValue(replacementStructuredValue!)
          : requestedDelete
            ? ""
            : replacementText,
        reason || null,
        user.identityKey,
        user.displayName,
        linkedCommentId,
        requestedValueType,
        structuredRevision ? canonicalRevisionValue(originalStructuredValue!) : null,
        structuredRevision ? canonicalRevisionValue(replacementStructuredValue!) : null,
        V03_VOCABULARY_VERSION,
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
        effectiveAnchorStart,
        effectiveAnchorEnd,
      replacementText,
      reason,
    )
    .run();

  const canDecide =
    snapshot.author_email === user.identityKey || (await isAppAdmin(user));
  return Response.json({ ok: true, suggestionId, canDecide }, { status: 201 });
}
