import { getDbClient, withDbTransaction } from "@/db";
import { isFinalReviewer } from "@/lib/admin";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  applyRevisionEventToAnnotation,
  materializeRevisionEvents,
  sha256Text,
  type RevisionEventRecord,
} from "@/lib/review-workflow";
import type { AnalysisReviewContext, AnnotationDraft, CreativeGrade } from "@/lib/types";

type SnapshotRow = {
  id: string;
  annotation_id: string;
  video_id: string;
  author_email: string;
  author_name: string;
  taxonomy_version: string;
  revision: number;
  payload_json: string;
};

type ReviewRoundRow = {
  id: string;
  submitted_snapshot_id: string;
  round_number: number;
  status: "PENDING" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED";
  reviewer_name: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
};

async function loadSnapshot(snapshotId: string) {
  return getDbClient().prepare(
    `SELECT s.id, s.annotation_id, s.video_id, s.author_email, s.author_name,
      s.taxonomy_version, s.revision, s.payload_json
    FROM annotation_snapshots s
    INNER JOIN videos v ON v.id = s.video_id
    WHERE s.id = ? AND v.deleted_at IS NULL`,
  ).bind(snapshotId).first<SnapshotRow>();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  const finalReviewer = await isFinalReviewer(user);
  const round = await getDbClient().prepare(
    `SELECT id, submitted_snapshot_id, round_number, status, reviewer_name,
      decision_note, created_at, decided_at
    FROM analysis_review_rounds WHERE submitted_snapshot_id = ?`,
  ).bind(snapshotId).first<ReviewRoundRow>();
  const annotationState = await getDbClient().prepare(
    `SELECT review_status, active_base_snapshot_id FROM annotations WHERE id = ?`,
  ).bind(snapshot.annotation_id).first<{
    review_status: string; active_base_snapshot_id: string | null;
  }>();
  const activeRelease = await getDbClient().prepare(
    `SELECT release_number FROM approved_analysis_releases
    WHERE annotation_id = ? AND status = 'ACTIVE' LIMIT 1`,
  ).bind(snapshot.annotation_id).first<{ release_number: number }>();
  const isAuthor = snapshot.author_email === user.identityKey;
  const activity = round
    ? await getDbClient().prepare(
        `SELECT
          (SELECT COUNT(*) FROM analysis_comments WHERE review_round_id = ? AND parent_id IS NULL) AS comment_count,
          (SELECT COUNT(*) FROM analysis_revision_events WHERE review_round_id = ? AND status = 'DRAFT') AS revision_count`,
      ).bind(round.id, round.id).first<{ comment_count: number; revision_count: number }>()
    : null;
  const roundIsActive = Boolean(
    round &&
    ["PENDING", "IN_REVIEW"].includes(round.status) &&
    annotationState?.active_base_snapshot_id === snapshotId,
  );
  const contextValue: AnalysisReviewContext = {
    round: round ? {
      id: round.id,
      submissionId: round.submitted_snapshot_id,
      roundNumber: Number(round.round_number),
      status: round.status,
      reviewerName: round.reviewer_name,
      decisionNote: round.decision_note,
      createdAt: round.created_at,
      decidedAt: round.decided_at,
    } : null,
    isAuthor,
    isFinalReviewer: finalReviewer,
    canReview: finalReviewer && roundIsActive,
    canReturn: finalReviewer && roundIsActive,
    canApprove: finalReviewer && roundIsActive,
    canWithdraw: Boolean(
      isAuthor &&
      roundIsActive &&
      round?.status === "PENDING" &&
      Number(activity?.comment_count ?? 0) === 0 &&
      Number(activity?.revision_count ?? 0) === 0,
    ),
    activeReleaseNumber: activeRelease ? Number(activeRelease.release_number) : null,
  };
  return Response.json({ review: contextValue });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const input = (await request.json()) as {
    action?: unknown;
    decisionNote?: unknown;
    expertCreativeGrade?: unknown;
    assignmentQualityGrade?: unknown;
  };
  if (!["RETURN", "APPROVE", "WITHDRAW"].includes(String(input.action))) {
    return Response.json({ error: "审核动作无效。" }, { status: 400 });
  }
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot || snapshot.taxonomy_version !== "V0.3-PILOT") {
    return Response.json({ error: "当前版本不支持 V0.3.1 审核。" }, { status: 404 });
  }
  const action = input.action as "RETURN" | "APPROVE" | "WITHDRAW";
  const finalReviewer = await isFinalReviewer(user);
  if (action === "WITHDRAW") {
    if (snapshot.author_email !== user.identityKey) {
      return Response.json({ error: "只有作者可以撤回自己的提交。" }, { status: 403 });
    }
  } else if (!finalReviewer) {
    return Response.json({ error: "只有终审者可以退回或批准入库。" }, { status: 403 });
  }
  const decisionNote = typeof input.decisionNote === "string"
    ? input.decisionNote.trim().slice(0, 4000)
    : "";
  const grade = String(input.expertCreativeGrade ?? "") as CreativeGrade;
  if (action === "APPROVE" && !["S", "A", "B", "C"].includes(grade)) {
    return Response.json({ error: "批准入库前请选择专家作品创意等级。" }, { status: 400 });
  }

  try {
    const result = await withDbTransaction(async (db) => {
      const annotation = await db.prepare(
        `SELECT revision, review_status, active_base_snapshot_id
        FROM annotations WHERE id = ? FOR UPDATE`,
      ).bind(snapshot.annotation_id).first<{
        revision: number; review_status: string; active_base_snapshot_id: string | null;
      }>();
      const round = await db.prepare(
        `SELECT id, round_number, status FROM analysis_review_rounds
        WHERE submitted_snapshot_id = ? FOR UPDATE`,
      ).bind(snapshotId).first<{ id: string; round_number: number; status: string }>();
      if (!annotation || !round) return { error: "审核轮次不存在。", status: 404 };
      if (!["PENDING", "IN_REVIEW"].includes(round.status)) {
        return { error: "当前审核轮次已经结束。", status: 409 };
      }
      if (annotation.active_base_snapshot_id !== snapshotId) {
        return { error: "当前基础版本已经变化，请刷新后重新审核。", status: 409 };
      }

      const activity = await db.prepare(
        `SELECT
          (SELECT COUNT(*) FROM analysis_comments WHERE review_round_id = ? AND parent_id IS NULL) AS comment_count,
          (SELECT COUNT(*) FROM analysis_revision_events WHERE review_round_id = ? AND status = 'DRAFT') AS revision_count`,
      ).bind(round.id, round.id).first<{ comment_count: number; revision_count: number }>();
      if (action === "WITHDRAW") {
        if (round.status !== "PENDING" || Number(activity?.comment_count ?? 0) > 0 || Number(activity?.revision_count ?? 0) > 0) {
          return { error: "终审已经开始，当前提交不能撤回；请等待终审者退回。", status: 409 };
        }
        const nextRevision = Number(annotation.revision) + 1;
        await db.batch([
          db.prepare(
            `UPDATE analysis_review_rounds SET status = 'CHANGES_REQUESTED',
              decision_note = '作者撤回并继续修订', decided_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          ).bind(new Date().toISOString(), round.id),
          db.prepare(
            `UPDATE annotations SET status = 'DRAFT', review_status = 'DRAFT',
              revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(nextRevision, snapshot.annotation_id),
        ]);
        return { ok: true, action, nextRevision };
      }

      const eventResult = await db.prepare(
        `SELECT id, target_key, edit_type, anchor_start, anchor_end,
          original_text, original_text_hash, replacement_text,
          value_type, original_value_json, replacement_value_json
        FROM analysis_revision_events
        WHERE review_round_id = ? AND status = 'DRAFT'
        ORDER BY created_at ASC`,
      ).bind(round.id).all<RevisionEventRecord>();
      const events = eventResult.results;
      if (action === "APPROVE") {
        const unresolved = await db.prepare(
          `SELECT COUNT(*) AS count FROM analysis_comments
          WHERE review_round_id IN (
            SELECT id FROM analysis_review_rounds WHERE annotation_id = ?
          ) AND parent_id IS NULL AND workflow_status <> 'RESOLVED'`,
        ).bind(snapshot.annotation_id).first<{ count: number }>();
        if (Number(unresolved?.count ?? 0) > 0) {
          return { error: "仍有未由终审解决的批注，暂不能批准入库。", status: 409 };
        }
      }
      const sourcePayload = JSON.parse(snapshot.payload_json) as AnnotationDraft;
      const cleanPayload = await materializeRevisionEvents(sourcePayload, events);
      for (const event of events) {
        await applyRevisionEventToAnnotation(db, snapshot.annotation_id, event);
      }
      const nextRevision = Number(annotation.revision) + 1;
      const decidedAt = new Date().toISOString();

      if (action === "RETURN") {
        await db.batch([
          db.prepare(
            `UPDATE annotations SET status = 'DRAFT', review_status = 'CHANGES_REQUESTED',
              revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(nextRevision, snapshot.annotation_id),
          db.prepare(
            `UPDATE analysis_review_rounds SET status = 'CHANGES_REQUESTED',
              reviewer_email = ?, reviewer_name = ?, decision_note = ?, decided_at = ?,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(user.identityKey, user.displayName, decisionNote || null, decidedAt, round.id),
          db.prepare(
            `UPDATE analysis_revision_events SET status = 'APPLIED', applied_revision = ?,
              updated_at = CURRENT_TIMESTAMP WHERE review_round_id = ? AND status = 'DRAFT'`,
          ).bind(nextRevision, round.id),
          db.prepare(
            `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
            VALUES (?, ?, 'REVIEW_CHANGES_REQUESTED', 'REVIEW_ROUND', ?, ?)`,
          ).bind(newId("audit"), user.identityKey, round.id, JSON.stringify({ snapshotId, nextRevision })),
        ]);
        return { ok: true, action, nextRevision, reviewRound: Number(round.round_number) };
      }

      cleanPayload.revision = nextRevision;
      cleanPayload.status = "SUBMITTED";
      cleanPayload.reviewStatus = "APPROVED";
      cleanPayload.updatedAt = decidedAt;
      const payloadJson = JSON.stringify(cleanPayload);
      const contentHash = await sha256Text(payloadJson);
      const version = await db.prepare(
        `SELECT COUNT(*) AS count FROM annotation_snapshots WHERE annotation_id = ?`,
      ).bind(snapshot.annotation_id).first<{ count: number }>();
      const release = await db.prepare(
        `SELECT id, release_number FROM approved_analysis_releases
        WHERE annotation_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      ).bind(snapshot.annotation_id).first<{ id: string; release_number: number }>();
      const approvedSnapshotId = newId("snapshot");
      const releaseId = newId("approved_release");
      const releaseNumber = Number(release?.release_number ?? 0) + 1;
      const qualityGrade = typeof input.assignmentQualityGrade === "string"
        ? input.assignmentQualityGrade.trim().slice(0, 100) || null
        : null;

      await db.batch([
        db.prepare(
          `INSERT INTO annotation_snapshots (
            id, annotation_id, video_id, author_email, author_name,
            taxonomy_version, revision, payload_json, content_hash,
            base_snapshot_id, version_number, revision_cause,
            workflow_status, submitted_at
          ) VALUES (?, ?, ?, ?, ?, 'V0.3-PILOT', ?, ?, ?, ?, ?,
            'EXPERT_BASE', 'APPROVED', ?)`,
        ).bind(
          approvedSnapshotId,
          snapshot.annotation_id,
          snapshot.video_id,
          snapshot.author_email,
          snapshot.author_name,
          nextRevision,
          payloadJson,
          contentHash,
          snapshotId,
          Number(version?.count ?? 0) + 1,
          decidedAt,
        ),
        db.prepare(
          `UPDATE annotations SET status = 'SUBMITTED', review_status = 'APPROVED',
            revision = ?, active_base_snapshot_id = ?, submitted_at = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).bind(nextRevision, approvedSnapshotId, decidedAt, snapshot.annotation_id),
        db.prepare(
          `UPDATE analysis_review_rounds SET status = 'APPROVED', reviewer_email = ?,
            reviewer_name = ?, decision_note = ?, decided_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        ).bind(user.identityKey, user.displayName, decisionNote || null, decidedAt, round.id),
        db.prepare(
          `UPDATE analysis_revision_events SET status = 'APPLIED', applied_revision = ?,
            materialized_snapshot_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE review_round_id = ? AND status = 'DRAFT'`,
        ).bind(nextRevision, approvedSnapshotId, round.id),
        db.prepare(
          `UPDATE approved_analysis_releases SET status = 'SUPERSEDED'
          WHERE annotation_id = ? AND status = 'ACTIVE'`,
        ).bind(snapshot.annotation_id),
        db.prepare(
          `INSERT INTO approved_analysis_releases (
            id, annotation_id, video_id, release_number, approved_snapshot_id,
            source_snapshot_id, source_review_round_id, payload_json, content_hash,
            approved_by_email, approved_by_name, approved_at,
            expert_creative_grade, assignment_quality_grade,
            assignment_quality_version, status, replaces_release_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        ).bind(
          releaseId,
          snapshot.annotation_id,
          snapshot.video_id,
          releaseNumber,
          approvedSnapshotId,
          snapshotId,
          round.id,
          payloadJson,
          contentHash,
          user.identityKey,
          user.displayName,
          decidedAt,
          grade,
          qualityGrade,
          qualityGrade ? "PILOT-UNFROZEN" : null,
          release?.id ?? null,
        ),
        db.prepare(
          `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
          VALUES (?, ?, 'STANDARD_RELEASE_APPROVED', 'APPROVED_RELEASE', ?, ?)`,
        ).bind(newId("audit"), user.identityKey, releaseId, JSON.stringify({ snapshotId, approvedSnapshotId, releaseNumber })),
      ]);
      return { ok: true, action, approvedSnapshotId, releaseId, releaseNumber };
    });

    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json(result);
  } catch (error) {
    const conflict = error instanceof Error && ["CONTENT_CHANGED", "ORIGINAL_HASH_MISMATCH"].includes(error.message);
    console.error("V0.3.1 review decision failed", { snapshotId, action, error });
    return Response.json(
      { error: conflict ? "原文已经变化，旧修订未被套用；请基于最新版重新修订。" : "审核处理失败，请稍后重试。" },
      { status: conflict ? 409 : 500 },
    );
  }
}
