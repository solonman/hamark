// 案例库互动的读写：收藏票和版本星级。周口径全部来自 lib/case-engagement.ts，
// 服务端不另算一套，避免前后端对「这是哪一周」有两种说法。

import type { DbClient, QueryResultRow } from "@/db";
import {
  CASE_BALLOT_EXHAUSTED_MESSAGE,
  CASE_WEEKLY_BALLOT_LIMIT,
  deriveWeekKey,
  emptyCaseEngagement,
  firstFreeBallotSlot,
  type CaseEngagement,
  type CaseFavoriteToggleResult,
} from "@/lib/case-engagement";

type VideoWeekRow = QueryResultRow & { id: string; created_at: string };
type FavoriteCountRow = QueryResultRow & { video_id: string; favorite_count: number };
type ViewerFavoriteRow = QueryResultRow & { video_id: string };
type BallotRow = QueryResultRow & { slot: number; video_id: string };
type RatingRow = QueryResultRow & {
  video_id: string;
  version_number: number;
  owner_name_snapshot: string;
  stars: number;
};

const uniqueIds = (videoIds: readonly string[]) =>
  [...new Set(videoIds.map((item) => item.trim()).filter(Boolean))];

/** 只读取还在库里的案例；已删除的片子不该再出现在任何一周里。 */
async function loadVideoWeeks(db: DbClient, videoIds: string[]) {
  const placeholders = videoIds.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT id, created_at FROM videos
    WHERE id IN (${placeholders})
      AND deleted_at IS NULL
      AND COALESCE(deletion_state, 'ACTIVE') NOT IN ('TRASHED', 'ASSET_PURGED')`,
  ).bind(...videoIds).all<VideoWeekRow>();
  return new Map(rows.results.map((row) => [row.id, deriveWeekKey(String(row.created_at))]));
}

export async function loadCaseEngagement(
  db: DbClient,
  videoIds: readonly string[],
  viewerUserId: string,
): Promise<Record<string, CaseEngagement>> {
  const ids = uniqueIds(videoIds);
  if (!ids.length) return {};
  const placeholders = ids.map(() => "?").join(", ");
  const [weeks, counts, mine, ratings] = await Promise.all([
    loadVideoWeeks(db, ids),
    db.prepare(
      `SELECT video_id, COUNT(*)::integer AS favorite_count
      FROM case_weekly_favorites
      WHERE video_id IN (${placeholders})
      GROUP BY video_id`,
    ).bind(...ids).all<FavoriteCountRow>(),
    db.prepare(
      `SELECT video_id FROM case_weekly_favorites
      WHERE user_id = ? AND video_id IN (${placeholders})`,
    ).bind(viewerUserId, ...ids).all<ViewerFavoriteRow>(),
    db.prepare(
      `SELECT r.video_id, v.version_number, v.owner_name_snapshot, r.stars
      FROM analysis_version_ratings r
      JOIN analysis_versions v ON v.id = r.version_id
      WHERE r.video_id IN (${placeholders})
      ORDER BY r.video_id ASC, v.version_number ASC`,
    ).bind(...ids).all<RatingRow>(),
  ]);

  const countByVideo = new Map(counts.results.map((row) => [row.video_id, Number(row.favorite_count)]));
  const minePerVideo = new Set(mine.results.map((row) => row.video_id));
  const engagement: Record<string, CaseEngagement> = {};
  for (const videoId of ids) {
    const weekKey = weeks.get(videoId);
    if (weekKey === undefined) continue;
    engagement[videoId] = {
      ...emptyCaseEngagement(weekKey),
      favoriteCount: countByVideo.get(videoId) ?? 0,
      viewerFavorited: minePerVideo.has(videoId),
    };
  }
  for (const row of ratings.results) {
    engagement[row.video_id]?.ratings.push({
      versionNumber: Number(row.version_number),
      ownerName: row.owner_name_snapshot,
      stars: Number(row.stars),
    });
  }
  return engagement;
}

async function countFavorites(db: DbClient, videoId: string) {
  const row = await db.prepare(
    "SELECT COUNT(*)::integer AS favorite_count FROM case_weekly_favorites WHERE video_id = ?",
  ).bind(videoId).first<FavoriteCountRow>();
  return Number(row?.favorite_count ?? 0);
}

/**
 * 投票或撤票：再点一次自己已投的片子就是撤票，点没投过的片子就是用掉一张新票。
 * 一周三票，一部片最多收下同一个人的一票；三票用完之后再点第四部直接拒绝——
 * 该让出哪一票只有本人知道，替他挑一票顶掉，票会在他没察觉的时候消失。
 */
export async function toggleCaseFavorite(
  db: DbClient,
  input: { videoId: string; userId: string },
): Promise<CaseFavoriteToggleResult> {
  const videoId = input.videoId.trim();
  const weeks = await loadVideoWeeks(db, [videoId]);
  const weekKey = weeks.get(videoId);
  if (!weekKey) {
    throw new Error("该案例不可收藏。");
  }
  return db.withTransaction(async (transaction) => {
    // 空票位是数出来的，而行锁锁不住还不存在的行：两个并发请求会数出同一个空位，
    // 一个插入成功另一个撞主键报错。锁「这个人这一周」本身，两次投票就排成队。
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")
      .bind(`case-weekly-ballot:${input.userId}:${weekKey}`).run();
    const held = await transaction.prepare(
      `SELECT slot, video_id FROM case_weekly_favorites
      WHERE user_id = ? AND week_key = ? ORDER BY slot ASC`,
    ).bind(input.userId, weekKey).all<BallotRow>();
    const ballots = held.results;
    if (ballots.some((row) => row.video_id === videoId)) {
      await transaction.prepare(
        "DELETE FROM case_weekly_favorites WHERE user_id = ? AND week_key = ? AND video_id = ?",
      ).bind(input.userId, weekKey, videoId).run();
      return {
        weekKey,
        favorited: false,
        videoId,
        favoriteCount: await countFavorites(transaction, videoId),
        usedBallots: ballots.length - 1,
        ballotLimit: CASE_WEEKLY_BALLOT_LIMIT,
      };
    }
    const slot = firstFreeBallotSlot(ballots.map((row) => Number(row.slot)));
    if (!slot) {
      throw new Error(CASE_BALLOT_EXHAUSTED_MESSAGE);
    }
    await transaction.prepare(
      `INSERT INTO case_weekly_favorites (user_id, week_key, slot, video_id)
      VALUES (?, ?, ?, ?)`,
    ).bind(input.userId, weekKey, slot, videoId).run();
    return {
      weekKey,
      favorited: true,
      videoId,
      favoriteCount: await countFavorites(transaction, videoId),
      usedBallots: ballots.length + 1,
      ballotLimit: CASE_WEEKLY_BALLOT_LIMIT,
    };
  });
}
