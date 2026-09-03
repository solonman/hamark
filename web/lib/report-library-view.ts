// 报告库首页的纯逻辑：搜索过滤、按周分组排序、冻结顺序、状态文案。
// 这一层不碰网络也不碰 DOM，浏览器组件（components/report/library/ReportLibrary.tsx）
// 和单测（tests/report-library-view.test.ts）共用同一套函数，做法与 lib/case-engagement.ts
// 之于视频库一致：分组/排序/冻结的机制本身已经在 case-engagement.ts 里实现并测过，
// 这里只负责“报告怎么喂给那套机制”的那一层胶水，以及报告特有的状态文案。

import {
  applyFrozenWeeklyOrder,
  deriveWeekKey,
  emptyCaseEngagement,
  groupByWeek,
  snapshotWeeklyOrder,
  type CaseEngagement,
  type WeeklyGroup,
} from "@/lib/case-engagement";
import type { ReportListItem, ReportStatus, ReportVersionSummary } from "@/lib/report-model";

/**
 * 报告库的收藏和视频库的收藏是两张独立的库表（见 lib/report-engagement-server.ts 的
 * report_weekly_favorites），同一个人同一周在两个库里各有一票，互不占用。
 * 文案单独定义在这里，别处（尤其是 CASE_FAVORITE_BALLOT 那句）说的是视频库自己的口径。
 */
export const REPORT_FAVORITE_BALLOT = "每人每周 1 票（报告库单独计票）" as const;

/** 与 lib/v04-ui-client-state.ts 的 normalizeV04LibraryQuery 同一套归一化，中文全半角、大小写都不该影响命中。 */
export function normalizeReportQuery(value = ""): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

/** 搜索命中标题、任务类型、上传者、标签四个字段（规格 6.1）。 */
export function matchesReportQuery(
  item: Pick<ReportListItem, "title" | "taskType" | "createdByName" | "tags">,
  query: string,
): boolean {
  const normalized = normalizeReportQuery(query);
  if (!normalized) return true;
  const haystack = [item.title, item.taskType, item.createdByName, ...item.tags].join(" ");
  return normalizeReportQuery(haystack).includes(normalized);
}

export function filterReports<T extends Pick<ReportListItem, "title" | "taskType" | "createdByName" | "tags">>(
  items: readonly T[],
  query: string,
): T[] {
  return items.filter((item) => matchesReportQuery(item, query));
}

/**
 * 卡片和 aria 文案要用的中文状态名——开发用的英文状态码（QUEUED/PROCESSING/…）
 * 不能漏到界面上。UPLOADING 会真的出现在列表接口：浏览器直传中途失败、
 * complete 从未被调用时，报告就卡在这一态，`GET /api/reports`
 * （lib/report-server.ts 的 listReports）不按状态过滤，照样把它列出来
 * ——与视频库 `GET /api/videos` 同一口径，不单独藏起来。原来的
 * 「上传中」在这一态会跟封面上「上传完成，等待转换」的说明自相矛盾（人已经在等
 * 上传完成，其实文件根本没传完），统一改成「上传未完成」。
 */
export function reportStatusLabel(status: ReportStatus): string {
  switch (status) {
    case "READY":
      return "可拆解";
    case "QUEUED":
      return "排队中";
    case "PROCESSING":
      return "转换中";
    case "FAILED":
      return "转换失败";
    case "UPLOADING":
    default:
      return "上传未完成";
  }
}

/**
 * 封面左上角格式角标的展示文案：demo 的 mock 数据里 PPT 一律显示成「PPT 97-2003」
 * （honggutan/pujiang 两条 fmt:"PPT 97-2003"，字面就是普通连字符 "-" U+002D，
 * 逐字节核对过，不是 en dash），PPTX／PDF 原样展示。真实上传只按扩展名/content-type
 * 判出 PPT/PPTX/PDF 三选一（lib/report-model.ts 的 sourceFormatOf），不再细分具体的
 * PPT 年份版本，角标统一补这个后缀。
 */
export function reportFormatBadgeLabel(sourceFormat: string): string {
  return sourceFormat === "PPT" ? "PPT 97-2003" : sourceFormat;
}

/**
 * 卡片主按钮上的文案：就绪是唯一能点进工作台的状态，其余都是说明当前卡在哪一步。
 * UPLOADING 单独给「上传未完成」，不能跟着 QUEUED 说「等待转换」——文件都没传完，
 * 压根还没到能排队等转换的地步；删除后重新上传才是唯一出路。
 */
export function reportEnterLabel(status: ReportStatus): string {
  switch (status) {
    case "READY":
      return "进入工作台";
    case "PROCESSING":
      return "生成页图中";
    case "FAILED":
      return "转换失败";
    case "UPLOADING":
      return "上传未完成";
    case "QUEUED":
    default:
      return "等待转换";
  }
}

