import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import {
  newId,
  requireApiUser,
  requireSameOriginMutation,
} from "@/lib/current-user";

type CommentRow = {
  id: string;
  author_email: string;
  submission_author_email: string;
  parent_id: string | null;
  status: "OPEN" | "RESOLVED";
  is_excellent: number;
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ snapshotId: string; commentId: string }> },
) {
  const originError = requireSameOriginMutation(request);
  if (originError) return originError;
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  const { snapshotId, commentId } = await context.params;
  const payload = (await request.json()) as {
    status?: unknown;
    isExcellent?: unknown;
  };
  const db = getDbClient();
  const comment = await db
    .prepare(
      `SELECT c.id, c.author_email, s.author_email AS submission_author_email,
        c.parent_id, c.status, c.is_excellent
      FROM analysis_comments c
      INNER JOIN annotation_snapshots s ON s.id = c.submission_id
      WHERE c.id = ? AND c.submission_id = ? AND c.deleted_at IS NULL`,
    )
    .bind(commentId, snapshotId)
    .first<CommentRow>();
  if (!comment || comment.parent_id) {
    return Response.json({ error: "批注不存在。" }, { status: 404 });
  }

  const admin = await isAppAdmin(user);
  const statements = [];
  if (payload.status === "OPEN" || payload.status === "RESOLVED") {
    if (
      !admin &&
      comment.author_email !== user.identityKey &&
      comment.submission_author_email !== user.identityKey
    ) {
      return Response.json({ error: "只有批注人或管理员可以修改处理状态。" }, { status: 403 });
    }
    statements.push(
      db
        .prepare(
          `UPDATE analysis_comments
          SET status = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND submission_id = ?`,
        )
        .bind(
          payload.status,
          payload.status === "RESOLVED" ? new Date().toISOString() : null,
          commentId,
          snapshotId,
        ),
    );
  }

  if (typeof payload.isExcellent === "boolean") {
    if (!admin) {
      return Response.json({ error: "只有管理员可以标记优秀。" }, { status: 403 });
    }
    statements.push(
      db
        .prepare(
          `UPDATE analysis_comments
          SET is_excellent = ?, marked_by_email = ?, marked_by_name = ?,
            marked_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND submission_id = ?`,
        )
        .bind(
          payload.isExcellent ? 1 : 0,
          payload.isExcellent ? user.identityKey : null,
          payload.isExcellent ? user.displayName : null,
          payload.isExcellent ? new Date().toISOString() : null,
          commentId,
          snapshotId,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_logs (
            id, actor_email, action, object_type, object_id, detail_json
          ) VALUES (?, ?, ?, 'ANALYSIS_COMMENT', ?, ?)`,
        )
        .bind(
          newId("audit"),
          user.identityKey,
          payload.isExcellent ? "COMMENT_MARKED_EXCELLENT" : "COMMENT_UNMARKED_EXCELLENT",
          commentId,
          JSON.stringify({ snapshotId }),
        ),
    );
  }

  if (!statements.length) {
    return Response.json({ error: "没有可更新的内容。" }, { status: 400 });
  }
  await db.batch(statements);
  return Response.json({ ok: true });
}
