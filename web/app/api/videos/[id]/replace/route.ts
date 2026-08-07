import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  replacementObjectKey,
  replacementThumbnailKey,
} from "@/lib/video-replacement";

type ReplacementRow = {
  id: string;
  created_by_email: string;
};

// The replacement file goes straight from the browser to COS with a presigned PUT.
// It must never stream through this function: serverless request bodies are capped
// well below a normal video, and the platform rejects the upload before the handler runs.
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
    originalName?: string;
    contentType?: string;
    rightsConfirmed?: boolean;
  };

  const db = getDbClient();
  const video = await db
    .prepare(
      `SELECT id, created_by_email
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
  if (!body.rightsConfirmed) {
    return Response.json(
      { error: "请先确认新素材仅用于公司内部学习与评审。" },
      { status: 400 },
    );
  }
  if (!body.originalName?.trim()) {
    return Response.json({ error: "无法识别新文件名称。" }, { status: 400 });
  }

  const assetId = newId("asset");
  const contentType = body.contentType || "application/octet-stream";
  const bucket = getVideoBucket();
  const [uploadUrl, thumbnailUploadUrl] = await Promise.all([
    bucket.createPresignedPutUrl(replacementObjectKey(id, assetId), { contentType }),
    bucket.createPresignedPutUrl(replacementThumbnailKey(id, assetId), {
      contentType: "image/jpeg",
    }),
  ]);

  return Response.json({ assetId, uploadUrl, thumbnailUploadUrl }, { status: 201 });
}
