import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { V04_WORKFLOW_VERSION } from "./v04-contract";
import type { V04Actor } from "./v04-workspace-service";
import { V04ServiceError } from "./v04-errors";
import { restoreVideo, trashVideo } from "./v04-video-lifecycle";

export type LegacyVideoSchemaCapabilities = {
  stableUploader: boolean;
  softTrashColumns: boolean;
  stableAuditActor: boolean;
  requestAudit: boolean;
  workflowAudit: boolean;
  roleMemberships: boolean;
  collaborationWorkspaces: boolean;
  fullV04Lifecycle: boolean;
};

type CapabilityRow = QueryResultRow & {
  stable_uploader: boolean;
  soft_trash_columns: boolean;
  stable_audit_actor: boolean;
  request_audit: boolean;
  workflow_audit: boolean;
  role_memberships: boolean;
  collaboration_workspaces: boolean;
};

export type VideoUploaderIdentity = {
  created_by_user_id: string | null;
  created_by_email: string;
};

export function videoUploaderMatches(
  video: VideoUploaderIdentity,
  actor: { userId: string; identityKey: string },
) {
  const stableUploader = video.created_by_user_id?.trim();
  return stableUploader
    ? stableUploader === actor.userId
    : video.created_by_email === actor.identityKey;
}

