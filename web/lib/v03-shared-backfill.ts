import { createHash } from "node:crypto";
import type { DbClient } from "@/db";
import { getDbClient } from "@/db";
import { installAdminDataOperationSchema } from "@/lib/admin-data-operations";
import { loadAnnotationById } from "@/lib/annotation-server";
import type { CurrentUser } from "@/lib/auth/types";
import {
  V03_SHARED_BACKFILL_CONFIRMATION,
  type V03SharedBackfillCandidate,
  type V03SharedBackfillPreview,
  type V03SharedBackfillResult,
} from "@/lib/v03-shared-backfill-contract";

type Row = Record<string, unknown>;
type BindValue = string | number | boolean | null;

const OPERATION_PREFIX = "V03_SHARED_STREAM_V0_1_";
const TEST_OPERATION_PREFIX = "TEST_ONLY_V03_SHARED_STREAM_V0_1_";

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class V03SharedBackfillError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "V03SharedBackfillError";
  }
}

function sha(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown) {
  return String(value ?? "");
}

function number(value: unknown) {
  return Number(value ?? 0);
}

async function queryRows(db: DbClient, sql: string, ...values: BindValue[]) {
  return (await db.prepare(sql).bind(...values).all<Row>()).results;
}

function candidateKey(videoId: string) {
  return sha({ videoId, version: "V03_SHARED_STREAM_V0_1" }).slice(0, 24);
}

function operationKey(videoId: string, dataScope: unknown = "BUSINESS") {
  return `${dataScope === "TEST_ONLY" ? TEST_OPERATION_PREFIX : OPERATION_PREFIX}${candidateKey(videoId)}`;
}

async function loadCandidates(db: DbClient) {
  return queryRows(db, `
    WITH v03 AS (
      SELECT a.*,
        COALESCE((SELECT COUNT(*) FROM shots WHERE annotation_id = a.id), 0) AS shots,
        COALESCE((SELECT COUNT(*) FROM shot_groups WHERE annotation_id = a.id), 0) AS groups,
        COALESCE((SELECT COUNT(*) FROM field_answers WHERE annotation_id = a.id), 0) AS fields,
        COALESCE((SELECT COUNT(*) FROM annotation_snapshots WHERE annotation_id = a.id), 0) AS snapshots,
        COALESCE((SELECT COUNT(*) FROM analysis_comments WHERE video_id = a.video_id), 0) AS comments,
        COALESCE((SELECT COUNT(*) FROM analysis_revision_events WHERE video_id = a.video_id), 0) AS revision_events,
        COALESCE((SELECT COUNT(*) FROM analysis_review_rounds WHERE video_id = a.video_id), 0) AS review_rounds,
        COALESCE((SELECT COUNT(*) FROM approved_analysis_releases WHERE video_id = a.video_id), 0) AS releases,
        COALESCE((SELECT MIN(revision) FROM annotation_snapshots WHERE annotation_id = a.id), 0) - 1 AS baseline_storage_revision,
        ROW_NUMBER() OVER (
          PARTITION BY a.video_id
          ORDER BY
            CASE WHEN EXISTS (
              SELECT 1 FROM approved_analysis_releases active_release
              WHERE active_release.annotation_id = a.id AND active_release.status = 'ACTIVE'
            ) THEN 0 ELSE 1 END,
            CASE WHEN EXISTS (
              SELECT 1 FROM annotation_snapshots submitted
              WHERE submitted.annotation_id = a.id AND submitted.workflow_status = 'SUBMITTED'
            ) THEN 0 ELSE 1 END,
            a.updated_at DESC, a.revision DESC, a.id
        ) AS canonical_rank
      FROM annotations a
      INNER JOIN videos video ON video.id = a.video_id
      WHERE a.taxonomy_version = 'V0.3-PILOT' AND a.deleted_at IS NULL
        AND video.deleted_at IS NULL
    )
    SELECT v03.*, video.title AS video_title, video.data_scope, video.test_run_id,
      (SELECT COUNT(*) FROM annotations sibling
        WHERE sibling.video_id = v03.video_id
          AND sibling.taxonomy_version = 'V0.3-PILOT'
          AND sibling.deleted_at IS NULL) AS annotation_count,
      active_release.id AS active_release_id,
      active_release.release_number AS active_release_number,
      active_release.approved_snapshot_id AS active_release_snapshot_id,
      stream.id AS stream_id,
      stream.initial_baseline_id,
      stream.active_round_id,
      mapped.operation_key AS mapped_operation_key,
      mapped.operation_type AS mapped_operation_type
      ,current_snapshot.id AS current_revision_snapshot_id
      ,current_snapshot.content_hash AS current_revision_snapshot_hash
      ,current_snapshot.payload_json AS current_revision_snapshot_payload
    FROM v03
    INNER JOIN videos video ON video.id = v03.video_id
    LEFT JOIN LATERAL (
      SELECT release.id, release.release_number, release.approved_snapshot_id
      FROM approved_analysis_releases release
      WHERE release.video_id = v03.video_id AND release.status = 'ACTIVE'
      ORDER BY release.approved_at DESC LIMIT 1
    ) active_release ON TRUE
    LEFT JOIN v03_collaboration_streams stream
      ON stream.video_id = v03.video_id AND stream.taxonomy_version = 'V0.3-PILOT'
    LEFT JOIN LATERAL (
      SELECT operation.operation_key, operation.operation_type
      FROM admin_data_operations operation
      WHERE operation.target_video_id = v03.video_id
        AND operation.operation_type IN ('V02_TO_V03_AUTHOR_BATCH', 'V02_TO_V03_CASE_MAPPING')
        AND operation.status = 'COMPLETED'
      ORDER BY operation.completed_at DESC LIMIT 1
    ) mapped ON TRUE
    LEFT JOIN LATERAL (
      SELECT snapshot.id, snapshot.content_hash, snapshot.payload_json
      FROM annotation_snapshots snapshot
      WHERE snapshot.annotation_id = v03.id AND snapshot.revision = v03.revision
      ORDER BY snapshot.created_at DESC, snapshot.id DESC LIMIT 1
    ) current_snapshot ON TRUE
    WHERE v03.canonical_rank = 1
    ORDER BY video.created_at, video.title, v03.video_id`);
}

