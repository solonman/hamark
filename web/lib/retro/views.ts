// 库里的行 → 给前端的视图：附件、回合、关联作品、点评录音。读多写少，不改库。

import type { DbClient, QueryResultRow } from "@/db";
import { isoOrNull } from "@/lib/audio-review/view";
import {
  RETRO_LINK_KIND_LABELS,
  type RetroAssetType,
  type RetroAssetView,
  type RetroDocFormat,
  type RetroDocPageView,
  type RetroLinkKind,
  type RetroLinkView,
  type RetroRecordingStatus,
  type RetroRecordingView,
  type RetroRoundView,
  type RetroTranscribeStatus,
  friendlyRetroPreviewError,
} from "@/lib/retro-model";
import { VISUAL_SUBDOMAIN_SPECS, isVisualSubdomain } from "@/lib/visual-contract";
import type { VideoBucket } from "@/storage/types";
import { retroDocPagesFromStored } from "./doc-preview";
import { retroAssetStreamPath, retroRecordingAudioPath } from "./keys";
import { retroSegmentsFromStored } from "./transcription";

export const RETRO_SIGNED_URL_TTL_SECONDS = 3 * 60 * 60;

type SigningBucket = Pick<VideoBucket, "createPresignedGetUrl">;

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

export const RETRO_ASSET_COLUMNS = `id, case_id, round_id, type, doc_format, position, object_key, thumbnail_key, display_key,
  original_name, content_type, file_size, width, height, duration_seconds, upload_status, derivative_status,
  derivative_error, transcribe_status, transcribe_fail_reason, audio_duration_ms, transcript_json, page_count, pages_json`;

export type RetroAssetRow = QueryResultRow & {
  id: string;
  case_id: string;
  round_id: string | null;
  type: string;
  doc_format: string | null;
  position: number;
  object_key: string;
  thumbnail_key: string | null;
  display_key: string | null;
  original_name: string;
  content_type: string;
  file_size: number | string;
  width: number;
  height: number;
  duration_seconds: number;
  upload_status: string;
  derivative_status: string;
  derivative_error: string | null;
  transcribe_status: string;
  transcribe_fail_reason: string | null;
  audio_duration_ms: number | null;
  transcript_json: unknown;
  page_count: number | null;
  pages_json: unknown;
};

/** 文档逐页预览的签名地址：15 分钟（同视频、音频的站内播放）。详情页打开弹层前会按需刷新。 */
export const RETRO_PAGE_URL_TTL_SECONDS = 15 * 60;

async function buildRetroDocPages(bucket: SigningBucket, row: RetroAssetRow): Promise<RetroDocPageView[]> {
  if (row.derivative_status !== "READY") return [];
  const sign = (key: string | null) => (key ? bucket.createPresignedGetUrl(key, { expiresInSeconds: RETRO_PAGE_URL_TTL_SECONDS }) : null);
  return Promise.all(retroDocPagesFromStored(row.pages_json, row.case_id, row.id).map(async (page) => {
    const [thumbUrl, largeUrl] = await Promise.all([sign(page.thumbKey), sign(page.largeKey)]);
    return { pageNo: page.pageNo, ok: page.ok, thumbUrl, largeUrl };
  }));
}

export async function buildRetroAssetViews(bucket: SigningBucket, rows: readonly RetroAssetRow[]): Promise<RetroAssetView[]> {
  return Promise.all(rows.map(async (row): Promise<RetroAssetView> => {
    const type = row.type as RetroAssetType;
    const [thumbnailUrl, displayUrl] = await Promise.all([
      row.thumbnail_key ? bucket.createPresignedGetUrl(row.thumbnail_key, { expiresInSeconds: RETRO_SIGNED_URL_TTL_SECONDS }) : null,
      row.display_key ? bucket.createPresignedGetUrl(row.display_key, { expiresInSeconds: RETRO_SIGNED_URL_TTL_SECONDS }) : null,
    ]);
    const transcribeStatus = row.transcribe_status as RetroTranscribeStatus;
    return {
      id: row.id,
      roundId: row.round_id,
      type,
      docFormat: (row.doc_format as RetroDocFormat | null) ?? null,
      position: Number(row.position),
      originalName: row.original_name,
      contentType: row.content_type,
      fileSize: Number(row.file_size),
      width: Number(row.width),
      height: Number(row.height),
      durationSeconds: Number(row.duration_seconds),
      uploadStatus: row.upload_status === "READY" ? "READY" : "UPLOADING",
      derivativeStatus: row.derivative_status as RetroAssetView["derivativeStatus"],
      derivativeError: friendlyRetroPreviewError(row.derivative_error),
      thumbnailUrl,
      displayUrl,
      streamUrl: retroAssetStreamPath(row.case_id, row.id, type),
      pages: type === "DOC" ? await buildRetroDocPages(bucket, row) : null,
      transcribe: type === "AUDIO"
        ? {
            status: transcribeStatus,
            failReason: row.transcribe_fail_reason,
            durationMs: row.audio_duration_ms === null ? null : Number(row.audio_duration_ms),
            segments: transcribeStatus === "READY" ? retroSegmentsFromStored(row.transcript_json) : null,
          }
        : null,
    };
  }));
}

