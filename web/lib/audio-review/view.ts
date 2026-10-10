// 库里的点评任务行 → 给前端的 AudioReviewView / V19AudioReviewSummary（docs/25 4.8）。
// 可见性也在这里：老孙看得到任何状态；其他人只看得到已生成的点评。纯函数。

import type { QueryResultRow } from "@/db";
import {
  audioReviewStepOf,
  type AudioReviewFailedStep,
  type AudioReviewProposalView,
  type AudioReviewSegment,
  type AudioReviewStatus,
  type AudioReviewView,
  type V19AudioReviewSummary,
} from "@/lib/audio-review-model";
import { isCaseReviewer } from "@/lib/case-review";
import { isReviewerSegment, parseStoredProposal, type StoredAudioReviewProposal } from "./proposal";
import { dominantSpeaker, parseStoredTranscript, safeJson, type AudioReviewTranscriptSegment } from "./transcript";

export const AUDIO_REVIEW_COLUMN_LIST = [
  "id", "workspace_id", "video_id", "base_version_id", "base_version_number", "base_owner_name", "base_payload_json",
  "reviewer_user_id", "reviewer_name", "status", "failed_step", "fail_reason",
  "audio_object_key", "audio_file_name", "audio_content_type", "audio_size_bytes", "audio_duration_ms",
  "asr_engine", "asr_task_id", "asr_submitted_at", "asr_checked_at", "transcript_json",
  "llm_model", "prompt_version", "llm_attempts", "llm_started_at", "llm_finished_at", "llm_usage_json",
  "input_content_hash", "proposal_json", "selected_change_ids", "review_version_id", "lease_until",
  "created_at", "updated_at", "uploaded_at", "proposed_at", "confirmed_at", "abandoned_at",
] as const;

export const AUDIO_REVIEW_COLUMNS = AUDIO_REVIEW_COLUMN_LIST.join(", ");
export const AUDIO_REVIEW_COLUMNS_AR = AUDIO_REVIEW_COLUMN_LIST.map((column) => `ar.${column}`).join(", ");

type Timestamp = string | Date | null;

export type AudioReviewRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  video_id: string;
  base_version_id: string;
  base_version_number: number;
  base_owner_name: string;
  base_payload_json: unknown;
  reviewer_user_id: string;
  reviewer_name: string;
  status: AudioReviewStatus;
  failed_step: AudioReviewFailedStep | null;
  fail_reason: string | null;
  audio_object_key: string;
  audio_file_name: string;
  audio_content_type: string;
  audio_size_bytes: number | string;
  audio_duration_ms: number | null;
  asr_engine: string | null;
  asr_task_id: string | null;
  asr_submitted_at: Timestamp;
  asr_checked_at: Timestamp;
  transcript_json: unknown;
  llm_model: string | null;
  prompt_version: string | null;
  llm_attempts: number;
  llm_started_at: Timestamp;
  llm_finished_at: Timestamp;
  llm_usage_json: unknown;
  input_content_hash: string | null;
  proposal_json: unknown;
  selected_change_ids: unknown;
  review_version_id: string | null;
  lease_until: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  uploaded_at: Timestamp;
  proposed_at: Timestamp;
  confirmed_at: Timestamp;
  abandoned_at: Timestamp;
  /** LEFT JOIN analysis_versions 带出来的点评版编号；没有 JOIN 时缺省。 */
  review_version_number?: number | null;
};

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export function parseSelectedChangeIds(value: unknown): string[] | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is string => typeof item === "string");
}

/** 老孙看得到任何状态；其他人只看得到已生成的（docs/25 4.2 第 2 条）。 */
export function canViewAudioReview(viewerDisplayName: string, status: AudioReviewStatus) {
  return isCaseReviewer(viewerDisplayName) || status === "GENERATED";
}

export function audioReviewAudioPath(videoId: string, reviewId: string) {
  return `/api/videos/${encodeURIComponent(videoId)}/audio-reviews/${encodeURIComponent(reviewId)}/audio`;
}

/**
 * 每段话的说话人显示名与「是不是老孙」。以模型按内容逐段的判断为准（转写的说话人标签不可靠，
 * 通用引擎会把所有人都标成 S0）；还没有提案、或模型没给逐段判断时才按标签：
 * 老孙 / 模型认出的名字 / 其他人 A、B…（按出场顺序）。
 */
export function audioReviewSpeakerNames(
  segments: readonly AudioReviewTranscriptSegment[],
  proposal: Pick<StoredAudioReviewProposal, "speakers"> | null,
  reviewerName: string,
) {
  type SegmentRef = Pick<AudioReviewTranscriptSegment, "id" | "speakerId">;
  const judgement = proposal?.speakers ?? null;
  if (judgement?.others) {
    const bySegment = new Map(judgement.others.map((entry) => [entry.segmentId, entry.speaker]));
    return {
      isReviewer: (segment: SegmentRef) => isReviewerSegment(segment, judgement),
      nameOf: (segment: SegmentRef) => bySegment.get(segment.id) ?? reviewerName,
    };
  }
  const reviewer = judgement?.reviewer ?? dominantSpeaker(segments);
  const labels = judgement?.labels ?? {};
  const names = new Map<string, string>();
  let letter = 0;
  for (const segment of segments) {
    if (names.has(segment.speakerId)) continue;
    if (segment.speakerId === reviewer) names.set(segment.speakerId, reviewerName);
    else if (labels[segment.speakerId]) names.set(segment.speakerId, labels[segment.speakerId]);
    else names.set(segment.speakerId, `其他人 ${String.fromCharCode(65 + (letter++ % 26))}`);
  }
  return {
    isReviewer: (segment: SegmentRef) => segment.speakerId === reviewer,
    nameOf: (segment: SegmentRef) => names.get(segment.speakerId) ?? segment.speakerId,
  };
}

