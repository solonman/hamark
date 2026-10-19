// 月度整理的服务层（docs/26 六）：发起任务（GENERATE / REVISE_PUBLISHED）、RETRY / ABANDON / PUBLISH、
// 草稿修改、后台推进 advanceRetroMonthJob。
//
// 推进模型（6.3）：没有常驻进程。发起、重试、月份页 GET、内部接力请求都在响应发出后用 after() 调一次
// advanceRetroMonthJob，deadline = 请求开始 + 280 秒。进门先抢租约（290 秒），抢不到说明另一次推进正在
// 跑，直接返回；抢到后**最多做一次模型调用**，做完（或剩余时间不足 245 秒、或第一次失败要换低思考强度
// 再试）就退出，告诉调用方要不要接力。每一步的写入都带「状态仍是我以为的那个」条件，所以中途被放弃
// （ABANDON）不会被后台写回来。外部错误一律翻成中文 fail_reason，绝不向外抛。

import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { parseModelJsonContent } from "@/lib/audio-review/deepseek";
import { isCaseReviewer } from "@/lib/case-review";
import {
  isRetroJobLive,
  type RetroJobFailedStep,
  type RetroJobStatus,
  type RetroMethods,
  type RetroMinutes,
  type RetroStoredPublicationCases,
  type RetroStoredQuotes,
  type RetroSource,
} from "@/lib/retro-model";
import { normalizeRetroExtraction, type RetroExtractionOutput, type RetroSpeakers } from "./extraction";
import { applyRetroDraftPatch, collectRetroDraftSources, normalizeDraftPatchRequest, type RetroDraft } from "./month-draft";
import { RetroError, retroConflict, retroForbidden, retroInvalid, retroNotFound } from "./errors";
import { buildRetroGenerateSnapshot, computeRetroPreconditions, loadRetroMonthFacts } from "./month-input";
import type { RetroLlmProvider } from "./month-providers";
import {
  analyzedCases,
  buildRetroQuotes,
  hashRetroCaseInput,
  hashRetroSnapshot,
  parseJsonColumn,
  parseRetroSnapshot,
  snapshotRecordingRefs,
  type RetroGenerateSnapshot,
  type RetroMonthSnapshot,
  type RetroQuoteResolver,
  type RetroRevisionSnapshot,
} from "./month-snapshot";
import {
  buildRetroExtractMessages,
  buildRetroMethodsMessages,
  buildRetroMinutesMessages,
  hashRetroMessages,
  RETRO_EXTRACT_PROMPT_VERSION,
  RETRO_METHODS_PROMPT_VERSION,
  RETRO_MINUTES_PROMPT_VERSION,
  RETRO_PROMPT_VERSIONS,
  type RetroLlmMessages,
} from "./prompt";
import {
  assembleRetroMinutes,
  normalizeRetroDistill,
  normalizeRetroSummary,
  type RetroSynthesisContext,
} from "./synthesis";

export const RETRO_REVIEWER_ONLY = "只有老孙可以生成、审阅和发布本月纪要。";
export const RETRO_MONTH_DEADLINE_MS = 280_000;
export const RETRO_MONTH_LEASE_SECONDS = 290;
export const RETRO_MONTH_MIN_LLM_WINDOW_MS = 245_000;
export const RETRO_MONTH_LLM_TIMEOUT_MS = 240_000;
export const RETRO_MONTH_MAX_LLM_ATTEMPTS = 2;

/** 与 V04Actor 兼容（路由外壳 retroRoute 给的就是它）。 */
export type RetroMonthActor = { userId: string; displayName: string; identityKey: string };

export type RetroMonthDeps = {
  llm: RetroLlmProvider;
  clock: () => number;
  log?: (message: string, detail?: unknown) => void;
};

export const newRetroJobId = () => `rtj_${randomUUID()}`;
export const newRetroPublicationId = () => `rtp_${randomUUID()}`;
export const newRetroCandidateId = () => `rmc_${randomUUID()}`;

// ---------------------------------------------------------------------------
// 行与 JSON 列
// ---------------------------------------------------------------------------

export const RETRO_JOB_COLUMNS = `id, month_key, status, progress_index, failed_step, fail_reason, based_on_publication_id,
  input_snapshot_json, input_content_hash, extractions_json, minutes_json, methods_json, draft_revision, llm_model,
  prompt_versions_json, llm_attempts, llm_usage_json, relay_seq, requested_by_user_id, lease_until, created_at,
  updated_at, finished_at, abandoned_at`;

export type RetroJobRow = QueryResultRow & {
  id: string;
  month_key: string;
  status: RetroJobStatus;
  progress_index: number;
  failed_step: RetroJobFailedStep | null;
  fail_reason: string | null;
  based_on_publication_id: string | null;
  input_snapshot_json: unknown;
  input_content_hash: string | null;
  extractions_json: unknown;
  minutes_json: unknown;
  methods_json: unknown;
  draft_revision: number;
  llm_model: string | null;
  prompt_versions_json: unknown;
  llm_attempts: number;
  llm_usage_json: unknown;
  relay_seq: number;
  requested_by_user_id: string;
  lease_until: unknown;
  created_at: unknown;
  updated_at: unknown;
  finished_at: unknown;
  abandoned_at: unknown;
};

export type RetroExtractionCacheEntry = {
  inputHash: string;
  output: RetroExtractionOutput;
  dropped: string[];
  model: string;
  promptVersion: string;
  usage: unknown;
  at: string;
  /** 全部被校验丢光（或模型什么都没给）：这种结果不复用，下次重新生成时重算（审查意见 2）。 */
  empty?: boolean;
};

/** 缓存条目能不能复用：输入哈希一致，且不是空结果。 */
export function isReusableExtraction(entry: RetroExtractionCacheEntry | undefined, inputHash: string): boolean {
  return Boolean(entry) && entry!.inputHash === inputHash && !(entry!.empty ?? entry!.output?.empty ?? false);
}

