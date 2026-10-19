// 月度整理读表的部分：当月案例、录音、客户录音的概况（月份页、生成前提），以及生成那一刻的
// 输入快照。只读 retro_cases / retro_case_rounds / retro_case_assets / retro_round_links /
// retro_recordings（形状见 db/retro-schema.ts），不写。关联作品只取库名、标题、品牌或客户、
// 标签、一句话摘要（规格 4.4）。

import type { DbClient, QueryResultRow } from "@/db";
import { parseStoredTranscript } from "@/lib/audio-review/transcript";
import {
  RETRO_LIMITS,
  retroCaseNumbers,
  type RetroGeneratePreconditions,
  type RetroJobStatus,
  type RetroLinkKind,
  type RetroRecordingBadge,
  type RetroRecordingStatus,
  type RetroTranscriptSegment,
} from "@/lib/retro-model";
import { RETRO_RECORDING_COLUMNS, type RetroRecordingRow } from "./views";
import {
  truncateClientAudio,
  truncateRecordings,
  type RetroGenerateSnapshot,
  type RetroSnapshotCase,
  type RetroSnapshotLink,
  type RetroSnapshotRecording,
} from "./month-snapshot";

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return "";
}

/** retro_recordings / retro_case_assets 的 transcript_json 都是 { segments, durationMs, engine }（同录音点评）。 */
export function parseRetroTranscriptSegments(value: unknown): RetroTranscriptSegment[] {
  return parseStoredTranscript(value)?.segments ?? [];
}

