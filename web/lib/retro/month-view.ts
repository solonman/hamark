// 月份页与整理结果的读取：RetroMonthView、RetroJobView、RetroPublicationView（形状见 lib/retro-model.ts）。
// 草稿内容只给老孙；其他人拿到的 job.draft 恒为 null、failReason 也不给。

import type { DbClient, QueryResultRow } from "@/db";
import { isCaseReviewer } from "@/lib/case-review";
import type {
  RetroJobView,
  RetroMethods,
  RetroMinutes,
  RetroMonthCaseRow,
  RetroMonthView,
  RetroPublicationView,
  RetroStoredPublicationCases,
  RetroStoredQuotes,
} from "@/lib/retro-model";
import { retroCaseNumbers } from "@/lib/retro-model";
import {
  computeRetroPreconditions,
  countRecordingChangesSince,
  liveRetroCases,
  loadRetroMonthFacts,
  retroRecordingBadge,
  toIso,
  type RetroMonthFacts,
} from "./month-input";
import { canRemoveRetroRecording, type RetroViewer } from "./access";
import { toRetroRecordingView } from "./views";
import {
  loadLiveRetroJob,
  parseDraft,
  parseExtractionsStore,
  quotesForDraft,
  shouldAdvanceRetroJob,
  type RetroJobRow,
} from "./month-service";
import { analyzedCases, parseJsonColumn, parseRetroSnapshot } from "./month-snapshot";

