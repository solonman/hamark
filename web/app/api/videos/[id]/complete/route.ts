import { ensureSchema } from "@/db/bootstrap";
import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

type UploadRow = {
  id: string;
  object_key: string;
  file_size: number;
  status: string;
  created_by_email: string;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const { id } = await context.params;
  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT id, object_key, file_size, status, created_by_email
      FROM videos WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<UploadRow>();

  if (!video) return Response.json({ error: "上传会话不存在。" }, { status: 404 });
  if (video.created_by_email !== user.identityKey) {
    return Response.json({ error: "只有原上传者可以完成视频上传。" }, { status: 403 });
  }
  if (video.status === "READY") return Response.json({ ok: true, videoId: id });
  if (video.status !== "UPLOADING") {
    return Response.json({ error: "上传会话不可用，请重新创建视频条目。" }, { status: 409 });
  }

  const object = await getVideoBucket().head(video.object_key);
  if (!object || object.size <= 0) {
    return Response.json({ error: "未检测到已上传的视频文件，请重试。" }, { status: 409 });
  }
  if (video.file_size > 0 && object.size !== video.file_size) {
    return Response.json({ error: "上传文件大小与原始文件不一致，请重新上传。" }, { status: 409 });
  }

  await db.withTransaction(async (transaction) => {
    const updateResult = await transaction
      .prepare(
        `UPDATE videos
        SET status = 'READY', file_size = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'UPLOADING'`,
      )
      .bind(object.size, id)
      .run();
    if (updateResult.meta.rows_written !== 1) return;

    await transaction
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'VIDEO_UPLOAD_COMPLETED', 'VIDEO', ?, ?)`
      )
      .bind(
        newId("audit"),
        user.identityKey,
        id,
        JSON.stringify({ fileSize: object.size, etag: object.httpEtag ?? null }),
      )
      .run();
  });

  return Response.json({ ok: true, videoId: id });
}
