import { getDbClient } from "../db/index.ts";

const db = getDbClient();

const releases = await db.prepare(
  `SELECT r.id, r.release_number, r.status, r.approved_at, r.approved_by_name,
    r.source_snapshot_id, r.approved_snapshot_id, r.source_review_round_id,
    r.expert_creative_grade, v.id AS video_id, v.title AS video_title,
    COALESCE(v.data_scope, 'BUSINESS') AS data_scope,
    source.author_name AS source_author_name,
    source.created_at AS source_created_at,
    round.round_number, round.status AS round_status,
    round.reviewer_name, round.decision_note
  FROM approved_analysis_releases r
  INNER JOIN videos v ON v.id = r.video_id
  INNER JOIN annotation_snapshots source ON source.id = r.source_snapshot_id
  INNER JOIN analysis_review_rounds round ON round.id = r.source_review_round_id
  WHERE r.release_number = 5
  ORDER BY r.approved_at ASC`,
).all<Record<string, string | number | null>>();

const publicV14 = await db.prepare(
  `WITH public_versions AS (
    SELECT s.id, s.annotation_id, s.video_id, s.author_name, s.created_at,
      s.submitted_at, s.revision, s.revision_cause, s.base_snapshot_id,
      s.base_release_id, s.source_public_snapshot_id,
      ROW_NUMBER() OVER (PARTITION BY s.annotation_id ORDER BY s.created_at ASC, s.revision ASC) AS public_version
    FROM annotation_snapshots s
    WHERE s.workflow_status = 'SUBMITTED'
  )
  SELECT p.*, v.title AS video_title, COALESCE(v.data_scope, 'BUSINESS') AS data_scope,
    round.id AS review_round_id, round.round_number, round.status AS round_status,
    round.reviewer_name, round.decision_note
  FROM public_versions p
  INNER JOIN videos v ON v.id = p.video_id
  LEFT JOIN analysis_review_rounds round ON round.submitted_snapshot_id = p.id
  WHERE p.public_version = 14
  ORDER BY p.created_at ASC`,
).all<Record<string, string | number | null>>();

const physicalV14Candidates = await db.prepare(
  `SELECT s.id, s.annotation_id, s.video_id, s.author_name, s.created_at,
    s.submitted_at, s.revision, s.version_number, s.revision_cause,
    s.workflow_status, s.base_snapshot_id, s.base_release_id,
    s.source_public_snapshot_id, v.title AS video_title,
    COALESCE(v.data_scope, 'BUSINESS') AS data_scope,
    round.id AS review_round_id, round.round_number,
    round.status AS round_status, round.reviewer_name, round.decision_note
  FROM annotation_snapshots s
  INNER JOIN videos v ON v.id = s.video_id
  LEFT JOIN analysis_review_rounds round ON round.submitted_snapshot_id = s.id
  WHERE s.version_number = 14 OR s.revision = 14
  ORDER BY s.created_at ASC`,
).all<Record<string, string | number | null>>();

const targetSnapshotIds = Array.from(new Set([
  ...releases.results.flatMap((row) => [row.source_snapshot_id, row.approved_snapshot_id]),
  ...publicV14.results.map((row) => row.id),
  ...physicalV14Candidates.results.map((row) => row.id),
].filter((value): value is string => typeof value === "string")));
const targetRoundIds = Array.from(new Set([
  ...releases.results.map((row) => row.source_review_round_id),
  ...publicV14.results.map((row) => row.review_round_id),
  ...physicalV14Candidates.results.map((row) => row.review_round_id),
].filter((value): value is string => typeof value === "string")));

const events: Array<Record<string, string | number | null>> = [];
for (const roundId of targetRoundIds) {
  const result = await db.prepare(
    `SELECT id, review_round_id, base_snapshot_id, target_key, edit_type,
      actor_name, actor_role, source, status, change_set_id, created_at,
      materialized_snapshot_id
    FROM analysis_revision_events WHERE review_round_id = ? ORDER BY created_at ASC`,
  ).bind(roundId).all<Record<string, string | number | null>>();
  events.push(...result.results);
}

const audits: Array<Record<string, string | number | null>> = [];
for (const objectId of [...targetSnapshotIds, ...targetRoundIds, ...releases.results.map((row) => String(row.id))]) {
  const result = await db.prepare(
    `SELECT action, object_type, object_id, created_at,
      CASE
        WHEN detail_json LIKE '%verify-v03%' OR detail_json LIKE '%verify-v031%'
          OR detail_json LIKE '%verify-v032%' OR detail_json LIKE '%V032_SMOKE%'
        THEN 'SCRIPT_MARKER_PRESENT'
        ELSE 'NO_SCRIPT_MARKER'
      END AS script_marker
    FROM audit_logs WHERE object_id = ? ORDER BY created_at ASC`,
  ).bind(objectId).all<Record<string, string | number | null>>();
  audits.push(...result.results);
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  readOnly: true,
  releaseR5: releases.results,
  publicV14: publicV14.results,
  physicalV14Candidates: physicalV14Candidates.results,
  relatedRevisionEvents: events,
  exactObjectAuditLogs: audits,
  interpretationRule: "只有明确 TEST_ONLY 数据范围、测试命名空间或脚本标记才可判为测试来源；其余只列证据，不做推断。",
}, null, 2));
