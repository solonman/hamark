import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import type { VideoBucket } from "@/storage/types";
import {
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "./v04-contract";
import { V04ServiceError } from "./v04-errors";
import { hashV04GrayUserId } from "./v04-gray-access";
import { V04_GRAY_TEST_MEDIA, v04GrayTestMediaBytes } from "./v04-gray-test-media";
import {
  V04_GRAY_TEST_OBJECT_CONFIRMATION,
  type V04GrayTestObjectApplyInput,
  type V04GrayTestObjectApplyResult,
  type V04GrayTestObjectPreview,
} from "./v04-gray-test-object-contract";
import { canonicalV04SchemaValue, v04TargetCodeSha } from "./v04-schema-catalog";
import type { V04Actor } from "./v04-workspace-service";

export { V04_GRAY_TEST_OBJECT_CONFIRMATION } from "./v04-gray-test-object-contract";
export type {
  V04GrayTestObjectApplyInput,
  V04GrayTestObjectApplyResult,
  V04GrayTestObjectPreview,
} from "./v04-gray-test-object-contract";
export const V04_GRAY_TEST_OBJECT_TTL_MS = 30 * 60 * 1000;
export const V04_GRAY_TEST_OBJECT_LOCK_KEY = "HAMARK:V04:GRAY_TEST_OBJECT:V1";
export const V04_GRAY_TEST_OBJECT_OPERATION_TYPE = "V04_GRAY_TEST_OBJECT_CREATE";

type Environment = Record<string, string | undefined>;
type SystemFactsRow = QueryResultRow & {
  actor_active: boolean;
  actor_system_admin_count: number | string;
  active_system_admin_count: number | string;
  taxonomy_active: number | string;
  vocabulary_active: number | string;
  workflow_active: number | string;
};
type TargetVideoRow = QueryResultRow & {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  file_size: number | string;
  status: string;
  created_by_user_id: string | null;
  data_scope: string;
  test_run_id: string | null;
  deleted_at: string | null;
  deletion_state: string | null;
};
type LedgerRow = QueryResultRow & {
  operation_key: string;
  status: string;
  actor_identity: string;
  target_video_id: string;
  source_hash: string;
  target_hash: string;
  non_target_hash: string;
  backup_json: Record<string, unknown> | null;
  result_json: V04GrayTestObjectApplyResult | null;
};

type PreviewTokenPayload = {
  version: "V04_GRAY_TEST_OBJECT_PREVIEW_V1";
  actorDigest: string;
  targetCodeSha: string;
  previewHash: string;
  generatedAt: string;
  expiresAt: string;
  videoId: string;
  objectKey: string;
  mediaSha256: string;
};

type BucketObjectFacts = {
  state: "ABSENT" | "EXACT" | "DRIFT";
  etag: string | null;
  etagDigest: string | null;
  creationMarker: string | null;
  creationMarkerDigest: string | null;
};

export function classifyV04GrayTestObjectState(input: {
  targetState: "ABSENT" | "EXACT" | "DRIFT";
  objectState: "ABSENT" | "EXACT" | "DRIFT";
  ledgerState: "ABSENT" | "EXACT" | "DRIFT";
  ledgerAppliedCount: number;
}) {
  if (input.targetState === "ABSENT" && input.objectState === "ABSENT"
    && input.ledgerState === "ABSENT" && input.ledgerAppliedCount === 0) {
    return "CLEAN_CREATE" as const;
  }
  if (input.targetState === "EXACT" && input.objectState === "EXACT"
    && input.ledgerState === "EXACT" && input.ledgerAppliedCount === 1) {
    return "EXACT_APPLIED" as const;
  }
  return "INCONSISTENT" as const;
}

export function loadV04GrayTestObjectConfig(environment: Environment = process.env) {
  return { enabled: environment.V04_GRAY_TEST_OBJECT_ENABLED === "true" };
}

function hash(value: unknown) {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalV04SchemaValue(value),
    "utf8",
  ).digest("hex");
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function tokenFor(payload: PreviewTokenPayload, secret: string) {
  const encoded = base64Url(canonicalV04SchemaValue(payload));
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function parseToken(token: string, secret: string): PreviewTokenPayload {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) {
    throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体 PREVIEW token 无效。");
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体 PREVIEW token 无效。");
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体 PREVIEW token 无效。");
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PreviewTokenPayload;
    if (payload.version !== "V04_GRAY_TEST_OBJECT_PREVIEW_V1") throw new Error("version");
    return payload;
  } catch {
    throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体 PREVIEW token 无效。");
  }
}

function requireText(value: string, label: string, min: number, max: number) {
  const normalized = value?.trim() ?? "";
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f]/u.test(normalized)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", `${label}格式不正确。`);
  }
  return normalized;
}