/** retro_month_jobs.extractions_json：逐案结果按输入哈希缓存，另存②③的说话人认定与丢弃原因。 */
export type RetroExtractionsStore = {
  cases: Record<string, RetroExtractionCacheEntry>;
  summary?: { speakers: RetroSpeakers; dropped: string[] };
  distill?: { dropped: string[] };
};

type LlmCallRecord = {
  step: RetroJobFailedStep;
  caseId?: string;
  attempt: number;
  ok: boolean;
  at: string;
  durationMs: number;
  finishReason: string | null;
  usage: unknown;
  inputHash: string;
  reason?: string;
};

export function parseExtractionsStore(value: unknown): RetroExtractionsStore {
  const raw = parseJsonColumn<RetroExtractionsStore>(value);
  return raw && typeof raw === "object" && raw.cases && typeof raw.cases === "object" ? raw : { cases: {} };
}

function usageCalls(value: unknown): LlmCallRecord[] {
  const raw = parseJsonColumn<{ calls?: unknown }>(value);
  return raw && Array.isArray(raw.calls) ? (raw.calls as LlmCallRecord[]) : [];
}

export function parseDraft(row: Pick<RetroJobRow, "minutes_json" | "methods_json">): RetroDraft | null {
  const minutes = parseJsonColumn<RetroMinutes>(row.minutes_json);
  const methods = parseJsonColumn<RetroMethods>(row.methods_json);
  if (!minutes || !methods) return null;
  return { minutes, methods };
}

export async function loadRetroJob(db: DbClient, jobId: string, lock = false): Promise<RetroJobRow | null> {
  return db.prepare(`SELECT ${RETRO_JOB_COLUMNS} FROM retro_month_jobs WHERE id = ?${lock ? " FOR UPDATE" : ""}`).bind(jobId).first<RetroJobRow>();
}

export async function loadLiveRetroJob(db: DbClient, monthKey: string): Promise<RetroJobRow | null> {
  return db.prepare(
    `SELECT ${RETRO_JOB_COLUMNS} FROM retro_month_jobs
    WHERE month_key = ? AND status NOT IN ('PUBLISHED', 'ABANDONED')
    ORDER BY created_at DESC LIMIT 1`,
  ).bind(monthKey).first<RetroJobRow>();
}

