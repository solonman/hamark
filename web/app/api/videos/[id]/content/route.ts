import { ensureSchema } from "@/db/bootstrap";
import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser } from "@/lib/current-user";

type UploadRow = {
  id: string;
  object_key: string;
  content_type: string;
  file_size: number;
  status: string;
  created_by_email: string;
};

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const { id } = await context.params;
  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT id, object_key, content_type, file_size, status, created_by_email
      FROM videos WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<UploadRow>();

  if (!video) {
    return Response.json({ error: "上传会话不存在。" }, { status: 404 });
  }
  if (video.created_by_email !== user.identityKey) {
    return Response.json({ error: "只有原上传者可以写入视频文件。" }, { status: 403 });
  }
  if (!request.body) {
    return Response.json({ error: "没有收到文件内容。" }, { status: 400 });
  }

  const contentType =
    request.headers.get("content-type") ||
    video.content_type ||
    "application/octet-stream";
  const contentLength = Math.max(
    0,
    Number(request.headers.get("content-length")) || video.file_size,
  );

  try {
    await getVideoBucket().put(video.object_key, request.body, {
      httpMetadata: { contentType },
      customMetadata: {
        videoId: id,
        uploader: user.identityKey,
      },
    });

    await db.batch([
      db
        .prepare(
          `UPDATE videos
          SET status = 'READY', content_type = ?, file_size = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        )
        .bind(contentType, contentLength, id),
      db
        .prepare(
          `INSERT INTO audit_logs (
            id, actor_email, action, object_type, object_id, detail_json
          ) VALUES (?, ?, 'VIDEO_UPLOAD_COMPLETED', 'VIDEO', ?, ?)`,
        )
        .bind(
          newId("audit"),
          user.identityKey,
          id,
          JSON.stringify({ contentType, fileSize: contentLength }),
        ),
    ]);
  } catch (error) {
    await db
      .prepare(
        `UPDATE videos SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .bind(id)
      .run();
    const message = error instanceof Error ? error.message : "上传失败";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({ ok: true, videoId: id });
}