async function systemFacts(db: DbClient, actorUserId: string) {
  const row = await db.prepare(`SELECT
    EXISTS (SELECT 1 FROM users WHERE id=? AND status='ACTIVE') AS actor_active,
    (SELECT COUNT(*)::bigint FROM app_role_memberships
      WHERE user_id=? AND role_key='SYSTEM_ADMIN' AND status='ACTIVE') AS actor_system_admin_count,
    (SELECT COUNT(*)::bigint FROM app_role_memberships
      WHERE role_key='SYSTEM_ADMIN' AND status='ACTIVE') AS active_system_admin_count,
    (SELECT COUNT(*)::bigint FROM annotation_taxonomy_versions
      WHERE taxonomy_version=? AND status='ACTIVE') AS taxonomy_active,
    (SELECT COUNT(*)::bigint FROM annotation_vocabulary_versions
      WHERE vocabulary_version=? AND status='ACTIVE') AS vocabulary_active,
    (SELECT COUNT(*)::bigint FROM workflow_contract_versions
      WHERE workflow_version=? AND status='ACTIVE') AS workflow_active`)
    .bind(actorUserId, actorUserId, V04_TAXONOMY_VERSION, V04_VOCABULARY_VERSION, V04_WORKFLOW_VERSION)
    .first<SystemFactsRow>();
  return {
    actorActive: Boolean(row?.actor_active),
    actorSystemAdmin: Number(row?.actor_system_admin_count ?? 0) === 1
      && Number(row?.active_system_admin_count ?? 0) === 1,
    contractsActive: Number(row?.taxonomy_active ?? 0) === 1
      && Number(row?.vocabulary_active ?? 0) === 1
      && Number(row?.workflow_active ?? 0) === 1,
  };
}

async function targetVideo(db: DbClient) {
  return db.prepare(`SELECT id,object_key,original_name,content_type,file_size,status,
      created_by_user_id,data_scope,test_run_id,deleted_at,deletion_state
    FROM videos WHERE id=?`)
    .bind(V04_GRAY_TEST_MEDIA.videoId).first<TargetVideoRow>();
}

function exactTarget(row: TargetVideoRow | null, actorUserId: string) {
  return Boolean(row
    && row.object_key === V04_GRAY_TEST_MEDIA.objectKey
    && row.original_name === V04_GRAY_TEST_MEDIA.originalName
    && row.content_type === V04_GRAY_TEST_MEDIA.contentType
    && Number(row.file_size) === V04_GRAY_TEST_MEDIA.fileSize
    && row.status === "READY"
    && row.created_by_user_id === actorUserId
    && row.data_scope === "TEST_ONLY"
    && row.test_run_id === V04_GRAY_TEST_MEDIA.testRunId
    && row.deleted_at === null
    && (row.deletion_state === null || row.deletion_state === "ACTIVE"));
}

async function businessFingerprint(db: DbClient) {
  const result = await db.prepare(`SELECT id,title,brand,description,tags_json,object_key,
      thumbnail_key,original_name,content_type,file_size,status,rights_confirmed,
      created_by_email,created_by_name,created_at,updated_at,deleted_at
    FROM videos WHERE COALESCE(data_scope,'BUSINESS')='BUSINESS' ORDER BY id`).all();
  return { count: result.results.length, hash: hash(result.results) };
}

async function appliedLedgers(db: DbClient) {
  const rows = await db.prepare(`SELECT operation_key,status,actor_identity,target_video_id,
      source_hash,target_hash,non_target_hash,backup_json,result_json
    FROM admin_data_operations
    WHERE operation_type=? AND target_video_id=? AND status='COMPLETED'
      AND result_json->>'outcome'='APPLIED'
    ORDER BY created_at,operation_key`)
    .bind(V04_GRAY_TEST_OBJECT_OPERATION_TYPE, V04_GRAY_TEST_MEDIA.videoId)
    .all<LedgerRow>();
  return rows.results;
}

