import { getDbClient, withDbTransaction } from "@/db";
import { isFinalReviewer } from "@/lib/admin";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  applyRevisionEventToAnnotation,
  materializeRevisionEvents,
  sha256Text,
  type RevisionEventRecord,
} from "@/lib/review-workflow";
import { validateApprovalCandidate } from "@/lib/annotation-validation";
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
  const roundIsActive = Boolean(
    round &&
    ["PENDING", "IN_REVIEW"].includes(round.status) &&
    annotationState?.active_base_snapshot_id === snapshotId,
  );
  const collaboration = await getDbClient().prepare(
    `SELECT collaboration_round.candidate_snapshot_id
    FROM v03_collaboration_streams stream
    LEFT JOIN v03_collaboration_rounds collaboration_round
      ON collaboration_round.id = stream.active_round_id
    WHERE stream.canonical_annotation_id = ? AND stream.status = 'ACTIVE'`,
  ).bind(snapshot.annotation_id).first<{ candidate_snapshot_id: string | null }>();
  const isCurrentCandidate = collaboration?.candidate_snapshot_id === snapshotId;
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
    canReview: finalReviewer && roundIsActive && isCurrentCandidate,
    canReturn: finalReviewer && roundIsActive && isCurrentCandidate,
    canApprove: finalReviewer && roundIsActive && isCurrentCandidate,
    canWithdraw: false,
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
    return Response.json(
      { error: "公共 V0.3 不再由个人撤回；可继续共享修订，或由专家退回本轮候选。" },
      { status: 409 },
    );
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
      const collaboration = await db.prepare(
        `SELECT stream.id AS stream_id, stream.active_round_id,
          collaboration_round.round_number AS collaboration_round_number,
          collaboration_round.candidate_snapshot_id
        FROM v03_collaboration_streams stream
        INNER JOIN v03_collaboration_rounds collaboration_round
          ON collaboration_round.id = stream.active_round_id
        WHERE stream.canonical_annotation_id = ? AND stream.status = 'ACTIVE'
        FOR UPDATE OF stream, collaboration_round`,
      ).bind(snapshot.annotation_id).first<{
        stream_id: string;
        active_round_id: string;
        collaboration_round_number: number;
        candidate_snapshot_id: string | null;
      }>();
      if (!collaboration) {
        return { error: "该作业尚未接入公共 V0.3 主线。", status: 409 };
      }
      if (collaboration.candidate_snapshot_id !== snapshotId) {
        return { error: "当前候选已被后续共享修订替代，请刷新后重新提交候选。", status: 409 };
      }
      if (!["PENDING", "IN_REVIEW"].includes(round.status)) {
        return { error: "当前审核轮次已经结束。", status: 409 };
      }
      if (annotation.active_base_snapshot_id !== snapshotId) {
        return { error: "当前基础版本已经变化，请刷新后重新审核。", status: 409 };
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
          WHERE (
            review_round_id IN (
              SELECT id FROM analysis_review_rounds WHERE annotation_id = ?
            ) OR collaboration_round_id = ?
          ) AND parent_id IS NULL AND workflow_status <> 'RESOLVED'`,
        ).bind(snapshot.annotation_id, collaboration.active_round_id).first<{ count: number }>();
        if (Number(unresolved?.count ?? 0) > 0) {
          return { error: "仍有未由终审解决的批注，暂不能批准入库。", status: 409 };
        }
      }
      const sourcePayload = JSON.parse(snapshot.payload_json) as AnnotationDraft;
      const cleanPayload = await materializeRevisionEvents(sourcePayload, events);
      if (action === "APPROVE") {
        const issues = validateApprovalCandidate(cleanPayload);
        if (issues.length) {
          return {
            error: "整案结构校验未通过；请修正列出的字段后再批准。",
            status: 422,
            issues,
          };
        }
      }
      for (const event of events) {
        await applyRevisionEventToAnnotation(db, snapshot.annotation_id, event);
      }
      const nextRevision = Number(annotation.revision) + 1;
      const decidedAt = new Date().toISOString();

      if (action === "RETURN") {
        await db.batch([
          db.prepare(
            `UPDATE annotations SET status = 'DRAFT', review_status = 'CHANGES_REQUESTED',
              active_base_snapshot_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(snapshot.annotation_id),
          db.prepare(
            `UPDATE analysis_review_rounds SET status = 'CHANGES_REQUESTED',
              reviewer_email = ?, reviewer_name = ?, decision_note = ?, decided_at = ?,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          ).bind(user.identityKey, user.displayName, decisionNote || null, decidedAt, round.id),
          db.prepare(
            `UPDATE analysis_revision_events SET status = 'APPLIED', applied_revision = ?,
              updated_at = CURRENT_TIMESTAMP WHERE review_round_id = ? AND status = 'DRAFT'`,
          ).bind(Number(annotation.revision), round.id),
          db.prepare(
            `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
            VALUES (?, ?, 'REVIEW_CHANGES_REQUESTED', 'REVIEW_ROUND', ?, ?)`,
          ).bind(newId("audit"), user.identityKey, round.id, JSON.stringify({
            snapshotId,
            sharedRevision: Number(annotation.revision),
          })),
          db.prepare(
            `UPDATE v03_collaboration_rounds SET candidate_snapshot_id = NULL
            WHERE id = ? AND status = 'ACTIVE'`,
          ).bind(collaboration.active_round_id),
        ]);
        return { ok: true, action, nextRevision: Number(annotation.revision), reviewRound: Number(round.round_number) };
      }

      cleanPayload.revision = nextRevision;
      cleanPayload.status = "SUBMITTED";
      cleanPayload.reviewStatus = "APPROVED";
      cleanPayload.updatedAt = decidedAt;
      const payloadJson = JSON.stringify(cleanPayload);
      const contentHash = await sha256Text(payloadJson);
      const version = await db.prepare(
        `SELECT COUNT(*) AS count FROM annotation_snapshots
        WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'`,
      ).bind(snapshot.annotation_id).first<{ count: number }>();
      const release = await db.prepare(
        `SELECT id, release_number FROM approved_analysis_releases
        WHERE annotation_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      ).bind(snapshot.annotation_id).first<{ id: string; release_number: number }>();
      const approvedSnapshotId = newId("snapshot");
      const releaseId = newId("approved_release");
      const nextCollaborationRoundId = newId("collaboration_round");
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
            workflow_status, submitted_at, snapshot_kind
          ) VALUES (?, ?, ?, ?, ?, 'V0.3-PILOT', ?, ?, ?, ?, ?,
            'EXPERT_BASE', 'APPROVED', ?, 'APPROVED')`,
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
            assignment_quality_version, status, replaces_release_id,
            collaboration_stream_id, collaboration_round_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
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
          collaboration.stream_id,
          collaboration.active_round_id,
        ),
        db.prepare(
          `UPDATE annotations SET status = 'DRAFT', review_status = 'DRAFT',
            revision = ?, active_base_snapshot_id = NULL, submitted_at = ?,
            base_release_id = ?, base_snapshot_id = ?, source_public_snapshot_id = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).bind(
          nextRevision,
          decidedAt,
          releaseId,
          approvedSnapshotId,
          snapshotId,
          snapshot.annotation_id,
        ),
        db.prepare(
          `UPDATE v03_collaboration_rounds SET status = 'FINALIZED',
            candidate_snapshot_id = ?, ended_by_email = ?, ended_by_name = ?,
            ended_at = ? WHERE id = ? AND status = 'ACTIVE'`,
        ).bind(
          snapshotId,
          user.identityKey,
          user.displayName,
          decidedAt,
          collaboration.active_round_id,
        ),
        db.prepare(
          `INSERT INTO v03_collaboration_rounds (
            id, stream_id, annotation_id, round_number, status, base_type,
            base_release_id, base_snapshot_id, starting_revision,
            created_by_email, created_by_name
          ) VALUES (?, ?, ?, ?, 'ACTIVE', 'APPROVED_RELEASE', ?, ?, ?, ?, ?)`,
        ).bind(
          nextCollaborationRoundId,
          collaboration.stream_id,
          snapshot.annotation_id,
          Number(collaboration.collaboration_round_number) + 1,
          releaseId,
          approvedSnapshotId,
          nextRevision,
          user.identityKey,
          user.displayName,
        ),
        db.prepare(
          `UPDATE v03_collaboration_streams SET active_round_id = ?,
            active_release_id = ?, current_snapshot_id = ?, updated_at = ?
          WHERE id = ?`,
        ).bind(
          nextCollaborationRoundId,
          releaseId,
          approvedSnapshotId,
          decidedAt,
          collaboration.stream_id,
        ),
        db.prepare(
          `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
          VALUES (?, ?, 'STANDARD_RELEASE_APPROVED', 'APPROVED_RELEASE', ?, ?)`,
        ).bind(newId("audit"), user.identityKey, releaseId, JSON.stringify({ snapshotId, approvedSnapshotId, releaseNumber })),
        db.prepare(
          `UPDATE annotation_snapshots
          SET base_release_id = ?, source_public_snapshot_id = ?
          WHERE id = ?`,
        ).bind(releaseId, snapshotId, approvedSnapshotId),
      ]);
      return {
        ok: true,
        action,
        approvedSnapshotId,
        releaseId,
        releaseNumber,
        nextCollaborationRoundId,
      };
    });

    if ("error" in result) {
      return Response.json(
        { error: result.error, ...(result.issues ? { issues: result.issues } : {}) },
        { status: result.status },
      );
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
