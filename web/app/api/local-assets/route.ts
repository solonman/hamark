import { getVideoBucket } from "@/db";
import { requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { isLocalDemoMode } from "@/lib/local-demo";
import { localObjectContentType, localObjectPath } from "@/storage/local";

function objectKey(request: Request) {
  const key = new URL(request.url).searchParams.get("key") || "";
  localObjectPath(key);
  return key;
}

function unavailable() {
  return Response.json({ error: "本地素材接口不可用。" }, { status: 404 });
}

export async function PUT(request: Request) {
  if (!isLocalDemoMode()) return unavailable();
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!request.body) return Response.json({ error: "上传内容为空。" }, { status: 400 });

  try {
    await getVideoBucket().put(objectKey(request), request.body, {
      httpMetadata: {
        contentType: request.headers.get("content-type") || "application/octet-stream",
      },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "本地素材写入失败。" },
      { status: 400 },
    );
  }
}

export async function GET(request: Request) {
  if (!isLocalDemoMode()) return unavailable();
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;

  try {
    const key = objectKey(request);
    const bucket = getVideoBucket();
    const head = await bucket.head(key);
    if (!head) return Response.json({ error: "素材不存在。" }, { status: 404 });

    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache",
      "Content-Disposition": "inline",
      "Content-Type": await localObjectContentType(key),
      "X-Content-Type-Options": "nosniff",
    });
    if (head.httpEtag) headers.set("ETag", head.httpEtag);

    const range = request.headers.get("range");
    const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (range && !match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${head.size}` },
      });
    }
    if (match) {
      const start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : head.size - 1;
      const end = Math.min(requestedEnd, head.size - 1);
      if (start > end || start >= head.size) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${head.size}` },
        });
      }
      const object = await bucket.get(key, {
        range: { offset: start, length: end - start + 1 },
      });
      headers.set("Content-Length", String(end - start + 1));
      headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
      return new Response(object?.body ?? null, { status: 206, headers });
    }

    const object = await bucket.get(key);
    headers.set("Content-Length", String(head.size));
    return new Response(object?.body ?? null, { headers });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "本地素材读取失败。" },
      { status: 400 },
    );
  }
}
