// 案例附件（规格 4.3、九）：需求凭证（round_id 为空）和回合附件同表同规则。
// 建附件行 → 用到哪个签哪个（600 秒）→ complete 用 head() 核对 → 图片出派生图。
// 移除是真删（行和对象一并删，规格 4.3 / docs/22 决定 #20）。结构照 lib/visual-server.ts。
//
// 客户录音（AUDIO）传完自动进入转写（lib/retro/transcription.ts）；这里只负责把状态置为 TRANSCRIBING，
// 推进由路由用 after() 触发。

import type { DbClient, QueryResultRow } from "@/db";
import { audioReviewContentType } from "@/lib/audio-review-model";
import {
  type RetroAssetType,
  type RetroTranscriptResponse,
  type RetroTranscribeStatus,
  type RetroUploadUrlResponse,
} from "@/lib/retro-model";
import { formatVisualOversizeReason, isOversizedForVisualDerivative } from "@/lib/visual-model";
import type { VideoBucket } from "@/storage/types";
import { canEditRetroCase, type RetroViewer } from "./access";
import { loadRetroCaseHead, requireEditableRetroCase, touchRetroCase } from "./case-head";
import { retroConflict, retroInvalid, retroNotFound } from "./errors";
import {
  retroAssetCoverKey,
  retroAssetDisplayKey,
  retroAssetOriginalKey,
  retroAssetThumbKey,
  retroNewId,
} from "./keys";
import { retroSegmentsFromStored, startRetroTranscription } from "./transcription";
import { assertRetroAssetCapacity, validateRetroNewAssets } from "./validate";

export const RETRO_UPLOAD_URL_TTL_SECONDS = 600;
export const RETRO_STREAM_URL_TTL_SECONDS = 15 * 60;
export const RETRO_ORIGINAL_URL_TTL_SECONDS = 3 * 60 * 60;

type Editor = Pick<RetroViewer, "userId" | "isAdmin">;

// ---------------------------------------------------------------------------
// 追加附件
// ---------------------------------------------------------------------------

export async function addRetroAssets(db: DbClient, viewer: Editor, caseId: string, body: unknown): Promise<{ assetIds: string[] }> {
  const assets = validateRetroNewAssets(body);
  const assetIds = assets.map(() => retroNewId("rta"));
  await db.withTransaction(async (tx) => {
    // 锁案例行：同一案例上并发追加附件时，数量上限和 position 才不会算岔。
    await requireEditableRetroCase(tx, caseId, viewer, { lock: true });

    const rounds = await tx.prepare(`SELECT id, title FROM retro_case_rounds WHERE case_id = ? AND deleted_at IS NULL`)
      .bind(caseId).all<QueryResultRow & { id: string; title: string }>();
    const roundTitle = new Map(rounds.results.map((round) => [round.id, round.title]));
    for (const asset of assets) {
      if (asset.roundId && !roundTitle.has(asset.roundId)) throw retroInvalid("附件所属的回合不存在或已删除，请刷新后重试。");
    }

    const existing = await tx.prepare(
      `SELECT round_id, COUNT(*)::integer AS total, COALESCE(MAX(position), -1)::integer AS max_position
       FROM retro_case_assets WHERE case_id = ? GROUP BY round_id`,
    ).bind(caseId).all<QueryResultRow & { round_id: string | null; total: number; max_position: number }>();
    const counts = new Map(existing.results.map((row) => [row.round_id ?? "NEED", Number(row.total)]));
    const nextPosition = new Map(existing.results.map((row) => [row.round_id ?? "NEED", Number(row.max_position) + 1]));
    assertRetroAssetCapacity(counts, assets, (key) => (key === "NEED" ? "「任务与最初需求」" : `「${roundTitle.get(key) ?? "这个回合"}」`));

    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const ownerKey = asset.roundId ?? "NEED";
      const position = nextPosition.get(ownerKey) ?? 0;
      nextPosition.set(ownerKey, position + 1);
      await tx.prepare(
        `INSERT INTO retro_case_assets (
           id, case_id, round_id, type, doc_format, position, object_key, original_name, content_type, file_size,
           width, height, duration_seconds, upload_status, derivative_status, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', 'PENDING', ?)`,
      ).bind(
        assetIds[index], caseId, asset.roundId, asset.type, asset.docFormat, position,
        retroAssetOriginalKey(caseId, assetIds[index], asset.originalName), asset.originalName, asset.contentType,
        asset.fileSize, asset.width, asset.height, asset.durationSeconds, viewer.userId,
      ).run();
    }
    await touchRetroCase(tx, caseId);
  });
  return { assetIds };
}