export async function loadLegacyVideoSchemaCapabilities(db: DbClient) {
  const row = await db.prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'videos'
          AND column_name = 'created_by_user_id'
      ) AS stable_uploader,
      NOT EXISTS (
        SELECT required.column_name
        FROM (VALUES
          ('deleted_by_user_id'), ('delete_reason'), ('restore_until'),
          ('deletion_state'), ('restored_at'), ('restored_by_user_id')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.columns actual
          WHERE actual.table_schema = current_schema()
            AND actual.table_name = 'videos'
            AND actual.column_name = required.column_name
        )
      ) AS soft_trash_columns,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_logs'
          AND column_name = 'actor_user_id'
      ) AS stable_audit_actor,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_logs'
          AND column_name = 'request_id'
      ) AS request_audit,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_logs'
          AND column_name = 'workflow_version'
      ) AS workflow_audit,
      to_regclass(current_schema() || '.app_role_memberships') IS NOT NULL AS role_memberships,
      to_regclass(current_schema() || '.collaboration_workspaces') IS NOT NULL AS collaboration_workspaces
  `).first<CapabilityRow>();
  if (!row) throw new Error("无法识别当前数据库结构能力。");
  const capabilities: LegacyVideoSchemaCapabilities = {
    stableUploader: Boolean(row.stable_uploader),
    softTrashColumns: Boolean(row.soft_trash_columns),
    stableAuditActor: Boolean(row.stable_audit_actor),
    requestAudit: Boolean(row.request_audit),
    workflowAudit: Boolean(row.workflow_audit),
    roleMemberships: Boolean(row.role_memberships),
    collaborationWorkspaces: Boolean(row.collaboration_workspaces),
    fullV04Lifecycle: false,
  };
  capabilities.fullV04Lifecycle = capabilities.stableUploader
    && capabilities.softTrashColumns
    && capabilities.stableAuditActor
    && capabilities.requestAudit
    && capabilities.workflowAudit
    && capabilities.roleMemberships
    && capabilities.collaborationWorkspaces;
  return capabilities;
}

type VideoCreateInput = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tagsJson: string;
  objectKey: string;
  thumbnailKey: string;
  originalName: string;
  contentType: string;
  fileSize: number;
  actor: { userId: string; identityKey: string; displayName: string };
  requestId: string;
};

function auditInsert(
  db: DbClient,
  capabilities: LegacyVideoSchemaCapabilities,
  input: {
    id: string;
    actorUserId: string;
    actorIdentity: string;
    action: string;
    videoId: string;
    detailJson: string;
    requestId: string;
  },
) {
  const columns = ["id", "actor_email", "action", "object_type", "object_id", "detail_json"];
  const values: (string | null)[] = [
    input.id,
    input.actorIdentity,
    input.action,
    "VIDEO",
    input.videoId,
    input.detailJson,
  ];
  if (capabilities.stableAuditActor) {
    columns.push("actor_user_id");
    values.push(input.actorUserId);
  }
  if (capabilities.requestAudit) {
    columns.push("request_id");
    values.push(input.requestId);
  }
  if (capabilities.workflowAudit) {
    columns.push("workflow_version");
    values.push(V04_WORKFLOW_VERSION);
  }
  return db.prepare(
    `INSERT INTO audit_logs (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})`,
  ).bind(...values);
}

export async function createVideoWithSchemaCompatibility(
  db: DbClient,
  capabilities: LegacyVideoSchemaCapabilities,
  input: VideoCreateInput,
) {
  const videoColumns = [
    "id", "title", "brand", "description", "tags_json", "object_key", "thumbnail_key",
    "original_name", "content_type", "file_size", "status", "rights_confirmed",
    "created_by_email", "created_by_name",
  ];
  const videoValues: (string | number)[] = [
    input.id,
    input.title,
    input.brand,
    input.description,
    input.tagsJson,
    input.objectKey,
    input.thumbnailKey,
    input.originalName,
    input.contentType,
    input.fileSize,
    "UPLOADING",
    1,
    input.actor.identityKey,
    input.actor.displayName,
  ];
  if (capabilities.stableUploader) {
    videoColumns.push("created_by_user_id");
    videoValues.push(input.actor.userId);
  }
  await db.batch([
    db.prepare(
      `INSERT INTO videos (${videoColumns.join(", ")})
      VALUES (${videoColumns.map(() => "?").join(", ")})`,
    ).bind(...videoValues),
    auditInsert(db, capabilities, {
      id: `audit_${randomUUID()}`,
      actorUserId: input.actor.userId,
      actorIdentity: input.actor.identityKey,
      action: "VIDEO_CREATED",
      videoId: input.id,
      detailJson: JSON.stringify({ title: input.title, originalName: input.originalName }),
      requestId: input.requestId,
    }),
  ]);
}

type LegacyLifecycleRow = QueryResultRow & VideoUploaderIdentity & {
  id: string;
  deleted_at: string | null;
};

async function isSystemAdminWhenAvailable(
  db: DbClient,
  capabilities: LegacyVideoSchemaCapabilities,
  userId: string,
) {
  if (!capabilities.roleMemberships) return false;
  return Boolean(await db.prepare(
    `SELECT 1 FROM app_role_memberships
    WHERE user_id = ? AND role_key = 'SYSTEM_ADMIN' AND status = 'ACTIVE'`,
  ).bind(userId).first());
}

async function requireLegacyLifecycleAccess(
  db: DbClient,
  capabilities: LegacyVideoSchemaCapabilities,
  video: LegacyLifecycleRow,
  actor: V04Actor,
) {
  if (videoUploaderMatches(video, actor)) return;
  if (await isSystemAdminWhenAvailable(db, capabilities, actor.userId)) return;
  throw new V04ServiceError("FORBIDDEN", "只有原上传者或系统管理员可以管理该视频。");
}

export async function trashVideoWithoutV04Schema(
  db: DbClient,
  capabilities: LegacyVideoSchemaCapabilities,
  videoId: string,
  actor: V04Actor,
  input: { reason: string; idempotencyKey: string; now?: Date },
) {
  const now = input.now ?? new Date();
  if (!input.reason.trim() || !input.idempotencyKey.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "移入回收站需要原因和幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    const video = await transaction.prepare(
      `SELECT id, created_by_email,
        to_jsonb(videos)->>'created_by_user_id' AS created_by_user_id,
        deleted_at
      FROM videos WHERE id = ? FOR UPDATE`,
    ).bind(videoId).first<LegacyLifecycleRow>();
    if (!video) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
    await requireLegacyLifecycleAccess(transaction, capabilities, video, actor);
    if (video.deleted_at) {
      return { trashed: true, restoreUntil: null, idempotentReplay: true, compatibilityMode: "PRE_1A" };
    }
    const result = await transaction.prepare(
      `UPDATE videos SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    ).bind(now.toISOString(), now.toISOString(), videoId).run();
    if (result.meta.rows_written !== 1) {
      throw new V04ServiceError("REVISION_CONFLICT", "视频状态已变化，请刷新后重试。");
    }
    await auditInsert(transaction, capabilities, {
      id: `audit_${randomUUID()}`,
      actorUserId: actor.userId,
      actorIdentity: actor.identityKey,
      action: "VIDEO_TRASHED",
      videoId,
      detailJson: JSON.stringify({
        reason: input.reason.trim(),
        assetAction: "NONE",
        compatibilityMode: "PRE_1A",
      }),
      requestId: input.idempotencyKey,
    }).run();
    return { trashed: true, restoreUntil: null, idempotentReplay: false, compatibilityMode: "PRE_1A" };
  });
}

