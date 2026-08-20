import { createHash } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { getDbClient } from "@/db";
import {
  COMMENT_QUOTE_MAX_LENGTH,
  normalizeCommentText,
  validateCommentBody,
} from "@/lib/analysis-comments";
import { v04IdempotencyKey, v04Route } from "@/lib/v04-api";
import { V04_WORKFLOW_VERSION, type V04DraftPayloadV1 } from "@/lib/v04-contract";
import { assertV04PayloadContract } from "@/lib/v04-domain";
import { V04ServiceError } from "@/lib/v04-errors";
import { resolveV04CommentTarget } from "@/lib/v04-read-models";
import type { V04Actor } from "@/lib/v04-workspace-service";

type CommentContextRow = QueryResultRow & {
  workspace_id: string;
  annotation_id: string;
  round_id: string;
  snapshot_id: string;
  revision: number;
  payload_json: V04DraftPayloadV1 | string;
};

type CommentRow = QueryResultRow & {
  id: string;
  parent_id: string | null;
  author_email: string;
  author_name: string;
  target_key: string;
  target_label: string;
  selected_text: string;
  anchor_start: number;
  anchor_end: number;
  body: string;
  kind: string;
  workflow_status: string;
  created_at: string;
  updated_at: string;
};

type CreateV04CommentInput = {
  videoId: string;
  targetKey: string;
  targetLabel?: string;
  selectedText?: string;
  anchorStart?: number;
  anchorEnd?: number;
  body: string;
  idempotencyKey: string;
};

type CreateV04CommentHooks = {
  afterCommentInsert?: () => void | Promise<void>;
};

const parsePayload = (value: V04DraftPayloadV1 | string) => {
  const payload = typeof value === "string"
    ? JSON.parse(value) as V04DraftPayloadV1
    : value;
  assertV04PayloadContract(payload);
  return payload;
};

const deterministicId = (prefix: string, ...values: string[]) =>
  `${prefix}_${createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex").slice(0, 40)}`;

function normalizeV04CommentTarget(value: unknown) {
  const target = normalizeCommentText(value, 180);
  return target && /^[a-z0-9:._-]+$/i.test(target) ? target : "";
}

function moduleForTarget(targetKey: string) {
  if (targetKey.startsWith("shot:") || targetKey.startsWith("shotGroup:")) {
    return { moduleKey: "SCRIPT", moduleLabel: "第一模块｜脚本反写" };
  }
  if (targetKey.startsWith("facts.")) {
    return { moduleKey: "FACTS", moduleLabel: "第二模块｜全片事实与核心判断" };
  }
  return { moduleKey: "PERCEPTION", moduleLabel: "第三模块｜主导感知类型发生路径" };
}

async function loadContext(db: DbClient, videoId: string, lock = false) {
  return db.prepare(
    `SELECT w.id AS workspace_id, w.canonical_annotation_id AS annotation_id,
      w.active_round_id AS round_id, w.current_working_snapshot_id AS snapshot_id,
      s.revision, s.payload_json
    FROM collaboration_workspaces w
    INNER JOIN videos v ON v.id = w.video_id
    INNER JOIN annotation_snapshots s ON s.id = w.current_working_snapshot_id
    WHERE w.video_id = ? AND w.workflow_version = ? AND w.status = 'ACTIVE'
      AND v.deleted_at IS NULL
      AND COALESCE(v.deletion_state, 'ACTIVE') NOT IN ('TRASHED', 'ASSET_PURGED')
    ${lock ? "FOR UPDATE OF w" : ""}`,
  ).bind(videoId, V04_WORKFLOW_VERSION).first<CommentContextRow>();
}