async function databaseFingerprint(db: DbClient, actorUserId: string) {
  const system = await systemFacts(db, actorUserId);
  const target = await targetVideo(db);
  const business = await businessFingerprint(db);
  const ledgers = await appliedLedgers(db);
  return hash({ system, target, business, ledgers });
}

function targetState(row: TargetVideoRow | null, actorUserId: string) {
  if (!row) return "ABSENT" as const;
  return exactTarget(row, actorUserId) ? "EXACT" as const : "DRIFT" as const;
}

function exactLedger(
  row: LedgerRow | null,
  actorUserId: string,
  targetCodeSha: string,
) {
  if (!row?.result_json) return false;
  const result = row.result_json;
  return row.status === "COMPLETED"
    && row.actor_identity === actorUserId
    && row.target_video_id === V04_GRAY_TEST_MEDIA.videoId
    && row.source_hash === row.backup_json?.previewHash
    && row.target_hash === V04_GRAY_TEST_MEDIA.sha256
    && row.non_target_hash === result.businessFingerprint
    && result.status === "APPLIED"
    && result.outcome === "APPLIED"
    && result.videoId === V04_GRAY_TEST_MEDIA.videoId
    && result.dataScope === "TEST_ONLY"
    && result.testRunId === V04_GRAY_TEST_MEDIA.testRunId
    && result.fileSize === V04_GRAY_TEST_MEDIA.fileSize
    && result.mediaSha256 === V04_GRAY_TEST_MEDIA.sha256
    && result.objectKeyDigest === hash(V04_GRAY_TEST_MEDIA.objectKey)
    && result.actorDigest === hashV04GrayUserId(actorUserId)
    && result.targetCodeSha === targetCodeSha
    && typeof result.objectEtagDigest === "string"
    && typeof result.creationMarkerDigest === "string"
    && row.backup_json?.testRunId === V04_GRAY_TEST_MEDIA.testRunId
    && row.backup_json?.targetCodeSha === targetCodeSha
    && row.backup_json?.targetVideoId === V04_GRAY_TEST_MEDIA.videoId
    && row.backup_json?.mediaSha256 === V04_GRAY_TEST_MEDIA.sha256
    && row.backup_json?.actorDigest === hashV04GrayUserId(actorUserId);
}

async function bucketObjectFacts(
  bucket: VideoBucket,
  appliedLedger: LedgerRow | null,
): Promise<BucketObjectFacts> {
  const head = await bucket.head(V04_GRAY_TEST_MEDIA.objectKey);
  if (!head) {
    return {
      state: "ABSENT",
      etag: null,
      etagDigest: null,
      creationMarker: null,
      creationMarkerDigest: null,
    };
  }
  const etag = head.httpEtag?.trim() || null;
  const creationMarker = head.customMetadata?.["creation-marker"]?.trim() || null;
  const objectHash = await sha256BucketObject(bucket, V04_GRAY_TEST_MEDIA.objectKey);
  const etagDigest = etag ? hash(etag) : null;
  const creationMarkerDigest = creationMarker ? hash(creationMarker) : null;
  const exact = Boolean(appliedLedger?.result_json
    && head.size === V04_GRAY_TEST_MEDIA.fileSize
    && head.contentType === V04_GRAY_TEST_MEDIA.contentType
    && objectHash === V04_GRAY_TEST_MEDIA.sha256
    && head.customMetadata?.["data-scope"] === "TEST_ONLY"
    && head.customMetadata?.["test-run-id"] === V04_GRAY_TEST_MEDIA.testRunId
    && head.customMetadata?.sha256 === V04_GRAY_TEST_MEDIA.sha256
    && creationMarker === appliedLedger.operation_key
    && etagDigest === appliedLedger.result_json.objectEtagDigest
    && creationMarkerDigest === appliedLedger.result_json.creationMarkerDigest);
  return {
    state: exact ? "EXACT" : "DRIFT",
    etag,
    etagDigest,
    creationMarker,
    creationMarkerDigest,
  };
}

