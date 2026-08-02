import { ensureSchema } from "@/db/bootstrap";
import { getD1 } from "@/db";
import { currentUserFromRequest, newId } from "@/lib/current-user";

type VideoDetailRow = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  original_name: string;
  content_type: string;
  file_size: number;
  status: string;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
};

type SnapshotRow = {
  id: string;
  author_name: string;
  taxonomy_version: string;
  revision: number;
  payload_json: string;
  content_hash: string;
  created_at: string;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await ensureSchema();
  const { id } = await context.params;
  const user = currentUserFromRequest(request);
  const d1 = getD1();
  const video = await d1
    .prepare(
      `SELECT id, title, brand, description, tags_json, original_name,
        content_type, file_size, status, created_by_email, created_by_name, created_at
      FROM videos
      WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<VideoDetailRow>();

  if (!video) {
    return Response.json({ error: "视频不存在或已进入回收站。" }, { status: 404 });
  }

  const snapshots = await d1
    .prepare(
      `SELECT s.id, s.author_name, s.taxonomy_version, s.revision,
        s.payload_json, s.content_hash, s.created_at
      FROM annotation_snapshots s
      INNER JOIN (
        SELECT author_email, MAX(revision) AS latest_revision
        FROM annotation_snapshots
        WHERE video_id = ?
        GROUP BY author_email
      ) latest
      ON latest.author_email = s.author_email
      AND latest.latest_revision = s.revision
      WHERE s.video_id = ?
      ORDER BY s.created_at DESC`,
    )
    .bind(id, id)
    .all<SnapshotRow>();

  let tags: string[] = [];
  try {
    tags = JSON.parse(video.tags_json);
  } catch {
    tags = [];
  }

  return Response.json({
    video: {
      id: video.id,
      title: video.title,
      brand: video.brand,
      description: video.description,
      tags,
      originalName: video.original_name,
      contentType: video.content_type,
      fileSize: video.file_size,
      status: video.status,
      createdByName: video.created_by_name,
      createdAt: video.created_at,
      annotationCount: snapshots.results.length,
    },
    analyses: snapshots.results.map((snapshot: SnapshotRow) => ({
      id: snapshot.id,
      authorName: snapshot.author_name,
      taxonomyVersion: snapshot.taxonomy_version,
      revision: snapshot.revision,
      createdAt: snapshot.created_at,
      contentHash: snapshot.content_hash,
      payload: JSON.parse(snapshot.payload_json),
    })),
    canReplaceOriginal: video.created_by_email === user.email,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await ensureSchema();
  const user = currentUserFromRequest(request);
  const { id } = await context.params;
  const d1 = getD1();

  const existing = await d1
    .prepare(`SELECT id FROM videos WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!existing) {
    return Response.json({ error: "视频不存在。" }, { status: 404 });
  }

  await d1.batch([
    d1
      .prepare(
        `UPDATE videos SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      )
      .bind(id),
    d1
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'VIDEO_MOVED_TO_TRASH', 'VIDEO', ?, '{}')`,
      )
      .bind(newId("audit"), user.email, id),
  ]);

  return Response.json({ ok: true });
}