// ---------------------------------------------------------------------------
// 关联作品：把三个库的条目解析成小卡片（规格 4.4）
// ---------------------------------------------------------------------------

export type RetroLinkRow = { round_id: string; target_kind: string; target_id: string; position: number };

type LinkTarget = { title: string; subtitle: string; thumbnailKey: string | null; deleted: boolean; href: string };

const linkKey = (kind: string, id: string) => `${kind}:${id}`;

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 直接查 videos / reports / visual_cases；缺的条目（物理上不存在）不在返回里，按「已删除」处理。 */
export async function fetchRetroLinkTargets(
  db: DbClient,
  pairs: ReadonlyArray<{ kind: RetroLinkKind; targetId: string }>,
): Promise<Map<string, LinkTarget>> {
  const byKind = new Map<RetroLinkKind, string[]>();
  for (const pair of pairs) byKind.set(pair.kind, [...(byKind.get(pair.kind) ?? []), pair.targetId]);
  const result = new Map<string, LinkTarget>();

  const videoIds = byKind.get("VIDEO");
  if (videoIds?.length) {
    const rows = await db.prepare(
      `SELECT v.id, v.title, v.brand, v.status, v.deleted_at,
              to_jsonb(v)->>'thumbnail_key' AS thumbnail_key, to_jsonb(v)->>'deletion_state' AS deletion_state
       FROM videos v WHERE v.id IN (${placeholders(videoIds.length)})`,
    ).bind(...videoIds).all<QueryResultRow & {
      id: string; title: string; brand: string | null; status: string; deleted_at: unknown;
      thumbnail_key: string | null; deletion_state: string | null;
    }>();
    for (const row of rows.results) {
      const deleted = Boolean(row.deleted_at) || row.deletion_state === "TRASHED" || row.deletion_state === "ASSET_PURGED";
      result.set(linkKey("VIDEO", row.id), {
        title: row.title,
        subtitle: row.brand ?? "",
        thumbnailKey: row.status === "READY" ? row.thumbnail_key : null,
        deleted,
        href: `/videos/${row.id}`,
      });
    }
  }

  const reportIds = byKind.get("REPORT");
  if (reportIds?.length) {
    const [rows, covers] = await Promise.all([
      db.prepare(`SELECT id, title, task_type, status, deleted_at FROM reports WHERE id IN (${placeholders(reportIds.length)})`)
        .bind(...reportIds).all<QueryResultRow & { id: string; title: string; task_type: string | null; status: string; deleted_at: unknown }>(),
      db.prepare(
        `SELECT DISTINCT ON (report_id) report_id, thumb_key FROM report_pages
         WHERE report_id IN (${placeholders(reportIds.length)}) AND render_status = 'OK'
         ORDER BY report_id, page_no ASC`,
      ).bind(...reportIds).all<QueryResultRow & { report_id: string; thumb_key: string }>(),
    ]);
    const coverByReport = new Map(covers.results.map((row) => [row.report_id, row.thumb_key]));
    for (const row of rows.results) {
      result.set(linkKey("REPORT", row.id), {
        title: row.title,
        subtitle: row.task_type ?? "",
        thumbnailKey: row.status === "READY" ? coverByReport.get(row.id) ?? null : null,
        deleted: Boolean(row.deleted_at),
        href: `/reports/${row.id}`,
      });
    }
  }

  const visualIds = byKind.get("VISUAL");
  if (visualIds?.length) {
    const [rows, covers] = await Promise.all([
      db.prepare(`SELECT id, title, subdomain, deleted_at FROM visual_cases WHERE id IN (${placeholders(visualIds.length)})`)
        .bind(...visualIds).all<QueryResultRow & { id: string; title: string; subdomain: string; deleted_at: unknown }>(),
      db.prepare(
        `SELECT DISTINCT ON (case_id) case_id, thumbnail_key FROM visual_case_assets
         WHERE case_id IN (${placeholders(visualIds.length)}) AND upload_status = 'READY' AND thumbnail_key IS NOT NULL
         ORDER BY case_id, position ASC`,
      ).bind(...visualIds).all<QueryResultRow & { case_id: string; thumbnail_key: string }>(),
    ]);
    const coverByCase = new Map(covers.results.map((row) => [row.case_id, row.thumbnail_key]));
    for (const row of rows.results) {
      result.set(linkKey("VISUAL", row.id), {
        title: row.title,
        subtitle: isVisualSubdomain(row.subdomain) ? VISUAL_SUBDOMAIN_SPECS[row.subdomain].label : "",
        thumbnailKey: coverByCase.get(row.id) ?? null,
        deleted: Boolean(row.deleted_at),
        href: `/visual/${row.id}`,
      });
    }
  }
  return result;
}