export async function restoreVideoWithoutV04Schema(
  db: DbClient,
  capabilities: LegacyVideoSchemaCapabilities,
  videoId: string,
  actor: V04Actor,
  input: { idempotencyKey: string; now?: Date },
) {
  const now = input.now ?? new Date();
  if (!input.idempotencyKey.trim()) {
    throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "恢复案例缺少幂等键。");
  }
  return db.withTransaction(async (transaction) => {
    const video = await transaction.prepare(
      `SELECT id, created_by_email,
        to_jsonb(videos)->>'created_by_user_id' AS created_by_user_id,
        deleted_at
      FROM videos WHERE id = ? FOR UPDATE`,
    ).bind(videoId).first<LegacyLifecycleRow>();
    if (!video) throw new V04ServiceError("CASE_NOT_FOUND", "案例不存在。");
    await requireLegacyLifecycleAccess(transaction, capabilities, video, actor);
    if (!video.deleted_at) {
      return { restored: true, idempotentReplay: true, compatibilityMode: "PRE_1A" };
    }
    const result = await transaction.prepare(
      `UPDATE videos SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`,
    ).bind(now.toISOString(), videoId).run();
    if (result.meta.rows_written !== 1) {
      throw new V04ServiceError("REVISION_CONFLICT", "视频状态已变化，请刷新后重试。");
    }
    await auditInsert(transaction, capabilities, {
      id: `audit_${randomUUID()}`,
      actorUserId: actor.userId,
      actorIdentity: actor.identityKey,
      action: "VIDEO_RESTORED",
      videoId,
      detailJson: JSON.stringify({ assetAction: "NONE", compatibilityMode: "PRE_1A" }),
      requestId: input.idempotencyKey,
    }).run();
    return { restored: true, idempotentReplay: false, compatibilityMode: "PRE_1A" };
  });
}

export async function trashVideoWithSchemaCompatibility(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { reason: string; idempotencyKey: string; now?: Date },
) {
  const capabilities = await loadLegacyVideoSchemaCapabilities(db);
  return capabilities.fullV04Lifecycle
    ? trashVideo(db, videoId, actor, input)
    : trashVideoWithoutV04Schema(db, capabilities, videoId, actor, input);
}

export async function restoreVideoWithSchemaCompatibility(
  db: DbClient,
  videoId: string,
  actor: V04Actor,
  input: { idempotencyKey: string; now?: Date },
) {
  const capabilities = await loadLegacyVideoSchemaCapabilities(db);
  return capabilities.fullV04Lifecycle
    ? restoreVideo(db, videoId, actor, input)
    : restoreVideoWithoutV04Schema(db, capabilities, videoId, actor, input);
}
