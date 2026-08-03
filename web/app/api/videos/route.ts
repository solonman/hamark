import { ensureSchema } from "@/db/bootstrap";
import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

type VideoRow = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  original_name: string;
  content_type: string;
  file_size: number;
  status: string;
  created_by_name: string;
  created_at: string;
  annotation_count: number;
};

function tagsFromJson(value: string) {
  try {
    const tags = JSON.parse(value);
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const result = await getDbClient()
    .prepare(
      `SELECT
        v.id, v.title, v.brand, v.description, v.tags_json,
        v.original_name, v.content_type, v.file_size, v.status,
        v.created_by_name, v.created_at,
        (SELECT COUNT(*) FROM annotation_snapshots s WHERE s.video_id = v.id) AS annotation_count
      FROM videos v
      WHERE v.deleted_at IS NULL
      ORDER BY v.created_at DESC`,
    )
    .all<VideoRow>();

  return Response.json({
    videos: result.results.map((row: VideoRow) => ({
      id: row.id,
      title: row.title,
      brand: row.brand,
      description: row.description,
      tags: tagsFromJson(row.tags_json),
      originalName: row.original_name,
      contentType: row.content_type,
      fileSize: row.file_size,
      status: row.status,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      annotationCount: Number(row.annotation_count || 0),
    })),
  });
}

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  await ensureSchema();
  const body = (await request.json()) as {
    title?: string;
    brand?: string;
    description?: string;
    tags?: string[];
    originalName?: string;
    contentType?: string;
    fileSize?: number;
    rightsConfirmed?: boolean;
  };

  const title = body.title?.trim();
  const originalName = body.originalName?.trim();
  if (!title || !originalName || !body.rightsConfirmed) {
    return Response.json(
      { error: "请填写片名、选择视频，并确认内部学习使用声明。" },
      { status: 400 },
    );
  }

  const id = newId("video");
  const objectKey = `videos/${id}/original`;
  const contentType = body.contentType || "application/octet-stream";
  const tags = (body.tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
  const db = getDbClient();
  const uploadUrl = await getVideoBucket().createPresignedPutUrl(objectKey, { contentType });

  await db.batch([
    db
      .prepare(
        `INSERT INTO videos (
          id, title, brand, description, tags_json, object_key,
          original_name, content_type, file_size, status, rights_confirmed,
          created_by_email, created_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', 1, ?, ?)`,
      )
      .bind(
        id,
        title,
        body.brand?.trim() ?? "",
        body.description?.trim() ?? "",
        JSON.stringify(tags),
        objectKey,
        originalName,
        contentType,
        Math.max(0, Number(body.fileSize) || 0),
        user.identityKey,
        user.displayName,
      ),
    db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'VIDEO_CREATED', 'VIDEO', ?, ?)`,
      )
      .bind(
        newId("audit"),
        user.identityKey,
        id,
        JSON.stringify({ title, originalName }),
      ),
  ]);

  return Response.json(
    { videoId: id, uploadUrl },
    { status: 201 },
  );
}
