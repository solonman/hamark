import { getDbClient, getVideoBucket, withDbTransaction } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  isReplacementAssetId,
  replacementObjectKey,
  replacementThumbnailKey,
} from "@/lib/video-replacement";

type ReplacementRow = {
  id: string;
  object_key: string;
  thumbnail_key: string | null;
  original_name: string;
  content_type: string;
  file_size: number;
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
  const body = (await request.json()) as {
    assetId?: string;
    originalName?: string;
    contentType?: string;
    fileSize?: number;
  };

  if (!isReplacementAssetId(body.assetId)) {
    return Response.json({ error: "替换会话不可用，请重新选择文件。" }, { status: 400 });
  }
  const originalName = body.originalName?.trim().slice(0, 500);
  if (!originalName) {
    return Response.json({ error: "无法识别新文件名称。" }, { status: 400 });
  }

  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT v.id, v.object_key, to_jsonb(v)->>'thumbnail_key' AS thumbnail_key,
        v.original_name, v.content_type, v.file_size, v.created_by_email
      FROM videos v
      WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(id)
    .first<ReplacementRow>();

  if (!video) {
    return Response.json({ error: "视频不存在或已进入回收站。" }, { status: 404 });
  }
  if (video.created_by_email !== user.identityKey) {
    return Response.json(
      { error: "当前版本只有原上传者可以替换原视频。" },
      { status: 403 },
    );
  }

  const replacementKey = replacementObjectKey(id, body.assetId);
  const replacementThumbnail = replacementThumbnailKey(id, body.assetId);
  const bucket = getVideoBucket();
  const [object, thumbnailObject] = await Promise.all([
    bucket.head(replacementKey),
    bucket.head(replacementThumbnail),
  ]);
  if (!object || object.size <= 0) {
    return Response.json({ error: "未检测到已上传的新视频文件，请重试。" }, { status: 409 });
  }
  if (!thumbnailObject || thumbnailObject.size <= 0) {
    return Response.json({ error: "未检测到已上传的新视频封面，请重试。" }, { status: 409 });
  }
  const declaredSize = Math.max(0, Number(body.fileSize) || 0);
  if (declaredSize > 0 && object.size !== declaredSize) {
    return Response.json(
      { error: "上传文件大小与原始文件不一致，请重新上传。" },
      { status: 409 },
    );
  }

  const contentType = body.contentType || "application/octet-stream";
  const swapped = await withDbTransaction(async (transaction) => {
    const updateResult = await transaction
      .prepare(
        `UPDATE videos
        SET object_key = ?, thumbnail_key = ?, original_name = ?, content_type = ?,
          file_size = ?, status = 'READY', rights_confirmed = 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND created_by_email = ? AND deleted_at IS NULL`,
      )
      .bind(
        replacementKey,
        replacementThumbnail,
        originalName,
        contentType,
        object.size,
        id,
        user.identityKey,
      )
      .run();
    if (updateResult.meta.rows_written !== 1) return false;

    await transaction
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'VIDEO_ORIGINAL_REPLACED', 'VIDEO', ?, ?)`,
      )
      .bind(
        newId("audit"),
        user.identityKey,
        id,
        JSON.stringify({
          previousObjectKey: video.object_key,
          previousThumbnailKey: video.thumbnail_key,
          previousOriginalName: video.original_name,
          previousContentType: video.content_type,
          previousFileSize: video.file_size,
          replacementObjectKey: replacementKey,
          replacementThumbnailKey: replacementThumbnail,
          originalName,
          contentType,
          fileSize: object.size,
        }),
      )
      .run();
    return true;
  });

  if (!swapped) {
    return Response.json({ error: "视频状态已变化，请刷新后重试。" }, { status: 409 });
  }

  const [playbackUrl, thumbnailUrl] = await Promise.all([
    bucket.createPresignedGetUrl(replacementKey, { expiresInSeconds: 3 * 60 * 60 }),
    bucket.createPresignedGetUrl(replacementThumbnail, { expiresInSeconds: 3 * 60 * 60 }),
  ]);

  return Response.json({
    ok: true,
    video: {
      originalName,
      contentType,
      fileSize: object.size,
      playbackUrl,
      thumbnailUrl,
      status: "READY",
    },
  });
}
