// 月度整理的输入快照（retro_month_jobs.input_snapshot_json）与围绕它的纯函数。
// 生成那一刻把案例文字、回合、关联作品摘要、客户录音文字稿、点评录音片段和冻结的案例序号
// 一次写定（docs/26 6.3、6.7）；之后的三步、草稿引文、发布都只读这份快照，不再回头查表。
// 「修订已发布内容」的任务没有模型输入，快照里存的是来源版本的案例清单和引文快照。

import { createHash } from "node:crypto";
import {
  RETRO_LIMITS,
  type RetroLinkKind,
  type RetroQuotedSegment,
  type RetroSource,
  type RetroStoredPublicationCases,
  type RetroStoredQuotes,
  type RetroTranscriptSegment,
} from "@/lib/retro-model";

export type RetroSnapshotLink = {
  kind: RetroLinkKind;
  targetId: string;
  title: string;
  /** 品牌或客户。 */
  brand: string;
  tags: string[];
  /** 一句话摘要（规格 4.4：不展开视频拆解全文）。 */
  summary: string;
  deleted: boolean;
};

export type RetroSnapshotRound = {
  id: string;
  position: number;
  title: string;
  occurredOn: string;
  deliveryText: string;
  feedbackText: string;
  responseText: string;
  links: RetroSnapshotLink[];
};

export type RetroSnapshotClientAudio = {
  assetId: string;
  /** null = 挂在「任务与最初需求」上（需求凭证）。 */
  roundId: string | null;
  fileName: string;
  segments: RetroTranscriptSegment[];
  /** 因为超出每案 3 万字上限而省略的片段数（规格 6.4）。 */
  omittedSegments: number;
};

export type RetroSnapshotRecording = {
  recordingId: string;
  partNo: number;
  segments: RetroTranscriptSegment[];
  /** 因为超出字数上限（RETRO_LIMITS.reviewTranscriptCharsPerCase / summaryTranscriptChars）而省略的片段数。 */
  omittedSegments?: number;
};

export type RetroSnapshotCase = {
  caseId: string;
  /** 冻结的「案例 N」序号。 */
  number: number;
  department: string;
  clientName: string;
  title: string;
  sceneTags: string[];
  background: string;
  outcome: string;
  turningPoints: string;
  discussionQuestions: string;
  rounds: RetroSnapshotRound[];
  clientAudio: RetroSnapshotClientAudio[];
  /** READY 的点评录音，按段号。为空 = 这个案例不参与提炼。 */
  recordings: RetroSnapshotRecording[];
};

export type RetroGenerateSnapshot = {
  kind: "GENERATE";
  monthKey: string;
  capturedAt: string;
  /** 当月全部案例（含已删除）的冻结序号。 */
  caseNumbers: Record<string, number>;
  /** 生成那一刻未删除的案例，按序号升序。 */
  cases: RetroSnapshotCase[];
  summaryRecordings: RetroSnapshotRecording[];
};

export type RetroRevisionSnapshot = {
  kind: "REVISION";
  monthKey: string;
  publicationId: string;
  versionNumber: number;
  cases: RetroStoredPublicationCases;
  quotes: RetroStoredQuotes;
};

export type RetroMonthSnapshot = RetroGenerateSnapshot | RetroRevisionSnapshot;

export function parseRetroSnapshot(value: unknown): RetroMonthSnapshot | null {
  const raw = typeof value === "string" ? safeJsonParse(value) : value;
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "GENERATE" || kind === "REVISION") return raw as RetroMonthSnapshot;
  return null;
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseJsonColumn<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") return safeJsonParse(value) as T | null;
  return value as T;
}

export const isAnalyzedCase = (item: RetroSnapshotCase) => item.recordings.some((recording) => recording.segments.length > 0);

export function analyzedCases(snapshot: RetroGenerateSnapshot): RetroSnapshotCase[] {
  return snapshot.cases.filter(isAnalyzedCase);
}

// ---------------------------------------------------------------------------
// 片段编号：一个案例的多段点评录音按段号拼成一份文字稿，模型看到的是连续编号 1..N
// ---------------------------------------------------------------------------

export type RetroSegmentRef = { n: number; recordingId: string; partNo: number; segment: RetroTranscriptSegment };

export function recordingSegmentIndex(recordings: readonly RetroSnapshotRecording[]): RetroSegmentRef[] {
  const refs: RetroSegmentRef[] = [];
  const ordered = [...recordings].sort((a, b) => a.partNo - b.partNo);
  for (const recording of ordered) {
    const segments = [...recording.segments].sort((a, b) => a.id - b.id);
    for (const segment of segments) {
      refs.push({ n: refs.length + 1, recordingId: recording.recordingId, partNo: recording.partNo, segment });
    }
  }
  return refs;
}

export const caseSegmentIndex = (item: RetroSnapshotCase) => recordingSegmentIndex(item.recordings);