export async function previewV04GrayTestObject(
  db: DbClient,
  bucket: VideoBucket,
  actor: Pick<V04Actor, "userId">,
  options: { tokenSecret: string; now?: Date; targetCodeSha?: string },
): Promise<V04GrayTestObjectPreview> {
  const now = options.now ?? new Date();
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  const windowStart = Math.floor(now.getTime() / V04_GRAY_TEST_OBJECT_TTL_MS)
    * V04_GRAY_TEST_OBJECT_TTL_MS;
  const generatedAt = new Date(windowStart).toISOString();
  const expiresAt = new Date(windowStart + V04_GRAY_TEST_OBJECT_TTL_MS).toISOString();
  const beforeHash = await databaseFingerprint(db, actor.userId);
  // Keep database reads sequential so this function is safe both on a pool and
  // on the single transaction client used by APPLY.
  const system = await systemFacts(db, actor.userId);
  const target = await targetVideo(db);
  const business = await businessFingerprint(db);
  const ledgers = await appliedLedgers(db);
  const appliedCount = ledgers.length;
  const appliedLedger = appliedCount === 1 ? ledgers[0] : null;
  const state = targetState(target, actor.userId);
  const ledgerState = appliedCount === 0
    ? "ABSENT" as const
    : appliedCount === 1 && exactLedger(appliedLedger, actor.userId, targetCodeSha)
      ? "EXACT" as const
      : "DRIFT" as const;
  const object = await bucketObjectFacts(bucket, appliedLedger);
  const legalState = classifyV04GrayTestObjectState({
    targetState: state,
    objectState: object.state,
    ledgerState,
    ledgerAppliedCount: appliedCount,
  });
  const stopReasons = [
    !system.actorActive ? "ACTOR_NOT_ACTIVE" : "",
    !system.actorSystemAdmin ? "SYSTEM_ADMIN_REQUIRED" : "",
    !system.contractsActive ? "V04_CONTRACTS_NOT_ACTIVE" : "",
    state === "DRIFT" ? "TARGET_VIDEO_DRIFT" : "",
    object.state === "DRIFT" ? "TARGET_OBJECT_DRIFT" : "",
    ledgerState === "DRIFT" ? "APPLIED_LEDGER_DRIFT" : "",
    appliedCount > 1 ? "MULTIPLE_APPLIED_LEDGER_ROWS" : "",
    legalState === "INCONSISTENT" ? "INCONSISTENT_TARGET_STATE" : "",
  ].filter(Boolean);
  const actorDigest = hashV04GrayUserId(actor.userId);
  const previewFacts = {
    actorDigest,
    targetCodeSha,
    generatedAt,
    expiresAt,
    media: V04_GRAY_TEST_MEDIA,
    actorActive: system.actorActive,
    actorSystemAdmin: system.actorSystemAdmin,
    contractsActive: system.contractsActive,
    targetState: state,
    objectState: object.state,
    ledgerState,
    legalState,
    businessVideoCount: business.count,
    businessFingerprint: business.hash,
    ledgerAppliedCount: appliedCount,
    stopReasons,
  };
  const previewHash = hash(previewFacts);
  const payload: PreviewTokenPayload = {
    version: "V04_GRAY_TEST_OBJECT_PREVIEW_V1",
    actorDigest,
    targetCodeSha,
    previewHash,
    generatedAt,
    expiresAt,
    videoId: V04_GRAY_TEST_MEDIA.videoId,
    objectKey: V04_GRAY_TEST_MEDIA.objectKey,
    mediaSha256: V04_GRAY_TEST_MEDIA.sha256,
  };
  const previewToken = tokenFor(payload, options.tokenSecret);
  const afterHash = await databaseFingerprint(db, actor.userId);
  const unchanged = beforeHash === afterHash;
  if (!unchanged) stopReasons.push("PREVIEW_WROTE_DATABASE");
  return {
    mode: "TEST_ONLY_GRAY_MEDIA",
    ready: stopReasons.length === 0,
    alreadyApplied: legalState === "EXACT_APPLIED",
    stopReasons,
    targetCodeSha,
    generatedAt,
    expiresAt,
    previewHash,
    previewToken,
    previewTokenDigest: hash(previewToken),
    actorDigest,
    plan: {
      videoId: V04_GRAY_TEST_MEDIA.videoId,
      objectKeyDigest: hash(V04_GRAY_TEST_MEDIA.objectKey),
      title: V04_GRAY_TEST_MEDIA.title,
      contentType: V04_GRAY_TEST_MEDIA.contentType,
      originalName: V04_GRAY_TEST_MEDIA.originalName,
      fileSize: V04_GRAY_TEST_MEDIA.fileSize,
      mediaSha256: V04_GRAY_TEST_MEDIA.sha256,
      dataScope: "TEST_ONLY",
      testRunId: V04_GRAY_TEST_MEDIA.testRunId,
    },
    facts: {
      actorActive: system.actorActive,
      actorSystemAdmin: system.actorSystemAdmin,
      contractsActive: system.contractsActive,
      targetState: state,
      objectState: object.state,
      ledgerState,
      legalState,
      businessVideoCount: business.count,
      businessFingerprint: business.hash,
      ledgerAppliedCount: appliedCount,
    },
    zeroWrite: { beforeHash, afterHash, unchanged },
  };
}

