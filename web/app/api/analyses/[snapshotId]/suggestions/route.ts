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
  materializeRevisionEvents,
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
import {
  saveSharedV03Draft,
  V03CollaborationError,
} from "@/lib/v03-collaboration";

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

function parseJsonRevisionValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return parseStoredRevisionValue(value) ?? value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
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
        `SELECT event.id, event.actor_name AS author_name,
          event.target_key, event.target_label, event.value_type,
          event.before_value_json, event.after_value_json,
          COALESCE(event.reason, '') AS reason, event.applied_revision,
          event.change_set_id, event.created_at
        FROM v03_collaboration_revision_events event
        INNER JOIN v03_collaboration_streams stream ON stream.id = event.stream_id
        WHERE stream.canonical_annotation_id = ?
        ORDER BY event.created_at ASC, event.id ASC`,
      )
      .bind(snapshot.annotation_id)
      .all<{
        id: string; author_name: string; target_key: string; target_label: string;
        value_type: RevisionValueType | "STRUCTURE";
        before_value_json: unknown; after_value_json: unknown;
        reason: string; applied_revision: number; change_set_id: string;
        created_at: string;
      }>();
    const displayValue = (value: unknown) => {
      const parsed = typeof value === "string" ? parseStoredRevisionValue(value) ?? value : value;
      if (Array.isArray(parsed)) return parsed.join(" · ");
      if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
      return String(parsed ?? "");
    };
    const suggestions: AnalysisRevisionSuggestion[] = result.results.map((row) => {
      const valueType = row.value_type === "STRUCTURE" ? "TEXT" : row.value_type;
      return {
        id: row.id,
        submissionId: snapshotId,
        targetKey: row.target_key,
        targetLabel: row.target_label,
        selectedText: displayValue(row.before_value_json),
        anchorStart: -1,
        anchorEnd: -1,
        replacementText: displayValue(row.after_value_json),
        reason: row.reason,
        authorName: row.author_name,
        actorRole: "COLLABORATOR",
        editType: "UNIT_REPLACE",
        valueType,
        originalValue: valueType === "TEXT" ? undefined : parseJsonRevisionValue(row.before_value_json),
        replacementValue: valueType === "TEXT" ? undefined : parseJsonRevisionValue(row.after_value_json),
        vocabularyVersion: V03_VOCABULARY_VERSION,
        changeSetId: row.change_set_id,
        status: "APPLIED",
        decidedByName: null,
        appliedRevision: Number(row.applied_revision),
        createdAt: row.created_at,
        updatedAt: row.created_at,
        canDecide: false,
      };
    });
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
    const requestedDelete = !structuredRevision && requestedEditType === "DELETE";
    if (!structuredRevision && !requestedDelete && !replacementText!.trim()) {
      return Response.json({ error: "请填写修订后的内容。" }, { status: 400 });
    }
    const editType = structuredRevision
      ? "UNIT_REPLACE"
      : requestedEditType;
    const originalTextHash = await sha256Text(
      structuredRevision
        ? canonicalRevisionValue(originalStructuredValue!)
        : selectedText,
    );
    const source = JSON.parse(snapshot.payload_json) as AnnotationDraft;
    const draftEvent = {
      id: "shared-inline-revision",
      target_key: targetKey,
      target_label: targetLabel,
      edit_type: editType,
      anchor_start: effectiveAnchorStart,
      anchor_end: effectiveAnchorEnd,
      original_text: structuredRevision ? "" : selectedText,
      original_text_hash: originalTextHash,
      replacement_text: structuredRevision
        ? displayStructuredValue(replacementStructuredValue!)
        : requestedDelete ? "" : replacementText!,
      value_type: requestedValueType,
      original_value_json: structuredRevision
        ? canonicalRevisionValue(originalStructuredValue!)
        : null,
      replacement_value_json: structuredRevision
        ? canonicalRevisionValue(replacementStructuredValue!)
        : null,
    } as const;
    try {
      const next = await materializeRevisionEvents(source, [draftEvent]);
      const saved = await saveSharedV03Draft({
        videoId: snapshot.video_id,
        payload: next,
        actor: user,
        reason,
        expectedSnapshotId: snapshotId,
      });
      return Response.json(
        {
          ok: true,
          suggestionId: saved.changeSetId,
          changeSetId: saved.changeSetId,
          appliedRevision: saved.annotation.revision,
          currentSnapshotId: saved.collaboration.currentSnapshotId,
          canDecide: false,
        },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof V03CollaborationError) {
        return Response.json({
          error: error.message,
          code: error.code,
          ...(error.serverRevision == null ? {} : { serverRevision: error.serverRevision }),
        }, { status: error.status });
      }
      console.error("Shared inline revision failed", { snapshotId, targetKey, error });
      return Response.json({ error: "共享修订未保存，事务已回滚。" }, { status: 500 });
    }
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
