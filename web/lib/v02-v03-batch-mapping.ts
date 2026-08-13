import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "@/db";
import { getDbClient } from "@/db";
import { installAdminDataOperationSchema } from "@/lib/admin-data-operations";
import type { CurrentUser } from "@/lib/current-user";
import { V03_VOCABULARY_VERSION, V03_WORKFLOW_VERSION } from "@/lib/taxonomy-v0.3";
import {
  V02_V03_BATCH_MAPPING_CONFIRMATION,
  type V02V03BatchCandidate,
  type V02V03BatchMappingResult,
  type V02V03BatchPreview,
} from "@/lib/v02-v03-batch-mapping-contract";

type Row = Record<string, unknown>;
type BindValue = string | number | boolean | null;

const LEGACY_FIELD_CODES = [
  "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9",
  "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10",
] as const;

export type V02V03BatchMappingConfig = {
  operationKeyPrefix: string;
  dataScope: "BUSINESS" | "TEST_ONLY";
  confirmation: string;
};

export const V02_V03_BATCH_MAPPING_CONFIG: V02V03BatchMappingConfig = {
  operationKeyPrefix: "V02_TO_V03_AUTHOR_BATCH_V0_1_",
  dataScope: "BUSINESS",
  confirmation: V02_V03_BATCH_MAPPING_CONFIRMATION,
};

type SnapshotPackage = {
  annotation: Row;
  shots: Row[];
  fields: Row[];
};

type MappedGroup = {
  title: string;
  note: string;
  shots: Row[];
};

type CandidateInternal = {
  public: V02V03BatchCandidate;
  operationKey: string;
  snapshotId: string;
  sourceAnnotationId: string;
  authorIdentity: string;
  targetAnnotationId: string | null;
  ledger: Row | null;
  pkg: SnapshotPackage | null;
  groups: MappedGroup[];
  sourceHash: string;
};

export class V02V03BatchMappingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "V02V03BatchMappingError";
  }
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

function numberValue(value: unknown) {
  return Number(value ?? 0);
}

async function queryRows(db: DbClient, sql: string, ...values: BindValue[]) {
  return (await db.prepare(sql).bind(...values).all<Row>()).results;
}

async function tableExists(db: DbClient, table: string) {
  const result = await db.prepare(`SELECT to_regclass(?) AS name`).bind(`public.${table}`)
    .first<{ name: string | null }>();
  return Boolean(result?.name);
}

function parseSnapshotPackage(row: Row): SnapshotPackage | null {
  try {
    const raw = typeof row.payload_json === "string"
      ? JSON.parse(row.payload_json) as Row
      : row.payload_json as Row;
    if (!raw || typeof raw !== "object") return null;
    const shots = Array.isArray(raw.shots) ? raw.shots as Row[] : [];
    const fields = Array.isArray(raw.fields) ? raw.fields as Row[] : [];
    return {
      annotation: raw,
      shots: shots.map((shot, index) => ({
        order_index: shot.orderIndex ?? index,
        group_name: shot.groupName,
        shot_number: shot.shotNumber,
        start_time: shot.startTime,
        end_time: shot.endTime,
        shot_size: shot.shotSize,
        camera_angle: shot.cameraAngle,
        camera_movement: shot.cameraMovement,
        visual_content: shot.visualContent,
        dialogue: shot.dialogue,
        voiceover: shot.voiceover,
        screen_text: shot.screenText,
        sound_effect: shot.soundEffect,
        music: shot.music,
        creative_comment: shot.creativeComment,
      })),
      fields: fields.map((field) => ({
        field_code: field.code,
        answer: field.answer,
        evidence: field.evidence,
      })),
    };
  } catch {
    return null;
  }
}

export function deriveBatchGroups(sourceShots: Row[]): MappedGroup[] {
  const groups: MappedGroup[] = [];
  for (const shot of sourceShots) {
    const title = stringValue(shot.group_name);
    if (!title) return [];
    let group = groups.at(-1);
    if (!group || group.title !== title) {
      group = { title, note: "", shots: [] };
      groups.push(group);
    }
    group.shots.push(shot);
    if (!group.note && stringValue(shot.creative_comment)) {
      group.note = stringValue(shot.creative_comment);
    }
  }
  return groups;
}

