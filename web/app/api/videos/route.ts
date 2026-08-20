import { getDbClient, getVideoBucket } from "@/db";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import {
  createVideoWithSchemaCompatibility,
  loadLegacyVideoSchemaCapabilities,
} from "@/lib/legacy-video-schema-compat";

type VideoRow = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags_json: string;
  thumbnail_key: string | null;
  original_name: string;
  content_type: string;
  file_size: number;
  status: string;
  created_by_name: string;
  created_at: string;
  annotation_count: number;
  has_v03_content: boolean;
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
  const result = await getDbClient()
    .prepare(
      `SELECT
        v.id, v.title, v.brand, v.description, v.tags_json,
        to_jsonb(v)->>'thumbnail_key' AS thumbnail_key,
        v.original_name, v.content_type, v.file_size, v.status,
        v.created_by_name, v.created_at,
        (SELECT COUNT(*) FROM annotation_snapshots s WHERE s.video_id = v.id) AS annotation_count,
        EXISTS (
          SELECT 1 FROM annotations a
          WHERE a.video_id = v.id AND a.taxonomy_version = 'V0.3-PILOT'
            AND a.deleted_at IS NULL
        ) AS has_v03_content
      FROM videos v
      WHERE v.deleted_at IS NULL
        AND COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS'
      ORDER BY v.created_at DESC`,
    )
    .all<VideoRow>();

  const bucket = getVideoBucket();
  const videos = await Promise.all(
    result.results.map(async (row: VideoRow) => ({
      id: row.id,
      title: row.title,
      brand: row.brand,
      description: row.description,
      tags: tagsFromJson(row.tags_json),
      originalName: row.original_name,
      playbackUrl: null,
      thumbnailUrl:
        row.status === "READY" && row.thumbnail_key
          ? await bucket.createPresignedGetUrl(row.thumbnail_key, {
              expiresInSeconds: 3 * 60 * 60,
            })
          : null,
      contentType: row.content_type,
      fileSize: row.file_size,
      status: row.status,
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      annotationCount: Number(row.annotation_count || 0),
      hasV03Content: Boolean(row.has_v03_content),
    })),
  );

  return Response.json({ videos });
}

export async function POST(request: Request) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
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
  const thumbnailKey = `videos/${id}/thumbnail.jpg`;
  const contentType = body.contentType || "application/octet-stream";
  const tags = (body.tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
  const db = getDbClient();
  const bucket = getVideoBucket();
  const [uploadUrl, thumbnailUploadUrl] = await Promise.all([
    bucket.createPresignedPutUrl(objectKey, { contentType }),
    bucket.createPresignedPutUrl(thumbnailKey, { contentType: "image/jpeg" }),
  ]);

  const capabilities = await loadLegacyVideoSchemaCapabilities(db);
  await createVideoWithSchemaCompatibility(db, capabilities, {
    id,
    title,
    brand: body.brand?.trim() ?? "",
    description: body.description?.trim() ?? "",
    tagsJson: JSON.stringify(tags),
    objectKey,
    thumbnailKey,
    originalName,
    contentType,
    fileSize: Math.max(0, Number(body.fileSize) || 0),
    actor: {
      userId: user.id,
      identityKey: user.identityKey,
      displayName: user.displayName,
    },
    requestId: request.headers.get("x-request-id")?.trim() || newId("request"),
  });

  return Response.json(
    { videoId: id, uploadUrl, thumbnailUploadUrl },
    { status: 201 },
  );
}
