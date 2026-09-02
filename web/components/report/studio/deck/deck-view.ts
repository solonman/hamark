/**
 * Pure view-layer helpers for `ReportDeck` — selection geometry, drag insert
 * markers, the floating "设为模块/单元" toolbar, nav-strip coloring, and
 * guide-step inference. Ported rule-for-rule from the approved demo
 * (`docs/demos/2026-09-01-报告拆解工作台demo-V2.html`, functions `setRange`,
 * `marqueeSelect`, `fab`, `stripCell`, `guideStep`, `showInsert`, `dropPlan`,
 * `boxLabel`, `movePages`'s toast text, `placePop`/`placePeek`'s viewport
 * clamp), per §2.3 of `docs/19_报告逆向工程_实施规格_V0.1.md`.
 *
 * Structural mutation itself (moving pages, creating/deleting boxes) lives in
 * `lib/report-structure.ts` — this file only derives what the UI should show
 * or do next. No React, no DOM: everything here takes plain data and returns
 * plain data, so it's unit-testable without a browser.
 */

import {
  modulePages,
  moduleColor,
  moduleNumbers,
  openPagesOf,
  pageStatus,
  planMove,
  sortedChildUnits,
  sortedModules,
  sortedRootUnits,
  unitPages,
  type ReportAnnotation,
  type ReportDeckKey,
  type ReportPage,
} from "@/lib/report-structure";

/* ============================ Rectangles / marquee ============================ */

export type RectLike = { left: number; top: number; right: number; bottom: number };

/** Standard axis-aligned overlap test — mirrors the demo's `marqueeSelect` hit test. */
export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

/** Page numbers whose card rect overlaps the marquee rect, in whatever order `cards` is given. */
export function marqueeHits(
  cards: readonly { n: number; rect: RectLike }[],
  marquee: RectLike,
): number[] {
  return cards.filter((c) => rectsIntersect(c.rect, marquee)).map((c) => c.n);
}

/* ============================ Range / shift-click selection ============================ */

export type SelectionState = { key: ReportDeckKey; ids: number[] };

/**
 * A drag-box or shift-click always resolves to "every open page from lo to
 * hi" — never a scattered pick. Returns `null` (refuse, leave the previous
 * selection alone) the moment any page in that span isn't open in `key`,
 * matching the demo's `setRange`.
 */
export function resolveRangeSelection(
  a: ReportAnnotation,
  key: ReportDeckKey,
  from: number,
  to: number,
): number[] | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const open = new Set(openPagesOf(a, key).map((p) => p.n));
  const ids: number[] = [];
  for (let n = lo; n <= hi; n += 1) {
    if (!open.has(n)) return null;
    ids.push(n);
  }
  return ids;
}

/**
 * A marquee drag's hit-list, resolved through the same open/contiguous rule
 * as a click-drag range — but forgiving of the drag box merely grazing an
 * already-claimed page at one end (an easy accident: the box only needs to
 * touch a card's edge by a pixel to register as a "hit"). Trims inward from
 * each end while it's claimed, landing on the widest open span the hit-list
 * covers; only refuses (`null`) when a claimed page still sits strictly
 * inside that trimmed span, or nothing open is left to trim to — that's the
 * genuine "would select two disconnected open segments" case the demo's
 * contiguous-selection rule exists for.
 */
export function resolveMarqueeSelection(
  a: ReportAnnotation,
  key: ReportDeckKey,
  cards: readonly { n: number; rect: RectLike }[],
  marquee: RectLike,
): number[] | null {
  const hits = marqueeHits(cards, marquee);
  if (!hits.length) return null;
  const open = new Set(openPagesOf(a, key).map((p) => p.n));
  let lo = Math.min(...hits);
  let hi = Math.max(...hits);
  while (lo <= hi && !open.has(lo)) lo += 1;
  while (hi >= lo && !open.has(hi)) hi -= 1;
  if (lo > hi) return null;
  return resolveRangeSelection(a, key, lo, hi);
}

/**
 * Shift+click: extend from the anchor (or, for a marquee-born selection with
 * no anchor, from whichever end of the current selection is farther from the
 * click) to the clicked page. Returns `null` when there's nothing to extend
 * from (different box, or the span would cross a taken page) — caller should
 * leave the selection untouched and may want to surface a hint.
 */