/** 每案客户录音合计不超过 3 万字：按「需求凭证 → 第 1 回合 → …」和时间顺序装入，超出部分省略并记数。 */
export function truncateClientAudio(
  list: ReadonlyArray<Omit<RetroSnapshotClientAudio, "omittedSegments">>,
  maxChars: number = RETRO_LIMITS.clientTranscriptCharsPerCase,
): RetroSnapshotClientAudio[] {
  let used = 0;
  let full = false;
  return list.map((audio) => {
    const kept: RetroTranscriptSegment[] = [];
    let omitted = 0;
    for (const segment of [...audio.segments].sort((a, b) => a.startMs - b.startMs || a.id - b.id)) {
      const length = [...segment.text].length;
      if (!full && used + length <= maxChars) {
        kept.push(segment);
        used += length;
      } else {
        full = true;
        omitted += 1;
      }
    }
    return { ...audio, segments: kept, omittedSegments: omitted };
  });
}

/**
 * 点评录音（每案各段合计）、整场总结（各段合计）进提示词的字数上限：按段号、再按时间装入，超出部分省略并记数。
 * 省略的片段不进快照，所以模型引用不到、校验也认不出它们。
 */
export function truncateRecordings(list: readonly RetroSnapshotRecording[], maxChars: number): RetroSnapshotRecording[] {
  let used = 0;
  let full = false;
  return [...list].sort((a, b) => a.partNo - b.partNo).map((recording) => {
    const kept: RetroTranscriptSegment[] = [];
    let omitted = 0;
    for (const segment of [...recording.segments].sort((a, b) => a.startMs - b.startMs || a.id - b.id)) {
      const length = [...segment.text].length;
      if (!full && used + length <= maxChars) {
        kept.push(segment);
        used += length;
      } else {
        full = true;
        omitted += 1;
      }
    }
    return omitted ? { ...recording, segments: kept, omittedSegments: omitted } : { ...recording, segments: kept };
  });
}

// ---------------------------------------------------------------------------
// 哈希：逐案缓存与任务输入哈希
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * 案例输入哈希（规格 6.3 缓存）：案例的全部输入 + 模型 + 提炼提示词版本。不含冻结序号——
 * 提示词里不出现序号，序号变了不影响提炼结果。
 */
export function hashRetroCaseInput(item: RetroSnapshotCase, options: { model: string; promptVersion: string }): string {
  const { number: _number, ...rest } = item;
  void _number;
  return sha256(stableStringify({ case: rest, model: options.model, promptVersion: options.promptVersion }));
}

export function hashRetroSnapshot(snapshot: RetroMonthSnapshot, extra: Record<string, unknown> = {}): string {
  const { capturedAt: _capturedAt, ...rest } = snapshot as RetroGenerateSnapshot;
  void _capturedAt;
  return sha256(stableStringify({ snapshot: rest, ...extra }));
}

// ---------------------------------------------------------------------------
// 说话人称呼与引文
// ---------------------------------------------------------------------------

/** 「说话人 N」：S0 → 说话人 1。 */
export function defaultSpeakerLabel(speakerId: string): string {
  const match = /^S(\d+)$/.exec(speakerId);
  return match ? `说话人 ${Number(match[1]) + 1}` : speakerId || "说话人";
}

export type RetroQuoteResolver = {
  recording(recordingId: string): { segments: RetroTranscriptSegment[]; labels: Record<string, string> | null } | null;
  clientAudio(assetId: string): { segments: RetroTranscriptSegment[] } | null;
};

/** 按出处里的片段号从转写里取原文（引文永远由服务端取，不用模型写的文字，规格三-1）。 */
export function buildRetroQuotes(sources: readonly RetroSource[], resolver: RetroQuoteResolver): Record<string, RetroQuotedSegment[]> {
  const wanted = new Map<string, { source: RetroSource; ids: Set<number> }>();
  for (const source of sources) {
    const key = source.kind === "REVIEW" ? `R:${source.recordingId}` : `C:${source.assetId}`;
    const entry = wanted.get(key) ?? { source, ids: new Set<number>() };
    for (const id of source.segmentIds) entry.ids.add(id);
    wanted.set(key, entry);
  }
  const result: Record<string, RetroQuotedSegment[]> = {};
  for (const [key, { source, ids }] of wanted) {
    const review = source.kind === "REVIEW" ? resolver.recording(source.recordingId) : null;
    const resolved = source.kind === "REVIEW" ? review : resolver.clientAudio(source.assetId);
    if (!resolved) continue;
    const labels = review?.labels ?? null;
    const quotes = resolved.segments
      .filter((segment) => ids.has(segment.id))
      .sort((a, b) => a.id - b.id)
      .map((segment) => ({
        segmentId: segment.id,
        startMs: segment.startMs,
        speakerLabel: labels?.[segment.speakerId] ?? defaultSpeakerLabel(segment.speakerId),
        text: segment.text,
      }));
    if (quotes.length) result[key] = quotes;
  }
  return result;
}

/** 出处标记要用的录音信息：录音 id → { 案例、序号、段号、段数 }。 */
export function snapshotRecordingRefs(snapshot: RetroGenerateSnapshot): RetroStoredQuotes["recordingRefs"] {
  const refs: RetroStoredQuotes["recordingRefs"] = {};
  for (const item of snapshot.cases) {
    for (const recording of item.recordings) {
      refs[recording.recordingId] = { caseId: item.caseId, caseNumber: item.number, partNo: recording.partNo, partCount: item.recordings.length };
    }
  }
  for (const recording of snapshot.summaryRecordings) {
    refs[recording.recordingId] = { caseId: null, caseNumber: null, partNo: recording.partNo, partCount: snapshot.summaryRecordings.length };
  }
  return refs;
}