export type RetroMonthViewer = Pick<RetroViewer, "userId" | "displayName" | "isAdmin">;

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export function toRetroJobView(row: RetroJobRow, options: { isReviewer: boolean; revisingFromVersion: number | null }): RetroJobView {
  const snapshot = parseRetroSnapshot(row.input_snapshot_json);
  const total = snapshot?.kind === "GENERATE" ? analyzedCases(snapshot).length : 0;
  const extracting = row.status === "QUEUED" || row.status === "EXTRACTING" || (row.status === "FAILED" && row.failed_step === "EXTRACT");
  let draft: RetroJobView["draft"] = null;
  if (options.isReviewer && row.status === "PENDING_REVIEW") {
    const parsed = parseDraft(row);
    if (parsed) {
      const quotes = quotesForDraft(snapshot, parseExtractionsStore(row.extractions_json), parsed);
      const caseNumbers = snapshot?.kind === "GENERATE"
        ? Object.fromEntries(snapshot.cases.map((item) => [item.caseId, item.number]))
        : Object.fromEntries((snapshot?.cases ?? []).map((item) => [item.caseId, item.number]));
      draft = { minutes: parsed.minutes, methods: parsed.methods, revision: Number(row.draft_revision), quotedSegments: quotes.segments, recordingRefs: quotes.recordingRefs, caseNumbers };
    }
  }
  return {
    id: row.id,
    status: row.status,
    progress: { done: extracting ? Math.min(Number(row.progress_index), total) : total, total },
    failedStep: row.failed_step,
    failReason: options.isReviewer ? row.fail_reason : null,
    revisingFromVersion: options.revisingFromVersion,
    draft,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function revisingFromVersion(db: DbClient, row: RetroJobRow): Promise<number | null> {
  if (!row.based_on_publication_id) return null;
  const publication = await db.prepare(`SELECT version_number FROM retro_month_publications WHERE id = ?`)
    .bind(row.based_on_publication_id).first<QueryResultRow & { version_number: number }>();
  return publication ? Number(publication.version_number) : null;
}

export async function loadRetroJobView(db: DbClient, row: RetroJobRow, viewer: { isReviewer: boolean }): Promise<RetroJobView> {
  return toRetroJobView(row, { isReviewer: viewer.isReviewer, revisingFromVersion: await revisingFromVersion(db, row) });
}

// ---------------------------------------------------------------------------
// 已发布版本
// ---------------------------------------------------------------------------

type PublicationRow = QueryResultRow & {
  id: string;
  month_key: string;
  version_number: number;
  case_ids_json: unknown;
  minutes_json: unknown;
  methods_json: unknown;
  quoted_segments_json: unknown;
  published_at: unknown;
  published_by_name: string | null;
};

const PUBLICATION_SELECT = `SELECT p.id, p.month_key, p.version_number, p.case_ids_json, p.minutes_json, p.methods_json,
  p.quoted_segments_json, p.published_at, u.display_name AS published_by_name
  FROM retro_month_publications p LEFT JOIN users u ON u.id = p.published_by_user_id`;

export function toRetroPublicationView(row: PublicationRow): RetroPublicationView {
  const cases = parseJsonColumn<RetroStoredPublicationCases>(row.case_ids_json) ?? [];
  const quotes = parseJsonColumn<RetroStoredQuotes>(row.quoted_segments_json) ?? { segments: {}, recordingRefs: {} };
  return {
    id: row.id,
    versionNumber: Number(row.version_number),
    publishedAt: toIso(row.published_at),
    publishedByName: row.published_by_name ?? "",
    caseIds: cases.map((item) => item.caseId),
    caseNumbers: Object.fromEntries(cases.map((item) => [item.caseId, item.number])),
    minutes: parseJsonColumn<RetroMinutes>(row.minutes_json) ?? { cases: [], unanalyzedCaseIds: [], insights: [], actions: [] },
    methods: parseJsonColumn<RetroMethods>(row.methods_json) ?? { candidates: [], observations: [] },
    quotedSegments: quotes.segments ?? {},
    recordingRefs: quotes.recordingRefs ?? {},
  };
}

export async function loadRetroPublication(db: DbClient, monthKey: string, versionNumber: number): Promise<RetroPublicationView | null> {
  const row = await db.prepare(`${PUBLICATION_SELECT} WHERE p.month_key = ? AND p.version_number = ?`)
    .bind(monthKey, versionNumber).first<PublicationRow>();
  return row ? toRetroPublicationView(row) : null;
}

export async function loadLatestRetroPublication(db: DbClient, monthKey: string): Promise<RetroPublicationView | null> {
  const row = await db.prepare(`${PUBLICATION_SELECT} WHERE p.month_key = ? ORDER BY p.version_number DESC LIMIT 1`)
    .bind(monthKey).first<PublicationRow>();
  return row ? toRetroPublicationView(row) : null;
}

export async function listRetroPublicationVersions(db: DbClient, monthKey: string): Promise<number[]> {
  const rows = (await db.prepare(`SELECT version_number FROM retro_month_publications WHERE month_key = ? ORDER BY version_number DESC`)
    .bind(monthKey).all<QueryResultRow & { version_number: number }>()).results;
  return rows.map((row) => Number(row.version_number));
}

// ---------------------------------------------------------------------------
// 月份页
// ---------------------------------------------------------------------------

export type RetroMonthAiStateInternal = {
  job: RetroJobView | null;
  liveJobRow: RetroJobRow | null;
  latestPublication: RetroPublicationView | null;
  publicationVersions: number[];
  changedSincePublish: number;
};

export async function buildRetroMonthAiState(db: DbClient, monthKey: string, viewer: { isReviewer: boolean }, facts?: RetroMonthFacts): Promise<RetroMonthAiStateInternal> {
  const liveJobRow = await loadLiveRetroJob(db, monthKey);
  const job = liveJobRow ? await loadRetroJobView(db, liveJobRow, viewer) : null;
  const latestPublication = await loadLatestRetroPublication(db, monthKey);
  const publicationVersions = await listRetroPublicationVersions(db, monthKey);
  let changedSincePublish = 0;
  if (latestPublication) {
    changedSincePublish = countRecordingChangesSince(facts ?? await loadRetroMonthFacts(db, monthKey), latestPublication.publishedAt);
  }
  return { job, liveJobRow, latestPublication, publicationVersions, changedSincePublish };
}

export async function loadRetroMonthView(
  db: DbClient,
  monthKey: string,
  viewer: RetroMonthViewer,
  nowMs: number = Date.now(),
): Promise<{ view: RetroMonthView; advanceJobId: string | null }> {
  const isReviewer = isCaseReviewer(viewer.displayName);
  const facts = await loadRetroMonthFacts(db, monthKey);
  const ai = await buildRetroMonthAiState(db, monthKey, { isReviewer }, facts);
  const numbers = retroCaseNumbers(facts.cases);
  const activeRecordings = facts.recordings.filter((recording) => recording.status !== "REMOVED");
  const live = liveRetroCases(facts);
  const liveIds = new Set(live.map((item) => item.id));
  const cases: RetroMonthCaseRow[] = live
    .map((item) => ({
      id: item.id,
      number: numbers[item.id],
      department: item.department,
      clientName: item.clientName,
      title: item.title,
      roundCount: item.roundCount,
      recording: retroRecordingBadge(activeRecordings.filter((recording) => recording.caseId === item.id)),
    }))
    .sort((a, b) => a.number - b.number);
  const summaryRecordings = activeRecordings
    .filter((recording) => recording.caseId == null)
    .sort((a, b) => a.partNo - b.partNo)
    // 整场总结没有案例上传者：能移除的是这段录音的上传者和系统管理员（规格 4.5）。
    .map((recording) => toRetroRecordingView(recording.row, canRemoveRetroRecording(recording, null, viewer)));
  const totalDurationMs = activeRecordings
    .filter((recording) => recording.caseId == null || liveIds.has(recording.caseId))
    .reduce((sum, recording) => sum + (recording.durationMs ?? 0), 0);
  const view: RetroMonthView = {
    monthKey,
    cases,
    summaryRecordings,
    totalDurationMs,
    latestPublication: ai.latestPublication,
    publicationVersions: ai.publicationVersions,
    changedSincePublish: ai.changedSincePublish,
    job: ai.job,
    preconditions: computeRetroPreconditions(facts, Boolean(ai.liveJobRow)),
    viewer: { isReviewer, canUploadSummary: true },
  };
  const advanceJobId = ai.liveJobRow && shouldAdvanceRetroJob(ai.liveJobRow, nowMs) ? ai.liveJobRow.id : null;
  return { view, advanceJobId };
}