function correctedText(text: string, corrections: readonly { from: string; to: string }[]) {
  return corrections.reduce((result, correction) => result.split(correction.from).join(correction.to), text);
}

export function toAudioReviewView(row: AudioReviewRow, options: { viewerDisplayName: string }): AudioReviewView {
  // 兜底：未生成的任务，提案与文字稿只给老孙（路由层已经对其他人回 404，这里再守一道）。
  const restricted = !canViewAudioReview(options.viewerDisplayName, row.status);
  const stored = restricted ? null : parseStoredProposal(row.proposal_json);
  const transcript = restricted ? null : parseStoredTranscript(row.transcript_json);
  const selected = parseSelectedChangeIds(row.selected_change_ids);
  const segments = transcript?.segments ?? [];
  const speakers = audioReviewSpeakerNames(segments, stored, row.reviewer_name);

  const viewSegments: AudioReviewSegment[] = segments.map((segment) => {
    const corrections = (stored?.corrections ?? [])
      .filter((item) => item.segmentId === segment.id)
      .map(({ from, to }) => ({ from, to }));
    return {
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      speaker: speakers.nameOf(segment),
      isReviewer: speakers.isReviewer(segment),
      text: correctedText(segment.text, corrections),
      corrections,
    };
  });
  const segmentById = new Map(viewSegments.map((segment) => [segment.id, segment]));

  let proposal: AudioReviewProposalView | null = null;
  if (stored) {
    // 完整提案（不含 dropped）。待确认的提案只有老孙拿得到——其他人在 GENERATED 之前根本看不到
    // 这条任务（loadAudioReviewForViewer 回 404）；生成之后点评版录音卡对所有人展示意见清单，
    // 「落实了几处」由前端拿 changeIds 与 selectedChangeIds 求交得出。
    proposal = {
      opinions: stored.opinions,
      changes: stored.changes,
      unaddressed: stored.unaddressed.map((entry) => {
        const found = entry.segmentIds.map((id) => segmentById.get(id)).filter((segment): segment is AudioReviewSegment => Boolean(segment));
        return {
          segmentIds: entry.segmentIds,
          startMs: found.length ? Math.min(...found.map((segment) => segment.startMs)) : 0,
          speaker: found[0]?.speaker ?? "",
          text: found.map((segment) => segment.text).join(" "),
          reason: entry.reason,
        };
      }),
      model: row.llm_model ?? null,
      promptVersion: row.prompt_version ?? null,
    };
  }

  return {
    id: row.id,
    videoId: row.video_id,
    baseVersionId: row.base_version_id,
    baseVersionNumber: Number(row.base_version_number),
    baseOwnerName: row.base_owner_name,
    reviewerName: row.reviewer_name,
    status: row.status,
    failedStep: row.failed_step ?? null,
    failReason: row.fail_reason ?? null,
    step: audioReviewStepOf(row.status, row.failed_step ?? null),
    audio: {
      fileName: row.audio_file_name,
      sizeBytes: Number(row.audio_size_bytes),
      durationMs: row.audio_duration_ms === null || row.audio_duration_ms === undefined ? null : Number(row.audio_duration_ms),
      url: audioReviewAudioPath(row.video_id, row.id),
    },
    transcript: transcript ? { segments: viewSegments } : null,
    proposal,
    selectedChangeIds: selected,
    reviewVersionId: row.review_version_id ?? null,
    reviewVersionNumber: row.review_version_number === null || row.review_version_number === undefined
      ? null
      : Number(row.review_version_number),
    createdAt: isoOrNull(row.created_at) ?? "",
    updatedAt: isoOrNull(row.updated_at) ?? "",
    confirmedAt: isoOrNull(row.confirmed_at),
  };
}

export type AudioReviewSummaryRow = QueryResultRow & {
  id: string;
  base_version_id: string;
  status: AudioReviewStatus;
  failed_step: AudioReviewFailedStep | null;
  fail_reason: string | null;
  proposal_change_count: number | string | null;
  selected_change_count: number | string | null;
  review_version_id: string | null;
  review_version_number: number | null;
};

export function toAudioReviewSummary(row: AudioReviewSummaryRow): V19AudioReviewSummary {
  const changeCount = row.status === "GENERATED"
    ? Number(row.selected_change_count ?? 0)
    : row.status === "PENDING_CONFIRM" ? Number(row.proposal_change_count ?? 0) : 0;
  return {
    id: row.id,
    baseVersionId: row.base_version_id,
    status: row.status,
    step: audioReviewStepOf(row.status, row.failed_step ?? null),
    failReason: row.fail_reason ?? null,
    changeCount,
    reviewVersionId: row.review_version_id ?? null,
    reviewVersionNumber: row.review_version_number === null || row.review_version_number === undefined
      ? null
      : Number(row.review_version_number),
  };
}
