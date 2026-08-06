import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requireApiUser } from "@/lib/current-user";
import { parseScoreRankingDateRange, type ScoreRankingItem } from "@/lib/score-ranking";

type RankingRow = {
  video_id: string;
  title: string;
  brand: string;
  average_score: number;
  valid_review_count: number;
};

export async function GET(request: Request) {
  const user = await requireApiUser(request);
  if (user instanceof Response) return user;
  if (!(await isAppAdmin(user))) {
    return Response.json({ error: "仅管理员可查看评分排行。" }, { status: 403 });
  }

  const url = new URL(request.url);
  let range: ReturnType<typeof parseScoreRankingDateRange>;
  try {
    range = parseScoreRankingDateRange(
      url.searchParams.get("startDate"),
      url.searchParams.get("endDate"),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "日期范围不正确。" },
      { status: 400 },
    );
  }

  const result = await getDbClient()
    .prepare(
      `SELECT
        v.id AS video_id,
        v.title,
        v.brand,
        AVG(r.total_score) AS average_score,
        COUNT(*) AS valid_review_count,
        v.created_at AS uploaded_at
      FROM videos v
      INNER JOIN assignment_reviews r ON r.video_id = v.id
      WHERE v.deleted_at IS NULL
        AND v.created_at >= ? AND v.created_at < ?
        AND r.status = 'SUBMITTED'
        AND r.is_valid_for_aggregate = 1
        AND r.deleted_at IS NULL
      GROUP BY v.id, v.title, v.brand, v.created_at
      ORDER BY average_score DESC, valid_review_count DESC, uploaded_at DESC`,
    )
    .bind(range.start, range.endExclusive)
    .all<RankingRow>();

  const items: ScoreRankingItem[] = result.results.map((row) => ({
    videoId: row.video_id,
    title: row.title,
    brand: row.brand,
    averageScore: Number(row.average_score),
    validReviewCount: Number(row.valid_review_count),
  }));

  return Response.json({ items });
}
