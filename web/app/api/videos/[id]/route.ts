import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

type VideoDetailRow = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  object_key: string;
  thumbnail_key: string | null;
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

type MyAnnotationRow = {
  id: string;
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  updated_at: string;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT v.id, v.title, v.brand, v.description, v.tags_json, v.object_key,
        to_jsonb(v)->>'thumbnail_key' AS thumbnail_key, v.original_name,
        v.content_type, v.file_size, v.status, v.created_by_email,
        v.created_by_name, v.created_at
      FROM videos v
      WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(id)
    .first<VideoDetailRow>();

  if (!video) {
    return Response.json({ error: "视频不存在或已进入回收站。" }, { status: 404 });
  }

  const [snapshots, myAnnotation, submittedAnalysis, playbackUrl, thumbnailUrl] = await Promise.all([
    db
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
      .all<SnapshotRow>(),
    db
      .prepare(
        `SELECT id, status, revision, updated_at
        FROM annotations
        WHERE video_id = ? AND author_email = ? AND deleted_at IS NULL`,
    )
      .bind(id, user.identityKey)
      .first<MyAnnotationRow>(),
    db
      .prepare(
        `SELECT 1 FROM annotation_snapshots WHERE video_id = ? LIMIT 1`,
      )
      .bind(id)
      .first(),
    video.status === "READY"
      ? getVideoBucket().createPresignedGetUrl(video.object_key, {
          expiresInSeconds: 3 * 60 * 60,
        })
      : Promise.resolve(null),
    video.status === "READY" && video.thumbnail_key
      ? getVideoBucket().createPresignedGetUrl(video.thumbnail_key, {
          expiresInSeconds: 3 * 60 * 60,
        })
      : Promise.resolve(null),
  ]);

  let tags: string[] = [];
  try {
    tags = JSON.parse(video.tags_json);
  } catch {
    tags = [];
  }

  const canManage = video.created_by_email === user.identityKey;
  const hasSubmittedAnalysis = Boolean(submittedAnalysis);

  return Response.json({
    video: {
      id: video.id,
      title: video.title,
      brand: video.brand,
      description: video.description,
      tags,
      originalName: video.original_name,
      playbackUrl,
      thumbnailUrl,
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
    myAnalysis: myAnnotation
      ? {
          id: myAnnotation.id,
          status: myAnnotation.status,
          revision: myAnnotation.revision,
          updatedAt: myAnnotation.updated_at,
        }
      : null,
    canManage,
    canDeletePermanently: canManage && !hasSubmittedAnalysis,
    canReplaceOriginal: canManage,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDbClient();

  const existing = await db
    .prepare(`SELECT id, created_by_email FROM videos WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ id: string; created_by_email: string }>();
  if (!existing) {
    return Response.json({ error: "视频不存在。" }, { status: 404 });
  }
  if (existing.created_by_email !== user.identityKey) {
    return Response.json({ error: "只有原上传者可以删除视频。" }, { status: 403 });
  }

  const deleteResult = await db
    .prepare(
      `UPDATE videos SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND created_by_email = ? AND deleted_at IS NULL`,
    )
    .bind(id, user.identityKey)
    .run();
  if (deleteResult.meta.rows_written !== 1) {
    return Response.json({ error: "视频状态已变化，请刷新后重试。" }, { status: 409 });
  }
  await db
    .prepare(
      `INSERT INTO audit_logs (
        id, actor_email, action, object_type, object_id, detail_json
      ) VALUES (?, ?, 'VIDEO_MOVED_TO_TRASH', 'VIDEO', ?, '{}')`,
    )
    .bind(newId("audit"), user.identityKey, id)
    .run();

  return Response.json({ ok: true });
}