function resultFromLedger(row: LedgerRow): V04GrayTestObjectApplyResult {
  const result = row.result_json;
  if (!result) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "相同 TEST_ONLY 媒体操作仍在执行。", {
      operationKey: row.operation_key,
    });
  }
  return {
    operationKey: row.operation_key,
    status: result.status,
    outcome: result.outcome,
    alreadyApplied: result.status === "APPLIED",
    videoId: result.videoId,
    dataScope: result.dataScope,
    testRunId: result.testRunId,
    fileSize: result.fileSize,
    mediaSha256: result.mediaSha256,
    objectKeyDigest: result.objectKeyDigest,
    actorDigest: hashV04GrayUserId(row.actor_identity),
    objectEtagDigest: result.objectEtagDigest ?? null,
    creationMarkerDigest: result.creationMarkerDigest ?? null,
    targetCodeSha: result.targetCodeSha,
    previewTokenDigest: result.previewTokenDigest,
    businessFingerprint: result.businessFingerprint,
    completedAt: result.completedAt,
    compensation: result.compensation,
    failure: result.failure,
  };
}

async function sha256BucketObject(bucket: VideoBucket, key: string) {
  const object = await bucket.get(key);
  if (!object.body) return null;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  if (bytes.byteLength > V04_GRAY_TEST_MEDIA.fileSize) return null;
  return createHash("sha256").update(bytes).digest("hex");
}

async function objectIsOwnedByOperation(
  bucket: VideoBucket,
  creationMarker: string,
  etag: string | null,
) {
  if (!etag) return false;
  const head = await bucket.head(V04_GRAY_TEST_MEDIA.objectKey);
  if (!head || head.httpEtag !== etag
    || head.customMetadata?.["creation-marker"] !== creationMarker
    || head.size !== V04_GRAY_TEST_MEDIA.fileSize
    || head.contentType !== V04_GRAY_TEST_MEDIA.contentType
    || head.customMetadata?.sha256 !== V04_GRAY_TEST_MEDIA.sha256) return false;
  return await sha256BucketObject(bucket, V04_GRAY_TEST_MEDIA.objectKey)
    === V04_GRAY_TEST_MEDIA.sha256;
}

function failure(stage: string, error: unknown) {
  return {
    stage,
    code: error instanceof V04ServiceError ? error.code : "GRAY_TEST_OBJECT_FAILED",
  };
}