async function insertRetroAudit(db: DbClient, actor: RetroMonthActor, action: string, objectType: string, objectId: string, detail: Record<string, unknown>) {
  await db.prepare(
    `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(`audit_${randomUUID()}`, actor.identityKey, action, objectType, objectId,
    JSON.stringify({ ...detail, actorUserId: actor.userId, actorName: actor.displayName })).run();
}

// ---------------------------------------------------------------------------
// 引文：草稿读取时现取（GENERATE 从快照取，REVISION 从来源版本的引文快照取）
// ---------------------------------------------------------------------------

export function generateQuoteResolver(snapshot: RetroGenerateSnapshot, store: RetroExtractionsStore): RetroQuoteResolver {
  const recordings = new Map<string, { segments: RetroGenerateSnapshot["cases"][number]["recordings"][number]["segments"]; labels: Record<string, string> | null }>();
  for (const item of snapshot.cases) {
    const speakers = store.cases[item.caseId]?.output.speakers;
    for (const recording of item.recordings) recordings.set(recording.recordingId, { segments: recording.segments, labels: speakers?.[recording.recordingId]?.labels ?? null });
  }
  for (const recording of snapshot.summaryRecordings) {
    recordings.set(recording.recordingId, { segments: recording.segments, labels: store.summary?.speakers[recording.recordingId]?.labels ?? null });
  }
  const client = new Map<string, { segments: RetroGenerateSnapshot["cases"][number]["clientAudio"][number]["segments"] }>();
  for (const item of snapshot.cases) for (const audio of item.clientAudio) client.set(audio.assetId, { segments: audio.segments });
  return { recording: (id) => recordings.get(id) ?? null, clientAudio: (id) => client.get(id) ?? null };
}

/** 修订：从来源版本的引文快照里挑出仍被引用的片段。 */
export function filterStoredQuotes(stored: RetroStoredQuotes, sources: readonly RetroSource[]): Record<string, RetroStoredQuotes["segments"][string]> {
  const wanted = new Map<string, Set<number>>();
  for (const source of sources) {
    const key = source.kind === "REVIEW" ? `R:${source.recordingId}` : `C:${source.assetId}`;
    const ids = wanted.get(key) ?? new Set<number>();
    for (const id of source.segmentIds) ids.add(id);
    wanted.set(key, ids);
  }
  const result: Record<string, RetroStoredQuotes["segments"][string]> = {};
  for (const [key, ids] of wanted) {
    const quotes = (stored.segments[key] ?? []).filter((quote) => ids.has(quote.segmentId));
    if (quotes.length) result[key] = quotes;
  }
  return result;
}

export function quotesForDraft(snapshot: RetroMonthSnapshot | null, store: RetroExtractionsStore, draft: RetroDraft): RetroStoredQuotes {
  const sources = collectRetroDraftSources(draft);
  if (!snapshot) return { segments: {}, recordingRefs: {} };
  if (snapshot.kind === "REVISION") return { segments: filterStoredQuotes(snapshot.quotes, sources), recordingRefs: snapshot.quotes.recordingRefs };
  return { segments: buildRetroQuotes(sources, generateQuoteResolver(snapshot, store)), recordingRefs: snapshotRecordingRefs(snapshot) };
}

// ---------------------------------------------------------------------------
// 发起任务
// ---------------------------------------------------------------------------

export type StartJobResult = { jobId: string; advance: boolean };

export async function startRetroMonthJob(
  db: DbClient,
  actor: RetroMonthActor,
  input: { monthKey: string; body: unknown; llmModel: string; now?: Date },
): Promise<StartJobResult> {
  if (!isCaseReviewer(actor.displayName)) throw retroForbidden(RETRO_REVIEWER_ONLY);
  const mode = (input.body && typeof input.body === "object" ? (input.body as { mode?: unknown }).mode : undefined);
  if (mode === "REVISE_PUBLISHED") return startRevision(db, actor, input.monthKey);
  if (mode !== "GENERATE") throw retroInvalid("mode 只能是 GENERATE 或 REVISE_PUBLISHED。");

  const now = input.now ?? new Date();
  const jobId = newRetroJobId();
  const rawReplace = (input.body as { replaceJobId?: unknown }).replaceJobId;
  const replaceJobId = typeof rawReplace === "string" && rawReplace.trim() ? rawReplace.trim() : null;
  if (rawReplace != null && !replaceJobId) throw retroInvalid("replaceJobId 格式不对。");
  // 一个事务：锁旧任务 → 校验 → 排除它重算前提 → 置 ABANDONED → 冻结快照 → 插入新任务。
  // 任何一步失败整体回滚，旧草稿原样保留（审查意见 1）。
  await db.withTransaction(async (tx) => {
    let replaced: RetroJobRow | null = null;
    if (replaceJobId) {
      replaced = await loadRetroJob(tx, replaceJobId, true);
      if (!replaced || replaced.month_key !== input.monthKey) throw retroNotFound("要替换的整理任务不存在。");
      if (replaced.status !== "PENDING_REVIEW" && replaced.status !== "FAILED") {
        throw retroConflict("INVALID_STATE", "只有待审阅或失败的任务可以重新生成；整理还在进行时请等它完成或先放弃。");
      }
    }
    const live = await loadLiveRetroJob(tx, input.monthKey);
    const otherLive = live && live.id !== replaced?.id ? live : null;
    if (otherLive) throw retroConflict("JOB_EXISTS", "本月已有一个整理任务，先完成或放弃它。");
    const facts = await loadRetroMonthFacts(tx, input.monthKey);
    const preconditions = computeRetroPreconditions(facts, null);
    if (!preconditions.canGenerate) throw retroConflict("NOT_READY", preconditions.blockedReason ?? "现在还不能生成。");
    if (replaced) {
      const abandoned = await tx.prepare(
        `UPDATE retro_month_jobs SET status = 'ABANDONED', abandoned_at = now(), lease_until = NULL, updated_at = now()
        WHERE id = ? AND status IN ('PENDING_REVIEW', 'FAILED')
        RETURNING id`,
      ).bind(replaced.id).first<QueryResultRow & { id: string }>();
      if (!abandoned) throw retroConflict("INVALID_STATE", "任务的状态刚刚变了，请刷新后重试。");
      await insertRetroAudit(tx, actor, "RETRO_MONTH_JOB_ABANDONED", "RETRO_MONTH_JOB", replaced.id, {
        monthKey: input.monthKey, fromStatus: replaced.status, replacedByJobId: jobId,
      });
    }
    const snapshot = await buildRetroGenerateSnapshot(tx, input.monthKey, now);
    if (!analyzedCases(snapshot).length) throw retroConflict("NOT_READY", "点评录音的文字稿都是空的，没有可以提炼的内容。");

    // 逐案缓存：之前任务里输入没变的案例直接复用，不再调模型（规格 6.3）。
    const cache: RetroExtractionsStore = { cases: {} };
    const previous = (await tx.prepare(
      `SELECT extractions_json FROM retro_month_jobs WHERE month_key = ? AND extractions_json IS NOT NULL
      ORDER BY created_at DESC LIMIT 6`,
    ).bind(input.monthKey).all<QueryResultRow & { extractions_json: unknown }>()).results.map((row) => parseExtractionsStore(row.extractions_json));
    for (const item of analyzedCases(snapshot)) {
      const hash = hashRetroCaseInput(item, { model: input.llmModel, promptVersion: RETRO_EXTRACT_PROMPT_VERSION });
      const hit = previous.map((store) => store.cases[item.caseId]).find((entry) => isReusableExtraction(entry, hash));
      if (hit) cache.cases[item.caseId] = hit;
    }

    const inserted = await tx.prepare(
      `INSERT INTO retro_month_jobs (
        id, month_key, status, progress_index, input_snapshot_json, input_content_hash, extractions_json,
        llm_model, prompt_versions_json, requested_by_user_id, created_at, updated_at
      ) VALUES (?, ?, 'QUEUED', 0, ?::jsonb, ?, ?::jsonb, ?, ?::jsonb, ?, now(), now())
      ON CONFLICT DO NOTHING
      RETURNING id`,
    ).bind(
      jobId, input.monthKey, JSON.stringify(snapshot),
      hashRetroSnapshot(snapshot, { model: input.llmModel, prompts: RETRO_PROMPT_VERSIONS }),
      JSON.stringify(cache), input.llmModel, JSON.stringify(RETRO_PROMPT_VERSIONS), actor.userId,
    ).first<QueryResultRow & { id: string }>();
    if (!inserted) throw retroConflict("JOB_EXISTS", "本月已有一个整理任务，先完成或放弃它。");
    await insertRetroAudit(tx, actor, "RETRO_MONTH_JOB_STARTED", "RETRO_MONTH_JOB", jobId, {
      monthKey: input.monthKey,
      mode: "GENERATE",
      caseCount: snapshot.cases.length,
      analyzedCaseCount: analyzedCases(snapshot).length,
      cachedCaseIds: Object.keys(cache.cases),
      ...(replaced ? { replacedJobId: replaced.id } : {}),
    });
  });
  return { jobId, advance: true };
}

async function startRevision(db: DbClient, actor: RetroMonthActor, monthKey: string): Promise<StartJobResult> {
  const jobId = newRetroJobId();
  await db.withTransaction(async (tx) => {
    const live = await loadLiveRetroJob(tx, monthKey);
    if (live) throw retroConflict("JOB_EXISTS", "本月已有一个整理任务，先完成或放弃它。");
    const publication = await tx.prepare(
      `SELECT id, version_number, case_ids_json, minutes_json, methods_json, quoted_segments_json
      FROM retro_month_publications WHERE month_key = ? ORDER BY version_number DESC LIMIT 1`,
    ).bind(monthKey).first<QueryResultRow & { id: string; version_number: number; case_ids_json: unknown; minutes_json: unknown; methods_json: unknown; quoted_segments_json: unknown }>();
    if (!publication) throw retroConflict("NOT_PUBLISHED", "本月还没有发布过，不能修订。");
    const snapshot: RetroRevisionSnapshot = {
      kind: "REVISION",
      monthKey,
      publicationId: publication.id,
      versionNumber: Number(publication.version_number),
      cases: parseJsonColumn<RetroStoredPublicationCases>(publication.case_ids_json) ?? [],
      quotes: parseJsonColumn<RetroStoredQuotes>(publication.quoted_segments_json) ?? { segments: {}, recordingRefs: {} },
    };
    // 不调模型：基于当前发布版复制出新草稿（规格 6.6「修订已发布内容」）。
    const inserted = await tx.prepare(
      `INSERT INTO retro_month_jobs (
        id, month_key, status, progress_index, based_on_publication_id, input_snapshot_json, input_content_hash,
        minutes_json, methods_json, draft_revision, requested_by_user_id, created_at, updated_at
      ) VALUES (?, ?, 'PENDING_REVIEW', 0, ?, ?::jsonb, ?, ?::jsonb, ?::jsonb, 1, ?, now(), now())
      ON CONFLICT DO NOTHING
      RETURNING id`,
    ).bind(
      jobId, monthKey, publication.id, JSON.stringify(snapshot), hashRetroSnapshot(snapshot),
      JSON.stringify(parseJsonColumn(publication.minutes_json)), JSON.stringify(parseJsonColumn(publication.methods_json)), actor.userId,
    ).first<QueryResultRow & { id: string }>();
    if (!inserted) throw retroConflict("JOB_EXISTS", "本月已有一个整理任务，先完成或放弃它。");
    await insertRetroAudit(tx, actor, "RETRO_MONTH_REVISION_STARTED", "RETRO_MONTH_JOB", jobId, {
      monthKey,
      basedOnPublicationId: publication.id,
      basedOnVersion: Number(publication.version_number),
    });
  });
  return { jobId, advance: false };
}

// ---------------------------------------------------------------------------
// 动作：RETRY / ABANDON / PUBLISH
// ---------------------------------------------------------------------------

export type JobActionResult = { jobId: string; advance: boolean; publicationVersion?: number };

const RETRY_STATUS: Record<RetroJobFailedStep, RetroJobStatus> = { EXTRACT: "EXTRACTING", SUMMARIZE: "SUMMARIZING", DISTILL: "DISTILLING" };

export async function runRetroMonthJobAction(
  db: DbClient,
  actor: RetroMonthActor,
  input: { monthKey: string; jobId: string; body: unknown },
): Promise<JobActionResult> {
  if (!isCaseReviewer(actor.displayName)) throw retroForbidden(RETRO_REVIEWER_ONLY);
  const action = input.body && typeof input.body === "object" ? (input.body as { action?: unknown }).action : undefined;
  if (action === "PUBLISH") return publishRetroMonthJob(db, actor, input);
  const row = await loadRetroJob(db, input.jobId);
  if (!row || row.month_key !== input.monthKey) throw retroNotFound("整理任务不存在。");

  if (action === "RETRY") {
    if (row.status !== "FAILED" || !row.failed_step) throw retroConflict("INVALID_STATE", "只有失败的任务可以重试。");
    const updated = await db.prepare(
      `UPDATE retro_month_jobs SET status = ?, failed_step = NULL, fail_reason = NULL, llm_attempts = 0,
        lease_until = NULL, updated_at = now()
      WHERE id = ? AND status = 'FAILED'
      RETURNING id`,
    ).bind(RETRY_STATUS[row.failed_step], row.id).first<QueryResultRow & { id: string }>();
    if (!updated) throw retroConflict("INVALID_STATE", "任务的状态刚刚变了，请刷新后重试。");
    await insertRetroAudit(db, actor, "RETRO_MONTH_JOB_RETRIED", "RETRO_MONTH_JOB", row.id, {
      monthKey: row.month_key, failedStep: row.failed_step, progressIndex: Number(row.progress_index),
    });
    return { jobId: row.id, advance: true };
  }

  if (action === "ABANDON") {
    if (row.status === "ABANDONED") return { jobId: row.id, advance: false };
    if (row.status === "PUBLISHED") throw retroConflict("INVALID_STATE", "已经发布的任务不能放弃。");
    const updated = await db.prepare(
      `UPDATE retro_month_jobs SET status = 'ABANDONED', abandoned_at = now(), lease_until = NULL, updated_at = now()
      WHERE id = ? AND status NOT IN ('PUBLISHED', 'ABANDONED')
      RETURNING id`,
    ).bind(row.id).first<QueryResultRow & { id: string }>();
    if (!updated) throw retroConflict("INVALID_STATE", "任务的状态刚刚变了，请刷新后重试。");
    await insertRetroAudit(db, actor, "RETRO_MONTH_JOB_ABANDONED", "RETRO_MONTH_JOB", row.id, { monthKey: row.month_key, fromStatus: row.status });
    return { jobId: row.id, advance: false };
  }

  throw retroInvalid("action 只能是 RETRY、ABANDON 或 PUBLISH。");
}

/**
 * 发布（规格 6.6），一个事务：锁任务行 → 写 retro_month_publications（版本号递增、案例清单与冻结序号、
 * 两份成果、引文快照）→ 逐条写 retro_method_candidates → 把 AI 认定的说话人称呼写进各录音 →
 * 任务转 PUBLISHED → 审计 RETRO_MONTH_PUBLISHED。已发布行只增不改。幂等：已经发布的返回既有版本号。
 */
export async function publishRetroMonthJob(
  db: DbClient,
  actor: RetroMonthActor,
  input: { monthKey: string; jobId: string },
): Promise<JobActionResult> {
  if (!isCaseReviewer(actor.displayName)) throw retroForbidden(RETRO_REVIEWER_ONLY);
  const version = await db.withTransaction(async (tx) => {
    const row = await loadRetroJob(tx, input.jobId, true);
    if (!row || row.month_key !== input.monthKey) throw retroNotFound("整理任务不存在。");
    if (row.status === "PUBLISHED") {
      const existing = await tx.prepare(`SELECT version_number FROM retro_month_publications WHERE job_id = ? LIMIT 1`)
        .bind(row.id).first<QueryResultRow & { version_number: number }>();
      if (existing) return Number(existing.version_number);
    }
    if (row.status !== "PENDING_REVIEW") throw retroConflict("INVALID_STATE", "草稿还没有生成好，或者已经放弃，不能发布。");
    const draft = parseDraft(row);
    const snapshot = parseRetroSnapshot(row.input_snapshot_json);
    if (!draft || !snapshot) throw retroConflict("INVALID_STATE", "草稿数据损坏，请重新生成。");
    const store = parseExtractionsStore(row.extractions_json);

    const caseIds: RetroStoredPublicationCases = snapshot.kind === "REVISION"
      ? snapshot.cases
      : [...snapshot.cases].sort((a, b) => a.number - b.number).map((item) => ({ caseId: item.caseId, number: item.number }));
    const quotes = quotesForDraft(snapshot, store, draft);
    const latest = await tx.prepare(`SELECT COALESCE(MAX(version_number), 0) AS max FROM retro_month_publications WHERE month_key = ?`)
      .bind(row.month_key).first<QueryResultRow & { max: number | string }>();
    const versionNumber = Number(latest?.max ?? 0) + 1;
    const publicationId = newRetroPublicationId();
    await tx.prepare(
      `INSERT INTO retro_month_publications (
        id, month_key, version_number, job_id, case_ids_json, minutes_json, methods_json, quoted_segments_json,
        published_by_user_id, published_at
      ) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, now())`,
    ).bind(
      publicationId, row.month_key, versionNumber, row.id, JSON.stringify(caseIds), JSON.stringify(draft.minutes),
      JSON.stringify(draft.methods), JSON.stringify(quotes), actor.userId,
    ).run();
    for (const candidate of draft.methods.candidates) {
      await tx.prepare(
        `INSERT INTO retro_method_candidates (
          id, publication_id, month_key, number, dimension, kind, title, description, situation, transfer,
          transfer_note, sources_json, origin, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, now())`,
      ).bind(
        newRetroCandidateId(), publicationId, row.month_key, candidate.number, candidate.dimension, candidate.kind,
        candidate.title, candidate.description, candidate.situation, candidate.transfer, candidate.transferNote,
        JSON.stringify(candidate.sources), candidate.origin,
      ).run();
    }
    let labeledRecordings = 0;
    if (snapshot.kind === "GENERATE") {
      // AI 认出的称呼（老孙／汇报人／其他同事）写进参与提炼的各段录音（规格 5.2、6.4）。
      const labelUpdates: Array<[string, Record<string, string>]> = [];
      for (const item of snapshot.cases) {
        // 每段录音用它自己的认定（标签只在一段录音里有意义）。
        const speakers = store.cases[item.caseId]?.output.speakers;
        for (const recording of item.recordings) {
          const labels = speakers?.[recording.recordingId]?.labels;
          if (labels && Object.keys(labels).length) labelUpdates.push([recording.recordingId, labels]);
        }
      }
      for (const recording of snapshot.summaryRecordings) {
        const labels = store.summary?.speakers[recording.recordingId]?.labels;
        if (labels && Object.keys(labels).length) labelUpdates.push([recording.recordingId, labels]);
      }
      for (const [recordingId, labels] of labelUpdates) {
        await tx.prepare(`UPDATE retro_recordings SET speaker_labels_json = ?::jsonb, updated_at = now() WHERE id = ?`)
          .bind(JSON.stringify(labels), recordingId).run();
        labeledRecordings += 1;
      }
    }
    const published = await tx.prepare(
      `UPDATE retro_month_jobs SET status = 'PUBLISHED', finished_at = now(), lease_until = NULL, updated_at = now()
      WHERE id = ? AND status = 'PENDING_REVIEW'
      RETURNING id`,
    ).bind(row.id).first<QueryResultRow & { id: string }>();
    if (!published) throw retroConflict("INVALID_STATE", "任务的状态刚刚变了，请刷新后重试。");
    await insertRetroAudit(tx, actor, "RETRO_MONTH_PUBLISHED", "RETRO_MONTH_PUBLICATION", publicationId, {
      monthKey: row.month_key,
      versionNumber,
      jobId: row.id,
      basedOnPublicationId: row.based_on_publication_id,
      caseCount: caseIds.length,
      candidateCount: draft.methods.candidates.length,
      labeledRecordings,
    });
    return versionNumber;
  });
  return { jobId: input.jobId, advance: false, publicationVersion: version };
}

// ---------------------------------------------------------------------------
// 草稿修改
// ---------------------------------------------------------------------------

export async function patchRetroDraft(
  db: DbClient,
  actor: RetroMonthActor,
  input: { monthKey: string; jobId: string; body: unknown },
): Promise<{ itemId: string | null; revision: number }> {
  if (!isCaseReviewer(actor.displayName)) throw retroForbidden(RETRO_REVIEWER_ONLY);
  const patch = normalizeDraftPatchRequest(input.body);
  return db.withTransaction(async (tx) => {
    const row = await loadRetroJob(tx, input.jobId, true);
    if (!row || row.month_key !== input.monthKey) throw retroNotFound("整理任务不存在。");
    if (row.status !== "PENDING_REVIEW") throw retroConflict("INVALID_STATE", "现在没有可以修改的草稿。");
    if (Number(row.draft_revision) !== patch.revision) {
      throw new RetroError(409, "REVISION_CONFLICT", "草稿已经在别处改过了，请刷新后再改。");
    }
    const draft = parseDraft(row);
    if (!draft) throw retroConflict("INVALID_STATE", "草稿数据损坏，请重新生成。");
    const { draft: next, itemId } = applyRetroDraftPatch(draft, patch);
    const updated = await tx.prepare(
      `UPDATE retro_month_jobs SET minutes_json = ?::jsonb, methods_json = ?::jsonb, draft_revision = draft_revision + 1, updated_at = now()
      WHERE id = ? AND status = 'PENDING_REVIEW' AND draft_revision = ?
      RETURNING draft_revision`,
    ).bind(JSON.stringify(next.minutes), JSON.stringify(next.methods), row.id, patch.revision).first<QueryResultRow & { draft_revision: number }>();
    if (!updated) throw new RetroError(409, "REVISION_CONFLICT", "草稿已经在别处改过了，请刷新后再改。");
    return { itemId, revision: Number(updated.draft_revision) };
  });
}

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------

const RUNNING: readonly RetroJobStatus[] = ["QUEUED", "EXTRACTING", "SUMMARIZING", "DISTILLING"];

export function isRetroJobAdvanceable(status: RetroJobStatus) {
  return RUNNING.includes(status);
}

/** GET 时要不要顺手推进一次：在途且租约空闲。 */
export function shouldAdvanceRetroJob(row: Pick<RetroJobRow, "status" | "lease_until">, nowMs: number) {
  if (!isRetroJobAdvanceable(row.status)) return false;
  if (!row.lease_until) return true;
  const lease = row.lease_until instanceof Date ? row.lease_until.getTime() : Date.parse(String(row.lease_until));
  return !Number.isFinite(lease) || lease < nowMs;
}

export type RetroAdvanceResult = {
  /** 抢到了租约并做了事。 */
  advanced: boolean;
  status: RetroJobStatus | null;
  /** 任务还在途、应该接力推进下一步。 */
  relay: boolean;
  /** 这次推进有没有调模型。 */
  llmCalled: boolean;
};

type AdvanceOptions = { deadline: number; deps: RetroMonthDeps };

export async function advanceRetroMonthJob(db: DbClient, jobId: string, options: AdvanceOptions): Promise<RetroAdvanceResult> {
  const log = options.deps.log ?? ((message: string, detail?: unknown) => console.error(message, detail));
  let leased: RetroJobRow | null;
  try {
    // 毫秒精度的租约值同时当令牌用：退出时只清自己的租约（同 lib/audio-review/service.ts）。
    leased = await db.prepare(
      `UPDATE retro_month_jobs
      SET lease_until = date_trunc('milliseconds', now() + interval '${RETRO_MONTH_LEASE_SECONDS} seconds')
      WHERE id = ? AND status IN ('QUEUED', 'EXTRACTING', 'SUMMARIZING', 'DISTILLING') AND (lease_until IS NULL OR lease_until < now())
      RETURNING ${RETRO_JOB_COLUMNS}`,
    ).bind(jobId).first<RetroJobRow>();
  } catch (error) {
    log("[retro-month] 抢租约失败", error);
    return { advanced: false, status: null, relay: false, llmCalled: false };
  }
  if (!leased) return { advanced: false, status: null, relay: false, llmCalled: false };
  const leaseToken = leased.lease_until instanceof Date ? leased.lease_until.toISOString() : String(leased.lease_until);
  const state = { row: leased as RetroJobRow, llmCalled: false };
  try {
    const status = await runSteps(db, state, options);
    return { advanced: true, status, relay: status != null && isRetroJobAdvanceable(status), llmCalled: state.llmCalled };
  } catch (error) {
    // 代码或数据库层面的意外：记日志，把任务停在失败态，等老孙重试，不往外抛。
    log("[retro-month] 推进时出错", error);
    const current = state.row.status;
    const step: RetroJobFailedStep = current === "SUMMARIZING" ? "SUMMARIZE" : current === "DISTILLING" ? "DISTILL" : "EXTRACT";
    await failJob(db, state.row, step, "处理时出现内部错误，请重试。").catch((failure) => log("[retro-month] 写失败状态也失败了", failure));
    return { advanced: true, status: "FAILED", relay: false, llmCalled: state.llmCalled };
  } finally {
    await db.prepare(`UPDATE retro_month_jobs SET lease_until = NULL WHERE id = ? AND lease_until = ?::timestamptz`)
      .bind(jobId, leaseToken).run().catch((error) => log("[retro-month] 释放租约失败", error));
  }
}

async function failJob(db: DbClient, row: RetroJobRow, step: RetroJobFailedStep, reason: string, usageJson?: string) {
  return db.prepare(
    `UPDATE retro_month_jobs SET status = 'FAILED', failed_step = ?, fail_reason = ?, updated_at = now()${usageJson ? ", llm_usage_json = ?::jsonb" : ""}
    WHERE id = ? AND status = ?
    RETURNING ${RETRO_JOB_COLUMNS}`,
  ).bind(...([step, reason, ...(usageJson ? [usageJson] : []), row.id, row.status] as Array<string>)).first<RetroJobRow>();
}

type StepState = { row: RetroJobRow; llmCalled: boolean };

/** 走能走的步骤；最多一次模型调用。返回退出时的状态（null = 状态被别处改了）。 */
async function runSteps(db: DbClient, state: StepState, options: AdvanceOptions): Promise<RetroJobStatus | null> {
  for (let guard = 0; guard < 100; guard += 1) {
    const row = state.row;
    const snapshot = parseRetroSnapshot(row.input_snapshot_json);
    if (!snapshot || snapshot.kind !== "GENERATE") {
      await failJob(db, row, "EXTRACT", "任务的输入快照损坏，请放弃后重新生成。");
      return "FAILED";
    }
    if (row.status === "QUEUED") {
      const next = await db.prepare(
        `UPDATE retro_month_jobs SET status = 'EXTRACTING', llm_attempts = 0, updated_at = now()
        WHERE id = ? AND status = 'QUEUED' RETURNING ${RETRO_JOB_COLUMNS}`,
      ).bind(row.id).first<RetroJobRow>();
      if (!next) return null;
      state.row = next;
      continue;
    }
    if (row.status === "EXTRACTING") {
      const cases = analyzedCases(snapshot);
      const store = parseExtractionsStore(row.extractions_json);
      const model = row.llm_model ?? options.deps.llm.model;
      let index = Number(row.progress_index);
      // 输入没变的案例直接复用缓存。
      while (index < cases.length && isReusableExtraction(store.cases[cases[index].caseId], hashRetroCaseInput(cases[index], { model, promptVersion: RETRO_EXTRACT_PROMPT_VERSION }))) {
        index += 1;
      }
      if (index !== Number(row.progress_index) || index >= cases.length) {
        const next = await db.prepare(
          `UPDATE retro_month_jobs SET progress_index = ?, status = ?, llm_attempts = ?, updated_at = now()
          WHERE id = ? AND status = 'EXTRACTING' AND progress_index = ? RETURNING ${RETRO_JOB_COLUMNS}`,
        ).bind(index, index >= cases.length ? "SUMMARIZING" : "EXTRACTING", index >= cases.length ? 0 : Number(row.llm_attempts), row.id, Number(row.progress_index)).first<RetroJobRow>();
        if (!next) return null;
        state.row = next;
        continue;
      }
      if (state.llmCalled) return row.status;
      const item = cases[index];
      const inputHash = hashRetroCaseInput(item, { model, promptVersion: RETRO_EXTRACT_PROMPT_VERSION });
      const outcome = await callModel(db, state, options, {
        step: "EXTRACT",
        caseId: item.caseId,
        label: `案例 ${item.number}（${item.title}）`,
        promptVersion: RETRO_EXTRACT_PROMPT_VERSION,
        messages: buildRetroExtractMessages(item),
        context: { step: "EXTRACT", item },
        normalize: (raw) => normalizeRetroExtraction(raw, item),
        reject: rejectRetroExtraction,
      });
      if (outcome.kind !== "OK") return outcome.status;
      const nextStore: RetroExtractionsStore = {
        ...store,
        cases: {
          ...store.cases,
          [item.caseId]: {
            inputHash,
            output: outcome.result.output,
            dropped: outcome.result.dropped,
            model,
            promptVersion: RETRO_EXTRACT_PROMPT_VERSION,
            usage: outcome.usage,
            at: new Date(options.deps.clock()).toISOString(),
            empty: outcome.result.output.empty,
          },
        },
      };
      const next = await db.prepare(
        `UPDATE retro_month_jobs SET extractions_json = ?::jsonb, progress_index = ?, llm_attempts = 0, llm_usage_json = ?::jsonb, updated_at = now()
        WHERE id = ? AND status = 'EXTRACTING' AND progress_index = ? RETURNING ${RETRO_JOB_COLUMNS}`,
      ).bind(JSON.stringify(nextStore), index + 1, outcome.usageJson, row.id, index).first<RetroJobRow>();
      if (!next) return null;
      state.row = next;
      continue;
    }
    if (row.status === "SUMMARIZING" || row.status === "DISTILLING") {
      if (state.llmCalled) return row.status;
      const store = parseExtractionsStore(row.extractions_json);
      const synthesis: RetroSynthesisContext = {
        snapshot,
        extractions: Object.fromEntries(analyzedCases(snapshot).flatMap((item) => (store.cases[item.caseId] ? [[item.caseId, store.cases[item.caseId].output]] : []))),
      };
      if (row.status === "SUMMARIZING") {
        const outcome = await callModel(db, state, options, {
          step: "SUMMARIZE",
          label: "汇总纪要",
          promptVersion: RETRO_MINUTES_PROMPT_VERSION,
          messages: buildRetroMinutesMessages(synthesis),
          context: { step: "SUMMARIZE", synthesis },
          normalize: (raw) => normalizeRetroSummary(raw, synthesis),
        });
        if (outcome.kind !== "OK") return outcome.status;
        const minutes = assembleRetroMinutes(synthesis, outcome.result.output);
        const nextStore: RetroExtractionsStore = { ...store, summary: { speakers: outcome.result.output.speakers, dropped: outcome.result.dropped } };
        const next = await db.prepare(
          `UPDATE retro_month_jobs SET status = 'DISTILLING', minutes_json = ?::jsonb, extractions_json = ?::jsonb, llm_attempts = 0,
            llm_usage_json = ?::jsonb, updated_at = now()
          WHERE id = ? AND status = 'SUMMARIZING' RETURNING ${RETRO_JOB_COLUMNS}`,
        ).bind(JSON.stringify(minutes), JSON.stringify(nextStore), outcome.usageJson, row.id).first<RetroJobRow>();
        if (!next) return null;
        state.row = next;
        continue;
      }
      const summarySpeakers = store.summary?.speakers ?? null;
      const outcome = await callModel(db, state, options, {
        step: "DISTILL",
        label: "汇总方法",
        promptVersion: RETRO_METHODS_PROMPT_VERSION,
        messages: buildRetroMethodsMessages(synthesis, summarySpeakers),
        context: { step: "DISTILL", synthesis, summarySpeakers },
        normalize: (raw) => normalizeRetroDistill(raw, synthesis, summarySpeakers),
      });
      if (outcome.kind !== "OK") return outcome.status;
      const nextStore: RetroExtractionsStore = { ...store, distill: { dropped: outcome.result.dropped } };
      const next = await db.prepare(
        `UPDATE retro_month_jobs SET status = 'PENDING_REVIEW', methods_json = ?::jsonb, extractions_json = ?::jsonb, llm_attempts = 0,
          llm_usage_json = ?::jsonb, draft_revision = 1, updated_at = now()
        WHERE id = ? AND status = 'DISTILLING' RETURNING ${RETRO_JOB_COLUMNS}`,
      ).bind(JSON.stringify(outcome.result.output), JSON.stringify(nextStore), outcome.usageJson, row.id).first<RetroJobRow>();
      if (!next) return null;
      state.row = next;
      return next.status;
    }
    return row.status;
  }
  return state.row.status;
}

type ModelCall<T> = {
  step: RetroJobFailedStep;
  caseId?: string;
  label: string;
  promptVersion: string;
  messages: RetroLlmMessages;
  context: Parameters<RetroLlmProvider["complete"]>[1];
  normalize: (raw: Record<string, unknown>) => T;
  /** 结果虽然是合法 JSON 但不能用（缺键、全被丢光）：返回失败原因，按可重试失败处理，不写缓存。 */
  reject?: (result: T, raw: Record<string, unknown>) => string | null;
};

const EXTRACT_KEYS = ["speakers", "review", "insights", "actions", "methods"] as const;

/**
 * ①的结果不能用的两种情况（审查意见 2）：原始 JSON 一个预期的键都没有；或者给了内容却全部被校验丢光
 * （只算条目被丢的原因，「某段没认出老孙」这类说话人提示不算）。这两种都当作可重试的失败，不写缓存。
 */
export function rejectRetroExtraction(result: ReturnType<typeof normalizeRetroExtraction>, raw: Record<string, unknown>): string | null {
  if (!EXTRACT_KEYS.some((key) => key in raw)) return "模型返回的 JSON 缺少预期的内容（speakers、review、methods 等都没有）。";
  const itemDrops = result.dropped.filter((line) => !line.startsWith("点评录音第"));
  if (result.output.empty && itemDrops.length) return "模型给出的内容全部没有有效的录音依据，被校验丢弃了。";
  return null;
}

type ModelOutcome<T> =
  | { kind: "OK"; result: T; usage: unknown; usageJson: string }
  | { kind: "STOP"; status: RetroJobStatus | null };

/**
 * 一次模型调用：剩余时间不足 245 秒不开始（留给接力）；第一次高思考强度、再试低强度；
 * 第二次仍失败（或错误不值得再试）转 FAILED(step)，progress_index 留在失败的那个案例。
 */
async function callModel<T>(db: DbClient, state: StepState, options: AdvanceOptions, call: ModelCall<T>): Promise<ModelOutcome<T>> {
  const { deps } = options;
  const row = state.row;
  const previousCalls = usageCalls(row.llm_usage_json);
  if (Number(row.llm_attempts) >= RETRO_MONTH_MAX_LLM_ATTEMPTS) {
    // 两次都开始了却没有收尾（例如函数被中途回收）：不再自动重试。
    const last = previousCalls[previousCalls.length - 1];
    await failJob(db, row, call.step, `${call.label}：${last?.reason ?? "模型连续两次没有返回可用结果，请重试。"}`);
    return { kind: "STOP", status: "FAILED" };
  }
  if (options.deadline - deps.clock() < RETRO_MONTH_MIN_LLM_WINDOW_MS) return { kind: "STOP", status: row.status };

  const attempt = Number(row.llm_attempts) + 1;
  const inputHash = hashRetroMessages(deps.llm.model, call.promptVersion, call.messages);
  const started = await db.prepare(
    `UPDATE retro_month_jobs SET llm_attempts = ?, llm_model = COALESCE(llm_model, ?), updated_at = now()
    WHERE id = ? AND status = ? RETURNING ${RETRO_JOB_COLUMNS}`,
  ).bind(attempt, deps.llm.model, row.id, row.status).first<RetroJobRow>();
  if (!started) return { kind: "STOP", status: null };
  state.row = started;
  state.llmCalled = true;

  const outcome = await deps.llm.complete(call.messages, call.context, {
    timeoutMs: RETRO_MONTH_LLM_TIMEOUT_MS,
    reasoningEffort: attempt === 1 ? "high" : "low",
  });
  let failure: { reason: string; retryable: boolean } | null = null;
  let result: T | null = null;
  if (!outcome.ok) {
    failure = { reason: outcome.reason, retryable: outcome.retryable };
  } else {
    const parsed = parseModelJsonContent(outcome.content, outcome.finishReason);
    if (!parsed.ok) failure = { reason: parsed.reason, retryable: true };
    else {
      const normalized = call.normalize(parsed.value);
      const rejection = call.reject?.(normalized, parsed.value) ?? null;
      if (rejection) failure = { reason: rejection, retryable: true };
      else result = normalized;
    }
  }
  const record: LlmCallRecord = {
    step: call.step,
    ...(call.caseId ? { caseId: call.caseId } : {}),
    attempt,
    ok: !failure,
    at: new Date(deps.clock()).toISOString(),
    durationMs: outcome.durationMs,
    finishReason: outcome.ok ? outcome.finishReason : null,
    usage: outcome.usage ?? null,
    inputHash,
    ...(failure ? { reason: failure.reason } : {}),
  };
  const usageJson = JSON.stringify({ calls: [...previousCalls, record] });
  if (result != null && !failure) return { kind: "OK", result, usage: outcome.usage ?? null, usageJson };

  if (!failure!.retryable || attempt >= RETRO_MONTH_MAX_LLM_ATTEMPTS) {
    await failJob(db, state.row, call.step, `${call.label}：${failure!.reason}`, usageJson);
    return { kind: "STOP", status: "FAILED" };
  }
  // 第一次失败：记下用量，留给下一次推进用低思考强度再试。
  const saved = await db.prepare(
    `UPDATE retro_month_jobs SET llm_usage_json = ?::jsonb, updated_at = now() WHERE id = ? AND status = ? RETURNING ${RETRO_JOB_COLUMNS}`,
  ).bind(usageJson, state.row.id, state.row.status).first<RetroJobRow>();
  if (!saved) return { kind: "STOP", status: null };
  state.row = saved;
  return { kind: "STOP", status: saved.status };
}

export { isRetroJobLive };