function candidateKey(row: Row) {
  return sha256({
    videoId: row.video_id,
    authorIdentity: row.author_email,
    snapshotId: row.snapshot_id,
  }).slice(0, 24);
}

function operationKey(config: V02V03BatchMappingConfig, key: string) {
  return `${config.operationKeyPrefix}${key}`;
}

async function loadLatestSourceRows(db: DbClient, config: V02V03BatchMappingConfig) {
  return queryRows(db,
    `WITH submitted AS (
      SELECT s.*,
        ROW_NUMBER() OVER (
          PARTITION BY s.annotation_id
          ORDER BY s.version_number DESC, s.created_at DESC, s.revision DESC, s.id DESC
        ) AS latest_rank,
        COUNT(*) OVER (PARTITION BY s.annotation_id) AS submitted_version_count
      FROM annotation_snapshots s
      INNER JOIN annotations source_annotation ON source_annotation.id = s.annotation_id
      INNER JOIN videos source_video ON source_video.id = s.video_id
      WHERE s.taxonomy_version = 'V0.2' AND s.workflow_status = 'SUBMITTED'
        AND source_annotation.taxonomy_version = 'V0.2'
        AND source_annotation.deleted_at IS NULL
        AND source_video.deleted_at IS NULL
        AND COALESCE(source_video.data_scope, 'BUSINESS') = ?
    )
    SELECT submitted.id AS snapshot_id, submitted.annotation_id AS source_annotation_id,
      submitted.video_id, submitted.author_email, submitted.author_name,
      submitted.revision AS snapshot_revision,
      submitted.version_number AS snapshot_version_number,
      submitted.submitted_version_count,
      submitted.payload_json, submitted.content_hash, submitted.created_at,
      video.title AS video_title,
      author_user.display_name AS current_author_name,
      author_user.status AS current_author_status,
      target.id AS target_annotation_id, target.status AS target_status,
      target.review_status AS target_review_status, target.revision AS target_revision
    FROM submitted
    INNER JOIN videos video ON video.id = submitted.video_id
    LEFT JOIN users author_user ON author_user.identity_key = submitted.author_email
    LEFT JOIN LATERAL (
      SELECT candidate.id, candidate.status, candidate.review_status, candidate.revision
      FROM annotations candidate
      WHERE candidate.video_id = submitted.video_id
        AND candidate.taxonomy_version = 'V0.3-PILOT' AND candidate.deleted_at IS NULL
      ORDER BY
        CASE WHEN candidate.author_email = submitted.author_email THEN 0 ELSE 1 END,
        candidate.created_at, candidate.id
      LIMIT 1
    ) target ON TRUE
    WHERE submitted.latest_rank = 1
    ORDER BY video.created_at DESC, video.title, submitted.author_name`,
    config.dataScope);
}

async function loadLedgers(db: DbClient, config: V02V03BatchMappingConfig) {
  if (!(await tableExists(db, "admin_data_operations"))) return new Map<string, Row>();
  const rows = await queryRows(db,
    `SELECT operation_key, status, completed_at, result_json
    FROM admin_data_operations WHERE operation_key LIKE ?`,
    `${config.operationKeyPrefix}%`);
  return new Map(rows.map((row) => [stringValue(row.operation_key), row]));
}

