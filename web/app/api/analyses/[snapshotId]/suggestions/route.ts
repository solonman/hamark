import { getDbClient } from "@/db";
import { analysisTargetValue, parseAnalysisTarget } from "@/lib/analysis-targets";
import {
  COMMENT_TARGET_MAX_LENGTH,
  normalizeCommentTarget,
  normalizeCommentText,
  validateCommentBody,
} from "@/lib/analysis-comments";
import { isAppAdmin } from "@/lib/admin";
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
  video_id: string;
  author_email: string;
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
      `SELECT s.id, s.video_id, s.author_email, s.payload_json
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

  const payload = (await request.json()) as {
    targetKey?: unknown;
    targetLabel?: unknown;
    selectedText?: unknown;
    anchorStart?: unknown;
    anchorEnd?: unknown;
    replacementText?: unknown;
    reason?: unknown;
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
      ? payload.replacementText.trim().slice(0, REVISION_CONTENT_MAX_LENGTH)
      : null;
  const reasonResult = validateCommentBody(payload.reason);
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
  if (reasonResult.error) {
    return Response.json({ error: "请填写修订理由。" }, { status: 400 });
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
      reasonResult.body,
    )
    .run();

  const canDecide =
    snapshot.author_email === user.identityKey || (await isAppAdmin(user));
  return Response.json({ ok: true, suggestionId, canDecide }, { status: 201 });
}