function immutableCounts(row: Row) {
  return {
    annotations: number(row.annotation_count),
    shots: number(row.shots),
    groups: number(row.groups),
    fields: number(row.fields),
    snapshots: number(row.snapshots),
    comments: number(row.comments),
    revisionEvents: number(row.revision_events),
    reviewRounds: number(row.review_rounds),
    releases: number(row.releases),
  };
}

function sourceType(row: Row): V03SharedBackfillCandidate["sourceType"] {
  if (row.active_release_id) return "APPROVED_RELEASE";
  if (row.mapped_operation_key) return "V02_MAPPED";
  return "EXISTING_V03";
}

function mappingKind(row: Row): V03SharedBackfillCandidate["mappingKind"] {
  if (row.mapped_operation_type === "V02_TO_V03_AUTHOR_BATCH") return "BATCH";
  if (row.mapped_operation_type === "V02_TO_V03_CASE_MAPPING") return "SINGLE_CASE";
  return null;
}

function contentFingerprint(payload: unknown) {
  if (!payload || typeof payload !== "object") return sha(null);
  const source = structuredClone(payload) as Row;
  for (const key of [
    "id", "status", "reviewStatus", "activeBaseSnapshotId", "baseReleaseId",
    "baseSnapshotId", "sourcePublicSnapshotId", "baseReleaseNumber", "revision",
    "updatedAt", "authorName",
  ]) delete source[key];
  return sha(source);
}

function inspectRow(row: Row): V03SharedBackfillCandidate {
  const reasons: string[] = [];
  const completed = Boolean(row.stream_id && row.initial_baseline_id && row.active_round_id);
  if (!text(row.id)) reasons.push("缺少可作为公共正文的 V0.3 annotation。");
  if (number(row.shots) < 1) reasons.push("V0.3 当前正文没有镜头，不能建立非空公共基线。");
  if (number(row.groups) < 1) reasons.push("V0.3 当前正文没有桥段，不能建立非空公共基线。");
  const status = completed ? "COMPLETED" : reasons.length ? "BLOCKED" : "READY";
  const core = {
    videoId: text(row.video_id),
    annotationId: text(row.id),
    revision: number(row.revision),
    sourceType: sourceType(row),
    mappedOrigin: Boolean(row.mapped_operation_key),
    mappingKind: mappingKind(row),
    activeReleaseId: text(row.active_release_id),
    counts: immutableCounts(row),
  };
  return {
    candidateKey: candidateKey(text(row.video_id)),
    previewToken: status === "READY" ? sha(core) : null,
    videoId: text(row.video_id),
    videoTitle: text(row.video_title),
    canonicalAnnotationId: text(row.id),
    sourceAuthorName: text(row.author_name),
    currentRevision: number(row.revision),
    status,
    sourceType: sourceType(row),
    mappedOrigin: Boolean(row.mapped_operation_key),
    mappingKind: mappingKind(row),
    activeReleaseNumber: row.active_release_number == null
      ? null
      : number(row.active_release_number),
    counts: immutableCounts(row),
    reasons,
  };
}

