// 录音点评改写的服务层（docs/25 四）：建任务（含虚拟 v1 物化）、UPLOADED / RETRY / ABANDON /
// CONFIRM 四个动作、后台推进 advanceAudioReview，以及工作台需要的摘要。
//
// 推进模型（4.3）：没有常驻进程。每次 UPLOADED、RETRY 和 GET 都在响应发出后用 after() 调一次
// advanceAudioReview，deadline = 请求开始 + 280 秒。进门先抢租约（290 秒），抢不到说明另一次推进
// 正在跑，直接返回；抢到后在 deadline 之内能走多远走多远，退出时只清自己的租约。每一步的写入都带
// 「状态仍是我以为的那个」条件，所以中途被放弃（ABANDON）不会被后台写回来。
// 外部错误（腾讯云、DeepSeek、存储）一律翻成中文 fail_reason，绝不向外抛。

import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import {
  AUDIO_REVIEW_MAX_BYTES,
  audioReviewContentType,
  type AudioReviewActionRequestBody,
  type AudioReviewFailedStep,
  type AudioReviewStatus,
  type CreateAudioReviewRequestBody,
  type V19AudioReviewSummary,
} from "@/lib/audio-review-model";
import { isCaseReviewer } from "@/lib/case-review";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04DraftPayloadV1,
} from "@/lib/v04-contract";
import { assertV04PayloadContract, hashV04Payload, listV04ContractViolations } from "@/lib/v04-domain";
import { V04ServiceError } from "@/lib/v04-errors";
import {
  VERSION_COLUMNS,
  findVersionById,
  insertAudit,
  listVersionRows,
  materializeV19FirstVersion,
  nextV19VersionNumber,
  parseJsonPayload,
  workspaceForVideo,
  type AnalysisVersionRow,
  type WorkspaceRow,
} from "@/lib/v19-version-chain";
import type { V04Actor } from "@/lib/v04-workspace-service";
import type { VideoBucket } from "@/storage/types";
import type { AudioReviewConfig } from "./config";
import { isAudioReviewAvailable } from "./config";
import { parseModelJsonContent } from "./deepseek";
import { AudioReviewError, isMissingAudioReviewSchema } from "./errors";
import {
  AUDIO_REVIEW_PROMPT_VERSION,
  buildAudioReviewMessages,
  hashAudioReviewInput,
  type AudioReviewPromptContext,
} from "./prompt";
import {
  audioReviewChangeReason,
  buildAudioReviewChangeSet,
  normalizeAudioReviewProposal,
  parseStoredProposal,
} from "./proposal";
import type { AudioReviewProviders } from "./providers";
import { buildAsrHotwords, formatHotwordList } from "./tencent-asr";
import { parseStoredTranscript } from "./transcript";
import {
  AUDIO_REVIEW_COLUMNS,
  AUDIO_REVIEW_COLUMNS_AR,
  isoOrNull,
  toAudioReviewSummary,
  type AudioReviewRow,
  type AudioReviewSummaryRow,
} from "./view";

export const AUDIO_REVIEW_UPLOAD_URL_TTL_SECONDS = 900;
export const AUDIO_REVIEW_AUDIO_URL_TTL_SECONDS = 3 * 60 * 60;
export const AUDIO_REVIEW_DEADLINE_MS = 280_000;
export const AUDIO_REVIEW_LEASE_SECONDS = 290;
export const AUDIO_REVIEW_MIN_LLM_WINDOW_MS = 245_000;
export const AUDIO_REVIEW_LLM_TIMEOUT_MS = 240_000;
export const AUDIO_REVIEW_MAX_LLM_ATTEMPTS = 2;
/** 转写提交后超过这么久还没结果，就不再等了（腾讯云一般几分钟内返回）。 */
export const AUDIO_REVIEW_TRANSCRIBE_MAX_MS = 2 * 60 * 60 * 1000;
/** 留给每次轮询前后写库的余量。 */
const POLL_MARGIN_MS = 1_000;

export type AudioReviewDeps = {
  providers: AudioReviewProviders;
  bucket: Pick<VideoBucket, "createPresignedPutUrl" | "createPresignedGetUrl" | "head">;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  log?: (message: string, detail?: unknown) => void;
};

export const newAudioReviewId = () => `arv_${randomUUID()}`;
export const audioReviewObjectKey = (reviewId: string) => `audio-reviews/${reviewId}/original`;

const ADVANCEABLE: readonly AudioReviewStatus[] = ["TRANSCRIBING", "UNDERSTANDING"];

function forbidden() {
  return new AudioReviewError(403, "FORBIDDEN", "只有老孙可以上传和处理点评录音。");
}

function notFound() {
  return new AudioReviewError(404, "AUDIO_REVIEW_NOT_FOUND", "点评录音不存在。");
}

