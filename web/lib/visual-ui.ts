// 公共视觉库前端专用的纯逻辑：不碰网络、不碰 DOM，组件与单测共用。
//
// 按周分组、名次冻结的机制已经在 lib/case-engagement.ts 里实现并测过（groupByWeek /
// snapshotWeeklyOrder / applyFrozenWeeklyOrder），本域「按周显示」直接调用它们，不在这里
// 重写——这个文件只补公共视觉库特有、别处没有的那一层：搜索匹配、子领域与收藏筛选、
// 「按收藏排序」（demo 里不分周的那种排序，是本域独有的视图，case-engagement.ts 没有
// 对应函数）、CASE 编号、是否需要轮询、素材数量限制、上传对话框的客户端校验顺序与
// 上传进度汇总。

import {
  VISUAL_LIMITS,
  VISUAL_SUBDOMAIN_SPECS,
  isHttpUrl,
  normalizeVisualSearch,
  parseVisualTags,
  type VisualAssetType,
  type VisualMetadata,
  type VisualSubdomain,
} from "./visual-contract";

export type VisualLibraryViewMode = "NEW" | "WEEK" | "FAV";

// ---------------------------------------------------------------------------
// 搜索（规格 6.2：搜标题、摘要、案例简介、标签、地点、创作方、上传者）
//
// 列表项带着案例简介全文（VisualCaseListItem.textBody），所以库首页能搜到简介里的字。
// 这里仍把它标成选填，方便只有标题等字段的调用方复用这个匹配函数。
// ---------------------------------------------------------------------------

export type VisualSearchableCase = {
  title: string;
  summary: string;
  textBody?: string;
  tags: readonly string[];
  location: string;
  creator: string;
  createdByName: string;
};

export function matchesVisualQuery(item: VisualSearchableCase, query: string): boolean {
  const normalized = normalizeVisualSearch(query).trim();
  if (!normalized) return true;
  const haystack = [
    item.title,
    item.summary,
    item.textBody ?? "",
    item.tags.join(" "),
    item.location,
    item.creator,
    item.createdByName,
  ].join(" ");
  return normalizeVisualSearch(haystack).includes(normalized);
}

// ---------------------------------------------------------------------------
// 子领域 / 只看我收藏的
// ---------------------------------------------------------------------------

export function filterBySubdomain<T extends { subdomain: VisualSubdomain }>(
  items: readonly T[],
  subdomain: VisualSubdomain | "ALL",
): T[] {
  return subdomain === "ALL" ? [...items] : items.filter((item) => item.subdomain === subdomain);
}

export function filterFavoritedOnly<T extends { viewerFavorited: boolean }>(
  items: readonly T[],
  onlyMine: boolean,
): T[] {
  return onlyMine ? items.filter((item) => item.viewerFavorited) : [...items];
}

// ---------------------------------------------------------------------------
// 按收藏排序：不分周，全部按收藏数从多到少，同数时新上传的在前（demo 的 ranking()）。
// 「按周显示」的周内排序、冻结用 case-engagement.ts 现成的函数；这一种不分周，
// 冻结的是整份列表里的名次，机制相同但作用范围不同，单独给一套。
// ---------------------------------------------------------------------------

export function rankByFavorite<T>(
  items: readonly T[],
  favoriteCountOf: (item: T) => number,
  createdAtOf: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => (
    favoriteCountOf(b) - favoriteCountOf(a) || createdAtOf(b).localeCompare(createdAtOf(a))
  ));
}

/** 冻结当下的名次：打开「按收藏排序」或点「重新排序」时拍一张快照。 */
export function freezeFlatOrder<T>(items: readonly T[], idOf: (item: T) => string): Map<string, number> {
  return new Map(items.map((item, index) => [idOf(item), index]));
}

/**
 * 按冻结的名次重新摆放，并报告真实顺序是否已经和它不一致（demo 的 applyFrozen）。
 * 冻结之后才出现的案例（不在 frozen 里）排在最后，同时也算「顺序已变」。
 */
export function applyFrozenFlatOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  frozen: ReadonlyMap<string, number> | null,
): { items: T[]; stale: boolean } {
  if (!frozen) return { items: [...items], stale: false };
  const rankOf = (item: T) => frozen.get(idOf(item)) ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...items].sort((a, b) => rankOf(a) - rankOf(b));
  const stale = sorted.some((item, index) => idOf(item) !== idOf(items[index]));
  return { items: sorted, stale };
}

// ---------------------------------------------------------------------------
// CASE 编号：按完整列表（不受筛选/搜索/排序影响），与 caseIndexById 同一做法。
// ---------------------------------------------------------------------------

export function buildCaseNumberMap(fullList: readonly { id: string }[]): Map<string, number> {
  return new Map(fullList.map((item, index) => [item.id, index + 1]));
}

