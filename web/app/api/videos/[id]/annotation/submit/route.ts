import { getDbClient, withDbTransaction } from "@/db";
import { validateAnnotation } from "@/lib/annotation-server";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { V03_TAXONOMY_VERSION } from "@/lib/taxonomy-v0.3";
import { ensureReviewRoundForSnapshot, sha256Text } from "@/lib/review-workflow";
import { loadSharedV03Annotation } from "@/lib/v03-collaboration";
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
  const shared = await loadSharedV03Annotation(videoId);
  const annotation = shared?.annotation ?? null;

  if (!shared || !annotation?.id) {
    return Response.json({ error: "这个作品尚未建立公共 V0.3。" }, { status: 409 });
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
  const canonicalPayload = JSON.stringify(annotation);
  const hash = await sha256Text(canonicalPayload);
  const existing = await db
    .prepare(
      `SELECT id, content_hash FROM annotation_snapshots
      WHERE id = ? AND annotation_id = ?`,
    )
    .bind(shared.collaboration.currentSnapshotId, annotation.id)
    .first<{ id: string; content_hash: string }>();

  if (existing) {
    if (existing.content_hash !== hash) {
      return Response.json(
        { error: "当前修订号对应的快照内容不一致，请刷新后重试。" },
        { status: 409 },
      );
    }
    const versionCount = await db
      .prepare(
        `SELECT COUNT(*) AS version_count FROM annotation_snapshots
        WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'`,
      )
      .bind(annotation.id)
      .first<{ version_count: number }>();
    const submittedAt = new Date().toISOString();
    await withDbTransaction(async (transaction) => {
      await transaction.prepare(
        `UPDATE annotation_snapshots SET workflow_status = 'SUBMITTED',
          snapshot_kind = 'CANDIDATE', submitted_at = COALESCE(submitted_at, ?),
          version_number = COALESCE(version_number, ?),
          revision_cause = 'SHARED_CANDIDATE'
        WHERE id = ?`,
      ).bind(
        submittedAt,
        Number(versionCount?.version_count ?? 0) + 1,
        existing.id,
      ).run();
      await transaction.prepare(
        `UPDATE annotations SET status = 'SUBMITTED', review_status = 'PENDING_REVIEW',
          active_base_snapshot_id = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(existing.id, submittedAt, submittedAt, annotation.id).run();
      await transaction.prepare(
        `UPDATE v03_collaboration_rounds SET candidate_snapshot_id = ? WHERE id = ?`,
      ).bind(existing.id, shared.collaboration.roundId).run();
      await ensureReviewRoundForSnapshot(transaction, {
        annotationId: annotation.id!,
        videoId,
        snapshotId: existing.id,
      });
      await transaction.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
        VALUES (?, ?, 'SHARED_V03_CANDIDATE_SUBMITTED', 'ANNOTATION_SNAPSHOT', ?, ?)`,
      ).bind(newId("audit"), user.identityKey, existing.id, JSON.stringify({
        streamId: shared.collaboration.streamId,
        roundId: shared.collaboration.roundId,
        revision: annotation.revision,
      })).run();
    });
    return Response.json({
      ok: true,
      snapshotId: existing.id,
      revision: annotation.revision,
      versionNumber: Number(versionCount?.version_count ?? 1),
    });
  }

  const snapshotId = newId("snapshot");
  const previousVersionCount = await db
    .prepare(
      `SELECT COUNT(*) AS version_count FROM annotation_snapshots
      WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'`,
    )
    .bind(annotation.id)
    .first<{ version_count: number }>();

  const priorSnapshot = await db
    .prepare(
      `SELECT id FROM annotation_snapshots
      WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'
      ORDER BY created_at DESC, revision DESC LIMIT 1`,
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
            workflow_status, submitted_at, base_release_id,
            source_public_snapshot_id,
            snapshot_kind
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, 'CANDIDATE')`,
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
          annotation.baseSnapshotId ?? priorSnapshot?.id ?? null,
          versionNumber,
          priorSnapshot ? "COMMENT_RESPONSE" : "INITIAL",
          new Date().toISOString(),
          annotation.baseReleaseId ?? null,
          annotation.sourcePublicSnapshotId ?? null,
        ),
      transaction
        .prepare(
          `UPDATE annotations
          SET status = 'SUBMITTED', review_status = 'PENDING_REVIEW',
            active_base_snapshot_id = ?, submitted_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        )
        .bind(snapshotId, annotation.id),
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
            baseReleaseId: annotation.baseReleaseId,
            baseSnapshotId: annotation.baseSnapshotId,
            sourcePublicSnapshotId: annotation.sourcePublicSnapshotId,
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
      await transaction.prepare(
        `UPDATE v03_collaboration_rounds SET candidate_snapshot_id = ? WHERE id = ?`,
      ).bind(snapshotId, shared.collaboration.roundId).run();
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