function commentModel(row: CommentRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    authorName: row.author_name,
    targetKey: row.target_key,
    targetLabel: row.target_label,
    originalExcerpt: row.selected_text,
    anchorStart: Number(row.anchor_start),
    anchorEnd: Number(row.anchor_end),
    body: row.body,
    kind: row.kind,
    status: row.workflow_status,
    ...moduleForTarget(row.target_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadV04Comments(db: DbClient, videoId: string) {
  const context = await loadContext(db, videoId);
  if (!context) return { comments: [], workspaceId: null, snapshotId: null };
  const rows = await db.prepare(
    `SELECT c.id, c.parent_id, c.author_email, c.author_name, c.target_key,
      c.target_label, c.selected_text, c.anchor_start, c.anchor_end,
      c.body, c.kind, c.workflow_status, c.created_at, c.updated_at
    FROM analysis_comments c
    INNER JOIN annotation_snapshots s ON s.id = c.submission_id
    WHERE s.annotation_id = ? AND s.workflow_version = ?
      AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC, c.id ASC`,
  ).bind(context.annotation_id, V04_WORKFLOW_VERSION).all<CommentRow>();
  return {
    workspaceId: context.workspace_id,
    snapshotId: context.snapshot_id,
    comments: rows.results.map(commentModel),
  };
}

async function createV04Comment(
  db: DbClient,
  actor: V04Actor,
  input: CreateV04CommentInput,
  hooks: CreateV04CommentHooks = {},
) {
  const targetKey = normalizeV04CommentTarget(input.targetKey);
  const idempotencyKey = input.idempotencyKey.trim();
  const validated = validateCommentBody(input.body);
  if (!targetKey || validated.error || !idempotencyKey) {
    throw new V04ServiceError(
      "INVALID_PAYLOAD_SCHEMA",
      validated.error ?? "批注目标和幂等标识不能为空。",
    );
  }
  const commentId = deterministicId("comment_v04", actor.userId, input.videoId, idempotencyKey);
  return db.withTransaction(async (transaction) => {
    const context = await loadContext(transaction, input.videoId, true);
    if (!context) {
      throw new V04ServiceError("VERSION_NOT_FOUND", "请先保存公共工作稿，再添加批注。");
    }
    const payload = parsePayload(context.payload_json);
    const target = resolveV04CommentTarget(payload, targetKey);
    if (!target) {
      throw new V04ServiceError("VERSION_NOT_FOUND", "批注目标不存在或已经失效。");
    }
    const requestedSelection = normalizeCommentText(input.selectedText, COMMENT_QUOTE_MAX_LENGTH);
    let excerpt = requestedSelection;
    let anchorStart = Number.isInteger(input.anchorStart) ? Number(input.anchorStart) : -1;
    let anchorEnd = Number.isInteger(input.anchorEnd) ? Number(input.anchorEnd) : -1;
    if (requestedSelection) {
      if (
        anchorStart < 0 || anchorEnd < anchorStart ||
        target.value.slice(anchorStart, anchorEnd) !== requestedSelection
      ) {
        throw new V04ServiceError("REVISION_CONFLICT", "所选文字已变化，请重新选中后批注。", {
          targetKey,
        });
      }
    } else {
      excerpt = target.value.replace(/\s+/g, " ").trim().slice(0, COMMENT_QUOTE_MAX_LENGTH);
      anchorStart = -1;
      anchorEnd = -1;
    }
    const targetLabel = normalizeCommentText(input.targetLabel, 180) || targetKey;
    const existing = await transaction.prepare(
      `SELECT id, parent_id, author_email, author_name, target_key, target_label,
        selected_text, anchor_start, anchor_end, body, kind, workflow_status,
        created_at, updated_at
      FROM analysis_comments WHERE id = ? FOR UPDATE`,
    ).bind(commentId).first<CommentRow>();
    if (existing) {
      if (
        existing.author_email !== actor.identityKey || existing.target_key !== targetKey ||
        existing.body !== validated.body
      ) {
        throw new V04ServiceError("IDEMPOTENCY_CONFLICT", "幂等标识已用于另一条批注。");
      }
      return { comment: commentModel(existing), idempotentReplay: true };
    }
    const now = new Date().toISOString();
    await transaction.prepare(
      `INSERT INTO analysis_comments (
        id, submission_id, video_id, parent_id, author_email, author_name,
        target_key, target_label, selected_text, anchor_start, anchor_end,
        body, kind, status, workflow_status, base_version_id,
        base_working_revision, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'COMMENT', 'OPEN',
        'OPEN', ?, ?, ?::timestamptz, ?::timestamptz)`,
    ).bind(
      commentId,
      context.snapshot_id,
      input.videoId,
      actor.identityKey,
      actor.displayName,
      targetKey,
      targetLabel,
      excerpt,
      anchorStart,
      anchorEnd,
      validated.body,
      context.snapshot_id,
      Number(context.revision),
      now,
      now,
    ).run();
    await hooks.afterCommentInsert?.();
    await transaction.prepare(
      `INSERT INTO audit_logs (
        id, actor_email, action, object_type, object_id, detail_json,
        actor_user_id, request_id, workflow_version
      ) VALUES (?, ?, 'V04_COMMENT_CREATED', 'ANALYSIS_COMMENT', ?, ?, ?, ?, ?)`,
    ).bind(
      deterministicId("audit_v04_comment", commentId),
      actor.identityKey,
      commentId,
      JSON.stringify({ videoId: input.videoId, targetKey, idempotencyKey }),
      actor.userId,
      actor.requestId,
      V04_WORKFLOW_VERSION,
    ).run();
    const created = await transaction.prepare(
      `SELECT id, parent_id, author_email, author_name, target_key, target_label,
        selected_text, anchor_start, anchor_end, body, kind, workflow_status,
        created_at, updated_at
      FROM analysis_comments WHERE id = ?`,
    ).bind(commentId).first<CommentRow>();
    if (!created) throw new V04ServiceError("TRANSACTION_ROLLED_BACK", "批注创建未完成。");
    return { comment: commentModel(created), idempotentReplay: false };
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const response = await v04Route(request, { mutation: false }, async () => {
    const { id } = await context.params;
    return Response.json(await loadV04Comments(getDbClient(), id));
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return v04Route(request, { mutation: true }, async (actor) => {
    const { id } = await context.params;
    const body = await request.json() as Omit<CreateV04CommentInput, "videoId" | "idempotencyKey"> & {
      idempotencyKey?: string;
    };
    const result = await createV04Comment(getDbClient(), actor, {
      videoId: id,
      targetKey: body.targetKey,
      targetLabel: body.targetLabel,
      selectedText: body.selectedText,
      anchorStart: body.anchorStart,
      anchorEnd: body.anchorEnd,
      body: body.body,
      idempotencyKey: v04IdempotencyKey(request, body.idempotencyKey),
    });
    return Response.json(result, { status: result.idempotentReplay ? 200 : 201 });
  });
}