export async function applyV04GrayTestObject(
  db: DbClient,
  bucket: VideoBucket,
  actor: V04Actor,
  input: V04GrayTestObjectApplyInput,
  options: { tokenSecret: string; now?: Date; targetCodeSha?: string; failAt?: string },
): Promise<V04GrayTestObjectApplyResult> {
  const now = options.now ?? new Date();
  const targetCodeSha = v04TargetCodeSha(options.targetCodeSha);
  if (input.action !== "CREATE_TEST_ONLY_GRAY_VIDEO"
    || input.confirmation !== V04_GRAY_TEST_OBJECT_CONFIRMATION
    || requireText(input.targetCodeSha, "目标代码 SHA", 7, 64) !== targetCodeSha) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "TEST_ONLY 媒体创建确认不正确。");
  }
  const idempotencyKey = requireText(input.idempotencyKey, "幂等键", 16, 128);
  const approvalReference = requireText(input.approvalReference, "批准引用", 12, 512);
  const payload = parseToken(input.previewToken, options.tokenSecret);
  const actorDigest = hashV04GrayUserId(actor.userId);
  if (payload.actorDigest !== actorDigest || payload.targetCodeSha !== targetCodeSha
    || payload.videoId !== V04_GRAY_TEST_MEDIA.videoId
    || payload.objectKey !== V04_GRAY_TEST_MEDIA.objectKey
    || payload.mediaSha256 !== V04_GRAY_TEST_MEDIA.sha256
    || Date.parse(payload.expiresAt) <= now.getTime()) {
    throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体 PREVIEW 已失效或事实不匹配。");
  }
  const operationDigest = hash({
    type: V04_GRAY_TEST_OBJECT_OPERATION_TYPE,
    idempotencyKey,
    actorDigest,
    targetCodeSha,
    videoId: V04_GRAY_TEST_MEDIA.videoId,
    previewHash: payload.previewHash,
  });
  const operationKey = `V04_GRAY_TEST_OBJECT:${operationDigest}`;
  const previewTokenDigest = hash(input.previewToken);

  return db.withTransaction(async (tx) => {
    await tx.prepare("SET LOCAL lock_timeout = '5s'").run();
    await tx.prepare("SET LOCAL statement_timeout = '55s'").run();
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")
      .bind(V04_GRAY_TEST_OBJECT_LOCK_KEY).run();
    const preview = await previewV04GrayTestObject(tx, bucket, actor, {
      tokenSecret: options.tokenSecret,
      now,
      targetCodeSha,
    });
    if (!preview.ready || preview.actorDigest !== actorDigest
      || preview.targetCodeSha !== targetCodeSha || !preview.zeroWrite.unchanged) {
      throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体事实已经变化。", {
        stopReasons: preview.stopReasons,
      });
    }
    const existing = await tx.prepare(`SELECT operation_key,status,actor_identity,target_video_id,
        source_hash,target_hash,non_target_hash,backup_json,result_json
      FROM admin_data_operations WHERE operation_key=? FOR UPDATE`)
      .bind(operationKey).first<LedgerRow>();
    if (existing) {
      if (existing.actor_identity !== actor.userId
        || existing.target_video_id !== V04_GRAY_TEST_MEDIA.videoId) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等键已绑定另一项操作。");
      }
      if (existing.result_json?.outcome === "APPLIED"
        && (!preview.alreadyApplied || !exactLedger(existing, actor.userId, targetCodeSha))) {
        throw new V04ServiceError("STALE_PREVIEW", "已执行账本与当前目标事实不一致。");
      }
      if (existing.result_json?.outcome === "FAILED"
        && preview.facts.legalState !== "CLEAN_CREATE") {
        throw new V04ServiceError("STALE_PREVIEW", "失败操作的目标事实不再处于可重试基线。");
      }
      return resultFromLedger(existing);
    }
    if (preview.alreadyApplied) {
      const rows = await appliedLedgers(tx);
      const applied = rows.length === 1 ? rows[0] : null;
      if (!applied || !exactLedger(applied, actor.userId, targetCodeSha)) {
        throw new V04ServiceError("STALE_PREVIEW", "已执行账本与当前目标事实不一致。");
      }
      return resultFromLedger(applied);
    }
    if (preview.facts.legalState !== "CLEAN_CREATE"
      || preview.previewHash !== payload.previewHash) {
      throw new V04ServiceError("STALE_PREVIEW", "TEST_ONLY 媒体事实已经变化。", {
        stopReasons: preview.stopReasons,
      });
    }
    const initialBusinessHash = preview.facts.businessFingerprint;
    await tx.prepare(`INSERT INTO admin_data_operations (
      operation_key,operation_type,target_video_id,status,actor_identity,actor_name,
      preview_token,source_hash,target_hash,non_target_hash,backup_json,result_json,
      created_at,completed_at
    ) VALUES (?,?,?,'RUNNING',?,?,?,?,?,?,?::jsonb,NULL,?,NULL)`)
      .bind(
        operationKey, V04_GRAY_TEST_OBJECT_OPERATION_TYPE, V04_GRAY_TEST_MEDIA.videoId,
        actor.userId, actor.displayName, previewTokenDigest, preview.previewHash,
        V04_GRAY_TEST_MEDIA.sha256, initialBusinessHash,
        JSON.stringify({
          approvalReference,
          previewTokenDigest,
          previewHash: preview.previewHash,
          targetCodeSha,
          targetVideoId: V04_GRAY_TEST_MEDIA.videoId,
          mediaSha256: V04_GRAY_TEST_MEDIA.sha256,
          actorDigest,
          objectKeyDigest: hash(V04_GRAY_TEST_MEDIA.objectKey),
          testRunId: V04_GRAY_TEST_MEDIA.testRunId,
          targetExisted: false,
          retention: "SOFT_DELETE_90_DAYS_NO_IMMEDIATE_COS_DELETE",
        }),
        now.toISOString(),
      ).run();
    await tx.prepare("SAVEPOINT v04_gray_test_object_body").run();
    const creationMarker = operationKey;
    let createdObject = false;
    let createdEtag: string | null = null;
    let stage = "MEDIA_UPLOAD";
    try {
      if (await bucket.head(V04_GRAY_TEST_MEDIA.objectKey)) {
        throw new V04ServiceError("STALE_PREVIEW", "目标对象已存在，拒绝覆盖。");
      }
      await bucket.put(V04_GRAY_TEST_MEDIA.objectKey, v04GrayTestMediaBytes(), {
        httpMetadata: { contentType: V04_GRAY_TEST_MEDIA.contentType },
        ifNoneMatch: "*",
        customMetadata: {
          "data-scope": "TEST_ONLY",
          "test-run-id": V04_GRAY_TEST_MEDIA.testRunId,
          "sha256": V04_GRAY_TEST_MEDIA.sha256,
          "creation-marker": creationMarker,
        },
      });
      createdObject = true;
      stage = "MEDIA_VERIFY";
      const head = await bucket.head(V04_GRAY_TEST_MEDIA.objectKey);
      const objectHash = await sha256BucketObject(bucket, V04_GRAY_TEST_MEDIA.objectKey);
      if (!head || !head.httpEtag
        || head.size !== V04_GRAY_TEST_MEDIA.fileSize
        || head.contentType !== V04_GRAY_TEST_MEDIA.contentType
        || head.customMetadata?.["data-scope"] !== "TEST_ONLY"
        || head.customMetadata?.["test-run-id"] !== V04_GRAY_TEST_MEDIA.testRunId
        || head.customMetadata?.sha256 !== V04_GRAY_TEST_MEDIA.sha256
        || head.customMetadata?.["creation-marker"] !== creationMarker
        || objectHash !== V04_GRAY_TEST_MEDIA.sha256) {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "固定 TEST_ONLY 媒体校验失败。");
      }
      createdEtag = head.httpEtag;
      if (options.failAt === "AFTER_UPLOAD") throw new Error("INJECTED_FAILURE");
      stage = "DATABASE_INSERT";
      await tx.prepare(`INSERT INTO videos (
        id,domain_key,title,brand,description,tags_json,object_key,thumbnail_key,
        original_name,content_type,file_size,status,rights_confirmed,created_by_email,
        created_by_name,created_at,updated_at,deleted_at,data_scope,test_run_id,
        created_by_user_id,deletion_state
      ) VALUES (?,'AD_VIDEO',?,?,?,?::jsonb,?,NULL,?,?,?,'READY',1,?,?,?, ?,NULL,
        'TEST_ONLY',?,?,'ACTIVE')`)
        .bind(
          V04_GRAY_TEST_MEDIA.videoId, V04_GRAY_TEST_MEDIA.title, V04_GRAY_TEST_MEDIA.brand,
          V04_GRAY_TEST_MEDIA.description, JSON.stringify(["V0.4", "TEST_ONLY", "灰度验证"]),
          V04_GRAY_TEST_MEDIA.objectKey, V04_GRAY_TEST_MEDIA.originalName,
          V04_GRAY_TEST_MEDIA.contentType, V04_GRAY_TEST_MEDIA.fileSize,
          actor.identityKey, actor.displayName, now.toISOString(), now.toISOString(),
          V04_GRAY_TEST_MEDIA.testRunId, actor.userId,
        ).run();
      await tx.prepare(`INSERT INTO audit_logs (
        id,actor_email,action,object_type,object_id,detail_json,actor_user_id,
        request_id,workflow_version
      ) VALUES (?,?,'V04_GRAY_TEST_OBJECT_CREATED','VIDEO',?,?::jsonb,?,?,?)`)
        .bind(
          `audit_${crypto.randomUUID()}`, actor.identityKey, V04_GRAY_TEST_MEDIA.videoId,
          JSON.stringify({
            dataScope: "TEST_ONLY",
            testRunId: V04_GRAY_TEST_MEDIA.testRunId,
            fileSize: V04_GRAY_TEST_MEDIA.fileSize,
            mediaSha256: V04_GRAY_TEST_MEDIA.sha256,
            objectKeyDigest: hash(V04_GRAY_TEST_MEDIA.objectKey),
            assetCleanup: "SOFT_DELETE_90_DAYS",
          }),
          actor.userId, idempotencyKey, V04_WORKFLOW_VERSION,
        ).run();
      if (options.failAt === "AFTER_DATABASE_INSERT") throw new Error("INJECTED_FAILURE");
      stage = "BUSINESS_INVARIANT";
      const afterBusiness = await businessFingerprint(tx);
      if (afterBusiness.hash !== initialBusinessHash || afterBusiness.count !== preview.facts.businessVideoCount) {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "普通业务案例指纹发生变化。");
      }
      const result: V04GrayTestObjectApplyResult = {
        operationKey,
        status: "APPLIED",
        outcome: "APPLIED",
        alreadyApplied: false,
        videoId: V04_GRAY_TEST_MEDIA.videoId,
        dataScope: "TEST_ONLY",
        testRunId: V04_GRAY_TEST_MEDIA.testRunId,
        fileSize: V04_GRAY_TEST_MEDIA.fileSize,
        mediaSha256: V04_GRAY_TEST_MEDIA.sha256,
        objectKeyDigest: hash(V04_GRAY_TEST_MEDIA.objectKey),
        actorDigest,
        objectEtagDigest: hash(createdEtag),
        creationMarkerDigest: hash(creationMarker),
        targetCodeSha,
        previewTokenDigest,
        businessFingerprint: initialBusinessHash,
        completedAt: now.toISOString(),
        compensation: "NOT_NEEDED",
      };
      await tx.prepare(`UPDATE admin_data_operations SET status='COMPLETED',result_json=?::jsonb,
        completed_at=? WHERE operation_key=? AND status='RUNNING'`)
        .bind(JSON.stringify(result), now.toISOString(), operationKey).run();
      stage = "FINAL_STATE_INVARIANT";
      const finalPreview = await previewV04GrayTestObject(tx, bucket, actor, {
        tokenSecret: options.tokenSecret,
        now,
        targetCodeSha,
      });
      if (!finalPreview.ready || !finalPreview.alreadyApplied
        || finalPreview.facts.legalState !== "EXACT_APPLIED"
        || finalPreview.facts.ledgerAppliedCount !== 1
        || finalPreview.facts.businessFingerprint !== initialBusinessHash) {
        throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "创建后的目标、对象与账本不一致。");
      }
      return result;
    } catch (error) {
      await tx.prepare("ROLLBACK TO SAVEPOINT v04_gray_test_object_body").run();
      let compensation: V04GrayTestObjectApplyResult["compensation"] = "NOT_NEEDED";
      if (createdObject) {
        try {
          if (await objectIsOwnedByOperation(bucket, creationMarker, createdEtag)) {
            await bucket.delete(V04_GRAY_TEST_MEDIA.objectKey);
            compensation = "OBJECT_DELETED";
          } else {
            compensation = "OBJECT_DELETE_REFUSED";
          }
        } catch {
          compensation = "OBJECT_DELETE_FAILED";
        }
      }
      const result: V04GrayTestObjectApplyResult = {
        operationKey,
        status: "FAILED",
        outcome: "FAILED",
        alreadyApplied: false,
        videoId: V04_GRAY_TEST_MEDIA.videoId,
        dataScope: "TEST_ONLY",
        testRunId: V04_GRAY_TEST_MEDIA.testRunId,
        fileSize: V04_GRAY_TEST_MEDIA.fileSize,
        mediaSha256: V04_GRAY_TEST_MEDIA.sha256,
        objectKeyDigest: hash(V04_GRAY_TEST_MEDIA.objectKey),
        actorDigest,
        objectEtagDigest: createdEtag ? hash(createdEtag) : null,
        creationMarkerDigest: createdObject ? hash(creationMarker) : null,
        targetCodeSha,
        previewTokenDigest,
        businessFingerprint: initialBusinessHash,
        completedAt: now.toISOString(),
        compensation,
        failure: failure(stage, error),
      };
      await tx.prepare(`UPDATE admin_data_operations SET status='COMPLETED',result_json=?::jsonb,
        completed_at=? WHERE operation_key=? AND status='RUNNING'`)
        .bind(JSON.stringify(result), now.toISOString(), operationKey).run();
      return result;
    }
  });
}
