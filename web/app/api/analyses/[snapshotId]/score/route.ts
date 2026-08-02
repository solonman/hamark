import { ensureSchema } from "@/db/bootstrap";
import { getDbClient } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  REVIEW_RUBRIC_VERSION,
  calculateReviewTotal,
  emptyReviewScores,
  reviewScoreItems,
  validateReviewScores,
} from "@/lib/review-rubric";

type SnapshotRow = {
  id: string;
  video_id: string;
  author_email: string;
  revision: number;
};

type ReviewRow = {
  id: string;
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  scores_json: string;
  total_score: number;
  general_comment: string;
  discussion_nomination: number;
  is_valid_for_aggregate: number;
  updated_at: string;
};

function normalizeScores(value: unknown) {
  const scores = emptyReviewScores();
  if (!value || typeof value !== "object") return scores;
  const record = value as Record<string, unknown>;
  for (const item of reviewScoreItems) {
    const score = record[item.code];
    scores[item.code] =
      typeof score === "number" && Number.isFinite(score) ? score : null;
  }
  return scores;
}

async function loadSnapshot(snapshotId: string) {
  return getDbClient()
    .prepare(
      `SELECT id, video_id, author_email, revision
      FROM annotation_snapshots WHERE id = ?`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业修订不存在。" }, { status: 404 });
  }

  const db = getDbClient();
  const [review, aggregate] = await Promise.all([
    db
      .prepare(
        `SELECT id, status, revision, scores_json, total_score,
          general_comment, discussion_nomination, is_valid_for_aggregate,
          updated_at
        FROM assignment_reviews
        WHERE submission_id = ? AND grader_email = ? AND deleted_at IS NULL`,
      )
      .bind(snapshotId, user.identityKey)
      .first<ReviewRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS valid_review_count, AVG(total_score) AS average_score
        FROM assignment_reviews
        WHERE submission_id = ? AND status = 'SUBMITTED'
          AND is_valid_for_aggregate = 1 AND deleted_at IS NULL`,
      )
      .bind(snapshotId)
      .first<{ valid_review_count: number; average_score: number | null }>(),
  ]);

  const isSelf = snapshot.author_email === user.identityKey;
  return Response.json({
    review: review
      ? {
          id: review.id,
          submissionId: snapshotId,
          rubricVersion: REVIEW_RUBRIC_VERSION,
          status: review.status,
          revision: review.revision,
          scores: normalizeScores(JSON.parse(review.scores_json || "{}")),
          totalScore: review.total_score,
          generalComment: review.general_comment,
          discussionNomination: Boolean(review.discussion_nomination),
          isValidForAggregate: Boolean(review.is_valid_for_aggregate),
          updatedAt: review.updated_at,
        }
      : {
          id: null,
          submissionId: snapshotId,
          rubricVersion: REVIEW_RUBRIC_VERSION,
          status: "DRAFT",
          revision: 0,
          scores: emptyReviewScores(),
          totalScore: 0,
          generalComment: "",
          discussionNomination: false,
          isValidForAggregate: !isSelf,
          updatedAt: null,
        },
    aggregate: {
      validReviewCount: Number(aggregate?.valid_review_count ?? 0),
      averageScore:
        aggregate?.average_score == null ? null : Number(aggregate.average_score),
    },
    isSelf,
  });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业修订不存在。" }, { status: 404 });
  }

  const payload = (await request.json()) as {
    revision?: number;
    scores?: unknown;
    generalComment?: unknown;
    discussionNomination?: unknown;
  };
  const scores = normalizeScores(payload.scores);
  const totalScore = calculateReviewTotal(scores);
  const generalComment =
    typeof payload.generalComment === "string" ? payload.generalComment.trim() : "";
  const discussionNomination = Boolean(payload.discussionNomination);
  const db = getDbClient();
  const existing = await db
    .prepare(
      `SELECT id, revision FROM assignment_reviews
      WHERE submission_id = ? AND grader_email = ? AND deleted_at IS NULL`,
    )
    .bind(snapshotId, user.identityKey)
    .first<{ id: string; revision: number }>();

  if (existing && existing.revision !== Number(payload.revision ?? 0)) {
    return Response.json(
      {
        error: "这份评分已在其他页面更新，请刷新后继续。",
        code: "REVISION_CONFLICT",
        serverRevision: existing.revision,
      },
      { status: 409 },
    );
  }

  const reviewId = existing?.id ?? newId("review");
  const nextRevision = (existing?.revision ?? 0) + 1;
  const isValidForAggregate = snapshot.author_email === user.identityKey ? 0 : 1;
  if (existing) {
    await db
      .prepare(
        `UPDATE assignment_reviews SET
          grader_name = ?, rubric_version = ?, status = 'DRAFT', revision = ?, scores_json = ?,
          total_score = ?, general_comment = ?, discussion_nomination = ?,
          is_valid_for_aggregate = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND grader_email = ?`,
      )
      .bind(
        user.displayName,
        REVIEW_RUBRIC_VERSION,
        nextRevision,
        JSON.stringify(scores),
        totalScore,
        generalComment,
        discussionNomination ? 1 : 0,
        isValidForAggregate,
        reviewId,
        user.identityKey,
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO assignment_reviews (
          id, submission_id, video_id, submission_revision,
          grader_email, grader_name, grader_role, rubric_version,
          status, revision, scores_json, total_score, general_comment,
          discussion_nomination, is_valid_for_aggregate, weight
        ) VALUES (?, ?, ?, ?, ?, ?, 'PEER', ?, 'DRAFT', ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(
        reviewId,
        snapshotId,
        snapshot.video_id,
        snapshot.revision,
        user.identityKey,
        user.displayName,
        REVIEW_RUBRIC_VERSION,
        nextRevision,
        JSON.stringify(scores),
        totalScore,
        generalComment,
        discussionNomination ? 1 : 0,
        isValidForAggregate,
      )
      .run();
  }

  return Response.json({
    ok: true,
    reviewId,
    revision: nextRevision,
    status: "DRAFT",
    totalScore,
    isValidForAggregate: Boolean(isValidForAggregate),
    updatedAt: new Date().toISOString(),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业修订不存在。" }, { status: 404 });
  }

  const db = getDbClient();
  const review = await db
    .prepare(
      `SELECT id, status, revision, scores_json, total_score,
        general_comment, discussion_nomination, is_valid_for_aggregate,
        updated_at
      FROM assignment_reviews
      WHERE submission_id = ? AND grader_email = ? AND deleted_at IS NULL`,
    )
    .bind(snapshotId, user.identityKey)
    .first<ReviewRow>();
  if (!review) {
    return Response.json({ error: "请先保存评分。" }, { status: 400 });
  }

  const scores = normalizeScores(JSON.parse(review.scores_json || "{}"));
  const missing = validateReviewScores(scores);
  if (missing.length) {
    return Response.json(
      { error: `还有 ${missing.length} 项需要评分。`, missing },
      { status: 400 },
    );
  }

  const existingSnapshot = await db
    .prepare(
      `SELECT id FROM assignment_review_snapshots
      WHERE review_id = ? AND revision = ?`,
    )
    .bind(review.id, review.revision)
    .first<{ id: string }>();
  if (existingSnapshot) {
    return Response.json({
      ok: true,
      snapshotId: existingSnapshot.id,
      revision: review.revision,
      totalScore: review.total_score,
    });
  }

  const canonicalPayload = JSON.stringify({
    submissionId: snapshotId,
    submissionRevision: snapshot.revision,
    rubricVersion: REVIEW_RUBRIC_VERSION,
    reviewRevision: review.revision,
    scores,
    totalScore: review.total_score,
    generalComment: review.general_comment,
    discussionNomination: Boolean(review.discussion_nomination),
    isValidForAggregate: Boolean(review.is_valid_for_aggregate),
  });
  const contentHash = await sha256(canonicalPayload);
  const reviewSnapshotId = newId("review_snapshot");
  await db.batch([
    db
      .prepare(
        `INSERT INTO assignment_review_snapshots (
          id, review_id, submission_id, grader_email, rubric_version,
          revision, payload_json, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reviewSnapshotId,
        review.id,
        snapshotId,
        user.identityKey,
        REVIEW_RUBRIC_VERSION,
        review.revision,
        canonicalPayload,
        contentHash,
      ),
    db
      .prepare(
        `UPDATE assignment_reviews SET status = 'SUBMITTED',
          submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      )
      .bind(review.id),
    db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'ASSIGNMENT_REVIEW_SUBMITTED', 'ASSIGNMENT_REVIEW', ?, ?)`,
      )
      .bind(
        newId("audit"),
        user.identityKey,
        review.id,
        JSON.stringify({
          submissionId: snapshotId,
          submissionRevision: snapshot.revision,
          rubricVersion: REVIEW_RUBRIC_VERSION,
          reviewRevision: review.revision,
          totalScore: review.total_score,
          contentHash,
          isValidForAggregate: Boolean(review.is_valid_for_aggregate),
        }),
      ),
  ]);

  return Response.json({
    ok: true,
    snapshotId: reviewSnapshotId,
    revision: review.revision,
    totalScore: review.total_score,
    contentHash,
    isValidForAggregate: Boolean(review.is_valid_for_aggregate),
  });
}