function matchingCurrentSnapshot(row: Row, annotation: unknown) {
  if (!row.current_revision_snapshot_id || !annotation) return null;
  const snapshotPayload = typeof row.current_revision_snapshot_payload === "string"
    ? JSON.parse(row.current_revision_snapshot_payload) as unknown
    : row.current_revision_snapshot_payload;
  return contentFingerprint(snapshotPayload) === contentFingerprint(annotation)
    ? text(row.current_revision_snapshot_id)
    : null;
}

async function inspectAll(db: DbClient) {
  const rows = await loadCandidates(db);
  const inspected: Array<{
    row: Row;
    annotation: Awaited<ReturnType<typeof loadAnnotationById>>;
    candidate: V03SharedBackfillCandidate;
  }> = [];
  for (const row of rows) {
    const annotation = await loadAnnotationById(text(row.id), db);
    inspected.push({ row, annotation, candidate: inspectRow(row) });
  }
  return inspected;
}

export async function previewV03SharedBackfill(
  db: DbClient = getDbClient(),
): Promise<V03SharedBackfillPreview> {
  await installAdminDataOperationSchema(db);
  const inspected = await inspectAll(db);
  const candidates = inspected.map((item) => item.candidate);
  return {
    confirmation: V03_SHARED_BACKFILL_CONFIRMATION,
    summary: {
      videosWithV03: candidates.length,
      ready: candidates.filter((item) => item.status === "READY").length,
      completed: candidates.filter((item) => item.status === "COMPLETED").length,
      blocked: candidates.filter((item) => item.status === "BLOCKED").length,
      batchMapped: candidates.filter((item) => item.mappingKind === "BATCH").length,
      singleCaseMapped: candidates.filter((item) => item.mappingKind === "SINGLE_CASE").length,
      existingV03: candidates.filter((item) => !item.mappedOrigin).length,
    },
    candidates,
  };
}

function resultFromLedger(row: Row): V03SharedBackfillResult {
  const result = typeof row.result_json === "string"
    ? JSON.parse(row.result_json) as V03SharedBackfillResult
    : row.result_json as V03SharedBackfillResult;
  return { ...result, alreadyApplied: true };
}

