// 案例库互动的纯逻辑：自然周的算法、每周分组排序、星级展示。
// 这个文件不碰数据库，浏览器和服务端共用同一套周口径；写库的部分在
// lib/case-engagement-server.ts。

/** 团队在北京时间上班，周次就按 UTC+8 算，免得服务器时区一换分组就变。 */
const WEEK_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CASE_FAVORITE_BALLOT = "每人每周 1 票" as const;
export const CASE_RATING_MAX_STARS = 5;

export type CaseVersionRating = {
  versionNumber: number;
  ownerName: string;
  stars: number;
};

export type CaseEngagement = {
  /** 案例所属自然周，例如 2026-W36。分组和投票口径都用它。 */
  weekKey: string;
  favoriteCount: number;
  viewerFavorited: boolean;
  ratings: CaseVersionRating[];
};

export function emptyCaseEngagement(weekKey = ""): CaseEngagement {
  return { weekKey, favoriteCount: 0, viewerFavorited: false, ratings: [] };
}

/** 数据库里的时间既有 ISO 串也有 `2026-07-31 07:15:48` 这种旧写法，都按 UTC 读。 */
function parseTimestamp(value: string): Date | null {
  let normalized = value.trim().replace(" ", "T");
  if (!normalized) return null;
  if (!/[zZ]$|[+-]\d{2}(?::?\d{2})?$/.test(normalized)) {
    normalized = `${normalized}Z`;
  } else if (/[+-]\d{2}$/.test(normalized)) {
    normalized = `${normalized}:00`;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function shiftToWeekTimezone(date: Date) {
  return new Date(date.getTime() + WEEK_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
}

/** ISO-8601 周：周一起算，含当年第一个星期四的那一周是第 1 周。 */
function isoWeekOf(shifted: Date) {
  const target = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ));
  const weekdayFromMonday = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - weekdayFromMonday + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3,
  );
  return {
    year: target.getUTCFullYear(),
    week: 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS)),
  };
}

/** 空串表示时间无法识别，调用方据此把这些案例归到「时间未知」一组。 */
export function deriveWeekKey(timestamp: string): string {
  const parsed = parseTimestamp(timestamp);
  if (!parsed) return "";
  const { year, week } = isoWeekOf(shiftToWeekTimezone(parsed));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 周一到周日的 `MM-DD`，用来给周标题加一句「这周是哪几天」。 */
export function weekRangeLabel(weekKey: string): string {
  const matched = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!matched) return "";
  const firstThursday = new Date(Date.UTC(Number(matched[1]), 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7),
  );
  const monday = new Date(firstThursday.getTime() + (Number(matched[2]) - 1) * 7 * DAY_MS);
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  const short = (date: Date) => `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `${short(monday)} ~ ${short(sunday)}`;
}

export function formatWeekTitle(weekKey: string): string {
  const matched = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!matched) return "时间未知";
  return `${matched[1]} 年第 ${Number(matched[2])} 周`;
}

/** 五颗星里点亮几颗。只用于展示，评级本身在别处写入。 */
export function formatStars(stars: number): string {
  const lit = Math.max(0, Math.min(CASE_RATING_MAX_STARS, Math.round(stars)));
  return "★".repeat(lit) + "☆".repeat(CASE_RATING_MAX_STARS - lit);
}

/**
 * 卡片上摆的是这个案例目前拿到的最好成绩——一眼要看到的是这份片子被反写到了什么
 * 水平，而不是版本流水。同分取版本号大的：后写的那一版是在前一版基础上做的。
 */
export function pickTopCaseRating(
  ratings: readonly CaseVersionRating[],
): CaseVersionRating | null {
  if (!ratings.length) return null;
  return ratings.reduce((best, item) => (
    item.stars > best.stars || (item.stars === best.stars && item.versionNumber > best.versionNumber)
      ? item
      : best
  ));
}

export type WeeklyGroup<T> = {
  weekKey: string;
  title: string;
  rangeLabel: string;
  items: T[];
};

/**
 * 按周分组，周从新到旧；周内按收藏数从多到少，同票数时新上传的在前。
 * 时间不可识别的案例统一落在最后一组，不跟正常周混排。
 */
export function groupByWeek<T>(
  items: readonly T[],
  read: (item: T) => { weekKey: string; favoriteCount: number; createdAt: string },
): WeeklyGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const { weekKey } = read(item);
    const bucket = groups.get(weekKey);
    if (bucket) bucket.push(item);
    else groups.set(weekKey, [item]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (!left) return 1;
      if (!right) return -1;
      return right.localeCompare(left);
    })
    .map(([weekKey, bucket]) => ({
      weekKey,
      title: formatWeekTitle(weekKey),
      rangeLabel: weekRangeLabel(weekKey),
      items: [...bucket].sort((left, right) => {
        const a = read(left);
        const b = read(right);
        return b.favoriteCount - a.favoriteCount
          || b.createdAt.localeCompare(a.createdAt);
      }),
    }));
}

export type CaseFavoriteToggleResult = {
  weekKey: string;
  favorited: boolean;
  videoId: string;
  favoriteCount: number;
  /** 改投时被让出去的那部片子，前端据此把它的计数减回去。 */
  releasedVideoId: string | null;
  releasedFavoriteCount: number;
};
