import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { V04_WORKFLOW_VERSION } from "./v04-contract";
import { V04ServiceError } from "./v04-errors";
import type { V04Actor } from "./v04-workspace-service";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

async function isSystemAdmin(db: DbClient, userId: string) {
  return Boolean(await db.prepare(
    `SELECT 1 FROM app_role_memberships
    WHERE user_id = ? AND role_key = 'SYSTEM_ADMIN' AND status = 'ACTIVE'`,
  ).bind(userId).first());
}

async function audit(
  db: DbClient,
  actor: V04Actor,
  action: string,
  videoId: string,
  detail: Record<string, unknown>,
) {
  await db.prepare(
    `INSERT INTO audit_logs (
      id, actor_email, action, object_type, object_id, detail_json,
      actor_user_id, request_id, workflow_version
    ) VALUES (?, ?, ?, 'VIDEO', ?, ?, ?, ?, ?)`,
  ).bind(
    id("audit"), actor.identityKey, action, videoId, JSON.stringify(detail),
    actor.userId, actor.requestId, V04_WORKFLOW_VERSION,
  ).run();
}

type VideoLifecycleRow = QueryResultRow & {
  id: string;
  created_by_user_id: string | null;
  created_by_email: string;
  deleted_at: string | null;
  deletion_state: string | null;
  restore_until: string | null;
};

export type V04VideoLifecycleHooks = {
  afterVideoUpdate?: () => void | Promise<void>;
  afterWorkspaceUpdate?: () => void | Promise<void>;
};

export async function trashVideo(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { reason: string; idempotencyKey: string; now?: Date },
  hooks: V04VideoLifecycleHooks = {},
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim() || !input.reason.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "移入回收站需要原因和幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    const video = await transaction.prepare(
      `SELECT id, created_by_user_id, created_by_email, deleted_at, deletion_state, restore_until
      FROM videos WHERE id = ? FOR UPDATE`,
    ).bind(videoId).first<VideoLifecycleRow>();
    if (!video) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
    const admin = await isSystemAdmin(transaction, actor.userId);
    const isUploader = video.created_by_user_id
      ? video.created_by_user_id === actor.userId
      : video.created_by_email === actor.identityKey;
    if (!isUploader && !admin) {
      throw new V04ServiceError("FORBIDDEN", "仅稳定上传者或系统管理员可将案例移入回收站。");
    }
    const replay = await transaction.prepare(
      `SELECT detail_json FROM audit_logs
      WHERE request_id = ? AND action = 'VIDEO_TRASHED' AND object_id = ? LIMIT 1`,
    ).bind(input.idempotencyKey, videoId).first<{ detail_json: string } & QueryResultRow>();
    if (replay) {
      return { trashed: true, restoreUntil: video.restore_until, idempotentReplay: true };
    }
    if (video.deletion_state === "ASSET_PURGED") {
      throw new V04ServiceError("ASSET_PURGED", "案例原始资产已经清理。");
    }
    if (video.deletion_state === "TRASHED" || video.deleted_at) {
      throw new V04ServiceError("CASE_IN_TRASH", "案例已在回收站中。");
    }
    const restoreUntil = new Date(now.getTime() + RETENTION_MS).toISOString();
    await transaction.prepare(
      `UPDATE videos SET deleted_at = ?, deleted_by_user_id = ?, delete_reason = ?,
        restore_until = ?::timestamptz, deletion_state = 'TRASHED', updated_at = ?
      WHERE id = ?`,
    ).bind(
      now.toISOString(), actor.userId, input.reason.trim(), restoreUntil,
      now.toISOString(), videoId,
    ).run();
    await hooks.afterVideoUpdate?.();
    await transaction.prepare(
      `UPDATE collaboration_workspaces SET status = 'TRASHED', updated_at = ?::timestamptz
      WHERE video_id = ? AND workflow_version = ?`,
    ).bind(now.toISOString(), videoId, V04_WORKFLOW_VERSION).run();
    await hooks.afterWorkspaceUpdate?.();
    await audit(transaction, { ...actor, requestId: input.idempotencyKey }, "VIDEO_TRASHED", videoId, {
      restoreUntil,
      reason: input.reason.trim(),
      assetAction: "NONE",
    });
    return { trashed: true, restoreUntil, idempotentReplay: false };
  });
}

export async function restoreVideo(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { idempotencyKey: string; now?: Date },
  hooks: V04VideoLifecycleHooks = {},
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "恢复案例缺少幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    const video = await transaction.prepare(
      `SELECT id, created_by_user_id, created_by_email, deleted_at, deletion_state, restore_until
      FROM videos WHERE id = ? FOR UPDATE`,
    ).bind(videoId).first<VideoLifecycleRow>();
    if (!video) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
    const admin = await isSystemAdmin(transaction, actor.userId);
    const isUploader = video.created_by_user_id
      ? video.created_by_user_id === actor.userId
      : video.created_by_email === actor.identityKey;
    if (!isUploader && !admin) {
      throw new V04ServiceError("FORBIDDEN", "仅稳定上传者或系统管理员可恢复案例。");
    }
    const replay = await transaction.prepare(
      `SELECT 1 FROM audit_logs
      WHERE request_id = ? AND action = 'VIDEO_RESTORED' AND object_id = ? LIMIT 1`,
    ).bind(input.idempotencyKey, videoId).first();
    if (replay) return { restored: true, idempotentReplay: true };
    if (video.deletion_state === "ASSET_PURGED") {
      throw new V04ServiceError("ASSET_PURGED", "案例原始资产已经清理，无法在普通恢复链路中恢复。");
    }
    if (video.deletion_state !== "TRASHED" && !video.deleted_at) {
      return { restored: true, idempotentReplay: false };
    }
    if (!video.restore_until || Date.parse(video.restore_until) < now.getTime()) {
      throw new V04ServiceError("CASE_IN_TRASH", "案例已超过 90 天普通恢复期。");
    }
    await transaction.prepare(
      `UPDATE videos SET deleted_at = NULL, deleted_by_user_id = NULL,
        delete_reason = NULL, restore_until = NULL, deletion_state = 'ACTIVE',
        restored_at = ?::timestamptz, restored_by_user_id = ?, updated_at = ?
      WHERE id = ?`,
    ).bind(now.toISOString(), actor.userId, now.toISOString(), videoId).run();
    await hooks.afterVideoUpdate?.();
    await transaction.prepare(
      `UPDATE collaboration_workspaces SET status = 'ACTIVE', updated_at = ?::timestamptz
      WHERE video_id = ? AND workflow_version = ? AND status = 'TRASHED'`,
    ).bind(now.toISOString(), videoId, V04_WORKFLOW_VERSION).run();
    await hooks.afterWorkspaceUpdate?.();
    await audit(transaction, { ...actor, requestId: input.idempotencyKey }, "VIDEO_RESTORED", videoId, {
      assetAction: "NONE",
    });
    return { restored: true, idempotentReplay: false };
  });
}