export function resolveShiftExtend(
  a: ReportAnnotation,
  sel: SelectionState,
  anchor: number | null,
  key: ReportDeckKey,
  clickedN: number,
): { ids: number[]; anchor: number } | null {
  if (sel.key !== key || !sel.ids.length) return null;
  const lo = Math.min(...sel.ids);
  const hi = Math.max(...sel.ids);
  const from = anchor != null ? anchor : (clickedN > hi ? lo : hi);
  const ids = resolveRangeSelection(a, key, from, clickedN);
  if (!ids) return null;
  return { ids, anchor: from };
}

/**
 * Plain click on one page: re-clicking the sole selected page clears the
 * selection (`null`); anything else selects just that page and anchors
 * there, ready for a following shift-click.
 */
export function toggleOrReplaceSingle(
  sel: SelectionState,
  key: ReportDeckKey,
  n: number,
): { ids: number[]; anchor: number } | null {
  if (sel.key === key && sel.ids.length === 1 && sel.ids[0] === n) return null;
  return { ids: [n], anchor: n };
}

/* ============================ Drag insert marker ============================ */

/**
 * Where the insert-position bar should sit while dragging: the page number
 * of the first page already shown in the target box (in ascending order,
 * i.e. `shownIds` as returned by `shownPagesOf`) that isn't part of the
 * moving set and sorts after it — `null` means append at the end of the box.
 */
export function insertMarkerPageNo(
  shownIds: readonly number[],
  movingIds: readonly number[],
): number | null {
  if (!movingIds.length) return null;
  const moving = new Set(movingIds);
  const maxMoving = Math.max(...movingIds);
  const found = shownIds.find((n) => !moving.has(n) && n > maxMoving);
  return found ?? null;
}

/* ============================ Floating "设为…" toolbar ============================ */

export type FabDescriptor =
  | { available: true; kind: "module" | "unit" | "subunit"; label: string }
  | { available: false; reason: string };

function isConsecutiveRun(ns: readonly number[]): boolean {
  for (let i = 1; i < ns.length; i += 1) {
    if (ns[i] !== ns[i - 1] + 1) return false;
  }
  return true;
}

function firstPageNo(pages: readonly { n: number }[]): number {
  return pages.length ? pages[0].n : Number.POSITIVE_INFINITY;
}

/**
 * What the floating toolbar button should say and do for the current
 * selection, or why it can't act. A selection built through
 * `resolveRangeSelection`/`resolveMarqueeSelection`/`resolveShiftExtend` is
 * always already contiguous and open, so `available: false` here is a
 * defensive backstop (e.g. the annotation changed under a stale selection)
 * rather than something the happy path hits — matches §2.3's "只有选区连续
 * 且全部处于开放状态时才可用，否则按钮禁用并说明原因".
 */
export function fabDescriptor(
  a: ReportAnnotation,
  key: ReportDeckKey,
  ids: readonly number[],
): FabDescriptor {
  if (!ids.length) return { available: false, reason: "先选中连续的页" };
  const sorted = [...ids].sort((x, y) => x - y);
  if (!isConsecutiveRun(sorted)) {
    return { available: false, reason: "选区必须是连续的一段页" };
  }
  const open = new Set(openPagesOf(a, key).map((p) => p.n));
  if (!sorted.every((n) => open.has(n))) {
    return { available: false, reason: "选区里有页已经被下一级收走，不能在这一层设组" };
  }
  const startN = sorted[0];
  const nums = moduleNumbers(a);
  if (key === "free") {
    const index = sortedModules(a).filter((m) => firstPageNo(modulePages(a, m.id)) < startN).length;
    return { available: true, kind: "module", label: `设为模块 ${index + 1}` };
  }
  const sep = key.indexOf(":");
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (kind === "mod") {
    const index = sortedRootUnits(a, id).filter((u) => firstPageNo(unitPages(a, u.id)) < startN).length;
    return { available: true, kind: "unit", label: `设为单元 ${nums[id]}-${index + 1}` };
  }
  const index = sortedChildUnits(a, id).filter((u) => firstPageNo(unitPages(a, u.id)) < startN).length;
  return { available: true, kind: "subunit", label: `设为子单元 ${nums[id]}-${index + 1}` };
}

/* ============================ Page fill-in mark ============================ */

export type PageMarkKind = "done" | "partial" | "none";

/** `"done"` → ✓ badge, `"partial"` → · badge ("在标"), `"none"` → no badge. */
export function pageMarkKind(p: ReportPage): PageMarkKind {
  const status = pageStatus(p);
  if (status.done) return "done";
  if (status.touched) return "partial";
  return "none";
}

