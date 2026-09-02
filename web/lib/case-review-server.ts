// 作业评审的读写：版本星级与逐条目评论。
// 权限只有一条规则——只有评审本人能写，其他登录用户只能读。

import type { DbClient, QueryResultRow } from "@/db";
import {
  isCaseReviewer,
  normalizeReviewComment,
  normalizeReviewStars,
  type CaseReviewComment,
  type CaseReviewModel,
} from "@/lib/case-review";
import { parseDatabaseDate } from "@/lib/date-format";

/**
 * `analysis_version_comments.updated_at` 是 `timestamptz`；pg 驱动把它解析成
 * JS `Date`，不是字符串。`String(date)` 会得到
 * `Date.prototype.toString()`（"Tue Sep 01 2026 14:31:39 GMT+0800 ..."），
 * 前端 `lib/date-format.ts` 的 `parseDatabaseDate` 认不出这种格式，
 * 于是评论气泡里的时间全显示「未知时间」。统一转成 ISO 字符串：
 * 是 `Date` 直接 `toISOString()`；是字符串（某些查询路径／测试桩会给字符串）
 * 交给 `parseDatabaseDate` 兜底 PostgreSQL 常见的 `YYYY-MM-DD HH:mm:ss+TZ`
 * 写法再转 ISO；两者都不行就原样返回，不该因为一个解析不出的时间戳
 * 打挂整个评审读取。
 */
export function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return parseDatabaseDate(value)?.toISOString() ?? value;
  }
  return String(value);
}

export type CaseReviewViewer = { userId: string; displayName: string };

type VersionRow = QueryResultRow & { id: string; video_id: string };
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
  /** `LEFT JOIN analysis_versions` 联查所得；为 null 的评论写在集成版上。 */
  version_number: number | null;
};

/**
 * 版本必须真属于这个案例才继续。否则一个能读 A 案例的人，
 * 就能拿 B 案例的版本号往这里写评语。
 */
async function requireVersionOfVideo(db: DbClient, videoId: string, versionId: string) {
  const row = await db.prepare(
    "SELECT id, video_id FROM analysis_versions WHERE id = ?",
  ).bind(versionId.trim()).first<VersionRow>();
  if (!row || row.video_id !== videoId) {
    throw new Error("指定的版本不存在。");
  }
  return row;
}

/**
 * 评论现在可能锚定在集成版上，集成版的 id 不在 `analysis_versions` 里，
 * 所以校验分两步：先当普通版本查，查不到再当集成版查。两处都查不到才拒绝——
 * 这样一个能读 A 案例的人依旧不能拿 B 案例的版本号／集成版 id 往这里写评语。
 *
 * `analysis_final_versions` 由同一批改动新增（见 `docs/20_..._V0.1.md` 二），
 * 本机若还没跑过那张表的 migration，这条 SELECT 落空是正常的失败，不是 bug。
 */
async function requireCommentVersionOfVideo(
  db: DbClient,
  videoId: string,
  versionId: string,
): Promise<{ id: string; label: string }> {
  const trimmed = versionId.trim();
  const version = await db.prepare(
    "SELECT id, video_id, version_number FROM analysis_versions WHERE id = ?",
  ).bind(trimmed).first<VersionWithNumberRow>();
  if (version && version.video_id === videoId) {
    return { id: version.id, label: `v${version.version_number}` };
  }
  const final = await db.prepare(
    "SELECT id FROM analysis_final_versions WHERE id = ? AND video_id = ?",
  ).bind(trimmed, videoId).first<VersionRow>();
  if (final) return { id: final.id, label: "集成版" };
  throw new Error("指定的版本不存在。");
}

function requireReviewer(viewer: CaseReviewViewer) {
  if (!isCaseReviewer(viewer.displayName)) {
    throw new Error("只有评审可以评分和评论。");
  }
}

