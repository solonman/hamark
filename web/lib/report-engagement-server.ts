// 报告库互动的读写：收藏票和版本星级。与 lib/case-engagement-server.ts 同构，
// 只把外键从 videos/analysis_versions 换成 reports/report_versions。
// 周口径仍然复用 lib/case-engagement.ts，服务端不另算一套。
// 票数口径也一样：每人每周三票，一份报告最多收下同一个人的一票。
// 与案例库不同的一条规则（规格 2.4）：未就绪（未 READY）的报告不能收藏。

import type { DbClient, QueryResultRow } from "@/db";
import {
  CASE_BALLOT_EXHAUSTED_MESSAGE,
  CASE_WEEKLY_BALLOT_LIMIT,
  deriveWeekKey,
  emptyCaseEngagement,
  firstFreeBallotSlot,
  type CaseEngagement,
} from "@/lib/case-engagement";
import { isReportReady } from "@/lib/report-model";

type ReportWeekRow = QueryResultRow & { id: string; created_at: string; status: string };
type FavoriteCountRow = QueryResultRow & { report_id: string; favorite_count: number };
type ViewerFavoriteRow = QueryResultRow & { report_id: string };
type BallotRow = QueryResultRow & { slot: number; report_id: string };
type RatingRow = QueryResultRow & {
  report_id: string;
  version_number: number;
  owner_name_snapshot: string;
  stars: number;
};

export type ReportFavoriteToggleResult = {
  weekKey: string;
  favorited: boolean;
  reportId: string;
  favoriteCount: number;
  /** 这一周投完之后一共用掉几票，前端据此更新「还剩几票」。 */
  usedBallots: number;
  ballotLimit: number;
};

const uniqueIds = (reportIds: readonly string[]) =>
  [...new Set(reportIds.map((item) => item.trim()).filter(Boolean))];

/** 只读取还在库里的报告；已删除的报告不该再出现在任何一周里。 */
async function loadReportWeeks(db: DbClient, reportIds: string[]) {
  if (!reportIds.length) return new Map<string, { weekKey: string; status: string }>();
  const placeholders = reportIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT id, created_at, status FROM reports
      WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .bind(...reportIds)
    .all<ReportWeekRow>();
  return new Map(
    rows.results.map((row) => [row.id, { weekKey: deriveWeekKey(String(row.created_at)), status: row.status }]),
  );
}

export async function loadReportEngagement(
  db: DbClient,
  reportIds: readonly string[],
  viewerUserId: string,
): Promise<Record<string, CaseEngagement>> {
  const ids = uniqueIds(reportIds);
  if (!ids.length) return {};
  const placeholders = ids.map(() => "?").join(", ");
  const [weeks, counts, mine, ratings] = await Promise.all([
    loadReportWeeks(db, ids),
    db
      .prepare(
        `SELECT report_id, COUNT(*)::integer AS favorite_count
        FROM report_weekly_favorites
        WHERE report_id IN (${placeholders})
        GROUP BY report_id`,
      )
      .bind(...ids)
      .all<FavoriteCountRow>(),
    db
      .prepare(
        `SELECT report_id FROM report_weekly_favorites
        WHERE user_id = ? AND report_id IN (${placeholders})`,
      )
      .bind(viewerUserId, ...ids)
      .all<ViewerFavoriteRow>(),
    db
      .prepare(
        `SELECT r.report_id, v.version_number, v.owner_name_snapshot, r.stars
        FROM report_version_ratings r
        JOIN report_versions v ON v.id = r.version_id
        WHERE r.report_id IN (${placeholders})
        ORDER BY r.report_id ASC, v.version_number ASC`,
      )
      .bind(...ids)
      .all<RatingRow>(),
  ]);

  const countByReport = new Map(counts.results.map((row) => [row.report_id, Number(row.favorite_count)]));
  const minePerReport = new Set(mine.results.map((row) => row.report_id));
  const engagement: Record<string, CaseEngagement> = {};
  for (const reportId of ids) {
    const week = weeks.get(reportId);
    if (!week) continue;
    engagement[reportId] = {
      ...emptyCaseEngagement(week.weekKey),
      favoriteCount: countByReport.get(reportId) ?? 0,
      viewerFavorited: minePerReport.has(reportId),
    };
  }
  for (const row of ratings.results) {
    engagement[row.report_id]?.ratings.push({
      versionNumber: Number(row.version_number),
      ownerName: row.owner_name_snapshot,
      stars: Number(row.stars),
    });
  }
  return engagement;
}

async function countFavorites(db: DbClient, reportId: string) {
  const row = await db
    .prepare("SELECT COUNT(*)::integer AS favorite_count FROM report_weekly_favorites WHERE report_id = ?")
    .bind(reportId)
    .first<FavoriteCountRow>();
  return Number(row?.favorite_count ?? 0);
}

/**
 * 投票或撤票，做法与案例库一致（见 lib/case-engagement-server.ts 的
 * toggleCaseFavorite）：一周三票，一份报告最多收下同一个人的一票，三票用完
 * 之后再点第四份直接拒绝。多出的一条规则是：页图还没生成的报告（非 READY）
 * 也直接拒绝——规格 2.4「未就绪的报告不能收藏」。
 */
export async function toggleReportFavorite(
  db: DbClient,
  input: { reportId: string; userId: string },
): Promise<ReportFavoriteToggleResult> {
  const reportId = input.reportId.trim();
  const weeks = await loadReportWeeks(db, [reportId]);
  const week = weeks.get(reportId);
  if (!week) {
    throw new Error("该报告不可收藏。");
  }
  if (!isReportReady(week.status)) {
    throw new Error("报告尚未就绪，暂时不能收藏。");
  }
  return db.withTransaction(async (transaction) => {
    // 锁「这个人这一周」本身：空票位是数出来的，行锁锁不住还不存在的行。
    await transaction
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
      .bind(`report-weekly-ballot:${input.userId}:${week.weekKey}`)
      .run();
    const held = await transaction
      .prepare(
        `SELECT slot, report_id FROM report_weekly_favorites
        WHERE user_id = ? AND week_key = ? ORDER BY slot ASC`,
      )
      .bind(input.userId, week.weekKey)
      .all<BallotRow>();
    const ballots = held.results;
    if (ballots.some((row) => row.report_id === reportId)) {
      await transaction
        .prepare("DELETE FROM report_weekly_favorites WHERE user_id = ? AND week_key = ? AND report_id = ?")
        .bind(input.userId, week.weekKey, reportId)
        .run();
      return {
        weekKey: week.weekKey,
        favorited: false,
        reportId,
        favoriteCount: await countFavorites(transaction, reportId),
        usedBallots: ballots.length - 1,
        ballotLimit: CASE_WEEKLY_BALLOT_LIMIT,
      };
    }
    const slot = firstFreeBallotSlot(ballots.map((row) => Number(row.slot)));
    if (!slot) {
      throw new Error(CASE_BALLOT_EXHAUSTED_MESSAGE);
    }
    await transaction
      .prepare(
        `INSERT INTO report_weekly_favorites (user_id, week_key, slot, report_id)
        VALUES (?, ?, ?, ?)`,
      )
      .bind(input.userId, week.weekKey, slot, reportId)
      .run();
    return {
      weekKey: week.weekKey,
      favorited: true,
      reportId,
      favoriteCount: await countFavorites(transaction, reportId),
      usedBallots: ballots.length + 1,
      ballotLimit: CASE_WEEKLY_BALLOT_LIMIT,
    };
  });
}
