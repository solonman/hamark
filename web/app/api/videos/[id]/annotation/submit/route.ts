import { getDbClient } from "@/db";
import { loadAnnotation, validateAnnotation } from "@/lib/annotation-server";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { id: videoId } = await context.params;
  const annotation = await loadAnnotation(videoId, user.identityKey, user.displayName);

  if (!annotation.id) {
    return Response.json({ error: "请先保存作业。" }, { status: 400 });
  }

  const missing = validateAnnotation(annotation);
  if (missing.length) {
    return Response.json(
      {
        error: `还有 ${missing.length} 项需要完成。`,
        missing,
      },
      { status: 400 },
    );
  }

  const db = getDbClient();
  const existing = await db
    .prepare(
      `SELECT id FROM annotation_snapshots
      WHERE annotation_id = ? AND revision = ?`,
    )
    .bind(annotation.id, annotation.revision)
    .first<{ id: string }>();

  if (existing) {
    return Response.json({
      ok: true,
      snapshotId: existing.id,
      revision: annotation.revision,
    });
  }

  const canonicalPayload = JSON.stringify(annotation);
  const hash = await sha256(canonicalPayload);
  const snapshotId = newId("snapshot");

  await db.batch([
    db
      .prepare(
        `INSERT INTO annotation_snapshots (
          id, annotation_id, video_id, author_email, author_name,
          taxonomy_version, revision, payload_json, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        snapshotId,
        annotation.id,
        videoId,
        user.identityKey,
        user.displayName,
        annotation.taxonomyVersion,
        annotation.revision,
        canonicalPayload,
        hash,
      ),
    db
      .prepare(
        `UPDATE annotations
        SET status = 'SUBMITTED', submitted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      )
      .bind(annotation.id),
    db
      .prepare(
        `INSERT INTO audit_logs (
          id, actor_email, action, object_type, object_id, detail_json
        ) VALUES (?, ?, 'ANNOTATION_SUBMITTED', 'ANNOTATION', ?, ?)`,
      )
      .bind(
        newId("audit"),
        user.identityKey,
        annotation.id,
        JSON.stringify({
          videoId,
          revision: annotation.revision,
          taxonomyVersion: annotation.taxonomyVersion,
          contentHash: hash,
        }),
      ),
  ]);

  return Response.json({
    ok: true,
    snapshotId,
    revision: annotation.revision,
    contentHash: hash,
  });
}
