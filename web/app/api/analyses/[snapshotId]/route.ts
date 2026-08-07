import { getDbClient } from "@/db";
import { requireApiUser } from "@/lib/current-user";

type SnapshotRow = {
  id: string;
  annotation_id: string;
  author_name: string;
  taxonomy_version: string;
  revision: number;
  payload_json: string;
  content_hash: string;
  created_at: string;
};

type VersionRow = {
  id: string;
  revision: number;
  content_hash: string;
  created_at: string;
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
      `SELECT s.id, s.annotation_id, s.author_name, s.taxonomy_version,
        s.revision, s.payload_json, s.content_hash, s.created_at
      FROM annotation_snapshots s
      INNER JOIN videos v ON v.id = s.video_id
      WHERE s.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (!snapshot) {
    return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  }

  const versionResult = await db
    .prepare(
      `SELECT id, revision, content_hash, created_at
      FROM annotation_snapshots
      WHERE annotation_id = ?
      ORDER BY created_at ASC, revision ASC`,
    )
    .bind(snapshot.annotation_id)
    .all<VersionRow>();
  const versions = versionResult.results.map((version, index) => ({
    id: version.id,
    revision: version.revision,
    versionNumber: index + 1,
    createdAt: version.created_at,
    contentHash: version.content_hash,
  }));
  const versionNumber =
    versions.find((version) => version.id === snapshot.id)?.versionNumber ?? 1;

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
    },
  });
}
