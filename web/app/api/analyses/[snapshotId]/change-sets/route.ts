import { getDbClient } from "@/db";
import { analysisTargetValue, parseAnalysisTarget } from "@/lib/analysis-targets";
import { isFinalReviewer } from "@/lib/admin";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  canonicalRevisionValue,
  ensureReviewRoundForSnapshot,
  materializeRevisionEvents,
  sha256Text,
  type RevisionEventRecord,
} from "@/lib/review-workflow";
import { V03_VOCABULARY_VERSION } from "@/lib/taxonomy-v0.3";
import type { AnnotationDraft, RevisionValueType } from "@/lib/types";

type ChangeRequest = {
  targetKey?: unknown;
  targetLabel?: unknown;
  valueType?: unknown;
  replacementValue?: unknown;
  replacementText?: unknown;
  reason?: unknown;
};

function normalizeReplacement(value: unknown, type: RevisionValueType) {
  if (type === "SINGLE_SELECT") return typeof value === "string" ? value.trim().slice(0, 500) : null;
  if (type === "MULTI_SELECT") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
    return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 20);
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!(await isFinalReviewer(user))) {
    return Response.json({ error: "只有终审者可以保存联合结构修订。" }, { status: 403 });
  }
  const { snapshotId } = await context.params;
  const db = getDbClient();
  const snapshot = await db.prepare(
    `SELECT s.id, s.annotation_id, s.video_id, s.taxonomy_version, s.payload_json,
      a.review_status, a.active_base_snapshot_id
    FROM annotation_snapshots s
    INNER JOIN annotations a ON a.id = s.annotation_id
    INNER JOIN videos v ON v.id = s.video_id
    WHERE s.id = ? AND v.deleted_at IS NULL`,
  ).bind(snapshotId).first<{
    id: string; annotation_id: string; video_id: string; taxonomy_version: string;
    payload_json: string; review_status: string; active_base_snapshot_id: string | null;
  }>();
  if (!snapshot) return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  if (snapshot.taxonomy_version !== "V0.3-PILOT") {
    return Response.json({ error: "V0.2 已归档为只读历史。" }, { status: 409 });
  }
  if (snapshot.review_status === "APPROVED" && snapshot.active_base_snapshot_id === snapshotId) {
    return Response.json({ error: "已批准版本不可继续修订。" }, { status: 409 });
  }
  const body = (await request.json()) as { changes?: unknown; reason?: unknown };
  if (!Array.isArray(body.changes) || body.changes.length < 2 || body.changes.length > 30) {
    return Response.json({ error: "联合修订至少包含两个、最多三十个内容项。" }, { status: 400 });
  }
  const source = JSON.parse(snapshot.payload_json) as AnnotationDraft;
  const requested = body.changes as ChangeRequest[];
  const seen = new Set<string>();
  const drafts: Array<RevisionEventRecord & { target_label: string; reason: string }> = [];
  for (const change of requested) {
    const targetKey = typeof change.targetKey === "string" ? change.targetKey.trim().slice(0, 300) : "";
    const targetLabel = typeof change.targetLabel === "string" ? change.targetLabel.trim().slice(0, 300) : targetKey;
    if (!targetKey || seen.has(targetKey)) {
      return Response.json({ error: "联合修订中的内容项不能缺失或重复。" }, { status: 400 });
    }
    seen.add(targetKey);
    const target = parseAnalysisTarget(targetKey);
    const current = target ? analysisTargetValue(source, targetKey) : null;
    if (!target || current == null) {
      return Response.json({ error: `内容项“${targetLabel}”不支持联合修订。` }, { status: 400 });
    }
    const valueType = String(change.valueType ?? ("valueType" in target ? target.valueType : "TEXT")) as RevisionValueType;
    const isStructured = valueType !== "TEXT";
    if (isStructured && (!("valueType" in target) || target.valueType !== valueType)) {
      return Response.json({ error: `内容项“${targetLabel}”的结构类型不匹配。` }, { status: 400 });
    }
    if (!isStructured && typeof current !== "string") {
      return Response.json({ error: `内容项“${targetLabel}”必须使用结构化值。` }, { status: 400 });
    }
    const replacement = isStructured ? normalizeReplacement(change.replacementValue, valueType) : null;
    if (isStructured && replacement == null) {
      return Response.json({ error: `内容项“${targetLabel}”的修订值无效。` }, { status: 400 });
    }
    const replacementText = isStructured
      ? (Array.isArray(replacement) ? replacement.join(" · ") : String(replacement))
      : typeof change.replacementText === "string" ? change.replacementText.slice(0, 50_000) : null;
    if (!isStructured && replacementText == null) {
      return Response.json({ error: `请填写“${targetLabel}”的修订内容。` }, { status: 400 });
    }
    const originalCanonical = isStructured ? canonicalRevisionValue(current) : String(current);
    const replacementCanonical = isStructured ? canonicalRevisionValue(replacement!) : replacementText!;
    if (originalCanonical === replacementCanonical) continue;
    drafts.push({
      id: newId("revision_event"),
      target_key: targetKey,
      target_label: targetLabel,
      edit_type: "UNIT_REPLACE",
      anchor_start: isStructured ? -1 : 0,
      anchor_end: isStructured ? -1 : String(current).length,
      original_text: isStructured ? "" : String(current),
      original_text_hash: await sha256Text(originalCanonical),
      replacement_text: replacementText!,
      value_type: valueType,
      original_value_json: isStructured ? originalCanonical : null,
      replacement_value_json: isStructured ? replacementCanonical : null,
      reason: typeof change.reason === "string"
        ? change.reason.trim().slice(0, 4000)
        : typeof body.reason === "string" ? body.reason.trim().slice(0, 4000) : "",
    });
  }
  if (drafts.length < 2) {
    return Response.json({ error: "至少需要两个真实变化才能保存联合修订。" }, { status: 400 });
  }
  try {
    await materializeRevisionEvents(source, drafts);
  } catch {
    return Response.json({ error: "联合修订与当前基础快照不一致，请刷新后重试。" }, { status: 409 });
  }
  const round = await ensureReviewRoundForSnapshot(db, {
    annotationId: snapshot.annotation_id,
    videoId: snapshot.video_id,
    snapshotId,
  });
  const roundState = await db.prepare(`SELECT status FROM analysis_review_rounds WHERE id = ?`)
    .bind(round.id).first<{ status: string }>();
  if (!roundState || !["PENDING", "IN_REVIEW"].includes(roundState.status)) {
    return Response.json({ error: "当前审核轮次已结束。" }, { status: 409 });
  }
  const changeSetId = newId("revision_change_set");
  await db.withTransaction(async (transaction) => {
    for (const event of drafts) {
      await transaction.prepare(
        `UPDATE analysis_revision_events SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
        WHERE review_round_id = ? AND target_key = ? AND status = 'DRAFT'`,
      ).bind(round.id, event.target_key).run();
      await transaction.prepare(
        `INSERT INTO analysis_revision_events (
          id, annotation_id, video_id, review_round_id, base_snapshot_id,
          target_key, target_label, edit_type, anchor_start, anchor_end,
          original_text, original_text_hash, replacement_text, reason,
          actor_email, actor_name, actor_role, source, value_type,
          original_value_json, replacement_value_json, vocabulary_version,
          change_set_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'UNIT_REPLACE', ?, ?, ?, ?, ?, ?, ?, ?,
          'FINAL_REVIEWER', 'FINAL_DIRECT_REVISION', ?, ?, ?, ?, ?)`,
      ).bind(
        event.id, snapshot.annotation_id, snapshot.video_id, round.id, snapshotId,
        event.target_key, event.target_label, event.anchor_start, event.anchor_end,
        event.original_text, event.original_text_hash, event.replacement_text,
        event.reason || null, user.identityKey, user.displayName, event.value_type ?? "TEXT",
        event.original_value_json ?? null, event.replacement_value_json ?? null,
        V03_VOCABULARY_VERSION, changeSetId,
      ).run();
    }
    await transaction.prepare(
      `UPDATE analysis_review_rounds SET status = 'IN_REVIEW', reviewer_email = ?,
        reviewer_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(user.identityKey, user.displayName, round.id).run();
    await transaction.prepare(
      `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
      VALUES (?, ?, 'FINAL_COMBINED_REVISION_SAVED', 'REVISION_CHANGE_SET', ?, ?)`,
    ).bind(newId("audit"), user.identityKey, changeSetId, JSON.stringify({
      snapshotId, reviewRoundId: round.id, targets: drafts.map((item) => item.target_key),
    })).run();
  });
  return Response.json({ ok: true, changeSetId, revisionIds: drafts.map((item) => item.id) }, { status: 201 });
}