function inspectRow(
  row: Row,
  ledger: Row | null,
  config: V02V03BatchMappingConfig,
): CandidateInternal {
  const pkg = parseSnapshotPackage(row);
  const groups = deriveBatchGroups(pkg?.shots ?? []);
  const key = candidateKey(row);
  const opKey = operationKey(config, key);
  const targetAnnotationId = stringValue(row.target_annotation_id) || null;
  const reasons: string[] = [];
  const codes = (pkg?.fields ?? []).map((field) => stringValue(field.field_code)).sort();
  const expectedCodes = [...LEGACY_FIELD_CODES].sort();
  const activeUserExists = Boolean(stringValue(row.current_author_name)) &&
    stringValue(row.current_author_status) === "ACTIVE";
  if (!stringValue(row.current_author_name)) reasons.push("原作者尚未绑定可登录用户身份。");
  else if (!activeUserExists) reasons.push("原作者用户身份已停用。");
  if (!pkg) reasons.push("最新 V0.2 公开版本的快照内容无法解析。");
  if (pkg && (
    stringValue(pkg.annotation.videoId) !== stringValue(row.video_id) ||
    stringValue(pkg.annotation.taxonomyVersion) !== "V0.2"
  )) reasons.push("快照载荷的作品或标注体系标识不匹配。");
  if ((pkg?.shots.length ?? 0) === 0) reasons.push("最新 V0.2 公开版本没有镜头数据。");
  if ((pkg?.shots.length ?? 0) > 0 && groups.length === 0) {
    reasons.push("镜头组名称为空，无法稳定形成 V0.3 桥段。");
  }
  if (JSON.stringify(codes) !== JSON.stringify(expectedCodes)) {
    reasons.push("最新 V0.2 公开版本不是完整的 19 项 A/B 字段结构。");
  }
  const ledgerCompleted = stringValue(ledger?.status) === "COMPLETED";
  if (ledgerCompleted && !targetAnnotationId) {
    reasons.push("操作账本已完成，但目标 V0.3 草稿不存在。");
  }
  let status: V02V03BatchCandidate["status"];
  if (ledgerCompleted && targetAnnotationId && reasons.length === 0) status = "COMPLETED";
  else if (targetAnnotationId) status = "SKIP_EXISTING";
  else if (reasons.length) status = "BLOCKED";
  else status = "READY";
  const sourceHash = sha256({
    snapshotId: row.snapshot_id,
    contentHash: row.content_hash,
    payload: row.payload_json,
  });
  const token = status === "READY" ? sha256({
    operationKey: opKey,
    sourceHash,
    currentAuthorName: row.current_author_name,
    targetAbsent: true,
  }) : null;
  return {
    public: {
      candidateKey: key,
      candidateToken: token,
      status,
      reasons,
      video: { id: stringValue(row.video_id), title: stringValue(row.video_title) },
      author: {
        sourceName: stringValue(row.author_name),
        currentName: stringValue(row.current_author_name) || null,
        activeUserExists,
      },
      source: {
        snapshotVersionNumber: numberValue(row.snapshot_version_number),
        snapshotRevision: numberValue(row.snapshot_revision),
        shots: pkg?.shots.length ?? 0,
        groups: groups.length,
        legacyFields: pkg?.fields.length ?? 0,
      },
      target: {
        exists: Boolean(targetAnnotationId),
        status: stringValue(row.target_status) || null,
        reviewStatus: stringValue(row.target_review_status) || null,
        revision: targetAnnotationId ? numberValue(row.target_revision) : null,
      },
    },
    operationKey: opKey,
    snapshotId: stringValue(row.snapshot_id),
    sourceAnnotationId: stringValue(row.source_annotation_id),
    authorIdentity: stringValue(row.author_email),
    targetAnnotationId,
    ledger,
    pkg,
    groups,
    sourceHash,
  };
}

async function inspectAll(
  db: DbClient,
  config: V02V03BatchMappingConfig,
) {
  const [rows, ledgers] = await Promise.all([
    loadLatestSourceRows(db, config),
    loadLedgers(db, config),
  ]);
  return rows.map((row) => {
    const key = candidateKey(row);
    const opKey = operationKey(config, key);
    return inspectRow(row, ledgers.get(opKey) ?? null, config);
  });
}

