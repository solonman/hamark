import { ensureSchema } from "@/db/bootstrap";
import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

type ReplacementRow = {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  file_size: number;
  created_by_email: string;
};

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name)?.trim() ?? "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function PUT(
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
      `SELECT id, object_key, original_name, content_type, file_size,
        created_by_email
      FROM videos
      WHERE id = ? AND deleted_at IS NULL`,
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
  if (request.headers.get("x-rights-confirmed") !== "1") {
    return Response.json(
      { error: "请先确认新素材仅用于公司内部学习与评审。" },
      { status: 400 },
    );
  }
  if (!request.body) {
    return Response.json({ error: "没有收到新的视频文件。" }, { status: 400 });
  }

  const originalName = decodedHeader(request, "x-original-file-name").slice(0, 500);
  if (!originalName) {
    return Response.json({ error: "无法识别新文件名称。" }, { status: 400 });
  }

  const contentType =
    request.headers.get("content-type") || "application/octet-stream";
  const fileSize = Math.max(
    0,
    Number(request.headers.get("x-original-file-size")) ||
      Number(request.headers.get("content-length")) ||
      0,
  );
  const replacementKey = `videos/${id}/replacements/${newId("asset")}`;
  const bucket = getVideoBucket();

  try {
    await bucket.put(replacementKey, request.body, {
      httpMetadata: { contentType },
      customMetadata: {
        videoId: id,
        uploader: user.identityKey,
        replacement: "true",
      },
    });

    await db.batch([
      db
        .prepare(
          `UPDATE videos
          SET object_key = ?, original_name = ?, content_type = ?, file_size = ?,
            status = 'READY', rights_confirmed = 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND created_by_email = ?`,
        )
        .bind(
          replacementKey,
          originalName,
          contentType,
          fileSize,
          id,
          user.identityKey,
        ),
      db
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
            previousOriginalName: video.original_name,
            previousContentType: video.content_type,
            previousFileSize: video.file_size,
            replacementObjectKey: replacementKey,
            originalName,
            contentType,
            fileSize,
          }),
        ),
    ]);
  } catch (error) {
    await bucket.delete(replacementKey).catch(() => undefined);
    const requestId = newId("replace_error");
    console.error("Video replacement failed", { requestId, videoId: id, error });
    return Response.json({ error: "替换失败，请稍后重试。", requestId }, { status: 500 });
  }

  return Response.json({
    ok: true,
    video: {
      originalName,
      contentType,
      fileSize,
      status: "READY",
    },
  });
}