function invalidState(message: string) {
  return new AudioReviewError(409, "AUDIO_REVIEW_INVALID_STATE", message);
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export async function loadAudioReview(db: DbClient, videoId: string, reviewId: string, lock = false) {
  if (lock) {
    return db.prepare(
      `SELECT ${AUDIO_REVIEW_COLUMNS} FROM audio_reviews WHERE id = ? AND video_id = ? FOR UPDATE`,
    ).bind(reviewId, videoId).first<AudioReviewRow>();
  }
  return db.prepare(
    `SELECT ${AUDIO_REVIEW_COLUMNS_AR}, rv.version_number AS review_version_number
    FROM audio_reviews ar
    LEFT JOIN analysis_versions rv ON rv.id = ar.review_version_id
    WHERE ar.id = ? AND ar.video_id = ?`,
  ).bind(reviewId, videoId).first<AudioReviewRow>();
}

/** 按可见性取一条：老孙任何状态都看得到；其他人只有已生成的，否则当作不存在（404）。 */
export async function loadAudioReviewForViewer(db: DbClient, actor: V04Actor, videoId: string, reviewId: string) {
  const row = await loadAudioReview(db, videoId, reviewId);
  if (!row) throw notFound();
  if (!isCaseReviewer(actor.displayName) && row.status !== "GENERATED") throw notFound();
  return row;
}

export async function listAudioReviewSummaries(
  db: DbClient,
  videoId: string,
  viewerDisplayName: string,
): Promise<V19AudioReviewSummary[]> {
  const reviewer = isCaseReviewer(viewerDisplayName);
  const rows = (await db.prepare(
    `SELECT ar.id, ar.base_version_id, ar.status, ar.failed_step, ar.fail_reason,
      CASE WHEN jsonb_typeof(ar.proposal_json -> 'changes') = 'array'
        THEN jsonb_array_length(ar.proposal_json -> 'changes') ELSE 0 END AS proposal_change_count,
      CASE WHEN jsonb_typeof(ar.selected_change_ids) = 'array'
        THEN jsonb_array_length(ar.selected_change_ids) ELSE 0 END AS selected_change_count,
      ar.review_version_id, rv.version_number AS review_version_number
    FROM audio_reviews ar
    LEFT JOIN analysis_versions rv ON rv.id = ar.review_version_id
    WHERE ar.video_id = ? AND ar.status <> 'ABANDONED'${reviewer ? "" : " AND ar.status = 'GENERATED'"}
    ORDER BY ar.created_at ASC`,
  ).bind(videoId).all<AudioReviewSummaryRow>()).results;
  return rows.map(toAudioReviewSummary);
}

/**
 * 工作台 GET /analysis/v19 用：摘要 + 入口开关。迁移没执行（或这张表读不出来）时降级成
 * 空列表、入口关闭，不让整个工作台挂掉。
 */
export async function loadAudioReviewStudioState(
  db: DbClient,
  videoId: string,
  actor: Pick<V04Actor, "displayName">,
  config: AudioReviewConfig,
  log: (message: string, detail?: unknown) => void = console.error,
): Promise<{ audioReviews: V19AudioReviewSummary[]; audioReviewAvailable: boolean }> {
  try {
    const audioReviews = await listAudioReviewSummaries(db, videoId, actor.displayName);
    return { audioReviews, audioReviewAvailable: isAudioReviewAvailable(actor.displayName, config) };
  } catch (error) {
    if (!isMissingAudioReviewSchema(error)) log("[audio-review] 读取点评摘要失败，工作台降级为无点评", error);
    return { audioReviews: [], audioReviewAvailable: false };
  }
}

// ---------------------------------------------------------------------------
// 建任务
// ---------------------------------------------------------------------------

export type NormalizedCreateInput = {
  baseVersionId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export function normalizeCreateAudioReviewBody(body: unknown): NormalizedCreateInput {
  const input = (body && typeof body === "object" ? body : {}) as Partial<CreateAudioReviewRequestBody>;
  const fileName = typeof input.fileName === "string" ? input.fileName.trim().slice(0, 200) : "";
  if (!fileName) throw new AudioReviewError(400, "INVALID_AUDIO_FILE", "缺少录音文件名。");
  const contentType = audioReviewContentType(fileName, typeof input.contentType === "string" ? input.contentType : "");
  if (!contentType) {
    throw new AudioReviewError(400, "INVALID_AUDIO_FILE", "只能上传录音文件（m4a、mp3、wav、aac、flac、ogg、amr、wma、3gp、mp4 等）。");
  }
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new AudioReviewError(400, "INVALID_AUDIO_FILE", "录音文件大小无效。");
  }
  if (sizeBytes > AUDIO_REVIEW_MAX_BYTES) {
    throw new AudioReviewError(400, "INVALID_AUDIO_FILE", "录音文件不能超过 500MB。");
  }
  let baseVersionId: string | null = null;
  if (input.baseVersionId !== null && input.baseVersionId !== undefined) {
    if (typeof input.baseVersionId !== "string" || !input.baseVersionId.trim()) {
      throw new AudioReviewError(400, "INVALID_INPUT", "被点评版本无效。");
    }
    baseVersionId = input.baseVersionId.trim();
  }
  return { baseVersionId, fileName, contentType, sizeBytes };
}

async function assertVideoAvailable(db: DbClient, videoId: string) {
  const row = await db.prepare(
    `SELECT id, deleted_at, deletion_state FROM videos WHERE id = ?`,
  ).bind(videoId).first<{ id: string; deleted_at: unknown; deletion_state: string | null } & QueryResultRow>();
  if (!row) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
  if (row.deleted_at || row.deletion_state === "TRASHED" || row.deletion_state === "ASSET_PURGED") {
    throw new V04ServiceError("CASE_IN_TRASH", "案例已进入回收站。");
  }
}

async function resolveBaseVersion(
  db: DbClient,
  workspace: WorkspaceRow,
  baseVersionId: string | null,
  now: Date,
): Promise<AnalysisVersionRow | null> {
  if (baseVersionId) return findVersionById(db, baseVersionId);
  // null = 被点评的是还没落库的虚拟 v1：先在同一事务里物化（docs/25 4.2 第 1 条）。
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM analysis_versions WHERE workspace_id = ? AND version_kind = 'PERSONAL'`,
  ).bind(workspace.id).first<{ count: number | string } & QueryResultRow>();
  if (Number(count?.count ?? 0) === 0) await materializeV19FirstVersion(db, workspace, now);
  return db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM analysis_versions
    WHERE workspace_id = ? AND version_kind = 'PERSONAL' AND version_number = 1`,
  ).bind(workspace.id).first<AnalysisVersionRow>();
}