// ---------------------------------------------------------------------------
// 是否需要轮询：有 UPLOADING 的案例，或者有封面还在 PENDING 时（规格 6.2）。
// ---------------------------------------------------------------------------

export function hasPendingVisualWork(
  items: readonly { status: string; cover?: { derivativeStatus: string } | null }[],
): boolean {
  return items.some((item) => item.status === "UPLOADING" || item.cover?.derivativeStatus === "PENDING");
}

// ---------------------------------------------------------------------------
// 素材数量限制（规格 3.8：视频 ≤12、图片 ≤24）
// ---------------------------------------------------------------------------

export function countAssetsByType(assets: readonly { type: VisualAssetType }[]): { videos: number; images: number } {
  let videos = 0;
  let images = 0;
  for (const asset of assets) {
    if (asset.type === "VIDEO") videos += 1;
    else images += 1;
  }
  return { videos, images };
}

/** 还能加几个（不会是负数）。 */
export function remainingVisualSlots(current: { videos: number; images: number }): { videos: number; images: number } {
  return {
    videos: Math.max(0, VISUAL_LIMITS.videos - current.videos),
    images: Math.max(0, VISUAL_LIMITS.images - current.images),
  };
}

// ---------------------------------------------------------------------------
// 上传／编辑对话框的客户端校验（规格 6.4）：
// 至少一个素材 → 子领域 → 标题 → 地点 → 标签 → 来源链接格式，依次拦，命中第一条就返回。
// ---------------------------------------------------------------------------

export type VisualDraftForValidation = {
  assetCount: number;
  subdomain: string;
  title: string;
  location: string;
  tagsText: string;
  sourceUrl: string;
};

export function validateVisualDraft(draft: VisualDraftForValidation, editing: boolean): string {
  if (draft.assetCount <= 0) {
    return editing ? "至少要保留一段视频或一张图片。" : "请先选择视频或图片，至少一个。";
  }
  if (!draft.subdomain) return "请选择子领域。";
  if (!draft.title.trim()) return "请填写标题。";
  if (!draft.location.trim()) return "请填写采集地点，写到城市即可。";
  const tags = parseVisualTags(draft.tagsText);
  if (!tags.length) return "至少填一个标签。";
  if (tags.length > VISUAL_LIMITS.tagsMax) return `标签最多 ${VISUAL_LIMITS.tagsMax} 个。`;
  if (tags.some((tag) => tag.length > VISUAL_LIMITS.tagLengthMax)) {
    return `每个标签不超过 ${VISUAL_LIMITS.tagLengthMax} 个字。`;
  }
  if (draft.sourceUrl.trim() && !isHttpUrl(draft.sourceUrl.trim())) {
    return "来源链接只收 http:// 或 https:// 开头的网址。";
  }
  return "";
}

// ---------------------------------------------------------------------------
// 上传进度汇总：按字节算的总百分比、以及「已传完 n / N 个 · 正在传 文件名」这句话。
// ---------------------------------------------------------------------------

export type VisualUploadFileProgress = { size: number; loaded: number };

export function aggregateUploadPercent(files: readonly VisualUploadFileProgress[]): number {
  const total = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  if (total <= 0) return 0;
  const loaded = files.reduce(
    (sum, file) => sum + Math.min(Math.max(0, file.loaded), Math.max(0, file.size)),
    0,
  );
  return Math.round((loaded / total) * 100);
}

export function countCompletedUploads(files: readonly VisualUploadFileProgress[]): number {
  return files.filter((file) => (file.size > 0 ? file.loaded >= file.size : file.loaded > 0)).length;
}

export function formatUploadProgressLabel(doneCount: number, total: number, currentName: string): string {
  return `已传完 ${doneCount} / ${total} 个 · 正在传 ${currentName}`;
}

// ---------------------------------------------------------------------------
// 子领域专有字段：换子领域时丢掉旧的整组；提交前去掉空值（规格 3.4 第 4／6 条）。
// ---------------------------------------------------------------------------

/** 只保留当前子领域字段清单里的键，且丢掉空值（多选空数组、文本空串）。 */
export function pruneVisualMetadata(subdomain: VisualSubdomain | "", metadata: VisualMetadata): VisualMetadata {
  if (!subdomain) return {};
  const allowed = new Set(VISUAL_SUBDOMAIN_SPECS[subdomain].fields.map((field) => field.key));
  const out: VisualMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key)) continue;
    if (Array.isArray(value)) {
      if (value.length) out[key] = value;
    } else if (String(value ?? "").trim()) {
      out[key] = String(value).trim();
    }
  }
  return out;
}

/** 折叠按钮上「含 X 专有 N 项，已填 n」里的已填计数。 */
export function countFilledMetadata(subdomain: VisualSubdomain | "", metadata: VisualMetadata): number {
  if (!subdomain) return 0;
  return VISUAL_SUBDOMAIN_SPECS[subdomain].fields.filter((field) => {
    const value = metadata[field.key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value && String(value).trim());
  }).length;
}
