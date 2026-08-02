import { ensureSchema } from "@/db/bootstrap";
import { getDbClient, getVideoBucket } from "@/db";
import { requireApiUser } from "@/lib/current-user";

type StreamRow = {
  object_key: string;
  content_type: string;
  status: string;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const { id } = await context.params;
  const video = await getDbClient()
    .prepare(
      `SELECT object_key, content_type, status
      FROM videos WHERE id = ? AND deleted_at IS NULL`,
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

  const bucket = getVideoBucket();
  const rangeHeader = request.headers.get("range");
  const head = await bucket.head(video.object_key);
  if (!head) {
    return Response.json({ error: "视频文件不存在。" }, { status: 404 });
  }

  const commonHeaders = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": video.content_type || "application/octet-stream",
    "Cache-Control": "private, no-cache",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  });
  if (head.httpEtag) commonHeaders.set("ETag", head.httpEtag);

  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (match) {
      const start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : head.size - 1;
      const end = Math.min(requestedEnd, head.size - 1);
      if (start <= end && start < head.size) {
        const object = await bucket.get(video.object_key, {
          range: { offset: start, length: end - start + 1 },
        });
        if (object?.body) {
          commonHeaders.set("Content-Length", String(end - start + 1));
          commonHeaders.set(
            "Content-Range",
            `bytes ${start}-${end}/${head.size}`,
          );
          return new Response(object.body, {
            status: 206,
            headers: commonHeaders,
          });
        }
      }
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${head.size}` },
      });
    }
  }

  const object = await bucket.get(video.object_key);
  if (!object?.body) {
    return Response.json({ error: "视频文件不存在。" }, { status: 404 });
  }
  commonHeaders.set("Content-Length", String(head.size));
  return new Response(object.body, { headers: commonHeaders });
}
