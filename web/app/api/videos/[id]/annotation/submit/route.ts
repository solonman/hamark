import { getDbClient, withDbTransaction } from "@/db";
import { loadAnnotation, validateAnnotation } from "@/lib/annotation-server";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { V03_TAXONOMY_VERSION } from "@/lib/taxonomy-v0.3";
import { ensureReviewRoundForSnapshot, sha256Text } from "@/lib/review-workflow";
import type { TaxonomyVersion } from "@/lib/types";

function requestedTaxonomy(request: Request): TaxonomyVersion | null {
  const value = new URL(request.url).searchParams.get("taxonomy") ?? "V0.2";
  return value === "V0.2" || value === V03_TAXONOMY_VERSION ? value : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const taxonomyVersion = requestedTaxonomy(request);
  if (!taxonomyVersion) {
    return Response.json({ error: "不支持的标注体系版本。" }, { status: 400 });
  }
  if (taxonomyVersion === "V0.2") {
    return Response.json(
      { error: "V0.2 已归档为历史体系，只读保留；请使用当前逆向体系。" },
      { status: 409 },
    );
  }
  const { id: videoId } = await context.params;
  const annotation = await loadAnnotation(
    videoId,
    user.identityKey,
    user.displayName,
    taxonomyVersion,
  );

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
    const versionCount = await db
      .prepare(
        `SELECT COUNT(*) AS version_count FROM annotation_snapshots
        WHERE annotation_id = ?`,
      )
      .bind(annotation.id)
      .first<{ version_count: number }>();
    if (annotation.taxonomyVersion === V03_TAXONOMY_VERSION) {
      await ensureReviewRoundForSnapshot(db, {
        annotationId: annotation.id,
        videoId,
        snapshotId: existing.id,
      });
    }
    return Response.json({
      ok: true,
      snapshotId: existing.id,
      revision: annotation.revision,
      versionNumber: Number(versionCount?.version_count ?? 1),
    });
  }

  const canonicalPayload = JSON.stringify(annotation);
  const hash = await sha256Text(canonicalPayload);
  const snapshotId = newId("snapshot");
  const previousVersionCount = await db
    .prepare(
      `SELECT COUNT(*) AS version_count FROM annotation_snapshots
      WHERE annotation_id = ?`,
    )
    .bind(annotation.id)
    .first<{ version_count: number }>();

  const priorSnapshot = await db
    .prepare(
      `SELECT id FROM annotation_snapshots
      WHERE annotation_id = ? ORDER BY created_at DESC, revision DESC LIMIT 1`,
    )
    .bind(annotation.id)
    .first<{ id: string }>();
  const versionNumber = Number(previousVersionCount?.version_count ?? 0) + 1;

  await withDbTransaction(async (transaction) => {
    await transaction.batch([
      transaction
        .prepare(
          `INSERT INTO annotation_snapshots (
            id, annotation_id, video_id, author_email, author_name,
            taxonomy_version, revision, payload_json, content_hash,
            base_snapshot_id, version_number, revision_cause,
            workflow_status, submitted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?)`,
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
          priorSnapshot?.id ?? null,
          versionNumber,
          priorSnapshot ? "COMMENT_RESPONSE" : "INITIAL",
          new Date().toISOString(),
        ),
      transaction
        .prepare(
          `UPDATE annotations
          SET status = 'SUBMITTED', submitted_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        )
        .bind(annotation.id),
      transaction
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
            workflowVersion: annotation.workflowVersion,
            sourceSnapshotId: annotation.sourceSnapshotId,
            contentHash: hash,
          }),
        ),
    ]);
    if (annotation.taxonomyVersion === V03_TAXONOMY_VERSION) {
      await ensureReviewRoundForSnapshot(transaction, {
        annotationId: annotation.id!,
        videoId,
        snapshotId,
      });
    }
  });

  return Response.json({
    ok: true,
    snapshotId,
    revision: annotation.revision,
    versionNumber,
    contentHash: hash,
  });
}