function parseTags(value: unknown): string[] {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

// ---------------------------------------------------------------------------
// 月份概况
// ---------------------------------------------------------------------------

export type RetroMonthCaseFact = {
  id: string;
  department: string;
  clientName: string;
  title: string;
  createdAt: string;
  deleted: boolean;
  roundCount: number;
};

export type RetroMonthRecordingFact = {
  id: string;
  caseId: string | null;
  partNo: number;
  status: RetroRecordingStatus;
  failReason: string | null;
  fileName: string;
  sizeBytes: number;
  durationMs: number | null;
  uploadedByUserId: string;
  uploadedByName: string;
  createdAt: string;
  removedAt: string | null;
  segments: RetroTranscriptSegment[] | null;
  /** 原始行：整场总结录音交给 lib/retro/views.ts 的 toRetroRecordingView 映射。 */
  row: RetroRecordingRow;
};

export type RetroMonthClientAudioFact = { id: string; caseId: string; uploadStatus: string; transcribeStatus: string; createdAt: string };

export type RetroMonthFacts = {
  monthKey: string;
  /** 含已删除的案例（序号要算上它们）。 */
  cases: RetroMonthCaseFact[];
  /** 含已移除的录音（变动计数要用）。 */
  recordings: RetroMonthRecordingFact[];
  clientAudio: RetroMonthClientAudioFact[];
};

type CaseRow = QueryResultRow & {
  id: string; department: string; client_name: string; title: string; created_at: unknown; deleted_at: unknown; round_count: number | string;
};
type RecordingRow = RetroRecordingRow & { removed_at: unknown };

export async function loadRetroMonthFacts(db: DbClient, monthKey: string): Promise<RetroMonthFacts> {
  const caseRows = (await db.prepare(
    `SELECT c.id, c.department, c.client_name, c.title, c.created_at, c.deleted_at,
      (SELECT COUNT(*) FROM retro_case_rounds r WHERE r.case_id = c.id AND r.deleted_at IS NULL) AS round_count
    FROM retro_cases c WHERE c.month_key = ? ORDER BY c.created_at ASC, c.id ASC`,
  ).bind(monthKey).all<CaseRow>()).results;
  const recordingRows = (await db.prepare(
    `SELECT ${RETRO_RECORDING_COLUMNS}, removed_at
    FROM retro_recordings WHERE month_key = ? ORDER BY case_id NULLS LAST, part_no ASC, created_at ASC`,
  ).bind(monthKey).all<RecordingRow>()).results;
  const assetRows = (await db.prepare(
    `SELECT a.id, a.case_id, a.upload_status, a.transcribe_status, a.created_at
    FROM retro_case_assets a JOIN retro_cases c ON c.id = a.case_id
    WHERE c.month_key = ? AND c.deleted_at IS NULL AND a.type = 'AUDIO'`,
  ).bind(monthKey).all<QueryResultRow & { id: string; case_id: string; upload_status: string; transcribe_status: string; created_at: unknown }>()).results;

  return {
    monthKey,
    cases: caseRows.map((row) => ({
      id: row.id,
      department: row.department,
      clientName: row.client_name,
      title: row.title,
      createdAt: toIso(row.created_at),
      deleted: Boolean(row.deleted_at),
      roundCount: Number(row.round_count) || 0,
    })),
    recordings: recordingRows.map((row) => ({
      id: row.id,
      caseId: row.case_id,
      partNo: Number(row.part_no),
      status: row.status as RetroRecordingStatus,
      failReason: row.fail_reason,
      fileName: row.audio_file_name,
      sizeBytes: Number(row.audio_size_bytes) || 0,
      durationMs: row.audio_duration_ms == null ? null : Number(row.audio_duration_ms),
      uploadedByUserId: row.uploaded_by_user_id,
      uploadedByName: row.uploaded_by_name,
      createdAt: toIso(row.created_at),
      removedAt: row.removed_at ? toIso(row.removed_at) : null,
      segments: row.status === "READY" ? parseRetroTranscriptSegments(row.transcript_json) : null,
      row,
    })),
    clientAudio: assetRows.map((row) => ({
      id: row.id, caseId: row.case_id, uploadStatus: row.upload_status, transcribeStatus: row.transcribe_status, createdAt: toIso(row.created_at),
    })),
  };
}

export const liveRetroCases = (facts: RetroMonthFacts) => facts.cases.filter((item) => !item.deleted);

/** 案例行与卡片上的录音标记（规格 10.2）：上传中也算「转写中」。 */
export function retroRecordingBadge(recordings: readonly RetroMonthRecordingFact[]): RetroRecordingBadge {
  const active = recordings.filter((recording) => recording.status !== "REMOVED");
  if (!active.length) return { state: "NONE" };
  if (active.some((recording) => recording.status === "UPLOADING" || recording.status === "TRANSCRIBING")) return { state: "PROCESSING" };
  if (active.some((recording) => recording.status === "FAILED")) return { state: "FAILED" };
  return { state: "READY", parts: active.length, durationMs: active.reduce((sum, recording) => sum + (recording.durationMs ?? 0), 0) };
}

/** 上传到一半被放弃的：UPLOADING 超过 1 小时，不算「还在上传」，也不挡生成（B1 会把它们懒置为 FAILED）。 */
export const RETRO_STALE_UPLOAD_MS = 60 * 60 * 1000;

const isStaleUpload = (uploadStatus: string, createdAt: string, nowMs: number) => {
  if (uploadStatus !== "UPLOADING") return false;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && nowMs - created > RETRO_STALE_UPLOAD_MS;
};

const isProcessing = (recording: RetroMonthRecordingFact, nowMs: number) =>
  recording.status === "TRANSCRIBING" || (recording.status === "UPLOADING" && !isStaleUpload("UPLOADING", recording.createdAt, nowMs));

/** 客户录音还没到终态：上传中（未过期）、转写中，或者传完还没开始转写。 */
const clientAudioPending = (asset: RetroMonthClientAudioFact, nowMs: number) =>
  asset.uploadStatus === "UPLOADING"
    ? !isStaleUpload(asset.uploadStatus, asset.createdAt, nowMs)
    : asset.transcribeStatus === "TRANSCRIBING" || asset.transcribeStatus === "NONE";

export type RetroLiveJobFact = { status: RetroJobStatus } | null;

/**
 * 生成前提（规格 6.1）。
 * - canGenerate / blockedReason：现在能不能新开一个任务（有在途任务时不能）；
 * - canRegenerate / regenerateBlockedReason：在途任务是待审阅或失败时，能不能「重新生成」替换它——
 *   排除这个任务自己，其余前提照算（审查意见 1）。
 */
export function computeRetroPreconditions(facts: RetroMonthFacts, liveJob: RetroLiveJobFact, nowMs: number = Date.now()): RetroGeneratePreconditions {
  const live = liveRetroCases(facts);
  const liveIds = new Set(live.map((item) => item.id));
  const reviewRecordings = facts.recordings.filter((recording) => recording.status !== "REMOVED" && (recording.caseId == null || liveIds.has(recording.caseId)));
  const recordedCaseCount = live.filter((item) => reviewRecordings.some((recording) => recording.caseId === item.id && recording.status === "READY")).length;
  const reviewRecordingsProcessing = reviewRecordings.filter((recording) => isProcessing(recording, nowMs)).length;
  const summaryParts = reviewRecordings.filter((recording) => recording.caseId == null && recording.status === "READY").length;
  const transcribing = facts.clientAudio.filter((asset) => clientAudioPending(asset, nowMs)).length;
  const clientAudio = {
    total: facts.clientAudio.length,
    ready: facts.clientAudio.filter((asset) => asset.uploadStatus !== "UPLOADING" && asset.transcribeStatus === "READY").length,
    transcribing,
    // 过期的半截上传算失败：它不会进入提炼。
    failed: facts.clientAudio.filter((asset) =>
      (asset.uploadStatus !== "UPLOADING" && asset.transcribeStatus === "FAILED") || isStaleUpload(asset.uploadStatus, asset.createdAt, nowMs)).length,
  };
  let inputBlocked: string | null = null;
  if (!live.length) inputBlocked = "本月还没有案例。";
  else if (!recordedCaseCount) inputBlocked = "还没有任何案例的点评录音转写完成。";
  else if (reviewRecordingsProcessing) inputBlocked = `有 ${reviewRecordingsProcessing} 段点评录音还在上传或转写，等它们完成后再生成。`;
  else if (transcribing) inputBlocked = `有 ${transcribing} 段客户录音还在上传或转写，等它们完成后再生成。`;
  const blockedReason = liveJob ? "本月已有一个整理任务，先完成或放弃它。" : inputBlocked;
  let regenerateBlockedReason: string | null;
  if (!liveJob) regenerateBlockedReason = "没有可以替换的整理任务。";
  else if (liveJob.status !== "PENDING_REVIEW" && liveJob.status !== "FAILED") regenerateBlockedReason = "整理还在进行，等它完成或放弃后再重新生成。";
  else regenerateBlockedReason = inputBlocked;
  return {
    caseCount: live.length,
    recordedCaseCount,
    unrecordedCaseCount: live.length - recordedCaseCount,
    reviewRecordingsProcessing,
    summaryParts,
    clientAudio,
    canGenerate: blockedReason == null,
    blockedReason,
    canRegenerate: regenerateBlockedReason == null,
    regenerateBlockedReason,
  };
}

/** 发布后录音变动的段数（规格 5.3）：发布后新增且未移除的，加上发布前就有、发布后被移除的。 */
export function countRecordingChangesSince(facts: RetroMonthFacts, publishedAt: string): number {
  const at = Date.parse(publishedAt);
  if (!Number.isFinite(at)) return 0;
  let count = 0;
  for (const recording of facts.recordings) {
    const created = Date.parse(recording.createdAt);
    const removed = recording.removedAt ? Date.parse(recording.removedAt) : null;
    if (created > at && recording.status !== "REMOVED") count += 1;
    else if (created <= at && removed != null && removed > at) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 输入快照
// ---------------------------------------------------------------------------

type DetailCaseRow = QueryResultRow & {
  id: string; department: string; client_name: string; title: string; scene_tags_json: unknown; background: string;
  outcome: string; turning_points: string; discussion_questions: string; created_at: unknown; deleted_at: unknown;
};
type RoundRow = QueryResultRow & {
  id: string; case_id: string; position: number; title: string; occurred_on: string; delivery_text: string; feedback_text: string; response_text: string;
};
type LinkRow = QueryResultRow & { round_id: string; target_kind: RetroLinkKind; target_id: string; position: number };
type AudioAssetRow = QueryResultRow & {
  id: string; case_id: string; round_id: string | null; position: number; original_name: string; transcript_json: unknown;
};

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

const clip = (value: unknown, max: number) => {
  const chars = [...String(value ?? "").replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

/** 关联作品摘要；原表读不出来（缺表、权限）时退化为只有 id，不让生成失败。 */
async function loadLinkSummaries(db: DbClient, links: readonly LinkRow[]): Promise<Map<string, RetroSnapshotLink>> {
  const result = new Map<string, RetroSnapshotLink>();
  const byKind = new Map<RetroLinkKind, string[]>();
  for (const link of links) {
    const ids = byKind.get(link.target_kind) ?? [];
    if (!ids.includes(link.target_id)) ids.push(link.target_id);
    byKind.set(link.target_kind, ids);
  }
  const queries: Record<RetroLinkKind, string> = {
    VIDEO: `SELECT id, title, brand AS brand, description AS summary, tags_json, deleted_at FROM videos WHERE id IN (%)`,
    REPORT: `SELECT id, title, '' AS brand, '' AS summary, tags_json, deleted_at FROM reports WHERE id IN (%)`,
    VISUAL: `SELECT id, title, creator AS brand, summary, tags_json, deleted_at FROM visual_cases WHERE id IN (%)`,
  };
  for (const [kind, ids] of byKind) {
    try {
      const rows = (await db.prepare(queries[kind].replace("%", placeholders(ids.length))).bind(...ids)
        .all<QueryResultRow & { id: string; title: string; brand: string | null; summary: string | null; tags_json: unknown; deleted_at: unknown }>()).results;
      for (const row of rows) {
        result.set(`${kind}:${row.id}`, {
          kind,
          targetId: row.id,
          title: clip(row.title, 80),
          brand: clip(row.brand, 40),
          tags: parseTags(row.tags_json).slice(0, 8),
          summary: clip(row.summary, 80),
          deleted: Boolean(row.deleted_at),
        });
      }
    } catch {
      // 退化：只有 id。
    }
  }
  for (const link of links) {
    const key = `${link.target_kind}:${link.target_id}`;
    if (!result.has(key)) result.set(key, { kind: link.target_kind, targetId: link.target_id, title: "（原作品已删除）", brand: "", tags: [], summary: "", deleted: true });
  }
  return result;
}

export async function buildRetroGenerateSnapshot(db: DbClient, monthKey: string, now: Date = new Date()): Promise<RetroGenerateSnapshot> {
  const caseRows = (await db.prepare(
    `SELECT id, department, client_name, title, scene_tags_json, background, outcome, turning_points, discussion_questions,
      created_at, deleted_at
    FROM retro_cases WHERE month_key = ? ORDER BY created_at ASC, id ASC`,
  ).bind(monthKey).all<DetailCaseRow>()).results;
  const caseNumbers = retroCaseNumbers(caseRows.map((row) => ({ id: row.id, createdAt: toIso(row.created_at) })));
  const live = caseRows.filter((row) => !row.deleted_at);
  const liveIds = live.map((row) => row.id);

  const rounds = liveIds.length
    ? (await db.prepare(
      `SELECT id, case_id, position, title, occurred_on, delivery_text, feedback_text, response_text
      FROM retro_case_rounds WHERE case_id IN (${placeholders(liveIds.length)}) AND deleted_at IS NULL
      ORDER BY case_id, position ASC, created_at ASC`,
    ).bind(...liveIds).all<RoundRow>()).results
    : [];
  const roundIds = rounds.map((round) => round.id);
  const links = roundIds.length
    ? (await db.prepare(
      `SELECT round_id, target_kind, target_id, position FROM retro_round_links
      WHERE round_id IN (${placeholders(roundIds.length)}) ORDER BY round_id, position ASC`,
    ).bind(...roundIds).all<LinkRow>()).results
    : [];
  const linkSummaries = await loadLinkSummaries(db, links);
  const audioAssets = liveIds.length
    ? (await db.prepare(
      `SELECT id, case_id, round_id, position, original_name, transcript_json FROM retro_case_assets
      WHERE case_id IN (${placeholders(liveIds.length)}) AND type = 'AUDIO' AND upload_status = 'READY' AND transcribe_status = 'READY'
      ORDER BY case_id, position ASC, created_at ASC`,
    ).bind(...liveIds).all<AudioAssetRow>()).results
    : [];
  const recordingRows = (await db.prepare(
    `SELECT id, case_id, part_no, transcript_json FROM retro_recordings
    WHERE month_key = ? AND status = 'READY' ORDER BY part_no ASC`,
  ).bind(monthKey).all<QueryResultRow & { id: string; case_id: string | null; part_no: number; transcript_json: unknown }>()).results;

  const toRecording = (row: (typeof recordingRows)[number]): RetroSnapshotRecording => ({
    recordingId: row.id,
    partNo: Number(row.part_no),
    segments: parseRetroTranscriptSegments(row.transcript_json),
  });

  const cases: RetroSnapshotCase[] = live.map((row) => {
    const caseRounds = rounds.filter((round) => round.case_id === row.id);
    const roundOrder = new Map(caseRounds.map((round, index) => [round.id, index]));
    const audio = audioAssets
      .filter((asset) => asset.case_id === row.id && (asset.round_id == null || roundOrder.has(asset.round_id)))
      // 需求凭证在前，回合按顺序，同一处按附件位置。
      .sort((a, b) => (a.round_id == null ? -1 : roundOrder.get(a.round_id)!) - (b.round_id == null ? -1 : roundOrder.get(b.round_id)!) || a.position - b.position)
      .map((asset) => ({ assetId: asset.id, roundId: asset.round_id, fileName: asset.original_name, segments: parseRetroTranscriptSegments(asset.transcript_json) }))
      .filter((asset) => asset.segments.length);
    return {
      caseId: row.id,
      number: caseNumbers[row.id],
      department: row.department,
      clientName: row.client_name,
      title: row.title,
      sceneTags: parseTags(row.scene_tags_json),
      background: row.background ?? "",
      outcome: row.outcome ?? "",
      turningPoints: row.turning_points ?? "",
      discussionQuestions: row.discussion_questions ?? "",
      rounds: caseRounds.map((round) => ({
        id: round.id,
        position: Number(round.position),
        title: round.title,
        occurredOn: round.occurred_on ?? "",
        deliveryText: round.delivery_text ?? "",
        feedbackText: round.feedback_text ?? "",
        responseText: round.response_text ?? "",
        links: links
          .filter((link) => link.round_id === round.id)
          .map((link) => linkSummaries.get(`${link.target_kind}:${link.target_id}`)!)
          .filter(Boolean),
      })),
      clientAudio: truncateClientAudio(audio),
      recordings: truncateRecordings(
        recordingRows.filter((recording) => recording.case_id === row.id).map(toRecording).filter((recording) => recording.segments.length),
        RETRO_LIMITS.reviewTranscriptCharsPerCase,
      ),
    };
  }).sort((a, b) => a.number - b.number);

  return {
    kind: "GENERATE",
    monthKey,
    capturedAt: now.toISOString(),
    caseNumbers,
    cases,
    summaryRecordings: truncateRecordings(
      recordingRows.filter((recording) => recording.case_id == null).map(toRecording).filter((recording) => recording.segments.length),
      RETRO_LIMITS.summaryTranscriptChars,
    ),
  };
}