export async function createAudioReview(
  db: DbClient,
  actor: V04Actor,
  input: { videoId: string; body: unknown; now?: Date },
  deps: Pick<AudioReviewDeps, "bucket">,
): Promise<{ row: AudioReviewRow; uploadUrl: string }> {
  if (!isCaseReviewer(actor.displayName)) throw forbidden();
  const body = normalizeCreateAudioReviewBody(input.body);
  const now = input.now ?? new Date();
  const reviewId = newAudioReviewId();
  const objectKey = audioReviewObjectKey(reviewId);

  await db.withTransaction(async (tx) => {
    await assertVideoAvailable(tx, input.videoId);
    const workspace = await workspaceForVideo(tx, input.videoId, true);
    if (!workspace) {
      throw new AudioReviewError(409, "AUDIO_REVIEW_NOT_ALLOWED", "这份作业还没有任何内容，不能上传点评录音。");
    }
    const base = await resolveBaseVersion(tx, workspace, body.baseVersionId, now);
    if (!base || base.workspace_id !== workspace.id || base.video_id !== input.videoId) {
      throw new V04ServiceError("VERSION_NOT_FOUND", "被点评的版本不存在，请刷新页面后重试。");
    }
    if ((base.version_kind ?? "PERSONAL") !== "PERSONAL") {
      throw new AudioReviewError(409, "AUDIO_REVIEW_NOT_ALLOWED", "点评版不能再上传点评录音。");
    }
    if (base.owner_user_id === actor.userId) {
      throw new AudioReviewError(409, "AUDIO_REVIEW_NOT_ALLOWED", "不能给自己的版本上传点评录音。");
    }
    const live = await tx.prepare(
      `SELECT id FROM audio_reviews WHERE base_version_id = ? AND status <> 'ABANDONED' LIMIT 1`,
    ).bind(base.id).first<{ id: string } & QueryResultRow>();
    if (live) {
      throw new AudioReviewError(409, "AUDIO_REVIEW_EXISTS", "这一版已经有一份点评录音在处理或已生成点评版；要重传请先放弃当前这份。");
    }
    const basePayload = parseJsonPayload(base.payload_json);
    const inserted = await tx.prepare(
      `INSERT INTO audio_reviews (
        id, workspace_id, video_id, base_version_id, base_version_number, base_owner_name, base_payload_json,
        reviewer_user_id, reviewer_name, status, audio_object_key, audio_file_name, audio_content_type,
        audio_size_bytes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, 'UPLOADING', ?, ?, ?, ?, now(), now())
      ON CONFLICT DO NOTHING
      RETURNING id`,
    ).bind(
      reviewId, workspace.id, input.videoId, base.id, Number(base.version_number), base.owner_name_snapshot,
      JSON.stringify(basePayload), actor.userId, actor.displayName, objectKey, body.fileName, body.contentType,
      body.sizeBytes,
    ).first<{ id: string } & QueryResultRow>();
    if (!inserted) {
      throw new AudioReviewError(409, "AUDIO_REVIEW_EXISTS", "这一版已经有一份点评录音在处理或已生成点评版；要重传请先放弃当前这份。");
    }
    await insertAudit(tx, actor, "V19_AUDIO_REVIEW_CREATED", "AUDIO_REVIEW", reviewId, {
      workspaceId: workspace.id,
      baseVersionId: base.id,
      baseVersionNumber: Number(base.version_number),
      fileName: body.fileName,
      sizeBytes: body.sizeBytes,
      contentType: body.contentType,
    });
  });

  const uploadUrl = await deps.bucket.createPresignedPutUrl(objectKey, {
    contentType: body.contentType,
    expiresInSeconds: AUDIO_REVIEW_UPLOAD_URL_TTL_SECONDS,
  });
  const row = await loadAudioReview(db, input.videoId, reviewId);
  if (!row) throw notFound();
  return { row, uploadUrl };
}

// ---------------------------------------------------------------------------
// 动作：UPLOADED / RETRY / ABANDON / CONFIRM
// ---------------------------------------------------------------------------

export type AudioReviewActionResult = { row: AudioReviewRow; reviewVersionId?: string; advance: boolean };

type ExtraAssignments = { sql: string; values: Array<string | number | null> };

async function failStep(
  db: DbClient,
  reviewId: string,
  fromStatus: AudioReviewStatus,
  step: AudioReviewFailedStep,
  reason: string,
  extra: ExtraAssignments = { sql: "", values: [] },
) {
  return db.prepare(
    `UPDATE audio_reviews SET status = 'FAILED', failed_step = ?, fail_reason = ?, updated_at = now()${extra.sql}
    WHERE id = ? AND status = ?
    RETURNING id`,
  ).bind(step, reason, ...extra.values, reviewId, fromStatus).first<{ id: string } & QueryResultRow>();
}

