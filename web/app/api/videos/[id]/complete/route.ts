import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

type UploadRow = {
  id: string;
  object_key: string;
  thumbnail_key: string | null;
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
  const { id } = await context.params;
  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT v.id, v.object_key, to_jsonb(v)->>'thumbnail_key' AS thumbnail_key,
        v.file_size, v.status, v.created_by_email
      FROM videos v WHERE v.id = ? AND v.deleted_at IS NULL`,
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

  const bucket = getVideoBucket();
  const [object, thumbnailObject] = await Promise.all([
    bucket.head(video.object_key),
    video.thumbnail_key ? bucket.head(video.thumbnail_key) : Promise.resolve(null),
  ]);
  if (!object || object.size <= 0) {
    return Response.json({ error: "未检测到已上传的视频文件，请重试。" }, { status: 409 });
  }
  if (!video.thumbnail_key || !thumbnailObject || thumbnailObject.size <= 0) {
    return Response.json({ error: "未检测到已上传的视频封面，请重试。" }, { status: 409 });
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
        JSON.stringify({
          fileSize: object.size,
          etag: object.httpEtag ?? null,
          thumbnailEtag: thumbnailObject.httpEtag ?? null,
        }),
      )
      .run();
  });

  return Response.json({ ok: true, videoId: id });
}