export async function previewV02V03BatchMapping(
  db = getDbClient(),
  config = V02_V03_BATCH_MAPPING_CONFIG,
): Promise<V02V03BatchPreview> {
  const candidates = (await inspectAll(db, config)).map((item) => item.public);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      sourcePairs: candidates.length,
      ready: candidates.filter((item) => item.status === "READY").length,
      blocked: candidates.filter((item) => item.status === "BLOCKED").length,
      skippedExisting: candidates.filter((item) => item.status === "SKIP_EXISTING").length,
      completed: candidates.filter((item) => item.status === "COMPLETED").length,
    },
    candidates,
  };
}

async function digestQuery(db: DbClient, sql: string, ...values: BindValue[]) {
  return (await db.prepare(sql).bind(...values).first<Row>()) ?? {};
}

async function nonTargetSummary(db: DbClient, targetAnnotationId: string | null) {
  const summary: Record<string, Row> = {};
  const mutable = [
    ["annotations", "annotations", "a", "a.id", "a.id"],
    ["shots", "shots", "s", "s.id", "s.annotation_id"],
    ["groups", "shot_groups", "g", "g.id", "g.annotation_id"],
    ["fields", "field_answers", "f", "f.id", "f.annotation_id"],
    ["structures", "annotation_creative_structures", "c", "c.annotation_id", "c.annotation_id"],
  ] as const;
  for (const [key, table, alias, order, targetColumn] of mutable) {
    const where = targetAnnotationId ? ` WHERE ${targetColumn} <> ?` : "";
    summary[key] = await digestQuery(db,
      `SELECT COUNT(*) AS count,
        md5(COALESCE(string_agg(md5(row_to_json(${alias})::text), '' ORDER BY ${order}), '')) AS digest
      FROM ${table} ${alias}${where}`,
      ...(targetAnnotationId ? [targetAnnotationId] : []));
  }
  for (const [key, table, order] of [
    ["videos", "videos", "id"],
    ["snapshots", "annotation_snapshots", "id"],
    ["reviewRounds", "analysis_review_rounds", "id"],
    ["comments", "analysis_comments", "id"],
    ["revisionEvents", "analysis_revision_events", "id"],
    ["releases", "approved_analysis_releases", "id"],
    ["users", "users", "id"],
  ] as const) {
    summary[key] = await digestQuery(db,
      `SELECT COUNT(*) AS count,
        md5(COALESCE(string_agg(md5(row_to_json(t)::text), '' ORDER BY t.${order}), '')) AS digest
      FROM ${table} t`);
  }
  return summary;
}