/** HEAD 核对对象与大小，通过就进 TRANSCRIBING；对象不在或大小不符转 FAILED(UPLOAD)。 */
async function verifyUploadAndStart(
  db: DbClient,
  row: AudioReviewRow,
  deps: Pick<AudioReviewDeps, "bucket">,
): Promise<boolean> {
  let head: Awaited<ReturnType<AudioReviewDeps["bucket"]["head"]>>;
  try {
    head = await deps.bucket.head(row.audio_object_key);
  } catch {
    throw new AudioReviewError(503, "STORAGE_UNAVAILABLE", "暂时无法核对录音文件，请稍后重试。");
  }
  const fromFailed = row.status === "FAILED";
  const condition = fromFailed ? `status = 'FAILED' AND failed_step = 'UPLOAD'` : `status = 'UPLOADING'`;
  if (!head || Number(head.size) !== Number(row.audio_size_bytes)) {
    const reason = !head
      ? "没有找到上传的录音文件，请重新上传。"
      : "录音文件不完整（大小与上传前不符），请重新上传。";
    await db.prepare(
      `UPDATE audio_reviews SET status = 'FAILED', failed_step = 'UPLOAD', fail_reason = ?, updated_at = now()
      WHERE id = ? AND ${condition}`,
    ).bind(reason, row.id).run();
    return false;
  }
  const started = await db.prepare(
    `UPDATE audio_reviews SET status = 'TRANSCRIBING', failed_step = NULL, fail_reason = NULL,
      asr_task_id = NULL, asr_submitted_at = NULL, asr_checked_at = NULL,
      uploaded_at = COALESCE(uploaded_at, now()), lease_until = NULL, updated_at = now()
    WHERE id = ? AND ${condition}
    RETURNING id`,
  ).bind(row.id).first<{ id: string } & QueryResultRow>();
  return Boolean(started);
}

export function normalizeSelectedChangeIds(value: unknown, available: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    throw new AudioReviewError(400, "INVALID_SELECTION", "请至少勾选一处改动再生成点评版。");
  }
  const ids = [...new Set(value as string[])];
  const unknown = ids.filter((id) => !available.includes(id));
  if (unknown.length) {
    throw new AudioReviewError(400, "INVALID_SELECTION", "勾选的改动不在拟定改动里，请刷新后重试。");
  }
  return ids;
}

export async function runAudioReviewAction(
  db: DbClient,
  actor: V04Actor,
  input: { videoId: string; reviewId: string; body: unknown },
  deps: Pick<AudioReviewDeps, "bucket">,
): Promise<AudioReviewActionResult> {
  if (!isCaseReviewer(actor.displayName)) throw forbidden();
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Partial<AudioReviewActionRequestBody> & {
    selectedChangeIds?: unknown;
  };
  const action = body.action;
  if (action === "CONFIRM") {
    const confirmed = await confirmAudioReview(db, actor, {
      videoId: input.videoId,
      reviewId: input.reviewId,
      selectedChangeIds: body.selectedChangeIds,
    });
    return { ...confirmed, advance: false };
  }

  const row = await loadAudioReview(db, input.videoId, input.reviewId);
  if (!row) throw notFound();
  const reload = async () => (await loadAudioReview(db, input.videoId, input.reviewId))!;

  if (action === "UPLOADED") {
    if (row.status !== "UPLOADING") {
      // 重复上报（比如网络重试）：已经往下走了就原样返回。
      if (row.status === "FAILED" || row.status === "ABANDONED") {
        throw invalidState("这份点评录音已经失败或放弃，不能再标记为已上传。");
      }
      return { row, advance: ADVANCEABLE.includes(row.status) };
    }
    const started = await verifyUploadAndStart(db, row, deps);
    await insertAudit(db, actor, "V19_AUDIO_REVIEW_UPLOADED", "AUDIO_REVIEW", row.id, { verified: started });
    return { row: await reload(), advance: started };
  }

  if (action === "RETRY") {
    if (row.status !== "FAILED") throw invalidState("只有处理失败的点评录音可以重试。");
    let advance = false;
    if (row.failed_step === "UPLOAD") {
      advance = await verifyUploadAndStart(db, row, deps);
    } else if (row.failed_step === "TRANSCRIBE") {
      // 从转写重来：重新提交任务（上次的任务可能已经失败或过期）。
      const updated = await db.prepare(
        `UPDATE audio_reviews SET status = 'TRANSCRIBING', failed_step = NULL, fail_reason = NULL,
          asr_task_id = NULL, asr_submitted_at = NULL, asr_checked_at = NULL, lease_until = NULL, updated_at = now()
        WHERE id = ? AND status = 'FAILED' AND failed_step = 'TRANSCRIBE'
        RETURNING id`,
      ).bind(row.id).first<{ id: string } & QueryResultRow>();
      advance = Boolean(updated);
    } else {
      // 从理解重来：文字稿已经落库，只重新调模型，自动重试次数重新计。
      const updated = await db.prepare(
        `UPDATE audio_reviews SET status = 'UNDERSTANDING', failed_step = NULL, fail_reason = NULL,
          llm_attempts = 0, lease_until = NULL, updated_at = now()
        WHERE id = ? AND status = 'FAILED' AND failed_step = 'UNDERSTAND'
        RETURNING id`,
      ).bind(row.id).first<{ id: string } & QueryResultRow>();
      advance = Boolean(updated);
    }
    await insertAudit(db, actor, "V19_AUDIO_REVIEW_RETRIED", "AUDIO_REVIEW", row.id, { failedStep: row.failed_step });
    return { row: await reload(), advance };
  }

  if (action === "ABANDON") {
    if (row.status === "ABANDONED") return { row, advance: false };
    if (row.status === "GENERATED") throw invalidState("点评版已经生成，不能再放弃。");
    const updated = await db.prepare(
      `UPDATE audio_reviews SET status = 'ABANDONED', abandoned_at = now(), lease_until = NULL, updated_at = now()
      WHERE id = ? AND status NOT IN ('GENERATED', 'ABANDONED')
      RETURNING id`,
    ).bind(row.id).first<{ id: string } & QueryResultRow>();
    if (!updated) throw invalidState("点评录音的状态刚刚变了，请刷新后重试。");
    await insertAudit(db, actor, "V19_AUDIO_REVIEW_ABANDONED", "AUDIO_REVIEW", row.id, { fromStatus: row.status });
    return { row: await reload(), advance: false };
  }

  throw new AudioReviewError(400, "INVALID_INPUT", "不支持的操作。");
}

