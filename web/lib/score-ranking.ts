export type ScoreRankingItem = {
  videoId: string;
  title: string;
  brand: string;
  averageScore: number;
  validReviewCount: number;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseUtcDate(value: string) {
  if (!datePattern.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

export function parseScoreRankingDateRange(startDate: string | null, endDate: string | null) {
  const start = startDate ? parseUtcDate(startDate) : null;
  const end = endDate ? parseUtcDate(endDate) : null;
  if (!start || !end) {
    throw new Error("请选择有效的起止日期。");
  }
  if (start > end) {
    throw new Error("起始日期不能晚于结束日期。");
  }
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), endExclusive: end.toISOString() };
}