/* ============================ Nav strip coloring ============================ */

const UNIT_BRIGHTNESS_CYCLE: readonly number[] = [1, 0.76, 0.9, 0.66];

export type NavStripCell = {
  pageNo: number;
  /** Module color, or `null` when the page isn't in any module (renders as neutral gray). */
  color: string | null;
  /** CSS `filter: brightness(...)` factor — root units within a module cycle through four levels. */
  brightness: number;
  /** True on a module's first page — the demo draws a light seam there. */
  isModuleStart: boolean;
  mark: PageMarkKind;
  isCurrent: boolean;
  tooltip: string;
};

function findUnitById(a: ReportAnnotation, uid: string) {
  return a.units.find((u) => u.id === uid);
}

function rootUnitOf(a: ReportAnnotation, uid: string) {
  let cursor = findUnitById(a, uid);
  while (cursor && cursor.pid) cursor = findUnitById(a, cursor.pid);
  return cursor;
}

/** One cell of the page-modal nav strip: color/brightness by module+root-unit, mark, tooltip. */
export function navStripCell(a: ReportAnnotation, page: ReportPage, currentPageNo: number): NavStripCell {
  let color: string | null = null;
  let brightness = 1;
  let isModuleStart = false;
  if (page.mid) {
    const modIndex = sortedModules(a).findIndex((m) => m.id === page.mid);
    color = moduleColor(modIndex);
    const root = page.uid ? rootUnitOf(a, page.uid) : undefined;
    const roots = sortedRootUnits(a, page.mid);
    const rootIndex = root ? roots.findIndex((u) => u.id === root.id) : -1;
    brightness = rootIndex < 0 ? 1 : UNIT_BRIGHTNESS_CYCLE[rootIndex % UNIT_BRIGHTNESS_CYCLE.length];
    const modPages = modulePages(a, page.mid);
    isModuleStart = modPages.length > 0 && modPages[0].n === page.n;
  }
  const mark = pageMarkKind(page);
  const nums = moduleNumbers(a);
  const status = pageStatus(page);
  const where = page.mid ? `模块 ${nums[page.mid] ?? ""}` : "未归入模块";
  const statusLabel = status.done ? "已填完" : status.touched ? `在标：还差 ${status.missing.join("、")}` : "未标注";
  const tooltip = `p${String(page.n).padStart(2, "0")} · ${where} · ${statusLabel}`;
  return { pageNo: page.n, color, brightness, isModuleStart, mark, isCurrent: page.n === currentPageNo, tooltip };
}

/* ============================ Guide step ============================ */

/** 0 = 划模块, 1 = 划单元, 2 = 标注 — matches the demo's `guideStep`. */
export function guideStepIndex(a: ReportAnnotation): 0 | 1 | 2 {
  if (!a.modules.length) return 0;
  if (!a.units.length) return 1;
  return 2;
}

/* ============================ Column width ============================ */

export const DECK_MIN_COLUMN_WIDTH = 150;
export const DECK_MAX_COLUMN_WIDTH = 680;
export const DECK_DEFAULT_COLUMN_WIDTH = 214;
export const DECK_COLUMN_WIDTH_STORAGE_KEY = "report-deck:colw";

export function clampColumnWidth(px: number): number {
  return Math.max(DECK_MIN_COLUMN_WIDTH, Math.min(DECK_MAX_COLUMN_WIDTH, px));
}

/* ============================ Floating panel placement ============================ */

/**
 * Keeps a fixed-position panel (section popover, hover preview, combobox
 * menu) fully inside the viewport, clear of the sticky top bar. Mirrors the
 * demo's `placePop`/`placePeek`.
 */
export function clampFloatingPosition(input: {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number;
  margin?: number; minTop?: number;
}): { x: number; y: number } {
  const margin = input.margin ?? 10;
  const minTop = input.minTop ?? 72;
  const x = Math.max(margin, Math.min(input.viewportWidth - input.width - margin, input.x));
  const y = Math.max(minTop, Math.min(input.viewportHeight - input.height - margin, input.y));
  return { x, y };
}

/**
 * Anchored placement for the section popover: sits just under the "标注"
 * button it opened from, but flips to sit just above it when there isn't
 * enough room below — §2.3 explicitly asks for this ("位置随视口调整…超出
 * 视口时翻转"), which the demo's own `placePop` doesn't do (it only clamps,
 * never flips — see the task report). Falls back to the clamp alone once
 * flipped, in case the anchor is so close to the top that even "above"
 * doesn't fully fit.
 */