export async function applyV03SharedBackfillCandidate(args: {
  actor: CurrentUser;
  candidateKey: string;
  previewToken: string;
  confirmation: string;
  db?: DbClient;
  failAfterCreateForTest?: boolean;
}) {
  if (args.confirmation !== V03_SHARED_BACKFILL_CONFIRMATION) {
    throw new V03SharedBackfillError("CONFIRMATION_MISMATCH", "确认口令不匹配。", 400);
  }
  const db = args.db ?? getDbClient();
  return db.withTransaction(async (tx) => {
    await tx.prepare(`SELECT pg_advisory_xact_lock(?)`).bind(913082026).run();
    await installAdminDataOperationSchema(tx);
    const inspected = await inspectAll(tx);
    const item = inspected.find(({ candidate }) => candidate.candidateKey === args.candidateKey);
    if (!item) throw new V03SharedBackfillError("CANDIDATE_NOT_FOUND", "候选作品不存在。", 404);
    const ledger = await tx.prepare(
      `SELECT status, result_json FROM admin_data_operations WHERE operation_key = ? FOR UPDATE`,
    ).bind(operationKey(item.candidate.videoId, item.row.data_scope)).first<Row>();
    if (text(ledger?.status) === "COMPLETED") return resultFromLedger(ledger!);
    if (item.candidate.status === "COMPLETED") {
      return {
        alreadyApplied: true,
        operationKey: operationKey(item.candidate.videoId, item.row.data_scope),
        videoId: item.candidate.videoId,
        videoTitle: item.candidate.videoTitle,
        streamId: text(item.row.stream_id),
        baselineId: text(item.row.initial_baseline_id),
        roundId: text(item.row.active_round_id),
        canonicalAnnotationId: item.candidate.canonicalAnnotationId,
        completedAt: new Date().toISOString(),
        preservedBusinessRows: true,
      } satisfies V03SharedBackfillResult;
    }
    if (item.candidate.status !== "READY" || !item.candidate.previewToken) {
      throw new V03SharedBackfillError(
        "PRECONDITION_FAILED",
        item.candidate.reasons.join("；") || "候选不满足共享接入条件。",
      );
    }
    if (args.previewToken !== item.candidate.previewToken) {
      throw new V03SharedBackfillError("PREVIEW_STALE", "数据已变化，请重新执行 PREVIEW。", 409);
    }
    if (args.failAfterCreateForTest && item.row.data_scope !== "TEST_ONLY") {
      throw new V03SharedBackfillError(
        "TEST_HOOK_REJECTED",
        "测试回滚钩子只能用于 TEST_ONLY 数据。",
        400,
      );
    }
    await tx.prepare(
      `SELECT id FROM annotations WHERE video_id = ? AND taxonomy_version = 'V0.3-PILOT'
      AND deleted_at IS NULL FOR UPDATE`,
    ).bind(item.candidate.videoId).all();
    const locked = (await inspectAll(tx)).find(
      ({ candidate }) => candidate.candidateKey === args.candidateKey,
    );
    if (!locked || locked.candidate.previewToken !== args.previewToken) {
      throw new V03SharedBackfillError("PREVIEW_STALE", "锁定后数据已变化，请重新预检。", 409);
    }
    const annotation = locked.annotation ?? await loadAnnotationById(item.candidate.canonicalAnnotationId, tx);
    if (!annotation) throw new V03SharedBackfillError("CANONICAL_MISSING", "公共正文不存在。", 409);
    const before = {
      candidate: item.candidate,
      annotationPayloadHash: sha(annotation),
      counts: item.candidate.counts,
    };
    const createdAt = new Date().toISOString();
    const opKey = operationKey(item.candidate.videoId, item.row.data_scope);
    const streamId = newId("collaboration_stream");
    const baselineId = newId("collaboration_baseline");
    const roundId = newId("collaboration_round");
    const reusedCurrentSnapshotId = matchingCurrentSnapshot(item.row, annotation);
    const currentSnapshotId = reusedCurrentSnapshotId || newId("working_snapshot");
    await tx.prepare(
      `INSERT INTO admin_data_operations (
        operation_key, operation_type, target_video_id, status,
        actor_identity, actor_name, preview_token, source_hash, target_hash,
        non_target_hash, backup_json, created_at
      ) VALUES (?, 'V03_SHARED_STREAM_BACKFILL', ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
    ).bind(
      opKey,
      item.candidate.videoId,
      args.actor.identityKey,
      args.actor.displayName,
      args.previewToken,
      sha(before),
      sha(null),
      sha(item.candidate.counts),
      JSON.stringify({ kind: "V03_SHARED_STREAM_PREWRITE", before }),
      createdAt,
    ).run();
    await tx.prepare(
      `INSERT INTO v03_collaboration_streams (
        id, video_id, taxonomy_version, canonical_annotation_id,
        initial_baseline_id, active_round_id, active_release_id,
        current_snapshot_id, source_author_email, source_author_name,
        status, created_by_email, created_by_name, created_at, updated_at
      ) VALUES (?, ?, 'V0.3-PILOT', ?, NULL, NULL, ?, NULL, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
    ).bind(
      streamId,
      item.candidate.videoId,
      item.candidate.canonicalAnnotationId,
      text(item.row.active_release_id) || null,
      text(item.row.author_email),
      item.candidate.sourceAuthorName,
      args.actor.identityKey,
      args.actor.displayName,
      createdAt,
      createdAt,
    ).run();
    const allAnnotations = await queryRows(tx,
      `SELECT id, author_email, author_name, source_snapshot_id
      FROM annotations WHERE video_id = ? AND taxonomy_version = 'V0.3-PILOT'
        AND deleted_at IS NULL ORDER BY created_at, id`,
      item.candidate.videoId,
    );
    for (const source of allAnnotations) {
      await tx.prepare(
        `INSERT INTO v03_collaboration_sources (
          id, stream_id, annotation_id, relation_type,
          source_author_email, source_author_name
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId("collaboration_source"),
        streamId,
        text(source.id),
        text(source.id) === item.candidate.canonicalAnnotationId
          ? "CANONICAL"
          : "LEGACY_CONTRIBUTOR",
        text(source.author_email),
        text(source.author_name),
      ).run();
    }
    await tx.prepare(
      `INSERT INTO v03_collaboration_baselines (
        id, stream_id, annotation_id, source_type, source_snapshot_id,
        source_operation_key, payload_json, content_hash,
        source_author_email, source_author_name, created_by_email, created_by_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`,
    ).bind(
      baselineId,
      streamId,
      item.candidate.canonicalAnnotationId,
      item.candidate.sourceType,
      text(item.row.source_snapshot_id) || null,
      text(item.row.mapped_operation_key) || null,
      JSON.stringify(annotation),
      sha(annotation),
      text(item.row.author_email),
      item.candidate.sourceAuthorName,
      args.actor.identityKey,
      args.actor.displayName,
    ).run();
    if (!reusedCurrentSnapshotId) {
      await tx.prepare(
        `INSERT INTO annotation_snapshots (
          id, annotation_id, video_id, author_email, author_name,
          taxonomy_version, revision, payload_json, content_hash,
          revision_cause, workflow_status, snapshot_kind,
          base_release_id, source_public_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, 'V0.3-PILOT', ?, ?::text, ?,
          'SHARED_INITIAL_BASELINE', 'WORKING', 'BASELINE', ?, ?)`,
      ).bind(
        currentSnapshotId,
        item.candidate.canonicalAnnotationId,
        item.candidate.videoId,
        text(item.row.author_email),
        item.candidate.sourceAuthorName,
        number(item.row.baseline_storage_revision),
        JSON.stringify(annotation),
        sha(annotation),
        text(item.row.active_release_id) || null,
        text(item.row.source_snapshot_id) || null,
      ).run();
    }
    await tx.prepare(
      `INSERT INTO v03_collaboration_rounds (
        id, stream_id, annotation_id, round_number, status, base_type,
        base_baseline_id, base_release_id, base_snapshot_id,
        starting_revision, created_by_email, created_by_name
      ) VALUES (?, ?, ?, 1, 'ACTIVE', 'INITIAL_BASELINE', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      roundId,
      streamId,
      item.candidate.canonicalAnnotationId,
      baselineId,
      text(item.row.active_release_id) || null,
      text(item.row.active_release_id)
        ? text(item.row.active_release_snapshot_id) || null
        : null,
      item.candidate.currentRevision,
      args.actor.identityKey,
      args.actor.displayName,
    ).run();
    await tx.prepare(
      `UPDATE v03_collaboration_streams SET initial_baseline_id = ?,
        active_round_id = ?, current_snapshot_id = ?, updated_at = ?
      WHERE id = ?`,
    ).bind(baselineId, roundId, currentSnapshotId, createdAt, streamId).run();
    if (args.failAfterCreateForTest) {
      throw new V03SharedBackfillError("TEST_ROLLBACK", "TEST_ONLY 强制回滚。", 409);
    }
    const afterAnnotation = await loadAnnotationById(item.candidate.canonicalAnnotationId, tx);
    const afterCounts = (await inspectAll(tx)).find(
      ({ candidate }) => candidate.candidateKey === args.candidateKey,
    )?.candidate.counts;
    if (!afterAnnotation || sha(afterAnnotation) !== before.annotationPayloadHash) {
      throw new V03SharedBackfillError("CONTENT_CHANGED", "共享接入改变了正文，事务已回滚。", 409);
    }
    const expectedCounts = {
      ...before.counts,
      snapshots: before.counts.snapshots + (reusedCurrentSnapshotId ? 0 : 1),
    };
    if (sha(afterCounts) !== sha(expectedCounts)) {
      throw new V03SharedBackfillError("HISTORY_CHANGED", "共享接入改变了历史计数，事务已回滚。", 409);
    }
    const completedAt = new Date().toISOString();
    const result: V03SharedBackfillResult = {
      alreadyApplied: false,
      operationKey: opKey,
      videoId: item.candidate.videoId,
      videoTitle: item.candidate.videoTitle,
      streamId,
      baselineId,
      roundId,
      canonicalAnnotationId: item.candidate.canonicalAnnotationId,
      completedAt,
      preservedBusinessRows: true,
    };
    await tx.prepare(
      `UPDATE admin_data_operations SET status = 'COMPLETED', result_json = ?::jsonb,
        completed_at = ? WHERE operation_key = ? AND status = 'RUNNING'`,
    ).bind(JSON.stringify(result), completedAt, opKey).run();
    await tx.prepare(
      `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
      VALUES (?, ?, 'V03_SHARED_STREAM_BACKFILLED', 'V03_COLLABORATION_STREAM', ?, ?)`,
    ).bind(newId("audit"), args.actor.identityKey, streamId, JSON.stringify(result)).run();
    return result;
  });
}