async function insertMappedDraft(db: DbClient, item: CandidateInternal) {
  const pkg = item.pkg!;
  const targetId = newId("annotation");
  const authorName = item.public.author.currentName!;
  await db.prepare(
    `INSERT INTO annotations (
      id, video_id, author_email, author_name, taxonomy_version,
      workflow_version, source_snapshot_id, status, review_status, revision,
      analysis_title, commercial_intent, creative_theme, synopsis,
      thinking_chain, shot_commentary, summary
    ) VALUES (?, ?, ?, ?, 'V0.3-PILOT', ?, ?, 'DRAFT', 'DRAFT', 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    targetId,
    item.public.video.id,
    item.authorIdentity,
    authorName,
    V03_WORKFLOW_VERSION,
    item.snapshotId,
    stringValue(pkg.annotation.analysisTitle),
    stringValue(pkg.annotation.commercialIntent),
    stringValue(pkg.annotation.creativeTheme),
    stringValue(pkg.annotation.synopsis),
    stringValue(pkg.annotation.thinkingChain),
    stringValue(pkg.annotation.shotCommentary),
    stringValue(pkg.annotation.summary),
  ).run();
  for (const [groupIndex, group] of item.groups.entries()) {
    const groupId = newId("group");
    await db.prepare(
      `INSERT INTO shot_groups (
        id, annotation_id, order_index, title, primary_role_id,
        primary_role_name_snapshot, auxiliary_roles_json, custom_role, note,
        taxonomy_version
      ) VALUES (?, ?, ?, ?, '', '', '[]', '', ?, 'V0.3-PILOT')`,
    ).bind(groupId, targetId, groupIndex, group.title, group.note).run();
    for (const shot of group.shots) {
      await db.prepare(
        `INSERT INTO shots (
          id, annotation_id, order_index, group_name, shot_group_id, shot_number,
          start_time, end_time, shot_size, camera_angle, camera_movement,
          visual_content, dialogue, voiceover, screen_text, sound_effect, music,
          creative_comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      ).bind(
        newId("shot"), targetId, numberValue(shot.order_index), group.title, groupId,
        stringValue(shot.shot_number), stringValue(shot.start_time), stringValue(shot.end_time),
        stringValue(shot.shot_size), stringValue(shot.camera_angle),
        stringValue(shot.camera_movement), stringValue(shot.visual_content),
        stringValue(shot.dialogue), stringValue(shot.voiceover),
        stringValue(shot.screen_text), stringValue(shot.sound_effect), stringValue(shot.music),
      ).run();
    }
  }
  for (const field of pkg.fields) {
    await db.prepare(
      `INSERT INTO field_answers (id, annotation_id, field_code, answer, evidence, source)
      VALUES (?, ?, ?, ?, ?, 'SYSTEM_MAPPED')`,
    ).bind(
      newId("field"), targetId, stringValue(field.field_code),
      stringValue(field.answer), stringValue(field.evidence),
    ).run();
  }
  const fieldByCode = new Map(pkg.fields.map((field) => [stringValue(field.field_code), field]));
  await db.prepare(
    `INSERT INTO annotation_creative_structures (
      annotation_id, vocabulary_version, creative_button, mechanism_statement,
      mechanism_primary, mechanism_auxiliary_json, mechanism_custom,
      realization_skeleton, brand_product_landing,
      story_reference_type, story_archetype, primary_creative_path,
      auxiliary_creative_paths_json, composite_state_reason,
      formation_primary, formation_auxiliary_json, formation_statement,
      formation_related_group_ids_json, creative_carriers,
      establishment_conditions, strength_sources, acceptance_contract,
      audiovisual_mechanism, information_release_turning, creative_grade,
      creative_grade_reason, creative_grade_version,
      main_path_payload_json, auxiliary_path_notes_json, condition_flags_json
    ) VALUES (?, ?, '', '', '', '[]', '', '', '', ?, ?, '', '[]', '',
      '', '[]', '', '[]', '', '', '', '', '', '', '', '',
      'CREATIVE-GRADE-V0.1', '{}', '{}', ?)`,
  ).bind(
    targetId,
    V03_VOCABULARY_VERSION,
    stringValue(fieldByCode.get("B2")?.answer),
    stringValue(fieldByCode.get("B3")?.answer),
    JSON.stringify({
      unconventionalWorld: false,
      audiovisualCarriesIdea: false,
      interestingLoadBearing: false,
    }),
  ).run();
  return targetId;
}

async function verifyMappedDraft(db: DbClient, targetId: string, item: CandidateInternal) {
  const row = await db.prepare(
    `SELECT status, review_status, revision, source_snapshot_id,
      (SELECT COUNT(*) FROM shots WHERE annotation_id = ?) AS shots,
      (SELECT COUNT(*) FROM shot_groups WHERE annotation_id = ?) AS groups,
      (SELECT COUNT(*) FROM field_answers WHERE annotation_id = ?) AS fields,
      (SELECT COUNT(*) FROM field_answers
        WHERE annotation_id = ? AND source = 'SYSTEM_MAPPED') AS mapped_fields,
      (SELECT primary_creative_path FROM annotation_creative_structures
        WHERE annotation_id = ?) AS primary_creative_path,
      (SELECT COUNT(*) FROM annotation_creative_structures
        WHERE annotation_id = ?) AS structures
    FROM annotations WHERE id = ?`,
  ).bind(targetId, targetId, targetId, targetId, targetId, targetId, targetId).first<Row>();
  if (!row || stringValue(row.status) !== "DRAFT" || stringValue(row.review_status) !== "DRAFT" ||
    numberValue(row.revision) !== 1 || stringValue(row.source_snapshot_id) !== item.snapshotId) {
    throw new V02V03BatchMappingError("POSTCHECK_TARGET", "映射后的 V0.3 草稿状态或来源血缘不正确。");
  }
  if (numberValue(row.shots) !== item.public.source.shots ||
    numberValue(row.groups) !== item.public.source.groups ||
    numberValue(row.fields) !== 19 || numberValue(row.mapped_fields) !== 19 ||
    numberValue(row.structures) !== 1) {
    throw new V02V03BatchMappingError("POSTCHECK_COUNTS", "映射后的桥段、镜头或字段结构不完整。");
  }
  if (stringValue(row.primary_creative_path)) {
    throw new V02V03BatchMappingError("POSTCHECK_SEMANTICS", "批量映射不得猜测 V0.3 主导创意路径。");
  }
}