export function placeAnchoredPanel(input: {
  anchor: { top: number; bottom: number; left: number };
  width: number; height: number;
  viewportWidth: number; viewportHeight: number;
  margin?: number; minTop?: number; gap?: number;
}): { x: number; y: number } {
  const margin = input.margin ?? 10;
  const minTop = input.minTop ?? 72;
  const gap = input.gap ?? 8;
  const fitsBelow = input.anchor.bottom + gap + input.height <= input.viewportHeight - margin;
  const y = fitsBelow ? input.anchor.bottom + gap : input.anchor.top - gap - input.height;
  return clampFloatingPosition({
    x: input.anchor.left, y, width: input.width, height: input.height,
    viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight,
    margin, minTop,
  });
}

/**
 * Where the floating "设为模块/单元" toolbar should sit: centered under the
 * union of the selected pages' card rects, clamped into the viewport. Ports
 * the demo's `placeFab` (`f.style.left = clamp(10, vw-w-10, (left+right)/2 -
 * w/2); f.style.top = clamp(72, vh-56, bottom+8)`).
 *
 * `cardRects` must already be viewport-relative (i.e. straight from
 * `Element.getBoundingClientRect()`), never derived from `scrollTop` /
 * `offsetTop` by hand — `getBoundingClientRect()` already accounts for every
 * ancestor's scroll offset (including the left column's own internal
 * scroll), so passing it straight through is what keeps this correct
 * regardless of how far the page or the column has scrolled. Returns `null`
 * when there's nothing to anchor to.
 */
export function placeFloatingToolbar(input: {
  cardRects: readonly RectLike[];
  toolbarWidth: number;
  viewportWidth: number; viewportHeight: number;
  margin?: number; minTop?: number; gap?: number;
}): { x: number; y: number } | null {
  if (!input.cardRects.length) return null;
  const margin = input.margin ?? 10;
  const minTop = input.minTop ?? 72;
  const gap = input.gap ?? 8;
  const left = Math.min(...input.cardRects.map((r) => r.left));
  const right = Math.max(...input.cardRects.map((r) => r.right));
  const bottom = Math.max(...input.cardRects.map((r) => r.bottom));
  const x = Math.max(margin, Math.min(input.viewportWidth - input.toolbarWidth - margin, (left + right) / 2 - input.toolbarWidth / 2));
  const y = Math.max(minTop, Math.min(input.viewportHeight - 56, bottom + gap));
  return { x, y };
}

/* ============================ Comment target keys ============================ */
// `module:<mid>:<field>` / `unit:<uid>:<field>` / `block:<blockId>:<field>`
// per the ReportDeck contract — "组块是评论的最小单元" reads as "you can't
// anchor a comment any finer than a whole block" (no per-coordinate/per-word
// comments), not "a block gets only one comment": the demo wires a comment
// button on the block's name row (`block|<pageNo>|<blockId>`, field-less —
// we call that field `"name"`) *and* separate ones on 叙述作用/关键标记 via
// its generic `item()` helper, same as modules/units getting one comment per
// free field. A page's two free fields (页面作用/本页组织关系) aren't in the
// contract's three-prefix list, but §2.4 explicitly calls for a page-level
// comment entry and the demo wires one on both — see the task report for
// this resolved gap.

export function moduleCommentKey(mid: string, field: string): string {
  return `module:${mid}:${field}`;
}
export function unitCommentKey(uid: string, field: string): string {
  return `unit:${uid}:${field}`;
}
export function pageCommentKey(pageNo: number, field: string): string {
  return `page:${pageNo}:${field}`;
}
export function blockCommentKey(blockId: string, field: string): string {
  return `block:${blockId}:${field}`;
}

/* ============================ Move preview / toast text ============================ */

function padPageNo(n: number): string {
  return String(n).padStart(2, "0");
}

/** `p05` / `p05–p09` / `空`, straight from a list of page numbers (no `ReportPage` needed). */
export function rangeLabelForPageNumbers(ids: readonly number[]): string {
  if (!ids.length) return "空";
  const sorted = [...ids].sort((x, y) => x - y);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? `p${padPageNo(first)}` : `p${padPageNo(first)}–p${padPageNo(last)}`;
}

