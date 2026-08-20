import { createHash } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { getDbClient } from "@/db";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { V04_WORKFLOW_VERSION } from "@/lib/v04-contract";
import { V04ServiceError } from "@/lib/v04-errors";
import type { V04Actor } from "@/lib/v04-workspace-service";

type V04CommentStatus = "AUTHOR_MARKED_HANDLED" | "RESOLVED" | "REOPENED";

type CommentStatusRow = QueryResultRow & {
  id: string;
  author_email: string;
  workflow_status: string;
  annotation_id: string;
};

type UpdateV04CommentInput = {
  videoId: string;
  commentId: string;
  status: V04CommentStatus;
  idempotencyKey: string;
};

type UpdateV04CommentHooks = {
  afterCommentUpdate?: () => void | Promise<void>;
};

const deterministicId = (prefix: string, ...values: string[]) =>
  `${prefix}_${createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex").slice(0, 40)}`;

async function hasRole(db: DbClient, userId: string, role: "EXPERT" | "SYSTEM_ADMIN") {
  return Boolean(await db.prepare(
    `SELECT 1 FROM app_role_memberships
    WHERE user_id = ? AND role_key = ? AND status = 'ACTIVE'`,
  ).bind(userId, role).first<QueryResultRow>());
}

async function updateV04Comment(
  db: DbClient,
  actor: V04Actor,
  input: UpdateV04CommentInput,
  hooks: UpdateV04CommentHooks = {},
) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || !["AUTHOR_MARKED_HANDLED", "RESOLVED", "REOPENED"].includes(input.status)) {
    throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "批注状态或幂等标识无效。");
  }
  return db.withTransaction(async (transaction) => {
    const comment = await transaction.prepare(
      `SELECT c.id, c.author_email, c.workflow_status,
        snapshot.annotation_id
      FROM analysis_comments c
      INNER JOIN annotation_snapshots snapshot ON snapshot.id = c.submission_id
      INNER JOIN collaboration_workspaces workspace
        ON workspace.canonical_annotation_id = snapshot.annotation_id
        AND workspace.workflow_version = ? AND workspace.status = 'ACTIVE'
      INNER JOIN videos video ON video.id = workspace.video_id
      WHERE workspace.video_id = ? AND c.id = ? AND c.parent_id IS NULL
        AND c.deleted_at IS NULL AND video.deleted_at IS NULL
        AND COALESCE(video.deletion_state, 'ACTIVE') NOT IN ('TRASHED', 'ASSET_PURGED')
      FOR UPDATE OF c`,
    ).bind(V04_WORKFLOW_VERSION, input.videoId, input.commentId).first<CommentStatusRow>();
    if (!comment) throw new V04ServiceError("VERSION_NOT_FOUND", "批注不存在或不属于当前案例。");

    if (
      (input.status === "RESOLVED" || input.status === "REOPENED") &&
      !await hasRole(transaction, actor.userId, "EXPERT")
    ) {
      throw new V04ServiceError("EXPERT_REQUIRED", "只有专家可以解决或重新打开批注。");
    }

    const auditId = deterministicId(
      "audit_v04_comment_status",
      actor.userId,
      input.commentId,
      idempotencyKey,
    );
    const replay = await transaction.prepare(
      `SELECT detail_json FROM audit_logs
      WHERE id = ? AND action = 'V04_COMMENT_STATUS_UPDATED' FOR UPDATE`,
    ).bind(auditId).first<{ detail_json: string | Record<string, unknown> } & QueryResultRow>();
    if (replay) {
      const detail = typeof replay.detail_json === "string"
        ? JSON.parse(replay.detail_json) as Record<string, unknown>
        : replay.detail_json;
      if (detail.status !== input.status || detail.videoId !== input.videoId) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等标识已用于另一项批注状态变更。");
      }
      return { commentId: input.commentId, status: input.status, idempotentReplay: true };
    }

    const now = new Date().toISOString();
    await transaction.prepare(
      `UPDATE analysis_comments SET
        workflow_status = ?, status = ?,
        resolved_by_email = ?, resolved_by_name = ?, resolved_at = ?::timestamptz,
        reopened_at = ?::timestamptz, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(
      input.status,
      input.status === "RESOLVED" ? "RESOLVED" : "OPEN",
      input.status === "RESOLVED" ? actor.identityKey : null,
      input.status === "RESOLVED" ? actor.displayName : null,
      input.status === "RESOLVED" ? now : null,
      input.status === "REOPENED" ? now : null,
      now,
      input.commentId,
    ).run();
    await hooks.afterCommentUpdate?.();
    await transaction.prepare(
      `INSERT INTO audit_logs (
        id, actor_email, action, object_type, object_id, detail_json,
        actor_user_id, request_id, workflow_version
      ) VALUES (?, ?, 'V04_COMMENT_STATUS_UPDATED', 'ANALYSIS_COMMENT', ?, ?, ?, ?, ?)`,
    ).bind(
      auditId,
      actor.identityKey,
      input.commentId,
      JSON.stringify({
        videoId: input.videoId,
        status: input.status,
        previousStatus: comment.workflow_status,
        idempotencyKey,
      }),
      actor.userId,
      actor.requestId,
      V04_WORKFLOW_VERSION,
    ).run();
    return { commentId: input.commentId, status: input.status, idempotentReplay: false };
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id, commentId } = await context.params;
    const body = await request.json() as { status?: V04CommentStatus; idempotencyKey?: string };
    if (!body.status) throw new V04ServiceError("INVALID_PAYLOAD_SCHEMA", "请选择批注处理状态。");
    return Response.json(await updateV04Comment(getDbClient(), actor, {
      videoId: id,
      commentId,
      status: body.status,
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    }));
  });
}