// ---------------------------------------------------------------------------
// 签上传链接
// ---------------------------------------------------------------------------

export async function signRetroAssetUpload(
  db: DbClient,
  bucket: Pick<VideoBucket, "createPresignedPutUrl">,
  viewer: Editor,
  caseId: string,
  assetId: string,
): Promise<RetroUploadUrlResponse> {
  await requireEditableRetroCase(db, caseId, viewer);
  const row = await db.prepare(
    `SELECT id, type, object_key, content_type, upload_status FROM retro_case_assets WHERE id = ? AND case_id = ?`,
  ).bind(assetId, caseId).first<QueryResultRow & { id: string; type: string; object_key: string; content_type: string; upload_status: string }>();
  if (!row) throw retroNotFound("附件不存在。");
  if (row.upload_status !== "UPLOADING") throw retroConflict("ASSET_ALREADY_UPLOADED", "这个附件已经上传完成，无需再次签名。");

  const uploadUrl = await bucket.createPresignedPutUrl(row.object_key, {
    contentType: row.content_type || "application/octet-stream",
    expiresInSeconds: RETRO_UPLOAD_URL_TTL_SECONDS,
  });
  const coverUploadUrl = row.type === "VIDEO"
    ? await bucket.createPresignedPutUrl(retroAssetCoverKey(caseId, row.id), {
        contentType: "image/jpeg",
        expiresInSeconds: RETRO_UPLOAD_URL_TTL_SECONDS,
      })
    : null;
  return { uploadUrl, coverUploadUrl };
}

// ---------------------------------------------------------------------------
// 完成上传：head() 核对，缺的列出来
// ---------------------------------------------------------------------------

export type RetroCompleteOutcome = {
  /** 没核对到的附件 id（没传上或大小不符）。 */
  missing: string[];
  /** 这次新进入「转写中」的客户录音，路由要用 after() 推进它们。 */
  transcribingAssetIds: string[];
  /** 这次有图片进入 PENDING，路由在 ci 模式下要触发派生图。 */
  hasPendingImages: boolean;
};

type CompleteRow = QueryResultRow & { id: string; type: string; object_key: string; file_size: number | string; upload_status: string };

export async function completeRetroAssets(
  db: DbClient,
  bucket: Pick<VideoBucket, "head">,
  viewer: Editor,
  caseId: string,
  body: unknown,
): Promise<RetroCompleteOutcome> {
  await requireEditableRetroCase(db, caseId, viewer);
  const requested = (body && typeof body === "object" ? (body as { assetIds?: unknown }).assetIds : undefined) as unknown;
  if (requested !== undefined && (!Array.isArray(requested) || !requested.every((id) => typeof id === "string"))) {
    throw retroInvalid("附件列表的格式不对。");
  }
  const rows = (await db.prepare(
    `SELECT id, type, object_key, file_size, upload_status FROM retro_case_assets WHERE case_id = ? ORDER BY position ASC, created_at ASC`,
  ).bind(caseId).all<CompleteRow>()).results;
  const wanted = requested ? new Set(requested as string[]) : null;
  const targets = rows.filter((row) => (wanted ? wanted.has(row.id) : row.upload_status !== "READY"));

  const outcome: RetroCompleteOutcome = { missing: [], transcribingAssetIds: [], hasPendingImages: false };
  for (const asset of targets) {
    if (asset.upload_status === "READY") continue;
    const object = await bucket.head(asset.object_key);
    const registered = Number(asset.file_size) || 0;
    if (!object || object.size <= 0 || (registered > 0 && object.size !== registered)) {
      outcome.missing.push(asset.id);
      continue;
    }

    if (asset.type === "VIDEO") {
      const coverKey = retroAssetCoverKey(caseId, asset.id);
      const cover = await bucket.head(coverKey);
      if (cover && cover.size > 0) {
        await db.prepare(
          `UPDATE retro_case_assets SET upload_status = 'READY', file_size = ?, thumbnail_key = ?,
             derivative_status = 'READY', derivative_error = NULL, updated_at = now() WHERE id = ?`,
        ).bind(object.size, coverKey, asset.id).run();
      } else {
        await db.prepare(
          `UPDATE retro_case_assets SET upload_status = 'READY', file_size = ?, derivative_status = 'FAILED',
             derivative_error = ?, updated_at = now() WHERE id = ?`,
        ).bind(object.size, "浏览器没能截到这段视频的封面", asset.id).run();
      }
    } else if (asset.type === "IMAGE") {
      if (isOversizedForVisualDerivative(object.size)) {
        await db.prepare(
          `UPDATE retro_case_assets SET upload_status = 'READY', file_size = ?, derivative_status = 'FAILED',
             derivative_error = ?, updated_at = now() WHERE id = ?`,
        ).bind(object.size, formatVisualOversizeReason(object.size), asset.id).run();
      } else {
        await db.prepare(
          `UPDATE retro_case_assets SET upload_status = 'READY', file_size = ?, derivative_status = 'PENDING', updated_at = now() WHERE id = ?`,
        ).bind(object.size, asset.id).run();
        outcome.hasPendingImages = true;
      }
    } else {
      // AUDIO、DOC 没有派生图：直接就绪。
      await db.prepare(
        `UPDATE retro_case_assets SET upload_status = 'READY', file_size = ?, derivative_status = 'READY',
           derivative_error = NULL, updated_at = now() WHERE id = ?`,
      ).bind(object.size, asset.id).run();
      if (asset.type === "AUDIO" && (await startRetroTranscription(db, "ASSET", asset.id, ["NONE"]))) {
        outcome.transcribingAssetIds.push(asset.id);
      }
    }
  }
  await touchRetroCase(db, caseId);
  return outcome;
}

