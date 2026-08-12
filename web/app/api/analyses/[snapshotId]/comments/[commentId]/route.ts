import { getDbClient } from "@/db";
import { isAppAdmin, isFinalReviewer } from "@/lib/admin";
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
  annotation_id: string;
  taxonomy_version: string;
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
        c.parent_id, c.status, c.is_excellent, s.annotation_id,
        s.taxonomy_version
      FROM analysis_comments c
      INNER JOIN annotation_snapshots s ON s.id = c.submission_id
      INNER JOIN annotation_snapshots requested ON requested.id = ?
      WHERE c.id = ? AND c.deleted_at IS NULL
        AND (c.submission_id = requested.id OR (
          requested.taxonomy_version = 'V0.3-PILOT'
          AND s.annotation_id = requested.annotation_id
        ))`,
    )
    .bind(snapshotId, commentId)
    .first<CommentRow>();
  if (!comment || comment.parent_id) {
    return Response.json({ error: "批注不存在。" }, { status: 404 });
  }

  const admin = await isAppAdmin(user);
  const finalReviewer = await isFinalReviewer(user);
  const statements = [];
  if (
    payload.status === "OPEN" ||
    payload.status === "AUTHOR_MARKED_HANDLED" ||
    payload.status === "RESOLVED" ||
    payload.status === "REOPENED"
  ) {
    if (comment.taxonomy_version === "V0.3-PILOT") {
      if (
        payload.status === "AUTHOR_MARKED_HANDLED" &&
        comment.submission_author_email !== user.identityKey
      ) {
        return Response.json({ error: "只有作业作者可以标记已处理。" }, { status: 403 });
      }
      if (
        (payload.status === "RESOLVED" || payload.status === "REOPENED") &&
        !finalReviewer
      ) {
        return Response.json({ error: "只有终审者可以解决或重新打开批注。" }, { status: 403 });
      }
      if (payload.status === "OPEN") {
        return Response.json({ error: "请使用“作者已处理”或“重新打开”。" }, { status: 400 });
      }
      statements.push(
        db.prepare(
          `UPDATE analysis_comments
          SET workflow_status = ?, status = ?, resolved_by_email = ?,
            resolved_by_name = ?, resolved_at = ?, reopened_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        ).bind(
          payload.status,
          payload.status === "RESOLVED" ? "RESOLVED" : "OPEN",
          payload.status === "RESOLVED" ? user.identityKey : null,
          payload.status === "RESOLVED" ? user.displayName : null,
          payload.status === "RESOLVED" ? new Date().toISOString() : null,
          payload.status === "REOPENED" ? new Date().toISOString() : null,
          commentId,
        ),
      );
      statements.push(
        db.prepare(
          `INSERT INTO audit_logs (
            id, actor_email, action, object_type, object_id, detail_json
          ) VALUES (?, ?, ?, 'ANALYSIS_COMMENT', ?, ?)`,
        ).bind(
          newId("audit"),
          user.identityKey,
          `COMMENT_${payload.status}`,
          commentId,
          JSON.stringify({ snapshotId }),
        ),
      );
    } else {
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
