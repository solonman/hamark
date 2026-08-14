import { withDbTransaction } from "@/db";
import { validateAnnotation } from "@/lib/annotation-server";
import { newId, requireApiUser, requireSameOriginMutation } from "@/lib/current-user";
import { V03_TAXONOMY_VERSION } from "@/lib/taxonomy-v0.3";
import { ensureReviewRoundForSnapshot, sha256Text } from "@/lib/review-workflow";
import {
  loadSharedV03Annotation,
  sharedContentFingerprint,
} from "@/lib/v03-collaboration";
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

  // 读工作稿、比对快照、提升为候选必须在同一把逻辑工作区锁内完成，
  // 用的是和保存路径相同的那把锁。否则中间任何一次并发保存都会让前后两次读
  // 落在不同修订上，把正常的提交误判成"内容不一致"。
  return withDbTransaction(async (db) => {
    await db
      .prepare(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`)
      .bind(`v03-logical-workspace:${videoId}`)
      .run();

    const shared = await loadSharedV03Annotation(videoId, db);
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

    const canonicalPayload = JSON.stringify(annotation);
    const hash = await sha256Text(canonicalPayload);
    const existing = await db
      .prepare(
        `SELECT id, payload_json FROM annotation_snapshots
        WHERE id = ? AND annotation_id = ?`,
      )
      .bind(shared.collaboration.currentSnapshotId, annotation.id)
      .first<{ id: string; payload_json: unknown }>();

    if (existing) {
      // 这里不再拿快照去和工作稿比对来决定放行与否。原来的字节哈希比对会把
      // "同一份内容的两种序列化"判成冲突，而它给出的"刷新后重试"永远修不好；
      // 而快照的 revision 也当不了并发信号 —— 回填基线固定是 -1。
      // 并发已经由上面那把逻辑工作区锁挡住，这里只需记录快照是否确实落后。
      const storedPayload =
        typeof existing.payload_json === "string"
          ? (JSON.parse(existing.payload_json) as unknown)
          : existing.payload_json;
      const contentDiverged =
        sharedContentFingerprint(storedPayload) !==
        sharedContentFingerprint(annotation);
      const versionCount = await db
        .prepare(
          `SELECT COUNT(*) AS version_count FROM annotation_snapshots
          WHERE annotation_id = ? AND workflow_status = 'SUBMITTED'`,
        )
        .bind(annotation.id)
        .first<{ version_count: number }>();
      const submittedAt = new Date().toISOString();
      // 候选快照必须装着这一修订在库里的真实内容，所以提升时一并用当前工作稿
      // 重写 payload 与哈希；锁已经保证了它不会在这中间再变。
      await db.prepare(
        `UPDATE annotation_snapshots SET workflow_status = 'SUBMITTED',
          snapshot_kind = 'CANDIDATE', submitted_at = COALESCE(submitted_at, ?),
          version_number = COALESCE(version_number, ?),
          revision_cause = 'SHARED_CANDIDATE',
          payload_json = ?, content_hash = ?
        WHERE id = ?`,
      ).bind(
        submittedAt,
        Number(versionCount?.version_count ?? 0) + 1,
        canonicalPayload,
        hash,
        existing.id,
      ).run();
      await db.prepare(
        `UPDATE annotations SET status = 'SUBMITTED', review_status = 'PENDING_REVIEW',
          active_base_snapshot_id = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(existing.id, submittedAt, submittedAt, annotation.id).run();
      await db.prepare(
        `UPDATE v03_collaboration_rounds SET candidate_snapshot_id = ? WHERE id = ?`,
      ).bind(existing.id, shared.collaboration.roundId).run();
      await ensureReviewRoundForSnapshot(db, {
        annotationId: annotation.id!,
        videoId,
        snapshotId: existing.id,
      });
      await db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
        VALUES (?, ?, 'SHARED_V03_CANDIDATE_SUBMITTED', 'ANNOTATION_SNAPSHOT', ?, ?)`,
      ).bind(newId("audit"), user.identityKey, existing.id, JSON.stringify({
        streamId: shared.collaboration.streamId,
        roundId: shared.collaboration.roundId,
        revision: annotation.revision,
        // 键序差异已被指纹忽略；这里为真时是工作快照确实落后于关系表，留痕备查。
        contentDiverged,
      })).run();
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

    {
      const transaction = db;
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
    }

    return Response.json({
      ok: true,
      snapshotId,
      revision: annotation.revision,
      versionNumber,
      contentHash: hash,
    });
  });
}