export async function loadCaseReview(
  db: DbClient,
  input: { videoId: string; versionId: string | null; viewer: CaseReviewViewer },
): Promise<CaseReviewModel> {
  const canReview = isCaseReviewer(input.viewer.displayName);
  const versionId = input.versionId?.trim() || "";

  // 星级仍只锚定 `?version=` 指定的那一版；只有普通版本能评分——
  // 找不到（含集成版，其 id 不在 `analysis_versions` 里）就是不能评分。
  let ratableVersionId: string | null = null;
  if (versionId) {
    const version = await db.prepare(
      "SELECT id, video_id FROM analysis_versions WHERE id = ?",
    ).bind(versionId).first<VersionRow>();
    if (version && version.video_id === input.videoId) ratableVersionId = versionId;
  }
  const canRate = ratableVersionId != null;

  // 评论不再按单一版本取：不管正看着哪一版，都汇总显示这个案例所有版本上的评论。
  const [rating, comments] = await Promise.all([
    ratableVersionId
      ? db.prepare("SELECT stars FROM analysis_version_ratings WHERE version_id = ?")
        .bind(ratableVersionId).first<RatingRow>()
      : Promise.resolve(null),
    db.prepare(
      `SELECT c.target_key, c.target_label, c.body, c.author_name, c.updated_at,
        c.version_id, av.version_number
      FROM analysis_version_comments c
      LEFT JOIN analysis_versions av ON av.id = c.version_id
      WHERE c.video_id = ?
      ORDER BY c.updated_at ASC`,
    ).bind(input.videoId).all<CommentRow>(),
  ]);
  return {
    canReview,
    versionId: versionId || null,
    stars: rating ? Number(rating.stars) : null,
    canRate,
    comments: comments.results.map((row) => ({
      targetKey: row.target_key,
      targetLabel: row.target_label,
      body: row.body,
      authorName: row.author_name,
      updatedAt: toIsoTimestamp(row.updated_at),
      versionId: row.version_id,
      // `analysis_versions` 里找不到（联查落空）的评论写在集成版上。
      versionLabel: row.version_number != null ? `v${row.version_number}` : "集成版",
    } satisfies CaseReviewComment)),
  };
}

/** stars 为 0 表示撤销评分——评错了要能收回，否则只能改成另一个错分数。 */
export async function saveCaseReviewRating(
  db: DbClient,
  input: { videoId: string; versionId: string; stars: unknown; viewer: CaseReviewViewer },
): Promise<{ stars: number | null }> {
  requireReviewer(input.viewer);
  const stars = normalizeReviewStars(input.stars);
  const version = await requireVersionOfVideo(db, input.videoId, input.versionId);
  if (stars === 0) {
    await db.prepare("DELETE FROM analysis_version_ratings WHERE version_id = ?")
      .bind(version.id).run();
    return { stars: null };
  }
  await db.prepare(
    `INSERT INTO analysis_version_ratings (version_id, video_id, stars, rated_by_user_id, rated_by_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (version_id) DO UPDATE SET
      stars = EXCLUDED.stars,
      rated_by_user_id = EXCLUDED.rated_by_user_id,
      rated_by_name = EXCLUDED.rated_by_name,
      updated_at = now()`,
  ).bind(version.id, input.videoId, stars, input.viewer.userId, input.viewer.displayName).run();
  return { stars };
}

/** 正文清空即删除这条评论——评论收回和写评论是同一个动作的两端。 */
export async function saveCaseReviewComment(
  db: DbClient,
  input: {
    videoId: string;
    versionId: string;
    targetKey: string;
    targetLabel: string;
    body: unknown;
    viewer: CaseReviewViewer;
  },
): Promise<{ comment: CaseReviewComment | null }> {
  requireReviewer(input.viewer);
  const targetKey = input.targetKey.trim();
  if (!targetKey) throw new Error("评论缺少对应条目。");
  const body = normalizeReviewComment(input.body);
  // 普通版本或集成版都行——写下去锚定的是当前正在看的那一版。
  const version = await requireCommentVersionOfVideo(db, input.videoId, input.versionId);
  if (!body) {
    await db.prepare(
      "DELETE FROM analysis_version_comments WHERE version_id = ? AND target_key = ?",
    ).bind(version.id, targetKey).run();
    return { comment: null };
  }
  const targetLabel = (input.targetLabel ?? "").trim().slice(0, 120);
  const saved = await db.prepare(
    `INSERT INTO analysis_version_comments (
      version_id, target_key, video_id, target_label, body, author_user_id, author_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (version_id, target_key) DO UPDATE SET
      body = EXCLUDED.body,
      target_label = EXCLUDED.target_label,
      author_user_id = EXCLUDED.author_user_id,
      author_name = EXCLUDED.author_name,
      updated_at = now()
    RETURNING target_key, target_label, body, author_name, updated_at`,
  ).bind(
    version.id, targetKey, input.videoId, targetLabel, body,
    input.viewer.userId, input.viewer.displayName,
  ).first<SavedCommentRow>();
  return {
    comment: saved ? {
      targetKey: saved.target_key,
      targetLabel: saved.target_label,
      body: saved.body,
      authorName: saved.author_name,
      updatedAt: toIsoTimestamp(saved.updated_at),
      versionId: version.id,
      versionLabel: version.label,
    } : null,
  };
}