/**
 * 确认生成点评版（docs/25 4.9），一个事务：锁工作区、锁任务行 → 合并选中的改动套到上传那一刻的快照上 →
 * 插入 version_kind='AUDIO_REVIEW' 的版本行 → 每条变更一条 AI_ACCEPTANCE_RESERVED 修订事件 → 审计 →
 * 任务转 GENERATED。不汇入集成版。幂等：已经 GENERATED 的直接返回既有结果。
 */
export async function confirmAudioReview(
  db: DbClient,
  actor: V04Actor,
  input: { videoId: string; reviewId: string; selectedChangeIds: unknown },
): Promise<{ row: AudioReviewRow; reviewVersionId: string }> {
  if (!isCaseReviewer(actor.displayName)) throw forbidden();
  const reviewVersionId = await db.withTransaction(async (tx) => {
    await assertVideoAvailable(tx, input.videoId);
    const workspace = await workspaceForVideo(tx, input.videoId, true);
    if (!workspace) throw notFound();
    const row = await loadAudioReview(tx, input.videoId, input.reviewId, true);
    if (!row || row.workspace_id !== workspace.id) throw notFound();
    if (row.status === "GENERATED" && row.review_version_id) return row.review_version_id;
    if (row.status !== "PENDING_CONFIRM") throw invalidState("点评改动还没有拟定好，或者已经放弃。");

    const existing = await tx.prepare(
      `SELECT id FROM analysis_versions WHERE base_version_id = ? AND version_kind = 'AUDIO_REVIEW' LIMIT 1`,
    ).bind(row.base_version_id).first<{ id: string } & QueryResultRow>();
    if (existing) throw new AudioReviewError(409, "AUDIO_REVIEW_EXISTS", "这一版已经有点评版了。");

    const proposal = parseStoredProposal(row.proposal_json);
    if (!proposal) throw invalidState("拟定改动数据损坏，请重试处理。");
    const selectedIds = normalizeSelectedChangeIds(input.selectedChangeIds, proposal.changes.map((change) => change.id));
    const selected = proposal.changes.filter((change) => selectedIds.includes(change.id));
    const snapshot = parseJsonPayload(row.base_payload_json as V04DraftPayloadV1 | string);
    const { changes, payload } = buildAudioReviewChangeSet(
      snapshot,
      selected,
      (opinionIds) => audioReviewChangeReason(opinionIds, proposal.opinions),
    );
    try {
      assertV04PayloadContract(payload);
    } catch {
      const violations = listV04ContractViolations(payload);
      throw new AudioReviewError(
        422,
        "CHOICE_RULE_VIOLATION",
        violations.length
          ? `所选改动组合不符合选项规则：${violations.map((item) => `${item.targetLabel}（${item.message}）`).join("；")}。请把相关的几处一起勾选或一起取消。`
          : "所选改动组合不符合工作稿规则。",
      );
    }

    const versions = await listVersionRows(tx, workspace.id);
    const versionNumber = nextV19VersionNumber(versions.map((version) => Number(version.version_number)));
    const versionId = `analysis_version_${randomUUID()}`;
    const contentHash = hashV04Payload(payload);
    const inserted = await tx.prepare(
      `INSERT INTO analysis_versions (
        id, workspace_id, video_id, version_number, owner_user_id, owner_name_snapshot,
        base_version_id, base_version_number, base_payload_json, base_captured_at,
        payload_json, content_hash, revision, taxonomy_version, workflow_version,
        vocabulary_version, payload_schema_version, version_kind, audio_review_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::timestamptz, ?::jsonb, ?, 1, ?, ?, ?, ?, 'AUDIO_REVIEW', ?, now(), now())
      ON CONFLICT DO NOTHING
      RETURNING id`,
    ).bind(
      versionId, workspace.id, input.videoId, versionNumber, actor.userId, actor.displayName,
      row.base_version_id, Number(row.base_version_number), JSON.stringify(snapshot), isoOrNull(row.created_at),
      JSON.stringify(payload), contentHash,
      V04_TAXONOMY_VERSION, V04_WORKFLOW_VERSION, V04_VOCABULARY_VERSION, V04_PAYLOAD_SCHEMA_VERSION,
      row.id,
    ).first<{ id: string } & QueryResultRow>();
    if (!inserted) throw new AudioReviewError(409, "AUDIO_REVIEW_EXISTS", "生成点评版时版本冲突，请刷新后重试。");

    const changeSetId = `audio-review:${row.id}`;
    for (const change of changes) {
      await tx.prepare(
        `INSERT INTO collaboration_revision_events (
          id, workspace_id, round_id, annotation_id, change_set_id,
          base_revision, applied_revision, target_key, target_label_snapshot,
          value_type, before_value_json, after_value_json, source_kind,
          source_object_type, source_object_id, reason, actor_user_id, actor_name_snapshot, created_at, version_id
        ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?::jsonb, ?::jsonb, 'AI_ACCEPTANCE_RESERVED', 'AUDIO_REVIEW', ?, ?, ?, ?, now(), ?)`,
      ).bind(
        `revision_event_${randomUUID()}`, workspace.id, workspace.active_round_id, workspace.canonical_annotation_id,
        changeSetId, change.targetKey, change.targetLabel, change.valueType,
        JSON.stringify(change.beforeValue ?? null), JSON.stringify(change.afterValue ?? null),
        row.id, change.reason ?? "录音点评", actor.userId, actor.displayName, versionId,
      ).run();
    }

    await insertAudit(tx, actor, "V19_AUDIO_REVIEW_GENERATED", "V19_VERSION", versionId, {
      workspaceId: workspace.id,
      audioReviewId: row.id,
      baseVersionId: row.base_version_id,
      baseVersionNumber: Number(row.base_version_number),
      versionNumber,
      selectedChangeIds: selectedIds,
      targets: changes.map((change) => change.targetKey),
      contentHash,
    });

    const generated = await tx.prepare(
      `UPDATE audio_reviews SET status = 'GENERATED', review_version_id = ?, selected_change_ids = ?::jsonb,
        confirmed_at = now(), lease_until = NULL, updated_at = now()
      WHERE id = ? AND status = 'PENDING_CONFIRM'
      RETURNING id`,
    ).bind(versionId, JSON.stringify(selectedIds), row.id).first<{ id: string } & QueryResultRow>();
    if (!generated) throw invalidState("点评录音的状态刚刚变了，请刷新后重试。");
    return versionId;
  });
  const row = await loadAudioReview(db, input.videoId, input.reviewId);
  if (!row) throw notFound();
  return { row, reviewVersionId };
}

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------

