// 报告评审的读写：版本星级与逐条目评论。与 lib/case-review-server.ts 同构，
// 只把外键从 videos/analysis_versions 换成 reports/report_versions；
// isCaseReviewer（"老孙"规则）与评分/评论的纯校验直接复用 lib/case-review.ts，
// 不重新定义一遍评审身份。

import type { DbClient, QueryResultRow } from "@/db";
import {
  isCaseReviewer,
  normalizeReviewComment,
  normalizeReviewStars,
  type CaseReviewComment,
  type CaseReviewModel,
} from "@/lib/case-review";

export type ReportReviewViewer = { userId: string; displayName: string };

type VersionRow = QueryResultRow & { id: string; report_id: string };
type RatingRow = QueryResultRow & { stars: number };
type CommentRow = QueryResultRow & {
  target_key: string;
  target_label: string;
  body: string;
  author_name: string;
  updated_at: string;
};

/**
 * 版本必须真属于这份报告才继续。否则一个能读 A 报告的人，
 * 就能拿 B 报告的版本号往这里写评语。
 */
async function requireVersionOfReport(db: DbClient, reportId: string, versionId: string) {
  const row = await db
    .prepare("SELECT id, report_id FROM report_versions WHERE id = ?")
    .bind(versionId.trim())
    .first<VersionRow>();
  if (!row || row.report_id !== reportId) {
    throw new Error("指定的版本不存在。");
  }
  return row;
}

function requireReviewer(viewer: ReportReviewViewer) {
  if (!isCaseReviewer(viewer.displayName)) {
    throw new Error("只有评审可以评分和评论。");
  }
}

export async function loadReportReview(
  db: DbClient,
  input: { reportId: string; versionId: string | null; viewer: ReportReviewViewer },
): Promise<CaseReviewModel> {
  const canReview = isCaseReviewer(input.viewer.displayName);
  const versionId = input.versionId?.trim() || "";
  if (!versionId) return { canReview, versionId: null, stars: null, comments: [] };
  const version = await db
    .prepare("SELECT id, report_id FROM report_versions WHERE id = ?")
    .bind(versionId)
    .first<VersionRow>();
  // 版本还没落库（新版本尚未保存过）时不是错误，只是还没有可评的东西。
  if (!version || version.report_id !== input.reportId) {
    return { canReview, versionId: null, stars: null, comments: [] };
  }
  const [rating, comments] = await Promise.all([
    db.prepare("SELECT stars FROM report_version_ratings WHERE version_id = ?").bind(versionId).first<RatingRow>(),
    db
      .prepare(
        `SELECT target_key, target_label, body, author_name, updated_at
        FROM report_version_comments WHERE version_id = ?
        ORDER BY updated_at ASC`,
      )
      .bind(versionId)
      .all<CommentRow>(),
  ]);
  return {
    canReview,
    versionId,
    stars: rating ? Number(rating.stars) : null,
    comments: comments.results.map(
      (row): CaseReviewComment => ({
        targetKey: row.target_key,
        targetLabel: row.target_label,
        body: row.body,
        authorName: row.author_name,
        updatedAt: String(row.updated_at),
      }),
    ),
  };
}

/** stars 为 0 表示撤销评分——评错了要能收回，否则只能改成另一个错分数。 */
export async function saveReportReviewRating(
  db: DbClient,
  input: { reportId: string; versionId: string; stars: unknown; viewer: ReportReviewViewer },
): Promise<{ stars: number | null }> {
  requireReviewer(input.viewer);
  const stars = normalizeReviewStars(input.stars);
  const version = await requireVersionOfReport(db, input.reportId, input.versionId);
  if (stars === 0) {
    await db.prepare("DELETE FROM report_version_ratings WHERE version_id = ?").bind(version.id).run();
    return { stars: null };
  }
  await db
    .prepare(
      `INSERT INTO report_version_ratings (version_id, report_id, stars, rated_by_user_id, rated_by_name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (version_id) DO UPDATE SET
        stars = EXCLUDED.stars,
        rated_by_user_id = EXCLUDED.rated_by_user_id,
        rated_by_name = EXCLUDED.rated_by_name,
        updated_at = now()`,
    )
    .bind(version.id, input.reportId, stars, input.viewer.userId, input.viewer.displayName)
    .run();
  return { stars };
}

/** 正文清空即删除这条评论——评论收回和写评论是同一个动作的两端。 */
export async function saveReportReviewComment(
  db: DbClient,
  input: {
    reportId: string;
    versionId: string;
    targetKey: string;
    targetLabel: string;
    body: unknown;
    viewer: ReportReviewViewer;
  },
): Promise<{ comment: CaseReviewComment | null }> {
  requireReviewer(input.viewer);
  const targetKey = input.targetKey.trim();
  if (!targetKey) throw new Error("评论缺少对应条目。");
  const body = normalizeReviewComment(input.body);
  const version = await requireVersionOfReport(db, input.reportId, input.versionId);
  if (!body) {
    await db
      .prepare("DELETE FROM report_version_comments WHERE version_id = ? AND target_key = ?")
      .bind(version.id, targetKey)
      .run();
    return { comment: null };
  }
  const targetLabel = (input.targetLabel ?? "").trim().slice(0, 120);
  const saved = await db
    .prepare(
      `INSERT INTO report_version_comments (
        version_id, target_key, report_id, target_label, body, author_user_id, author_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (version_id, target_key) DO UPDATE SET
        body = EXCLUDED.body,
        target_label = EXCLUDED.target_label,
        author_user_id = EXCLUDED.author_user_id,
        author_name = EXCLUDED.author_name,
        updated_at = now()
      RETURNING target_key, target_label, body, author_name, updated_at`,
    )
    .bind(version.id, targetKey, input.reportId, targetLabel, body, input.viewer.userId, input.viewer.displayName)
    .first<CommentRow>();
  return {
    comment: saved
      ? {
          targetKey: saved.target_key,
          targetLabel: saved.target_label,
          body: saved.body,
          authorName: saved.author_name,
          updatedAt: String(saved.updated_at),
        }
      : null,
  };
}