export async function buildRetroLinkViews(
  db: DbClient,
  bucket: SigningBucket,
  rows: ReadonlyArray<Pick<RetroLinkRow, "target_kind" | "target_id">>,
): Promise<RetroLinkView[]> {
  if (rows.length === 0) return [];
  const pairs = rows.map((row) => ({ kind: row.target_kind as RetroLinkKind, targetId: row.target_id }));
  const targets = await fetchRetroLinkTargets(db, pairs);
  return Promise.all(pairs.map(async (pair): Promise<RetroLinkView> => {
    const target = targets.get(linkKey(pair.kind, pair.targetId));
    // 原作品被删除（或物理上不存在）：关联本身保留，卡片显示「原作品已删除」，没有链接。
    if (!target || target.deleted) {
      return {
        kind: pair.kind,
        targetId: pair.targetId,
        title: target?.title ?? "原作品已删除",
        subtitle: RETRO_LINK_KIND_LABELS[pair.kind],
        thumbnailUrl: null,
        href: null,
        deleted: true,
      };
    }
    return {
      kind: pair.kind,
      targetId: pair.targetId,
      title: target.title,
      subtitle: target.subtitle,
      thumbnailUrl: target.thumbnailKey
        ? await bucket.createPresignedGetUrl(target.thumbnailKey, { expiresInSeconds: RETRO_SIGNED_URL_TTL_SECONDS })
        : null,
      href: target.href,
      deleted: false,
    };
  }));
}

// ---------------------------------------------------------------------------
// 回合
// ---------------------------------------------------------------------------

export type RetroRoundRow = QueryResultRow & {
  id: string;
  position: number;
  title: string;
  occurred_on: string;
  delivery_text: string;
  feedback_text: string;
  response_text: string;
  revision: number;
};

export const RETRO_ROUND_COLUMNS = "id, position, title, occurred_on, delivery_text, feedback_text, response_text, revision";

export function toRetroRoundView(row: RetroRoundRow, assets: RetroAssetView[], links: RetroLinkView[]): RetroRoundView {
  return {
    id: row.id,
    position: Number(row.position),
    title: row.title,
    occurredOn: row.occurred_on,
    deliveryText: row.delivery_text,
    feedbackText: row.feedback_text,
    responseText: row.response_text,
    revision: Number(row.revision),
    assets,
    links,
  };
}

// ---------------------------------------------------------------------------
// 点评录音
// ---------------------------------------------------------------------------

export const RETRO_RECORDING_COLUMNS = `id, month_key, case_id, part_no, status, fail_reason, audio_object_key, audio_file_name,
  audio_content_type, audio_size_bytes, audio_duration_ms, transcript_json, speaker_labels_json,
  uploaded_by_user_id, uploaded_by_name, lease_until, created_at`;

export type RetroRecordingRow = QueryResultRow & {
  id: string;
  month_key: string;
  case_id: string | null;
  part_no: number;
  status: string;
  fail_reason: string | null;
  audio_object_key: string;
  audio_file_name: string;
  audio_content_type: string;
  audio_size_bytes: number | string;
  audio_duration_ms: number | null;
  transcript_json: unknown;
  speaker_labels_json: unknown;
  uploaded_by_user_id: string;
  uploaded_by_name: string;
  lease_until: unknown;
  created_at: unknown;
};

function labelsOf(value: unknown): Record<string, string> | null {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : null;
}

export function toRetroRecordingView(row: RetroRecordingRow, canRemove: boolean): RetroRecordingView {
  const status = row.status as RetroRecordingStatus;
  return {
    id: row.id,
    monthKey: row.month_key,
    caseId: row.case_id,
    partNo: Number(row.part_no),
    status,
    failReason: row.fail_reason,
    fileName: row.audio_file_name,
    sizeBytes: Number(row.audio_size_bytes),
    durationMs: row.audio_duration_ms === null ? null : Number(row.audio_duration_ms),
    audioUrl: retroRecordingAudioPath(row.id),
    uploadedByName: row.uploaded_by_name,
    createdAt: isoOrNull(row.created_at) ?? "",
    canRemove,
    // 转写完才有文字稿（READY）；被移除的录音如果已经转完，文字稿照样给（已发布成果的出处要能打开）。
    segments: row.transcript_json ? retroSegmentsFromStored(row.transcript_json) : null,
    speakerLabels: labelsOf(row.speaker_labels_json),
  };
}