/** GET 时要不要顺手推进一次：在途且租约空闲。 */
export function shouldAdvanceAudioReview(row: Pick<AudioReviewRow, "status" | "lease_until">, nowMs: number) {
  if (!ADVANCEABLE.includes(row.status)) return false;
  const lease = isoOrNull(row.lease_until);
  return !lease || Date.parse(lease) < nowMs;
}

export type AdvanceResult = { advanced: boolean; status: AudioReviewStatus | null };

export async function advanceAudioReview(
  db: DbClient,
  reviewId: string,
  options: { deadline: number; deps: AudioReviewDeps },
): Promise<AdvanceResult> {
  const { deps } = options;
  const log = deps.log ?? ((message: string, detail?: unknown) => console.error(message, detail));
  let leased: AudioReviewRow | null;
  try {
    // 毫秒精度的租约值同时当令牌用：退出时只清自己的租约（pg 把 timestamptz 读成 Date 会丢微秒）。
    leased = await db.prepare(
      `UPDATE audio_reviews
      SET lease_until = date_trunc('milliseconds', now() + interval '${AUDIO_REVIEW_LEASE_SECONDS} seconds')
      WHERE id = ? AND status IN ('TRANSCRIBING', 'UNDERSTANDING') AND (lease_until IS NULL OR lease_until < now())
      RETURNING ${AUDIO_REVIEW_COLUMNS}`,
    ).bind(reviewId).first<AudioReviewRow>();
  } catch (error) {
    log("[audio-review] 抢租约失败", error);
    return { advanced: false, status: null };
  }
  if (!leased) return { advanced: false, status: null };
  const leaseToken = isoOrNull(leased.lease_until);
  let current: AudioReviewRow | null = leased;
  let step: AudioReviewFailedStep = leased.status === "TRANSCRIBING" ? "TRANSCRIBE" : "UNDERSTAND";
  try {
    if (current.status === "TRANSCRIBING") {
      current = await runTranscription(db, current, options);
      step = "UNDERSTAND";
    }
    if (current?.status === "UNDERSTANDING") {
      current = await runUnderstanding(db, current, options);
    }
    return { advanced: true, status: current?.status ?? null };
  } catch (error) {
    // 代码或数据库层面的意外：记日志，把任务停在失败态，等老孙重试，不往外抛。
    log("[audio-review] 推进时出错", error);
    const status: AudioReviewStatus = step === "TRANSCRIBE" ? "TRANSCRIBING" : "UNDERSTANDING";
    await failStep(db, reviewId, status, step, "处理时出现内部错误，请重试。").catch((failure) => log("[audio-review] 写失败状态也失败了", failure));
    return { advanced: true, status: "FAILED" };
  } finally {
    await db.prepare(
      `UPDATE audio_reviews SET lease_until = NULL WHERE id = ? AND lease_until = ?::timestamptz`,
    ).bind(reviewId, leaseToken).run().catch((error) => log("[audio-review] 释放租约失败", error));
  }
}