// ---------------------------------------------------------------------------
// 移除（真删）
// ---------------------------------------------------------------------------

export async function removeRetroAsset(
  db: DbClient,
  bucket: Pick<VideoBucket, "delete">,
  viewer: Editor,
  caseId: string,
  assetId: string,
): Promise<{ ok: true }> {
  const objectKeys = await db.withTransaction(async (tx) => {
    await requireEditableRetroCase(tx, caseId, viewer, { lock: true });
    const target = await tx.prepare(`SELECT id, round_id, object_key FROM retro_case_assets WHERE id = ? AND case_id = ?`)
      .bind(assetId, caseId).first<QueryResultRow & { id: string; round_id: string | null; object_key: string }>();
    if (!target) throw retroNotFound("附件不存在或已移除。");
    await tx.prepare(`DELETE FROM retro_case_assets WHERE id = ? AND case_id = ?`).bind(assetId, caseId).run();
    // 同一归属里剩下的重新排成 0..n-1。
    const siblings = await tx.prepare(
      `SELECT id FROM retro_case_assets WHERE case_id = ? AND ${target.round_id ? "round_id = ?" : "round_id IS NULL"} ORDER BY position ASC, created_at ASC`,
    ).bind(...(target.round_id ? [caseId, target.round_id] : [caseId])).all<QueryResultRow & { id: string }>();
    for (let index = 0; index < siblings.results.length; index += 1) {
      await tx.prepare(`UPDATE retro_case_assets SET position = ? WHERE id = ?`).bind(index, siblings.results[index].id).run();
    }
    await touchRetroCase(tx, caseId);
    return [
      target.object_key,
      retroAssetCoverKey(caseId, assetId),
      retroAssetThumbKey(caseId, assetId),
      retroAssetDisplayKey(caseId, assetId),
    ];
  });
  // 无论附件当时传到哪一步，这几个键有几个算几个：delete 对不存在的对象本身是幂等的。
  await Promise.all(objectKeys.map((key) => bucket.delete(key).catch(() => undefined)));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 打开：图片原图、PDF 内联、Office 下载（original）；视频、音频（stream）。302 到新签的地址。
// ---------------------------------------------------------------------------

type OpenRow = QueryResultRow & {
  id: string;
  type: string;
  doc_format: string | null;
  object_key: string;
  original_name: string;
  content_type: string;
  upload_status: string;
};

/** Content-Disposition 里文件名要同时给 ASCII 兜底和 UTF-8 编码版（RFC 6266）。 */
export function retroAttachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export async function resolveRetroAssetUrl(
  db: DbClient,
  bucket: Pick<VideoBucket, "createPresignedGetUrl">,
  input: { caseId: string; assetId: string; viewer: Editor; mode: "original" | "stream" },
): Promise<string> {
  const head = await loadRetroCaseHead(db, input.caseId);
  if (!head || head.deleted) throw retroNotFound("案例不存在或已进入回收站。");
  const canEdit = canEditRetroCase(head, input.viewer);
  const row = await db.prepare(
    `SELECT id, type, doc_format, object_key, original_name, content_type, upload_status FROM retro_case_assets WHERE id = ? AND case_id = ?`,
  ).bind(input.assetId, input.caseId).first<OpenRow>();
  if (!row || (!canEdit && row.upload_status !== "READY")) throw retroNotFound("附件不存在。");
  const type = row.type as RetroAssetType;
  const streamable = type === "VIDEO" || type === "AUDIO";
  if (input.mode === "stream" ? !streamable : streamable) throw retroNotFound("附件类型不对。");

  if (input.mode === "stream") {
    // 音频存进去的 Content-Type 可能是 application/octet-stream（浏览器给不出 MIME，常见于 .m4a / .amr），
    // <audio> 在个别浏览器里不认，播放时按扩展名补一个正确的。
    const audioType = type === "AUDIO" && !row.content_type.toLowerCase().startsWith("audio/")
      ? audioReviewContentType(row.original_name, row.content_type)
      : null;
    return bucket.createPresignedGetUrl(row.object_key, {
      expiresInSeconds: RETRO_STREAM_URL_TTL_SECONDS,
      ...(audioType ? { responseContentType: audioType } : {}),
    });
  }
  if (type === "DOC") {
    // PDF 在新标签页由浏览器打开；Word／Excel／PPT 点开是下载。存进去的 Content-Type 来自浏览器、不一定可靠，
    // 所以用 response-content-* 参数在响应头上覆盖。
    return row.doc_format === "PDF"
      ? bucket.createPresignedGetUrl(row.object_key, {
          expiresInSeconds: RETRO_ORIGINAL_URL_TTL_SECONDS,
          responseContentType: "application/pdf",
          responseContentDisposition: "inline",
        })
      : bucket.createPresignedGetUrl(row.object_key, {
          expiresInSeconds: RETRO_ORIGINAL_URL_TTL_SECONDS,
          responseContentDisposition: retroAttachmentDisposition(row.original_name || "附件"),
        });
  }
  return bucket.createPresignedGetUrl(row.object_key, { expiresInSeconds: RETRO_ORIGINAL_URL_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// 客户录音的转写状态
// ---------------------------------------------------------------------------

type TranscribeRow = QueryResultRow & {
  id: string;
  upload_status: string;
  transcribe_status: string;
  transcribe_fail_reason: string | null;
  audio_duration_ms: number | null;
  transcript_json: unknown;
  lease_until: unknown;
};

export async function loadRetroAssetTranscript(
  db: DbClient,
  input: { caseId: string; assetId: string; viewer: Editor },
): Promise<{ response: RetroTranscriptResponse; status: string; leaseUntil: unknown }> {
  const head = await loadRetroCaseHead(db, input.caseId);
  if (!head || head.deleted) throw retroNotFound("案例不存在或已进入回收站。");
  const row = await db.prepare(
    `SELECT id, upload_status, transcribe_status, transcribe_fail_reason, audio_duration_ms, transcript_json, lease_until
     FROM retro_case_assets WHERE id = ? AND case_id = ? AND type = 'AUDIO'`,
  ).bind(input.assetId, input.caseId).first<TranscribeRow>();
  if (!row || (!canEditRetroCase(head, input.viewer) && row.upload_status !== "READY")) throw retroNotFound("客户录音不存在。");
  const status = row.transcribe_status as RetroTranscribeStatus;
  return {
    response: {
      assetId: row.id,
      transcribe: {
        status,
        failReason: row.transcribe_fail_reason,
        durationMs: row.audio_duration_ms === null ? null : Number(row.audio_duration_ms),
        segments: status === "READY" ? retroSegmentsFromStored(row.transcript_json) : null,
      },
    },
    status,
    leaseUntil: row.lease_until,
  };
}

/** POST { action: "RETRY" }：只有转写失败的客户录音能重试。返回是否真的重新开始了。 */
export async function retryRetroAssetTranscription(db: DbClient, viewer: Editor, caseId: string, assetId: string): Promise<boolean> {
  await requireEditableRetroCase(db, caseId, viewer);
  const row = await db.prepare(
    `SELECT id, upload_status, transcribe_status FROM retro_case_assets WHERE id = ? AND case_id = ? AND type = 'AUDIO'`,
  ).bind(assetId, caseId).first<QueryResultRow & { id: string; upload_status: string; transcribe_status: string }>();
  if (!row) throw retroNotFound("客户录音不存在。");
  if (row.upload_status !== "READY" || row.transcribe_status !== "FAILED") {
    throw retroConflict("INVALID_STATE", "只有转写失败的客户录音可以重试。");
  }
  return startRetroTranscription(db, "ASSET", assetId, ["FAILED"]);
}
