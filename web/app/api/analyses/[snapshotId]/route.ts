import { getDbClient } from "@/db";
import { isFinalReviewer } from "@/lib/admin";
import { requireApiUser } from "@/lib/current-user";

type SnapshotRow = {
  id: string;
  annotation_id: string;
  author_name: string;
  author_email: string;
  taxonomy_version: string;
  revision: number;
  payload_json: string;
  content_hash: string;
  created_at: string;
  review_status: string;
  active_base_snapshot_id: string | null;
  round_id: string | null;
  round_number: number | null;
  round_status: "PENDING" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | null;
  reviewer_name: string | null;
  decision_note: string | null;
  round_created_at: string | null;
  round_decided_at: string | null;
  comment_count: number;
  revision_count: number;
};

type VersionRow = {
  id: string;
  revision: number;
  content_hash: string;
  created_at: string;
};

type ReleaseIdentityRow = {
  release_number: number;
  status: "ACTIVE" | "SUPERSEDED" | "WITHDRAWN";
};

export async function GET(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const db = getDbClient();
  const snapshot = await db
    .prepare(
      `SELECT s.id, s.annotation_id, s.author_name, s.author_email,
        s.taxonomy_version, s.revision, s.payload_json, s.content_hash,
        s.created_at, a.review_status, a.active_base_snapshot_id,
        r.id AS round_id, r.round_number, r.status AS round_status,
        r.reviewer_name, r.decision_note,
        r.created_at AS round_created_at, r.decided_at AS round_decided_at,
        COALESCE((SELECT COUNT(*) FROM analysis_comments c
          WHERE c.review_round_id = r.id AND c.parent_id IS NULL), 0) AS comment_count,
        COALESCE((SELECT COUNT(*) FROM analysis_revision_events e
          WHERE e.review_round_id = r.id AND e.status = 'DRAFT'), 0) AS revision_count
      FROM annotation_snapshots s
      INNER JOIN annotations a ON a.id = s.annotation_id
      LEFT JOIN analysis_review_rounds r ON r.submitted_snapshot_id = s.id
      INNER JOIN videos v ON v.id = s.video_id
      WHERE s.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (!snapshot) {
    return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  }

  const [versionResult, releaseIdentity] = await Promise.all([db
    .prepare(
      `SELECT id, revision, content_hash, created_at
      FROM annotation_snapshots
      WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'
      ORDER BY created_at ASC, revision ASC`,
    )
    .bind(snapshot.annotation_id)
    .all<VersionRow>(),
    db.prepare(
      `SELECT release_number, status FROM approved_analysis_releases
      WHERE approved_snapshot_id = ? LIMIT 1`,
    ).bind(snapshotId).first<ReleaseIdentityRow>(),
  ]);
  const versions = versionResult.results.map((version, index) => ({
    id: version.id,
    revision: version.revision,
    versionNumber: index + 1,
    createdAt: version.created_at,
    contentHash: version.content_hash,
  }));
  const versionNumber =
    versions.find((version) => version.id === snapshot.id)?.versionNumber ?? 1;
  const finalReviewer = await isFinalReviewer(user);
  const roundIsActive = Boolean(
    snapshot.round_id &&
    snapshot.active_base_snapshot_id === snapshot.id &&
    snapshot.round_status &&
    ["PENDING", "IN_REVIEW"].includes(snapshot.round_status),
  );

  return Response.json({
    analysis: {
      id: snapshot.id,
      authorName: snapshot.author_name,
      taxonomyVersion: snapshot.taxonomy_version,
      revision: snapshot.revision,
      versionNumber,
      createdAt: snapshot.created_at,
      contentHash: snapshot.content_hash,
      payload: JSON.parse(snapshot.payload_json),
      versions,
      versionIdentity: releaseIdentity
        ? releaseIdentity.status === "ACTIVE" ? "ACTIVE_STANDARD" : "HISTORICAL_STANDARD"
        : "PUBLIC_SUBMISSION",
      reviewContext: {
        round: snapshot.round_id ? {
          id: snapshot.round_id,
          submissionId: snapshot.id,
          roundNumber: Number(snapshot.round_number),
          status: snapshot.round_status,
          reviewerName: snapshot.reviewer_name,
          decisionNote: snapshot.decision_note,
          createdAt: snapshot.round_created_at,
          decidedAt: snapshot.round_decided_at,
        } : null,
        isAuthor: snapshot.author_email === user.identityKey,
        isFinalReviewer: finalReviewer,
        canReview: finalReviewer && roundIsActive,
        canReturn: finalReviewer && roundIsActive,
        canApprove: finalReviewer && roundIsActive,
        canWithdraw: Boolean(
          snapshot.author_email === user.identityKey &&
          roundIsActive &&
          snapshot.round_status === "PENDING" &&
          Number(snapshot.comment_count) === 0 &&
          Number(snapshot.revision_count) === 0
        ),
        activeReleaseNumber: releaseIdentity?.status === "ACTIVE"
          ? Number(releaseIdentity.release_number)
          : null,
      },
    },
  });
}
