import { getDbClient } from "@/db";
import { requireApiUser } from "@/lib/current-user";

export async function GET(
  request: Request,
  context: { params: Promise<{ releaseId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { releaseId } = await context.params;
  const release = await getDbClient().prepare(
    `SELECT r.id, r.release_number, r.approved_snapshot_id, r.source_snapshot_id,
      r.source_review_round_id, r.payload_json, r.content_hash,
      r.approved_by_name, r.approved_at, r.expert_creative_grade,
      r.assignment_quality_grade, r.status,
      source.author_name AS source_author_name,
      COALESCE(source.submitted_at, source.created_at) AS source_submitted_at
    FROM approved_analysis_releases r
    INNER JOIN videos v ON v.id = r.video_id
    INNER JOIN annotation_snapshots source ON source.id = r.source_snapshot_id
    WHERE r.id = ? AND v.deleted_at IS NULL`,
  ).bind(releaseId).first<{
    id: string;
    release_number: number;
    approved_snapshot_id: string;
    source_snapshot_id: string;
    source_review_round_id: string;
    payload_json: string;
    content_hash: string;
    approved_by_name: string;
    approved_at: string;
    expert_creative_grade: "S" | "A" | "B" | "C";
    assignment_quality_grade: string | null;
    status: "ACTIVE" | "SUPERSEDED" | "WITHDRAWN";
    source_author_name: string;
    source_submitted_at: string;
  }>();
  if (!release) return Response.json({ error: "标准版本不存在。" }, { status: 404 });
  return Response.json({
    release: {
      id: release.id,
      releaseNumber: Number(release.release_number),
      approvedSnapshotId: release.approved_snapshot_id,
      sourceSnapshotId: release.source_snapshot_id,
      approvedByName: release.approved_by_name,
      approvedAt: release.approved_at,
      expertCreativeGrade: release.expert_creative_grade,
      assignmentQualityGrade: release.assignment_quality_grade,
      contentHash: release.content_hash,
      status: release.status,
      versionIdentity: release.status === "ACTIVE" ? "ACTIVE_STANDARD" : "HISTORICAL_STANDARD",
      sourceAuthorName: release.source_author_name,
      sourceSubmittedAt: release.source_submitted_at,
      payload: JSON.parse(release.payload_json),
    },
  });
}
