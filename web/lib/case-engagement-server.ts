// 案例库互动的读写：收藏票和版本星级。周口径全部来自 lib/case-engagement.ts，
// 服务端不另算一套，避免前后端对「这是哪一周」有两种说法。

import type { DbClient, QueryResultRow } from "@/db";
import {
  deriveWeekKey,
  emptyCaseEngagement,
  type CaseEngagement,
  type CaseFavoriteToggleResult,
} from "@/lib/case-engagement";

type VideoWeekRow = QueryResultRow & { id: string; created_at: string };
type FavoriteCountRow = QueryResultRow & { video_id: string; favorite_count: number };
type ViewerFavoriteRow = QueryResultRow & { video_id: string };
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
 * 投票、改投或撤票，三种情况共用一个动作：再点一次自己已收藏的片子就是撤票，
 * 点同一周的另一部片子就是把这张票挪过去。主键 (user_id, week_key) 保证
 * 一周只留得下一行，改投永远不会变成两票。
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
    const existing = await transaction.prepare(
      "SELECT video_id FROM case_weekly_favorites WHERE user_id = ? AND week_key = ? FOR UPDATE",
    ).bind(input.userId, weekKey).first<ViewerFavoriteRow>();
    const previousVideoId = existing?.video_id ?? null;
    if (previousVideoId === videoId) {
      await transaction.prepare(
        "DELETE FROM case_weekly_favorites WHERE user_id = ? AND week_key = ?",
      ).bind(input.userId, weekKey).run();
      return {
        weekKey,
        favorited: false,
        videoId,
        favoriteCount: await countFavorites(transaction, videoId),
        releasedVideoId: null,
        releasedFavoriteCount: 0,
      };
    }
    await transaction.prepare(
      `INSERT INTO case_weekly_favorites (user_id, week_key, video_id)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id, week_key)
      DO UPDATE SET video_id = EXCLUDED.video_id, updated_at = now()`,
    ).bind(input.userId, weekKey, videoId).run();
    return {
      weekKey,
      favorited: true,
      videoId,
      favoriteCount: await countFavorites(transaction, videoId),
      releasedVideoId: previousVideoId,
      releasedFavoriteCount: previousVideoId
        ? await countFavorites(transaction, previousVideoId)
        : 0,
    };
  });
}