/** `"左边的页序"` / `"模块 2"` / `"单元 2-1"` — matches the demo's `boxLabel`. */
export function boxLabel(a: ReportAnnotation, key: ReportDeckKey): string {
  if (key === "free") return "左边的页序";
  const nums = moduleNumbers(a);
  const sep = key.indexOf(":");
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  return kind === "mod" ? `模块 ${nums[id] ?? ""}` : `单元 ${nums[id] ?? ""}`;
}

export type PlanMoveDescription =
  | { ok: true; ids: number[]; text: string }
  | { ok: false; text: string };

/**
 * What a drop at `(toKey, pageNo)` would do, described as drag-tooltip text
 * — wraps `lib/report-structure`'s `planMove` (the actual accept/reject
 * rule) with the demo's `"边界挪到 pNN："` prefix and `"<段> → <目标>"` body.
 */
export function describePlanMove(
  a: ReportAnnotation,
  fromKey: ReportDeckKey,
  toKey: ReportDeckKey,
  pageNo: number,
  selectedIds: readonly number[],
): PlanMoveDescription {
  const plan = planMove(a, fromKey, toKey, pageNo, selectedIds);
  if (!plan.ok) return { ok: false, text: plan.reason };
  const label = boxLabel(a, toKey);
  const seg = rangeLabelForPageNumbers(plan.ids);
  const prefix = plan.carried ? `边界挪到 p${padPageNo(pageNo)}：` : "";
  return { ok: true, ids: plan.ids, text: `${prefix}${seg} → ${label}` };
}

/** Post-drop toast text, including the "空段自动撤销" note when `applyMove` dropped any. */
export function moveToastText(movedCount: number, removedSegments: number): string {
  const suffix = removedSegments ? `（${removedSegments} 个空段自动撤销）` : "";
  return `已移动 ${movedCount} 页。${suffix}`;
}

/* ============================ Page-image block drawing ============================ */
// Restores the demo's `wireDraw()` (docs/demos 第 1181-1198 行): "＋ 框选"
// draws a rectangle directly on the page image to create a content block.
// The coordinator corrected an earlier misreading of "页面坐标取消" — that
// instruction meant *don't show the x/y/w/h numbers as text*, not *drop the
// draw interaction*. These are the pure geometry pieces; `ReportPageModal`
// wires the pointer events.

export type StageRect = { left: number; top: number; width: number; height: number };

/** Pointer position as a percentage of the page-image stage — mirrors `wireDraw`'s `pt(e)`. */
export function pointToStagePercent(clientX: number, clientY: number, stage: StageRect): { x: number; y: number } {
  return {
    x: ((clientX - stage.left) / stage.width) * 100,
    y: ((clientY - stage.top) / stage.height) * 100,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The drag-box rect in stage-percent, rounded to one decimal — mirrors `wireDraw`'s pointermove/pointerup math. */
export function drawnBlockRect(
  start: { x: number; y: number },
  current: { x: number; y: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: round1(Math.min(start.x, current.x)),
    y: round1(Math.min(start.y, current.y)),
    w: round1(Math.abs(current.x - start.x)),
    h: round1(Math.abs(current.y - start.y)),
  };
}

/** Below this the demo refuses the box and toasts "框太小了，再拖大一点。" instead of creating a block. */
export function isDrawnBlockTooSmall(w: number, h: number): boolean {
  return w < 3 || h < 2;
}

/** New blocks land in reading order (top-to-bottom, then left-to-right) — mirrors the post-draw `p.blocks.sort(...)`. */
export function sortBlocksByPosition<T extends { x: number; y: number }>(blocks: readonly T[]): T[] {
  return [...blocks].sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/* ============================ Header summary ============================ */

export type DeckSummary = {
  moduleCount: number;
  unitCount: number;
  blockCount: number;
  totalPages: number;
  donePages: number;
  inProgressPages: number;
};

/** The `"N 模块 · N 单元 · N 组块 ｜ 已填完 N/N 页（在标 N）"` chip in the section header. */
export function deckSummary(a: ReportAnnotation): DeckSummary {
  const blockCount = a.pages.reduce((sum, p) => sum + p.blocks.length, 0);
  let donePages = 0;
  let inProgressPages = 0;
  for (const p of a.pages) {
    const status = pageStatus(p);
    if (status.done) donePages += 1;
    else if (status.touched) inProgressPages += 1;
  }
  return {
    moduleCount: a.modules.length,
    unitCount: a.units.length,
    blockCount,
    totalPages: a.pages.length,
    donePages,
    inProgressPages,
  };
}
