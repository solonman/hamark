import { createHash, timingSafeEqual } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import {
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "./v04-contract";
import { V04ServiceError } from "./v04-errors";

type Environment = Record<string, string | undefined>;

export type V04GrayConfig = {
  enabled: boolean;
  valid: boolean;
  stableUserIdSha256s: ReadonlySet<string>;
  testVideoIds: ReadonlySet<string>;
  controlledVideoIds: ReadonlySet<string>;
};

export type V04GrayFacts = {
  userStatus: string | null;
  contractsActive: boolean;
  video?: {
    id: string;
    status: string;
    dataScope: string;
    objectKey: string;
    fileSize: number;
    deletedAt: string | null;
    deletionState: string | null;
  } | null;
};

export type V04GrayDecision = {
  allowed: boolean;
  reason:
    | "GRANTED"
    | "GATE_CLOSED"
    | "INVALID_ALLOWLIST"
    | "USER_NOT_ALLOWED"
    | "USER_NOT_ACTIVE"
    | "CONTRACT_NOT_ACTIVE"
    | "VIDEO_NOT_ALLOWED"
    | "VIDEO_NOT_READY"
    | "VIDEO_NOT_TEST_ONLY";
};

export type V04DefaultAccessDecision = {
  allowed: boolean;
  reason:
    | "GRANTED"
    | "USER_NOT_ACTIVE"
    | "CONTRACT_NOT_ACTIVE"
    | "VIDEO_NOT_FOUND"
    | "VIDEO_NOT_READY"
    | "VIDEO_NOT_BUSINESS";
};

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TEST_ONLY_USER_ID = /^user_(?:test|testonly)_[A-Za-z0-9][A-Za-z0-9_-]{2,}$/;
const STABLE_VIDEO_ID = /^video_[A-Za-z0-9_-]{8,}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export function normalizeV04GrayUserId(userId: string) {
  if (CANONICAL_UUID.test(userId)) return userId.toLowerCase();
  if (LEGACY_TEST_ONLY_USER_ID.test(userId)) return userId;
  throw new V04ServiceError("FORBIDDEN", "当前稳定身份不符合灰度摘要合同。");
}

export function hashV04GrayUserId(userId: string) {
  const canonicalUserId = normalizeV04GrayUserId(userId);
  return createHash("sha256")
    .update(`hamark:v04:gray-user:v1\0${canonicalUserId}`, "utf8")
    .digest("hex");
}

function digestAllowlistContains(config: V04GrayConfig, userId: string) {
  const actual = Buffer.from(hashV04GrayUserId(userId), "hex");
  let matched = 0;
  for (const digest of config.stableUserIdSha256s) {
    matched |= Number(timingSafeEqual(actual, Buffer.from(digest, "hex")));
  }
  return matched === 1;
}

function parseIds(value: string | undefined, pattern: RegExp) {
  const raw = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const unique = new Set(raw);
  return {
    ids: unique,
    valid: raw.length === unique.size && raw.length <= 32 && raw.every((item) => pattern.test(item)),
  };
}

export function loadV04GrayConfig(environment: Environment = process.env): V04GrayConfig {
  const users = parseIds(environment.V04_GRAY_USER_ID_SHA256S, SHA256_DIGEST);
  const testVideos = parseIds(environment.V04_GRAY_TEST_VIDEO_IDS, STABLE_VIDEO_ID);
  const controlledVideos = parseIds(environment.V04_GRAY_CONTROLLED_VIDEO_IDS, STABLE_VIDEO_ID);
  const enabled = environment.V04_GRAY_ROLLOUT_ENABLED === "true";
  return {
    enabled,
    valid: users.valid && testVideos.valid && controlledVideos.valid
      && users.ids.size > 0
      && (testVideos.ids.size + controlledVideos.ids.size) > 0,
    stableUserIdSha256s: users.ids,
    testVideoIds: testVideos.ids,
    controlledVideoIds: controlledVideos.ids,
  };
}

function videoHasUsableMedia(video: NonNullable<V04GrayFacts["video"]>) {
  return video.status === "READY"
    && video.objectKey.trim().length > 0
    && Number(video.fileSize) > 0
    && video.deletedAt === null
    && (video.deletionState === null || video.deletionState === "ACTIVE");
}

export function evaluateV04DefaultAccess(
  facts: V04GrayFacts,
  videoId?: string,
): V04DefaultAccessDecision {
  if (facts.userStatus !== "ACTIVE") return { allowed: false, reason: "USER_NOT_ACTIVE" };
  if (!facts.contractsActive) return { allowed: false, reason: "CONTRACT_NOT_ACTIVE" };
  if (!videoId) return { allowed: true, reason: "GRANTED" };
  if (!facts.video || facts.video.id !== videoId) {
    return { allowed: false, reason: "VIDEO_NOT_FOUND" };
  }
  if (facts.video.dataScope !== "BUSINESS") {
    return { allowed: false, reason: "VIDEO_NOT_BUSINESS" };
  }
  if (!videoHasUsableMedia(facts.video)) {
    return { allowed: false, reason: "VIDEO_NOT_READY" };
  }
  return { allowed: true, reason: "GRANTED" };
}

export function evaluateV04GrayAccess(
  config: V04GrayConfig,
  userId: string,
  facts: V04GrayFacts,
  videoId?: string,
): V04GrayDecision {
  if (!config.enabled) return { allowed: false, reason: "GATE_CLOSED" };
  if (!config.valid) return { allowed: false, reason: "INVALID_ALLOWLIST" };
  if (!digestAllowlistContains(config, userId)) {
    return { allowed: false, reason: "USER_NOT_ALLOWED" };
  }
  if (facts.userStatus !== "ACTIVE") return { allowed: false, reason: "USER_NOT_ACTIVE" };
  if (!facts.contractsActive) return { allowed: false, reason: "CONTRACT_NOT_ACTIVE" };
  if (!videoId) return { allowed: true, reason: "GRANTED" };
  const isTestVideo = config.testVideoIds.has(videoId);
  const isControlledVideo = config.controlledVideoIds.has(videoId);
  if (!isTestVideo && !isControlledVideo) return { allowed: false, reason: "VIDEO_NOT_ALLOWED" };
  if (!facts.video || facts.video.id !== videoId || !videoHasUsableMedia(facts.video)) {
    return { allowed: false, reason: "VIDEO_NOT_READY" };
  }
  if (isTestVideo && !isControlledVideo && facts.video.dataScope !== "TEST_ONLY") {
    return { allowed: false, reason: "VIDEO_NOT_TEST_ONLY" };
  }
  return { allowed: true, reason: "GRANTED" };
}

type ContractFactsRow = QueryResultRow & {
  user_status: string | null;
  taxonomy_active: number;
  vocabulary_active: number;
  workflow_active: number;
};

type VideoFactsRow = QueryResultRow & {
  id: string;
  status: string;
  data_scope: string;
  object_key: string;
  file_size: number;
  deleted_at: string | null;
  deletion_state: string | null;
};

async function loadActorAndContractFacts(db: DbClient, userId: string) {
  const row = await db.prepare(
    `SELECT
      (SELECT status FROM users WHERE id = ?) AS user_status,
      (SELECT COUNT(*) FROM annotation_taxonomy_versions
        WHERE taxonomy_version = ? AND status = 'ACTIVE') AS taxonomy_active,
      (SELECT COUNT(*) FROM annotation_vocabulary_versions
        WHERE vocabulary_version = ? AND status = 'ACTIVE') AS vocabulary_active,
      (SELECT COUNT(*) FROM workflow_contract_versions
        WHERE workflow_version = ? AND status = 'ACTIVE') AS workflow_active`,
  ).bind(userId, V04_TAXONOMY_VERSION, V04_VOCABULARY_VERSION, V04_WORKFLOW_VERSION)
    .first<ContractFactsRow>();
  return {
    userStatus: row?.user_status ?? null,
    contractsActive: Number(row?.taxonomy_active ?? 0) === 1
      && Number(row?.vocabulary_active ?? 0) === 1
      && Number(row?.workflow_active ?? 0) === 1,
  };
}

async function loadVideoFacts(db: DbClient, videoId: string) {
  const row = await db.prepare(
    `SELECT id,status,data_scope,object_key,file_size,deleted_at,deletion_state
    FROM videos WHERE id = ?`,
  ).bind(videoId).first<VideoFactsRow>();
  return row ? {
    id: row.id,
    status: row.status,
    dataScope: row.data_scope,
    objectKey: row.object_key,
    fileSize: Number(row.file_size),
    deletedAt: row.deleted_at,
    deletionState: row.deletion_state,
  } : null;
}

export async function decideV04GrayAccess(
  db: DbClient,
  userId: string,
  videoId?: string,
  environment: Environment = process.env,
) {
  const config = loadV04GrayConfig(environment);
  if (!config.enabled || !config.valid || !digestAllowlistContains(config, userId)) {
    return evaluateV04GrayAccess(config, userId, { userStatus: null, contractsActive: false }, videoId);
  }
  const actorFacts = await loadActorAndContractFacts(db, userId);
  const video = videoId ? await loadVideoFacts(db, videoId) : undefined;
  return evaluateV04GrayAccess(config, userId, { ...actorFacts, video }, videoId);
}

export async function canAccessV04Gray(
  db: DbClient,
  userId: string,
  videoId?: string,
  environment: Environment = process.env,
) {
  return (await decideV04GrayAccess(db, userId, videoId, environment)).allowed;
}

export async function decideV04DefaultAccess(
  db: DbClient,
  userId: string,
  videoId?: string,
) {
  const actorFacts = await loadActorAndContractFacts(db, userId);
  const video = videoId ? await loadVideoFacts(db, videoId) : undefined;
  return evaluateV04DefaultAccess({ ...actorFacts, video }, videoId);
}

export async function canAccessV04Default(
  db: DbClient,
  userId: string,
  videoId?: string,
) {
  return (await decideV04DefaultAccess(db, userId, videoId)).allowed;
}

export async function canAccessV04Surface(
  db: DbClient,
  userId: string,
  videoId?: string,
  environment: Environment = process.env,
) {
  return environment.V04_DEFAULT_UI_ENABLED === "true"
    ? canAccessV04Default(db, userId, videoId)
    : canAccessV04Gray(db, userId, videoId, environment);
}

export async function assertV04DefaultAccess(
  db: DbClient,
  userId: string,
  videoId?: string,
) {
  const decision = await decideV04DefaultAccess(db, userId, videoId);
  if (decision.allowed) return decision;
  if (decision.reason === "CONTRACT_NOT_ACTIVE") {
    throw new V04ServiceError("UNSUPPORTED_WORKFLOW", "V0.4 工作流当前未激活。", {
      reason: decision.reason,
    });
  }
  if (decision.reason.startsWith("VIDEO_")) {
    throw new V04ServiceError("CASE_NOT_FOUND", "该案例当前不可用于 V0.4 逆向工程。", {
      reason: decision.reason,
    });
  }
  throw new V04ServiceError("FORBIDDEN", "当前稳定身份无权访问 V0.4。", {
    reason: decision.reason,
  });
}

export async function assertV04GrayAccess(
  db: DbClient,
  userId: string,
  videoId?: string,
  environment: Environment = process.env,
) {
  const decision = await decideV04GrayAccess(db, userId, videoId, environment);
  if (decision.allowed) return decision;
  if (decision.reason === "GATE_CLOSED" || decision.reason === "CONTRACT_NOT_ACTIVE") {
    throw new V04ServiceError("UNSUPPORTED_WORKFLOW", "V0.4 小范围灰度当前未开放。", { reason: decision.reason });
  }
  if (decision.reason.startsWith("VIDEO_")) {
    throw new V04ServiceError("CASE_NOT_FOUND", "该案例未进入 V0.4 受控灰度。", { reason: decision.reason });
  }
  throw new V04ServiceError("FORBIDDEN", "当前稳定身份未进入 V0.4 受控灰度。", { reason: decision.reason });
}

export function v04GrayVideoIdFromRequest(request: Request) {
  const match = new URL(request.url).pathname.match(/^\/api\/videos\/([^/]+)\/analysis\/v04(?:\/|$)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

export async function filterV04GrayVideoIds(
  db: DbClient,
  videoIds: string[],
  environment: Environment = process.env,
) {
  const config = loadV04GrayConfig(environment);
  if (!config.enabled || !config.valid) return [];
  const candidates = [...new Set(videoIds)].filter((id) =>
    config.testVideoIds.has(id) || config.controlledVideoIds.has(id));
  if (candidates.length === 0) return [];
  const rows = await db.prepare(
    `SELECT id,status,data_scope,object_key,file_size,deleted_at,deletion_state
    FROM videos WHERE id IN (${candidates.map(() => "?").join(",")})`,
  ).bind(...candidates).all<VideoFactsRow>();
  const facts = new Map(rows.results.map((row) => [row.id, {
    id: row.id,
    status: row.status,
    dataScope: row.data_scope,
    objectKey: row.object_key,
    fileSize: Number(row.file_size),
    deletedAt: row.deleted_at,
    deletionState: row.deletion_state,
  }]));
  return candidates.filter((id) => {
    const video = facts.get(id);
    if (!video || !videoHasUsableMedia(video)) return false;
    if (config.testVideoIds.has(id) && !config.controlledVideoIds.has(id)) {
      return video.dataScope === "TEST_ONLY";
    }
    return config.controlledVideoIds.has(id);
  });
}

export async function filterV04DefaultVideoIds(db: DbClient, videoIds: string[]) {
  const candidates = [...new Set(videoIds)];
  if (candidates.length === 0) return [];
  const rows = await db.prepare(
    `SELECT id,status,data_scope,object_key,file_size,deleted_at,deletion_state
    FROM videos WHERE id IN (${candidates.map(() => "?").join(",")})`,
  ).bind(...candidates).all<VideoFactsRow>();
  const facts = new Map(rows.results.map((row) => [row.id, {
    id: row.id,
    status: row.status,
    dataScope: row.data_scope,
    objectKey: row.object_key,
    fileSize: Number(row.file_size),
    deletedAt: row.deleted_at,
    deletionState: row.deletion_state,
  }]));
  return candidates.filter((id) => {
    const video = facts.get(id);
    return Boolean(video && video.dataScope === "BUSINESS" && videoHasUsableMedia(video));
  });
}

export async function filterV04AccessibleVideoIds(
  db: DbClient,
  videoIds: string[],
  environment: Environment = process.env,
) {
  return environment.V04_DEFAULT_UI_ENABLED === "true"
    ? filterV04DefaultVideoIds(db, videoIds)
    : filterV04GrayVideoIds(db, videoIds, environment);
}