/**
 * 生成页图的进度条宽度。页数未知（还没转出 PDF、算不出总页数）时给个 3% 的
 * 「意思一下」，不让进度条看起来像卡死在 0；结果始终夹在 [3, 100] 之间。
 */
export function reportProcessingPercent(pagesDone: number, pageCount: number): number {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return 3;
  if (!Number.isFinite(pagesDone) || pagesDone <= 0) return 3;
  const percent = Math.round((pagesDone / pageCount) * 100);
  return Math.max(3, Math.min(100, percent));
}

/** 卡片上的时间只需要「哪天几点」，精确到秒反而挤占版面；与 V04LibraryClient 的 formatV19CardTime 同一逻辑。 */
export function formatReportCardTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 卡片信息带里的「版本摘要」文案：未就绪的报告谈不上版本，那一格改用状态说明卡在哪一步
 * （demo 的 mock 数据：QUEUED→等待转换／PROCESSING→页图生成中／FAILED→转换失败）；只有
 * READY 才回到版本数 + 最近更新人时间，没有版本记录时是「尚未开始拆解」。UPLOADING 单独
 * 给「上传未完成」，跟 reportEnterLabel 同一口径，不跟 QUEUED 混着说「等待转换」。
 */
export function reportVersionSummaryLabel(
  status: ReportStatus,
  versionSummary: Pick<ReportVersionSummary, "count" | "latestOwnerName" | "latestUpdatedAt">,
): string {
  if (status === "UPLOADING") return "上传未完成";
  if (status === "QUEUED") return "等待转换";
  if (status === "PROCESSING") return "页图生成中";
  if (status === "FAILED") return "转换失败";
  if (versionSummary.count > 0) {
    const time = versionSummary.latestUpdatedAt ? formatReportCardTime(versionSummary.latestUpdatedAt) : "";
    return `${versionSummary.count} 个版本 · 最近 ${versionSummary.latestOwnerName ?? "未知"} ${time}`;
  }
  return "尚未开始拆解";
}

/** 收藏数据还没读到时的兜底：周次照样按上传时间现算，只是票数暂时是 0。 */
export function reportEngagementFallback(report: Pick<ReportListItem, "createdAt">): CaseEngagement {
  return emptyCaseEngagement(deriveWeekKey(report.createdAt));
}

/**
 * 按上传周分组、周内按收藏数排序——机制在 case-engagement.ts，这里只提供报告的读法。
 * 泛型 T（限定至少长得像 ReportListItem）让调用方可以传 GET /api/reports 实际吐出来的
 * ReportListItemView（多一个 canManage 字段），分组结果里也不会把这个字段弄丢。
 */
export function reportWeeklyGroups<T extends ReportListItem>(
  items: readonly T[],
  engagementOf: (report: T) => CaseEngagement,
): WeeklyGroup<T>[] {
  return groupByWeek(items, (report) => {
    const engaged = engagementOf(report);
    return {
      weekKey: engaged.weekKey,
      favoriteCount: engaged.favoriteCount,
      createdAt: report.createdAt,
    };
  });
}

export function freezeReportOrder<T extends ReportListItem>(groups: readonly WeeklyGroup<T>[]): Map<string, number> {
  return snapshotWeeklyOrder(groups, (report) => report.id);
}

export function applyFrozenReportOrder<T extends ReportListItem>(
  groups: readonly WeeklyGroup<T>[],
  frozen: ReadonlyMap<string, number> | null,
): { groups: WeeklyGroup<T>[]; stale: boolean } {
  return applyFrozenWeeklyOrder(groups, (report) => report.id, frozen);
}

/** 列表里只要还有没转完的报告，就该继续轮询；全部就绪或失败了就该停。 */
export function hasPendingConversion(items: readonly Pick<ReportListItem, "status">[]): boolean {
  return items.some((item) => item.status === "QUEUED" || item.status === "PROCESSING");
}

/** POST /api/reports/[id]/favorite 的响应形状，字段名与 lib/report-engagement-server.ts 的 ReportFavoriteToggleResult 对齐。 */
export type ReportFavoriteToggleResult = {
  weekKey: string;
  favorited: boolean;
  reportId: string;
  favoriteCount: number;
  releasedReportId: string | null;
  releasedFavoriteCount: number;
};

/**
 * `GET /api/reports` 现在多吐一个 canManage 字段（lib/report-server.ts 的 listReports 按
 * canManageReport 算好），结构上就是 ReportListItem 加一个布尔量。这里单独声明一份，而不是
 * 从 lib/report-server.ts 里 import type——那个文件是服务端专用模块，不该被客户端组件引用，
 * 哪怕只是类型；两边字段名对齐即可，TypeScript 按结构类型天然兼容。
 */
export type ReportListItemView = ReportListItem & { canManage: boolean };

/** 「改传 PDF」要带去上传对话框的预填信息：新报告用旧的标题/任务类型/标签起步，文件另选。 */
export type ReportReplaceTarget = {
  reportId: string;
  title: string;
  taskType: string;
  tags: string[];
};