function resultFromLedger(ledger: Row): V02V03BatchMappingResult {
  const raw = ledger.result_json;
  const parsed = typeof raw === "string"
    ? JSON.parse(raw) as V02V03BatchMappingResult
    : raw as V02V03BatchMappingResult;
  return { ...parsed, alreadyApplied: true };
}

export async function applyV02V03BatchCandidate(args: {
  actor: CurrentUser;
  candidateKey: string;
  candidateToken: string;
  confirmation: string;
  db?: DbClient;
  config?: V02V03BatchMappingConfig;
  failAfterInsertForTest?: boolean;
}): Promise<V02V03BatchMappingResult> {
  const db = args.db ?? getDbClient();
  const config = args.config ?? V02_V03_BATCH_MAPPING_CONFIG;
  if (args.confirmation !== config.confirmation) {
    throw new V02V03BatchMappingError("CONFIRMATION_MISMATCH", "确认口令不匹配。", 400);
  }
  if (args.failAfterInsertForTest && !config.operationKeyPrefix.startsWith("TEST_ONLY_")) {
    throw new V02V03BatchMappingError("TEST_HOOK_REJECTED", "生产操作禁止启用测试回滚钩子。", 400);
  }
  return db.withTransaction(async (tx) => {
    await tx.prepare(`SELECT pg_advisory_xact_lock(?)`).bind(734025032).run();
    await installAdminDataOperationSchema(tx);
    let item = (await inspectAll(tx, config)).find(
      (candidate) => candidate.public.candidateKey === args.candidateKey,
    );
    if (!item) throw new V02V03BatchMappingError("CANDIDATE_MISSING", "候选案例已经不存在或来源已变化。");
    if (stringValue(item.ledger?.status) === "COMPLETED") return resultFromLedger(item.ledger!);
    await tx.prepare(`SELECT id FROM videos WHERE id = ? FOR UPDATE`)
      .bind(item.public.video.id).first();
    await tx.prepare(`SELECT id FROM annotations WHERE id = ? FOR UPDATE`)
      .bind(item.sourceAnnotationId).first();
    await tx.prepare(`SELECT id FROM annotation_snapshots WHERE id = ? FOR UPDATE`)
      .bind(item.snapshotId).first();
    await tx.prepare(
      `SELECT id FROM annotations
      WHERE video_id = ? AND author_email = ? AND taxonomy_version = 'V0.3-PILOT'
        AND deleted_at IS NULL FOR UPDATE`,
    ).bind(item.public.video.id, item.authorIdentity).all();
    item = (await inspectAll(tx, config)).find(
      (candidate) => candidate.public.candidateKey === args.candidateKey,
    );
    if (!item) throw new V02V03BatchMappingError("CANDIDATE_CHANGED", "候选案例锁定后已经变化，请重新执行 PREVIEW。");
    if (item.public.status !== "READY" || !item.public.candidateToken) {
      throw new V02V03BatchMappingError(
        "PRECONDITION_FAILED",
        item.public.reasons.join("；") || "候选案例已经不再满足新建条件。",
      );
    }
    if (!args.candidateToken || args.candidateToken !== item.public.candidateToken) {
      throw new V02V03BatchMappingError("PREVIEW_STALE", "候选案例已经变化，请重新执行 PREVIEW。", 409);
    }
    const nonTargetBefore = await nonTargetSummary(tx, null);
    const nonTargetHash = sha256(nonTargetBefore);
    const createdAt = new Date().toISOString();
    const backup = {
      kind: "V02_TO_V03_AUTHOR_BATCH_PREWRITE_BACKUP",
      createdAt,
      operationKey: item.operationKey,
      candidateKey: item.public.candidateKey,
      video: item.public.video,
      author: {
        identityHash: sha256(item.authorIdentity),
        sourceName: item.public.author.sourceName,
        currentName: item.public.author.currentName,
      },
      source: {
        annotationId: item.sourceAnnotationId,
        snapshotId: item.snapshotId,
        snapshotVersionNumber: item.public.source.snapshotVersionNumber,
        snapshotRevision: item.public.source.snapshotRevision,
        sourceHash: item.sourceHash,
      },
      targetPackage: null,
      nonTargetSummary: nonTargetBefore,
    };
    await tx.prepare(
      `INSERT INTO admin_data_operations (
        operation_key, operation_type, target_video_id, status,
        actor_identity, actor_name, preview_token, source_hash, target_hash,
        non_target_hash, backup_json, created_at
      ) VALUES (?, 'V02_TO_V03_AUTHOR_BATCH', ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
    ).bind(
      item.operationKey, item.public.video.id, args.actor.identityKey, args.actor.displayName,
      item.public.candidateToken, item.sourceHash, sha256(null), nonTargetHash,
      JSON.stringify(backup), createdAt,
    ).run();
    const targetId = await insertMappedDraft(tx, item);
    if (args.failAfterInsertForTest) {
      throw new V02V03BatchMappingError("TEST_ROLLBACK", "TEST_ONLY 强制回滚。", 409);
    }
    await verifyMappedDraft(tx, targetId, item);
    const nonTargetAfter = await nonTargetSummary(tx, targetId);
    if (sha256(nonTargetAfter) !== nonTargetHash) {
      throw new V02V03BatchMappingError("NON_TARGET_CHANGED", "非目标业务数据发生变化，事务已回滚。");
    }
    const completedAt = new Date().toISOString();
    const result: V02V03BatchMappingResult = {
      alreadyApplied: false,
      operationKey: item.operationKey,
      candidateKey: item.public.candidateKey,
      completedAt,
      videoId: item.public.video.id,
      videoTitle: item.public.video.title,
      authorName: item.public.author.currentName!,
      targetAnnotationId: targetId,
      targetRevision: 1,
      mapped: {
        shots: item.public.source.shots,
        groups: item.public.source.groups,
        legacyFields: 19,
      },
      existingBusinessDataUnchanged: true,
    };
    await tx.prepare(
      `INSERT INTO audit_logs (
        id, actor_email, action, object_type, object_id, detail_json
      ) VALUES (?, ?, 'V02_TO_V03_AUTHOR_BATCH', 'ADMIN_DATA_OPERATION', ?, ?)`,
    ).bind(
      newId("audit"), args.actor.identityKey, item.operationKey,
      JSON.stringify({
        candidateKey: item.public.candidateKey,
        videoId: item.public.video.id,
        sourceSnapshotId: item.snapshotId,
        sourceSnapshotVersionNumber: item.public.source.snapshotVersionNumber,
        targetAnnotationId: targetId,
        mapped: result.mapped,
        nonTargetHash,
      }),
    ).run();
    const completion = await tx.prepare(
      `UPDATE admin_data_operations SET status = 'COMPLETED', result_json = ?::jsonb,
        completed_at = ? WHERE operation_key = ? AND status = 'RUNNING'`,
    ).bind(JSON.stringify(result), completedAt, item.operationKey).run();
    if (completion.meta.rows_written !== 1) {
      throw new V02V03BatchMappingError("LEDGER_COMPLETION_FAILED", "操作账本未能完成，事务已回滚。");
    }
    return result;
  });
}