function hasTime(options: { deadline: number; deps: AudioReviewDeps }, ms: number) {
  return options.deadline - options.deps.clock() > ms + POLL_MARGIN_MS;
}

async function runTranscription(
  db: DbClient,
  row: AudioReviewRow,
  options: { deadline: number; deps: AudioReviewDeps },
): Promise<AudioReviewRow | null> {
  const { deps } = options;
  const { asr } = deps.providers;
  let current = row;
  for (;;) {
    if (!current.asr_task_id) {
      const since = Date.parse(isoOrNull(current.uploaded_at) ?? isoOrNull(current.updated_at) ?? "");
      if (Number.isFinite(since) && deps.clock() - since > AUDIO_REVIEW_TRANSCRIBE_MAX_MS) {
        await failStep(db, current.id, "TRANSCRIBING", "TRANSCRIBE", "转写一直没能提交成功，请重试。");
        return null;
      }
      let audioUrl: string;
      try {
        audioUrl = await deps.bucket.createPresignedGetUrl(current.audio_object_key, {
          expiresInSeconds: AUDIO_REVIEW_AUDIO_URL_TTL_SECONDS,
        });
      } catch {
        await failStep(db, current.id, "TRANSCRIBING", "TRANSCRIBE", "生成录音下载链接失败，请检查存储配置后重试。");
        return null;
      }
      const hotwordList = formatHotwordList(buildAsrHotwords({
        reviewerName: current.reviewer_name,
        revieweeName: current.base_owner_name,
      }));
      const submitted = await asr.submit({ audioUrl, hotwordList });
      if (!submitted.ok) {
        if (submitted.transient) return null;
        await failStep(db, current.id, "TRANSCRIBING", "TRANSCRIBE", submitted.reason);
        return null;
      }
      const saved = await db.prepare(
        `UPDATE audio_reviews SET asr_task_id = ?, asr_engine = ?, asr_submitted_at = now(), updated_at = now()
        WHERE id = ? AND status = 'TRANSCRIBING' AND asr_task_id IS NULL
        RETURNING ${AUDIO_REVIEW_COLUMNS}`,
      // 写实际用上的引擎：大模型额度不足时 tencent-asr 会退到 16k_zh。
      ).bind(submitted.taskId, submitted.engine || asr.engine, current.id).first<AudioReviewRow>();
      if (!saved) return null;
      current = saved;
      if (!hasTime(options, asr.pollIntervalMs)) return null;
      await deps.sleep(asr.pollIntervalMs);
    }

    const outcome = await asr.describe(current.asr_task_id!);
    if (outcome.kind === "SUCCESS") {
      const transcript = { segments: outcome.segments, durationMs: outcome.durationMs, engine: current.asr_engine ?? asr.engine };
      // 腾讯云只保留 24 小时，拿到就落库。
      return db.prepare(
        `UPDATE audio_reviews SET status = 'UNDERSTANDING', transcript_json = ?::jsonb, audio_duration_ms = ?,
          asr_checked_at = now(), updated_at = now()
        WHERE id = ? AND status = 'TRANSCRIBING'
        RETURNING ${AUDIO_REVIEW_COLUMNS}`,
      ).bind(JSON.stringify(transcript), outcome.durationMs, current.id).first<AudioReviewRow>();
    }
    if (outcome.kind === "FAILED" || (outcome.kind === "ERROR" && !outcome.transient)) {
      await failStep(db, current.id, "TRANSCRIBING", "TRANSCRIBE", outcome.reason, { sql: ", asr_checked_at = now()", values: [] });
      return null;
    }
    const checked = await db.prepare(
      `UPDATE audio_reviews SET asr_checked_at = now(), updated_at = now()
      WHERE id = ? AND status = 'TRANSCRIBING'
      RETURNING ${AUDIO_REVIEW_COLUMNS}`,
    ).bind(current.id).first<AudioReviewRow>();
    if (!checked) return null;
    current = checked;
    if (outcome.kind === "ERROR") return null; // 临时错误：留给下一次推进。
    const submittedAt = Date.parse(isoOrNull(current.asr_submitted_at) ?? "");
    if (Number.isFinite(submittedAt) && deps.clock() - submittedAt > AUDIO_REVIEW_TRANSCRIBE_MAX_MS) {
      await failStep(db, current.id, "TRANSCRIBING", "TRANSCRIBE", "转写超过 2 小时仍未完成，请重试。");
      return null;
    }
    if (!hasTime(options, asr.pollIntervalMs)) return null;
    await deps.sleep(asr.pollIntervalMs);
  }
}

type LlmCallRecord = {
  attempt: number;
  ok: boolean;
  at: string;
  durationMs: number;
  finishReason: string | null;
  usage: unknown;
  reason?: string;
};

function usageCalls(value: unknown): LlmCallRecord[] {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  const calls = raw && typeof raw === "object" ? (raw as { calls?: unknown }).calls : null;
  return Array.isArray(calls) ? calls as LlmCallRecord[] : [];
}

