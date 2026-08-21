import { getDbClient, getVideoBucket } from "@/db";
import { requireApiUser } from "@/lib/current-user";

type StreamRow = {
  object_key: string;
  thumbnail_key: string | null;
  status: string;
};

const PLAYBACK_URL_TTL_SECONDS = 15 * 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const video = await getDbClient()
    .prepare(
      `SELECT v.object_key, v.status,
              to_jsonb(v)->>'thumbnail_key' AS thumbnail_key
         FROM videos v
        WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(id)
    .first<StreamRow>();

  if (!video || video.status !== "READY") {
    return Response.json({ error: "视频尚未准备好。" }, { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  if (download) {
    return Response.json(
      { error: "当前版本仅允许站内播放，不提供原始视频下载。" },
      { status: 403 },
    );
  }

  const asset = new URL(request.url).searchParams.get("asset");
  if (asset && asset !== "thumbnail") {
    return Response.json({ error: "不支持的媒体资源类型。" }, { status: 400 });
  }
  const objectKey =
    asset === "thumbnail" ? video.thumbnail_key : video.object_key;
  if (!objectKey) {
    return Response.json(
      { error: asset === "thumbnail" ? "视频封面不存在。" : "视频文件不存在。" },
      { status: 404 },
    );
  }

  // The authenticated route authorizes this exact READY video object, then
  // redirects the browser to a short-lived object-scoped COS URL. Range and
  // conditional requests are preserved by 307 and handled by COS directly;
  // video bytes never traverse the serverless function.
  const location = await getVideoBucket().createPresignedGetUrl(objectKey, {
    expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
  });
  return new Response(null, {
    status: 307,
    headers: {
      Location: location,
      "Cache-Control": "private, max-age=300, no-transform",
      "Content-Disposition": "inline",
      "Referrer-Policy": "no-referrer",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
