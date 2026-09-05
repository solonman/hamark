// 案例库互动的纯逻辑：自然周的算法、每周分组排序、星级展示。
// 这个文件不碰数据库，浏览器和服务端共用同一套周口径；写库的部分在
// lib/case-engagement-server.ts。

/** 团队在北京时间上班，周次就按 UTC+8 算，免得服务器时区一换分组就变。 */
const WEEK_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 一个人一周能投几票。三票是「挑出这周值得看的几支」，不是「给最喜欢的那支加权」——
 * 所以一部片最多收一个人的一票，三票必须落在三部不同的片上（库表的
 * UNIQUE (user_id, week_key, video_id) 兜住这一条）。
 */
export const CASE_WEEKLY_BALLOT_LIMIT = 3;
export const CASE_FAVORITE_BALLOT = `每人每周 ${CASE_WEEKLY_BALLOT_LIMIT} 票` as const;
export const CASE_RATING_MAX_STARS = 5;

/** 票投完了就直说，不去猜该顶掉哪一票——哪一票该让位只有本人知道。 */
export const CASE_BALLOT_EXHAUSTED_MESSAGE =
  `本周 ${CASE_WEEKLY_BALLOT_LIMIT} 票已经投完了，先取消一票再投别的。`;

/**
 * 三个票位里第一个空着的（1..3）；全占满时返回 0，调用方据此拒绝这一票。
 * 用固定票位而不是数行数，是让「一周最多三票」由主键
 * (user_id, week_key, slot) 在库里兜底，应用层数错也塞不进第四票。
 */
export function firstFreeBallotSlot(occupied: readonly number[]): number {
  for (let slot = 1; slot <= CASE_WEEKLY_BALLOT_LIMIT; slot += 1) {
    if (!occupied.includes(slot)) return slot;
  }
  return 0;
}

/** 我在每一周已经投出去几票——从卡片自己的 viewerFavorited 数，不用再问服务端。 */
export function viewerBallotsByWeek(
  engagements: Iterable<Pick<CaseEngagement, "weekKey" | "viewerFavorited">>,
): Map<string, number> {
  const used = new Map<string, number>();
  for (const item of engagements) {
    if (item.viewerFavorited) used.set(item.weekKey, (used.get(item.weekKey) ?? 0) + 1);
  }
  return used;
}

export function remainingBallots(used: number): number {
  return Math.max(0, CASE_WEEKLY_BALLOT_LIMIT - used);
}

/** 周标题和收藏按钮上都用这一句，两处说法不能不一样。 */
export function ballotHint(used: number): string {
  const left = remainingBallots(used);
  return left ? `本周还剩 ${left} 票` : `本周 ${CASE_WEEKLY_BALLOT_LIMIT} 票已投完`;
}

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

/** 记下每个案例此刻在所在周里的位置。 */
export function snapshotWeeklyOrder<T>(
  groups: readonly WeeklyGroup<T>[],
  idOf: (item: T) => string,
): Map<string, number> {
  const order = new Map<string, number>();
  for (const group of groups) {
    group.items.forEach((item, index) => order.set(idOf(item), index));
  }
  return order;
}

/**
 * 按冻结的顺序摆放，并报告真实名次是否已经和它不一致。
 *
 * 投票要立刻看到票数变化，但脚下的卡片不该跟着跳走——名次变化交给用户自己点。
 * 这是投票列表的通行做法（Reddit、HN、Stack Overflow 都是投完不重排，
 * 刷新或显式重排才换位置），避免「正在操作的东西自己跑了」。
 * 冻结之后新出现的案例排在最后，同时也会把顺序标记为已变化。
 */
export function applyFrozenWeeklyOrder<T>(
  groups: readonly WeeklyGroup<T>[],
  idOf: (item: T) => string,
  frozen: ReadonlyMap<string, number> | null,
): { groups: WeeklyGroup<T>[]; stale: boolean } {
  if (!frozen) return { groups: groups.map((group) => ({ ...group })), stale: false };
  let stale = false;
  const next = groups.map((group) => {
    const items = [...group.items].sort((left, right) => (
      (frozen.get(idOf(left)) ?? Number.MAX_SAFE_INTEGER)
      - (frozen.get(idOf(right)) ?? Number.MAX_SAFE_INTEGER)
    ));
    if (group.items.some((item, index) => idOf(item) !== idOf(items[index]))) stale = true;
    return { ...group, items };
  });
  return { groups: next, stale };
}

export type CaseFavoriteToggleResult = {
  weekKey: string;
  favorited: boolean;
  videoId: string;
  favoriteCount: number;
  /** 这一周投完之后一共用掉几票，前端据此更新「还剩几票」。 */
  usedBallots: number;
  ballotLimit: number;
};
