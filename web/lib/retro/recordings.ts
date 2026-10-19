// 点评录音（规格 5、九）：案例录音最多 3 段，整场总结（case_id 为空）挂在月份上同样最多 3 段。
// 任何登录成员都能传；移除是软删除（行和对象都保留，已发布成果里的出处仍然能打开、能播放）。
// 状态：UPLOADING ──UPLOADED──▶ TRANSCRIBING ──▶ READY / FAILED ──RETRY──▶ TRANSCRIBING，任何状态可 REMOVE。
// 转写推进在 lib/retro/transcription.ts，和附件里的客户录音共用。

import type { DbClient, QueryResultRow } from "@/db";
import { RETRO_LIMITS, type RetroCreateRecordingResponse, type RetroRecordingView } from "@/lib/retro-model";
import type { VideoBucket } from "@/storage/types";
import { canRemoveRetroRecording, type RetroViewer } from "./access";
import { loadRetroCaseHead } from "./case-head";
import { RetroError, isUniqueViolation, retroConflict, retroForbidden, retroInvalid, retroNotFound } from "./errors";
import { retroRecordingObjectKey, retroNewId } from "./keys";
import { startRetroTranscription } from "./transcription";
import { RETRO_RECORDING_COLUMNS, toRetroRecordingView, type RetroRecordingRow } from "./views";
import { validateRetroRecordingAction, validateRetroRecordingRequest, type RetroRecordingActionName } from "./validate";
import type { RetroAsrKind } from "./asr";

export const RETRO_RECORDING_UPLOAD_URL_TTL_SECONDS = 900;
export const RETRO_RECORDING_AUDIO_URL_TTL_SECONDS = 3 * 60 * 60;

type Actor = Pick<RetroViewer, "userId" | "displayName" | "isAdmin">;

export function retroRecordingAsrKind(row: Pick<RetroRecordingRow, "case_id">): RetroAsrKind {
  return row.case_id ? "REVIEW" : "SUMMARY";
}

/** 取这个归属（案例或月份总结）里最小的空闲段号 1..3；占满了返回 null。已移除的段号可以复用。 */
export function nextRetroPartNo(taken: readonly number[]): number | null {
  for (let part = 1; part <= RETRO_LIMITS.recordingPartsMax; part += 1) {
    if (!taken.includes(part)) return part;
  }
  return null;
}

async function loadRow(db: DbClient, id: string): Promise<RetroRecordingRow | null> {
  return db.prepare(`SELECT ${RETRO_RECORDING_COLUMNS} FROM retro_recordings WHERE id = ?`).bind(id).first<RetroRecordingRow>();
}

async function viewOf(db: DbClient, viewer: Actor, row: RetroRecordingRow): Promise<RetroRecordingView> {
  const caseHead = row.case_id ? await loadRetroCaseHead(db, row.case_id) : null;
  const removable = row.status !== "REMOVED"
    && canRemoveRetroRecording({ uploadedByUserId: row.uploaded_by_user_id }, caseHead, viewer);
  return toRetroRecordingView(row, removable);
}

// ---------------------------------------------------------------------------
// 建行并签 PUT（POST /api/retro-recordings）
// ---------------------------------------------------------------------------

