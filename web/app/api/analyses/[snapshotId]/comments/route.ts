import { getDbClient } from "@/db";
import {
  COMMENT_QUOTE_MAX_LENGTH,
  COMMENT_TARGET_MAX_LENGTH,
  normalizeCommentTarget,
  normalizeCommentText,
  validateCommentBody,
} from "@/lib/analysis-comments";
import { isAppAdmin } from "@/lib/admin";
import {
  newId,
  requireApiUser,
  requireSameOriginMutation,
} from "@/lib/current-user";
import type {
  AnalysisComment,
  AnalysisCommentKind,
  AnalysisCommentReply,
} from "@/lib/types";

type SnapshotRow = {
  id: string;
  video_id: string;
  author_email: string;
};

type CommentRow = {
  id: string;
  submission_id: string;
  parent_id: string | null;
  author_email: string;
  author_name: string;
  target_key: string;
  target_label: string;
  selected_text: string;
  body: string;
  kind: AnalysisCommentKind;
  status: "OPEN" | "RESOLVED";
  is_excellent: number;
  marked_by_name: string | null;
  created_at: string;
  updated_at: string;
};

async function loadSnapshot(snapshotId: string) {
  return getDbClient()
    .prepare(
      `SELECT s.id, s.video_id, s.author_email
      FROM annotation_snapshots s
      INNER JOIN videos v ON v.id = s.video_id
      WHERE s.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  }

  const [result, admin] = await Promise.all([
    getDbClient()
      .prepare(
        `SELECT id, submission_id, parent_id, author_email, author_name,
          target_key, target_label, selected_text, body, kind, status,
          is_excellent, marked_by_name, created_at, updated_at
        FROM analysis_comments
        WHERE submission_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      )
      .bind(snapshotId)
      .all<CommentRow>(),
    isAppAdmin(user),
  ]);

  const replies = new Map<string, AnalysisCommentReply[]>();
  for (const row of result.results) {
    if (!row.parent_id) continue;
    const current = replies.get(row.parent_id) ?? [];
    current.push({
      id: row.id,
      authorName: row.author_name,
      body: row.body,
      kind: row.kind,
      createdAt: row.created_at,
    });
    replies.set(row.parent_id, current);
  }

  const comments: AnalysisComment[] = result.results
    .filter((row) => !row.parent_id)
    .map((row) => ({
      id: row.id,
      submissionId: row.submission_id,
      targetKey: row.target_key,
      targetLabel: row.target_label,
      selectedText: row.selected_text,
      body: row.body,
      authorName: row.author_name,
      kind: row.kind,
      status: row.status,
      isExcellent: Boolean(row.is_excellent),
      markedByName: row.marked_by_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canResolve:
        admin ||
        row.author_email === user.identityKey ||
        snapshot.author_email === user.identityKey,
      replies: replies.get(row.id) ?? [],
    }));

  return Response.json({ comments, isAdmin: admin });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ snapshotId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId } = await context.params;
  const snapshot = await loadSnapshot(snapshotId);
  if (!snapshot) {
    return Response.json({ error: "作业版本不存在。" }, { status: 404 });
  }

  const payload = (await request.json()) as {
    parentId?: unknown;
    targetKey?: unknown;
    targetLabel?: unknown;
    selectedText?: unknown;
    body?: unknown;
    kind?: unknown;
  };
  const { body, error } = validateCommentBody(payload.body);
  if (error) return Response.json({ error }, { status: 400 });

  const db = getDbClient();
  const parentId = normalizeCommentText(payload.parentId, 100);
  let targetKey = normalizeCommentTarget(payload.targetKey);
  let targetLabel = normalizeCommentText(
    payload.targetLabel,
    COMMENT_TARGET_MAX_LENGTH,
  );
  let selectedText = normalizeCommentText(
    payload.selectedText,
    COMMENT_QUOTE_MAX_LENGTH,
  );

  if (parentId) {
    const parent = await db
      .prepare(
        `SELECT id, target_key, target_label, selected_text
        FROM analysis_comments
        WHERE id = ? AND submission_id = ? AND parent_id IS NULL
          AND deleted_at IS NULL`,
      )
      .bind(parentId, snapshotId)
      .first<{
        id: string;
        target_key: string;
        target_label: string;
        selected_text: string;
      }>();
    if (!parent) {
      return Response.json({ error: "原批注不存在。" }, { status: 404 });
    }
    targetKey = parent.target_key;
    targetLabel = parent.target_label;
    selectedText = parent.selected_text;
  } else if (!targetKey) {
    return Response.json({ error: "请选择需要批注的内容。" }, { status: 400 });
  }

  const admin = await isAppAdmin(user);
  const requestedKind = payload.kind === "EXPERT_NOTE" ? "EXPERT_NOTE" : "COMMENT";
  if (requestedKind === "EXPERT_NOTE" && !admin) {
    return Response.json({ error: "只有管理员可以添加专家精修意见。" }, { status: 403 });
  }

  const commentId = newId("comment");
  await db
    .prepare(
      `INSERT INTO analysis_comments (
        id, submission_id, video_id, parent_id, author_email, author_name,
        target_key, target_label, selected_text, body, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      commentId,
      snapshotId,
      snapshot.video_id,
      parentId || null,
      user.identityKey,
      user.displayName,
      targetKey,
      targetLabel,
      selectedText,
      body,
      requestedKind,
    )
    .run();

  return Response.json({ ok: true, commentId }, { status: 201 });
}