async function caseTitle(db: DbClient, videoId: string) {
  const row = await db.prepare(`SELECT title FROM videos WHERE id = ?`)
    .bind(videoId).first<{ title: string | null } & QueryResultRow>();
  return row?.title ?? null;
}

async function runUnderstanding(
  db: DbClient,
  row: AudioReviewRow,
  options: { deadline: number; deps: AudioReviewDeps },
): Promise<AudioReviewRow | null> {
  const { deps } = options;
  const { llm } = deps.providers;
  let current = row;
  let title: string | null | undefined;
  for (;;) {
    // 留够一次完整的模型调用（240 秒）才开始，否则留给下一次 GET。
    if (options.deadline - deps.clock() < AUDIO_REVIEW_MIN_LLM_WINDOW_MS) return null;
    const previousCalls = usageCalls(current.llm_usage_json);
    if (Number(current.llm_attempts) >= AUDIO_REVIEW_MAX_LLM_ATTEMPTS) {
      // 两次都开始了却没有收尾（例如函数被中途回收）：不再自动重试。
      const last = previousCalls[previousCalls.length - 1];
      await failStep(db, current.id, "UNDERSTANDING", "UNDERSTAND", last?.reason ?? "模型连续两次没有返回可用结果，请重试。");
      return null;
    }
    const transcript = parseStoredTranscript(current.transcript_json);
    if (!transcript || transcript.segments.length === 0) {
      await failStep(db, current.id, "UNDERSTANDING", "UNDERSTAND", "文字稿为空，无法理解点评。请重试转写或重新上传。");
      return null;
    }
    const snapshot = parseJsonPayload(current.base_payload_json as V04DraftPayloadV1 | string);
    if (title === undefined) title = await caseTitle(db, current.video_id);
    const context: AudioReviewPromptContext = {
      snapshot,
      segments: transcript.segments,
      reviewerName: current.reviewer_name,
      revieweeName: current.base_owner_name,
      baseVersionNumber: Number(current.base_version_number),
      caseTitle: title,
    };
    const messages = buildAudioReviewMessages(context);
    const attempt = Number(current.llm_attempts) + 1;
    const started = await db.prepare(
      `UPDATE audio_reviews SET llm_attempts = ?, llm_started_at = now(), llm_finished_at = NULL,
        llm_model = ?, prompt_version = ?, input_content_hash = ?, updated_at = now()
      WHERE id = ? AND status = 'UNDERSTANDING'
      RETURNING id`,
    ).bind(
      attempt, llm.model, AUDIO_REVIEW_PROMPT_VERSION, hashAudioReviewInput(llm.model, messages), current.id,
    ).first<{ id: string } & QueryResultRow>();
    if (!started) return null;

    const outcome = await llm.complete(messages, context, { timeoutMs: AUDIO_REVIEW_LLM_TIMEOUT_MS });
    let failure: { reason: string; retryable: boolean } | null = null;
    let proposalJson: string | null = null;
    if (!outcome.ok) {
      failure = { reason: outcome.reason, retryable: outcome.retryable };
    } else {
      const parsed = parseModelJsonContent(outcome.content, outcome.finishReason);
      if (!parsed.ok) {
        failure = { reason: parsed.reason, retryable: true };
      } else {
        const proposal = normalizeAudioReviewProposal(parsed.value, {
          snapshot,
          segments: transcript.segments,
          reviewerName: current.reviewer_name,
        });
        if (proposal.changes.length === 0) {
          failure = { reason: "模型没有给出任何可用的改动。", retryable: true };
        } else {
          proposalJson = JSON.stringify(proposal);
        }
      }
    }
    const call: LlmCallRecord = {
      attempt,
      ok: !failure,
      at: new Date(deps.clock()).toISOString(),
      durationMs: outcome.durationMs,
      finishReason: outcome.ok ? outcome.finishReason : null,
      usage: outcome.usage ?? null,
      ...(failure ? { reason: failure.reason } : {}),
    };
    const usageJson = JSON.stringify({ calls: [...previousCalls, call] });

    if (proposalJson) {
      return db.prepare(
        `UPDATE audio_reviews SET status = 'PENDING_CONFIRM', proposal_json = ?::jsonb, proposed_at = now(),
          llm_finished_at = now(), llm_usage_json = ?::jsonb, updated_at = now()
        WHERE id = ? AND status = 'UNDERSTANDING'
        RETURNING ${AUDIO_REVIEW_COLUMNS}`,
      ).bind(proposalJson, usageJson, current.id).first<AudioReviewRow>();
    }
    if (!failure!.retryable || attempt >= AUDIO_REVIEW_MAX_LLM_ATTEMPTS) {
      await failStep(
        db, current.id, "UNDERSTANDING", "UNDERSTAND", failure!.reason,
        { sql: ", llm_finished_at = now(), llm_usage_json = ?::jsonb", values: [usageJson] },
      );
      return null;
    }
    const retried = await db.prepare(
      `UPDATE audio_reviews SET llm_finished_at = now(), llm_usage_json = ?::jsonb, updated_at = now()
      WHERE id = ? AND status = 'UNDERSTANDING'
      RETURNING ${AUDIO_REVIEW_COLUMNS}`,
    ).bind(usageJson, current.id).first<AudioReviewRow>();
    if (!retried) return null;
    current = retried;
  }
}