export async function createRetroRecording(
  db: DbClient,
  bucket: Pick<VideoBucket, "createPresignedPutUrl">,
  viewer: Actor,
  body: unknown,
): Promise<RetroCreateRecordingResponse> {
  const input = validateRetroRecordingRequest(body);
  if (input.caseId) {
    const head = await loadRetroCaseHead(db, input.caseId);
    if (!head || head.deleted) throw retroNotFound("案例不存在或已进入回收站。");
    if (head.monthKey !== input.monthKey) throw retroInvalid("录音的复盘月份和案例不一致，请刷新页面后重试。");
  }

  const recordingId = retroNewId("rtr");
  let attempt = 0;
  for (;;) {
    try {
      await db.withTransaction(async (tx) => {
        // 串行化同一归属上的并发上传：案例锁案例行，整场总结锁「月份」这把咨询锁。
        if (input.caseId) await loadRetroCaseHead(tx, input.caseId, { lock: true });
        else await tx.prepare(`SELECT pg_advisory_xact_lock(hashtext(?))`).bind(`retro-summary:${input.monthKey}`).first();
        const taken = input.caseId
          ? await tx.prepare(`SELECT part_no FROM retro_recordings WHERE case_id = ? AND status <> 'REMOVED'`).bind(input.caseId).all<QueryResultRow & { part_no: number }>()
          : await tx.prepare(`SELECT part_no FROM retro_recordings WHERE case_id IS NULL AND month_key = ? AND status <> 'REMOVED'`).bind(input.monthKey).all<QueryResultRow & { part_no: number }>();
        const partNo = nextRetroPartNo(taken.results.map((row) => Number(row.part_no)));
        if (partNo === null) {
          throw new RetroError(
            409,
            "RECORDING_PARTS_FULL",
            input.caseId
              ? `这个案例已经有 ${RETRO_LIMITS.recordingPartsMax} 段点评录音了，要换请先移除一段。`
              : `这个月的整场总结已经有 ${RETRO_LIMITS.recordingPartsMax} 段录音了，要换请先移除一段。`,
          );
        }
        await tx.prepare(
          `INSERT INTO retro_recordings (
             id, month_key, case_id, part_no, status, audio_object_key, audio_file_name, audio_content_type,
             audio_size_bytes, uploaded_by_user_id, uploaded_by_name
           ) VALUES (?, ?, ?, ?, 'UPLOADING', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          recordingId, input.monthKey, input.caseId, partNo, retroRecordingObjectKey(recordingId),
          input.fileName, input.contentType, input.sizeBytes, viewer.userId, viewer.displayName,
        ).run();
      });
      break;
    } catch (error) {
      // 锁已经串行化了，唯一索引冲突理论上不会出现；万一出现就按最新占用情况重算一次。
      if (isUniqueViolation(error) && attempt < 2) {
        attempt += 1;
        continue;
      }
      if (isUniqueViolation(error)) throw retroConflict("RECORDING_PARTS_CONFLICT", "同时有人在上传录音，请稍后再试。");
      throw error;
    }
  }

  const uploadUrl = await bucket.createPresignedPutUrl(retroRecordingObjectKey(recordingId), {
    contentType: input.contentType,
    expiresInSeconds: RETRO_RECORDING_UPLOAD_URL_TTL_SECONDS,
  });
  const row = await loadRow(db, recordingId);
  return { recording: await viewOf(db, viewer, row!), uploadUrl };
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export async function loadRetroRecording(db: DbClient, viewer: Actor, id: string): Promise<{ row: RetroRecordingRow; view: RetroRecordingView }> {
  const row = await loadRow(db, id);
  if (!row) throw retroNotFound("点评录音不存在。");
  return { row, view: await viewOf(db, viewer, row) };
}

export async function resolveRetroRecordingAudioUrl(
  db: DbClient,
  bucket: Pick<VideoBucket, "createPresignedGetUrl">,
  id: string,
): Promise<string> {
  const row = await db.prepare(`SELECT audio_object_key FROM retro_recordings WHERE id = ?`).bind(id).first<QueryResultRow & { audio_object_key: string }>();
  if (!row) throw retroNotFound("点评录音不存在。");
  // 被移除的录音照样能播：已发布成果里引用它的片段要能听原声。
  return bucket.createPresignedGetUrl(row.audio_object_key, { expiresInSeconds: RETRO_RECORDING_AUDIO_URL_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// 动作：UPLOADED / RETRY / REMOVE
// ---------------------------------------------------------------------------

export type RetroRecordingActionResult = { view: RetroRecordingView; row: RetroRecordingRow; advance: boolean };

/** HEAD 核对对象与大小：对得上返回 true；对不上把 fail_reason 写成人话，状态转（或留在）FAILED。 */
async function verifyUpload(db: DbClient, bucket: Pick<VideoBucket, "head">, row: RetroRecordingRow): Promise<boolean> {
  let head: Awaited<ReturnType<VideoBucket["head"]>>;
  try {
    head = await bucket.head(row.audio_object_key);
  } catch {
    throw new RetroError(503, "STORAGE_UNAVAILABLE", "暂时无法核对录音文件，请稍后重试。");
  }
  if (head && Number(head.size) === Number(row.audio_size_bytes)) return true;
  const reason = !head ? "没有找到上传的录音文件，请重新上传。" : "录音文件不完整（大小与上传前不符），请重新上传。";
  await db.prepare(
    `UPDATE retro_recordings SET status = 'FAILED', fail_reason = ?, updated_at = now()
     WHERE id = ? AND status IN ('UPLOADING', 'FAILED')`,
  ).bind(reason, row.id).run();
  return false;
}

export async function runRetroRecordingAction(
  db: DbClient,
  bucket: Pick<VideoBucket, "head">,
  viewer: Actor,
  id: string,
  body: unknown,
): Promise<RetroRecordingActionResult> {
  const action: RetroRecordingActionName = validateRetroRecordingAction(body);
  const row = await loadRow(db, id);
  if (!row) throw retroNotFound("点评录音不存在。");
  const caseHead = row.case_id ? await loadRetroCaseHead(db, row.case_id) : null;
  if (!canRemoveRetroRecording({ uploadedByUserId: row.uploaded_by_user_id }, caseHead, viewer)) {
    throw retroForbidden("只有这段录音的上传者、案例上传者或管理员可以处理这段录音。");
  }
  const result = async (advance: boolean): Promise<RetroRecordingActionResult> => {
    const fresh = (await loadRow(db, id))!;
    return { view: await viewOf(db, viewer, fresh), row: fresh, advance };
  };

  if (action === "REMOVE") {
    if (row.status === "REMOVED") return result(false);
    await db.prepare(
      `UPDATE retro_recordings SET status = 'REMOVED', removed_at = now(), removed_by_user_id = ?, lease_until = NULL, updated_at = now()
       WHERE id = ? AND status <> 'REMOVED'`,
    ).bind(viewer.userId, id).run();
    return result(false);
  }

  if (row.status === "REMOVED") throw retroConflict("INVALID_STATE", "这段录音已经被移除了。");

  if (action === "UPLOADED") {
    if (row.status !== "UPLOADING") {
      // 重复上报（比如网络重试）：已经往下走了就原样返回；失败态不能再标记为已上传，要走 RETRY。
      if (row.status === "FAILED") throw retroConflict("INVALID_STATE", "这段录音处理失败了，请用重试。");
      return result(row.status === "TRANSCRIBING");
    }
    if (!(await verifyUpload(db, bucket, row))) return result(false);
    const started = await startRetroTranscription(db, "RECORDING", id, ["UPLOADING"]);
    if (started) await db.prepare(`UPDATE retro_recordings SET uploaded_at = COALESCE(uploaded_at, now()) WHERE id = ?`).bind(id).run();
    return result(started);
  }

  // RETRY
  if (row.status !== "FAILED") throw retroConflict("INVALID_STATE", "只有处理失败的点评录音可以重试。");
  if (!(await verifyUpload(db, bucket, row))) return result(false);
  const started = await startRetroTranscription(db, "RECORDING", id, ["FAILED"]);
  if (started) await db.prepare(`UPDATE retro_recordings SET uploaded_at = COALESCE(uploaded_at, now()) WHERE id = ?`).bind(id).run();
  return result(started);
}
