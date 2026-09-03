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
// pg 把 `timestamptz` 解析成 JS Date，`String(date)` 得到的是
// Date.prototype.toString()，不是 ISO——`V19ReviewComment` 的 formatShortDateTime
// 认不出这种格式，评论气泡里的时间就会显示「未知时间」。这条转换是纯函数、
// 不碰视频专属的表，直接复用视频侧同一个实现，不在报告侧另抄一份。
import { toIsoTimestamp } from "@/lib/case-review-server";

export type ReportReviewViewer = { userId: string; displayName: string };

type VersionRow = QueryResultRow & { id: string; report_id: string };
type VersionWithNumberRow = VersionRow & { version_number: number };
type RatingRow = QueryResultRow & { stars: number };
type SavedCommentRow = QueryResultRow & {
  target_key: string;
  target_label: string;
  body: string;
  author_name: string;
  updated_at: string;
};
type CommentRow = SavedCommentRow & {
  version_id: string;
  /** `LEFT JOIN report_versions` 联查所得；为 null 的评论写在集成版上。 */
  version_number: number | null;
};

/**
 * 版本必须真属于这份报告才继续。否则一个能读 A 报告的人，
 * 就能拿 B 报告的版本号往这里写评语。带上 version_number 是因为
 * `saveReportReviewComment` 要用它拼评论的 `versionLabel`（`v${number}`）。
 * 只用于评分（星级只锚定普通版本，集成版不评分，见 loadReportReview）。
 */
async function requireVersionOfReport(db: DbClient, reportId: string, versionId: string) {
  const row = await db
    .prepare("SELECT id, report_id, version_number FROM report_versions WHERE id = ?")
    .bind(versionId.trim())
    .first<VersionWithNumberRow>();
  if (!row || row.report_id !== reportId) {
    throw new Error("指定的版本不存在。");
  }
  return row;
}

/**
 * 评论现在可能锚定在集成版上，集成版的 id 不在 `report_versions` 里，
 * 所以校验分两步：先当普通版本查，查不到再当集成版查。两处都查不到才拒绝——
 * 这样一个能读 A 报告的人依旧不能拿 B 报告的版本号／集成版 id 往这里写评语。
 * 照抄视频侧 `lib/case-review-server.ts` 的 `requireCommentVersionOfVideo` 写法
 * （见 docs/21_报告集成版_实施规格_V0.1.md 四、4.4）。
 */
async function requireCommentVersionOfReport(
  db: DbClient,
  reportId: string,
  versionId: string,
): Promise<{ id: string; label: string }> {
  const trimmed = versionId.trim();
  const version = await db
    .prepare("SELECT id, report_id, version_number FROM report_versions WHERE id = ?")
    .bind(trimmed)
    .first<VersionWithNumberRow>();
  if (version && version.report_id === reportId) {
    return { id: version.id, label: `v${version.version_number}` };
  }
  const final = await db
    .prepare("SELECT id FROM report_final_versions WHERE id = ? AND report_id = ?")
    .bind(trimmed, reportId)
    .first<VersionRow>();
  if (final) return { id: final.id, label: "集成版" };
  throw new Error("指定的版本不存在。");
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

  // 星级仍只锚定 `?version=` 指定的那一版；报告没有集成版这种"不在
  // report_versions 里的 id"，但版本也可能还没落库（新版本尚未保存过）——
  // 两种情况都归一为"找不到就是不能评分"，与视频侧 loadCaseReview 同一条规则。
  let ratableVersionId: string | null = null;
  if (versionId) {
    const version = await db
      .prepare("SELECT id, report_id FROM report_versions WHERE id = ?")
      .bind(versionId)
      .first<VersionRow>();
    if (version && version.report_id === input.reportId) ratableVersionId = versionId;
  }
  const canRate = ratableVersionId != null;

  // 评论不再按单一版本取：不管正看着哪一版，都汇总显示这份报告所有版本上的评论
  // （对齐视频侧 loadCaseReview，见 `docs/20_最终版与评论跨版本_实施规格_V0.1.md` 一之 2）。
  const [rating, comments] = await Promise.all([
    ratableVersionId
      ? db.prepare("SELECT stars FROM report_version_ratings WHERE version_id = ?")
        .bind(ratableVersionId).first<RatingRow>()
      : Promise.resolve(null),
    db.prepare(
      `SELECT c.target_key, c.target_label, c.body, c.author_name, c.updated_at,
        c.version_id, v.version_number
      FROM report_version_comments c
      LEFT JOIN report_versions v ON v.id = c.version_id
      WHERE c.report_id = ?
      ORDER BY c.updated_at ASC`,
    ).bind(input.reportId).all<CommentRow>(),
  ]);
  return {
    canReview,
    versionId: versionId || null,
    stars: rating ? Number(rating.stars) : null,
    canRate,
    comments: comments.results.map(
      (row): CaseReviewComment => ({
        targetKey: row.target_key,
        targetLabel: row.target_label,
        body: row.body,
        authorName: row.author_name,
        updatedAt: toIsoTimestamp(row.updated_at),
        versionId: row.version_id,
        // `report_versions` 里找不到（联查落空）的评论写在集成版上。
        versionLabel: row.version_number != null ? `v${row.version_number}` : "集成版",
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
  // 普通版本或集成版都行——写下去锚定的是当前正在看的那一版。
  const version = await requireCommentVersionOfReport(db, input.reportId, input.versionId);
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
    .first<SavedCommentRow>();
  return {
    comment: saved
      ? {
          targetKey: saved.target_key,
          targetLabel: saved.target_label,
          body: saved.body,
          authorName: saved.author_name,
          updatedAt: toIsoTimestamp(saved.updated_at),
          // 版本标签从 requireCommentVersionOfReport 已经查出来的那一行取，不用再联查一次。
          versionId: version.id,
          versionLabel: version.label,
        }
      : null,
  };
}
