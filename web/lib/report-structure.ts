/**
 * Report-reverse-engineering workbench: pure structural functions ported
 * from the approved interaction demo
 * (`docs/demos/2026-09-01-报告拆解工作台demo-V2.html` — see `numbers`,
 * `rangeOf`, `allOfMod`, `allOfUnit`, `directUnitPages`, `openPagesOf`,
 * `shownPagesOf`, `isTaken`, `carryFor`, `dropPlan`, `structureOk`/
 * `contiguous`, `movePages`'s dead-segment cleanup, `pageStatus`, `DONEP`,
 * `modColor`/`unitColor`), per `docs/19_报告逆向工程_实施规格_V0.1.md`
 * §2.1 (structure rules) and §3.3 (payload shape and server-side
 * validation).
 *
 * We port the demo's *rules*, not its mutable-global style: every function
 * here is pure — it takes a `ReportAnnotation` and returns a new one (or a
 * derived value), never touching the input. No React, no DOM, no database:
 * this is the shared contract other report-reverse work (API routes, the
 * studio UI) builds on.
 */

/* ============================ Types ============================ */

export type ReportBlock = {
  id: string; name: string; x: number; y: number; w: number; h: number;
  type: string; roles: string[]; style: string; rel: string; narr: string; mark: string;
};
export type ReportPage = {
  n: number; mid: string | null; uid: string | null; transition: boolean;
  func: string; org: string; blocks: ReportBlock[];
};
export type ReportUnit = {
  id: string; mid: string; pid: string | null; name: string; rel: string;
  task: string; role: string; psy: string; concl: string;
};
export type ReportModule = { id: string; name: string; rel: string; role: string };
export type ReportAnnotation = {
  background: { city: string; developer: string; projectBackground: string; businessBackground: string };
  strategy: { narrative: string; model: string };
  modules: ReportModule[]; units: ReportUnit[]; pages: ReportPage[];
};

/** `"free" | "mod:<id>" | "unit:<id>"` — the three kinds of page-holding boxes in the studio deck. */
export type ReportDeckKey = "free" | `mod:${string}` | `unit:${string}`;

/* ============================ Vocabularies ============================ */
// Values copied verbatim from the demo's top-of-file constants — free text
// (module name, content type) is intentionally not enforced here.

export const REPORT_RELATIONS: readonly string[] =
  ["推导", "并列", "展开", "对比", "隐喻/映射", "转折", "收敛", "时间", "相对独立"];
export const MODULE_NAME_CANDIDATES: readonly string[] =
  ["营销命题", "路线选择", "价值故事仓", "核心成果", "营销行动"];
export const CONTENT_TYPES: readonly string[] =
  ["标题", "解释文字", "观点文字", "事实证据", "数据图表", "视觉意象", "图片", "手绘线条", "阶段结论"];
export const BLOCK_ROLES: readonly string[] = [
  "核心结论", "核心观点", "核心演绎", "核心原则", "直接阐释", "分拆阐释",
  "图例阐释", "图片阐释", "模型阐释", "前序推理", "中间推理", "后续推理",
];
export const WRITING_STYLES: readonly string[] = ["理性", "感性", "中性"];
export const REPORT_MODELS: readonly string[] = ["标准型", "文学章回型", "问题章回型", "顾问模板型"];
export const TASK_TYPES: readonly string[] =
  ["宣发企划", "故事线", "宣发阶段性提报", "月度总结报告", "专项宣发方案"];

const DEFAULT_RELATION = "推导";

/* ============================ Basic lookups ============================ */

function byPageNo(a: ReportPage, b: ReportPage): number {
  return a.n - b.n;
}

function firstPageNo(pages: readonly ReportPage[]): number {
  return pages.length ? pages[0].n : Number.POSITIVE_INFINITY;
}

function unitOf(a: ReportAnnotation, uid: string): ReportUnit | undefined {
  return a.units.find((u) => u.id === uid);
}

function childUnitsOf(a: ReportAnnotation, uid: string): ReportUnit[] {
  return a.units.filter((u) => u.pid === uid);
}

function splitDeckKey(key: ReportDeckKey): [kind: "mod" | "unit", id: string] {
  const i = key.indexOf(":");
  return [key.slice(0, i) as "mod" | "unit", key.slice(i + 1)];
}

/* ============================ Structure derivation ============================ */

/** Every page directly or transitively (via child units) held by a module. Ascending by page number. */
export function modulePages(a: ReportAnnotation, mid: string): ReportPage[] {
  return a.pages.filter((p) => p.mid === mid).sort(byPageNo);
}

/** Only the pages assigned straight to this unit (not its children). Ascending by page number. */
export function unitDirectPages(a: ReportAnnotation, uid: string): ReportPage[] {
  return a.pages.filter((p) => p.uid === uid).sort(byPageNo);
}

/** This unit's direct pages plus its whole child-unit subtree. Ascending by page number. */
export function unitPages(a: ReportAnnotation, uid: string): ReportPage[] {
  const direct = unitDirectPages(a, uid);
  const nested = childUnitsOf(a, uid).flatMap((child) => unitPages(a, child.id));
  return [...direct, ...nested].sort(byPageNo);
}

/** Pages that belong to no module at all — the left-column tray. Ascending by page number. */
export function freePages(a: ReportAnnotation): ReportPage[] {
  return a.pages.filter((p) => !p.mid).sort(byPageNo);
}

/** Modules ordered by where they start in the deck (their earliest page). */
export function sortedModules(a: ReportAnnotation): ReportModule[] {
  return [...a.modules].sort(
    (x, y) => firstPageNo(modulePages(a, x.id)) - firstPageNo(modulePages(a, y.id)),
  );
}

/** A module's top-level (parent-less) units, ordered by where each one starts. */
export function sortedRootUnits(a: ReportAnnotation, mid: string): ReportUnit[] {
  return a.units
    .filter((u) => u.mid === mid && !u.pid)
    .sort((x, y) => firstPageNo(unitPages(a, x.id)) - firstPageNo(unitPages(a, y.id)));
}

/** A unit's direct children, ordered by where each one starts. */
export function sortedChildUnits(a: ReportAnnotation, uid: string): ReportUnit[] {
  return childUnitsOf(a, uid).sort(
    (x, y) => firstPageNo(unitPages(a, x.id)) - firstPageNo(unitPages(a, y.id)),
  );
}

/**
 * Module/unit numbering (1, 1-1, 1-1-1, …), derived from page order every
 * time — never stored. Matches the demo's `numbers()`.
 */
export function moduleNumbers(a: ReportAnnotation): Record<string, string> {
  const map: Record<string, string> = {};
  sortedModules(a).forEach((m, mi) => {
    map[m.id] = String(mi + 1);
    const walk = (units: ReportUnit[], prefix: string) => {
      units.forEach((u, i) => {
        map[u.id] = `${prefix}-${i + 1}`;
        walk(sortedChildUnits(a, u.id), map[u.id]);
      });
    };
    walk(sortedRootUnits(a, m.id), String(mi + 1));
  });
  return map;
}

/**
 * `p01–p09` / `p05` / `空`. Expects `pages` already sorted ascending by page
 * number (as every accessor above returns).
 */
export function pageRangeLabel(pages: readonly ReportPage[]): string {
  if (!pages.length) return "空";
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = pages[0].n;
  const last = pages[pages.length - 1].n;
  return first === last ? `p${pad(first)}` : `p${pad(first)}–p${pad(last)}`;
}

/** Pages in this box that haven't already been claimed by something nested inside it. */
export function openPagesOf(a: ReportAnnotation, key: ReportDeckKey): ReportPage[] {
  if (key === "free") return freePages(a);
  const [kind, id] = splitDeckKey(key);
  if (kind === "mod") return a.pages.filter((p) => p.mid === id && !p.uid).sort(byPageNo);
  return unitDirectPages(a, id);
}

/** Every page shown inside this box, including ones claimed by nested units (those render dimmed). */
export function shownPagesOf(a: ReportAnnotation, key: ReportDeckKey): ReportPage[] {
  if (key === "free") return [...a.pages].sort(byPageNo);
  const [kind, id] = splitDeckKey(key);
  return kind === "mod" ? modulePages(a, id) : unitPages(a, id);
}

/** Ascending, gap-free page numbers. Callers pass already-sorted lists (see accessors above). */
export function isContiguous(pages: readonly ReportPage[]): boolean {
  for (let i = 1; i < pages.length; i += 1) {
    if (pages[i].n !== pages[i - 1].n + 1) return false;
  }
  return true;
}

/** Every module and every unit (with its subtree) must hold one unbroken run of pages. */
export function structureOk(a: ReportAnnotation): boolean {
  return a.modules.every((m) => isContiguous(modulePages(a, m.id)))
    && a.units.every((u) => isContiguous(unitPages(a, u.id)));
}

/* ============================ Moving pages ============================ */

/**
 * Dragging one page to an adjacent box moves a boundary: everything from
 * that page to whichever end of its current run is nearer the target comes
 * along. Direction is decided by where the target box's pages sit relative
 * to the dragged page's run:
 * - target is entirely to the right → carry to the run's right end;
 * - target is entirely to the left → carry to the run's left end;
 * - target encloses the run (dropping back into a parent tray) → retreat
 *   toward whichever end is closer to the dragged page.
 *
 * Returns `null` when `pageNo` isn't actually open in `fromKey`, or the
 * target box is empty (an empty box has no "direction" to carry toward).
 */
export function carrySet(
  a: ReportAnnotation,
  fromKey: ReportDeckKey,
  toKey: ReportDeckKey,
  pageNo: number,
): number[] | null {
  const open = openPagesOf(a, fromKey).map((p) => p.n);
  if (!open.includes(pageNo)) return null;
  const openSet = new Set(open);
  let rs = pageNo;
  let re = pageNo;
  while (openSet.has(rs - 1)) rs -= 1;
  while (openSet.has(re + 1)) re += 1;

  const target = shownPagesOf(a, toKey).map((p) => p.n);
  if (!target.length) return null;
  const lo = Math.min(...target);
  const hi = Math.max(...target);
  const out: number[] = [];
  if (lo > re) {
    for (let i = pageNo; i <= re; i += 1) out.push(i);
    return out;
  }
  if (hi < rs) {
    for (let i = rs; i <= pageNo; i += 1) out.push(i);
    return out;
  }
  if (re - pageNo <= pageNo - rs) {
    for (let i = pageNo; i <= re; i += 1) out.push(i);
  } else {
    for (let i = rs; i <= pageNo; i += 1) out.push(i);
  }
  return out;
}

function reassignPages(
  a: ReportAnnotation,
  ids: readonly number[],
  toKey: ReportDeckKey,
): ReportAnnotation {
  const moving = new Set(ids);
  const pages = a.pages.map((p) => {
    if (!moving.has(p.n)) return p;
    if (toKey === "free") return { ...p, mid: null, uid: null };
    const [kind, id] = splitDeckKey(toKey);
    if (kind === "mod") return { ...p, mid: id, uid: null };
    const unit = unitOf(a, id);
    return { ...p, mid: unit ? unit.mid : p.mid, uid: id };
  });
  return { ...a, pages };
}

export type PlanMoveResult =
  | { ok: true; ids: number[]; carried: boolean }
  | { ok: false; reason: string };

/**
 * Works out what a drag from `fromKey` to `toKey` (dropped on `pageNo`)
 * would do, without mutating anything: a manual multi-page selection that
 * includes the dragged page moves as-is; otherwise the boundary-carry rule
 * above fills in the pages. Rejected — without touching `a` — if the
 * resulting layout would break a module's or unit's contiguity (e.g.
 * splitting a selected middle slice out of a run leaves the two remaining
 * ends non-contiguous).
 */
export function planMove(
  a: ReportAnnotation,
  fromKey: ReportDeckKey,
  toKey: ReportDeckKey,
  pageNo: number,
  selectedIds: readonly number[],
): PlanMoveResult {
  const picked = selectedIds.length > 1 && selectedIds.includes(pageNo) ? [...selectedIds] : null;
  const carriedSet = picked ? null : carrySet(a, fromKey, toKey, pageNo);
  const ids = picked ?? carriedSet ?? [...selectedIds];
  if (!ids.length) return { ok: false, reason: "没有可移动的页" };

  const next = reassignPages(a, ids, toKey);
  if (!structureOk(next)) return { ok: false, reason: "会把某一段拆成两截 · 只能从段的两端挪" };

  const carried = !picked && !!carriedSet && carriedSet.length > 1;
  return { ok: true, ids, carried };
}

/**
 * Actually performs a move already approved by `planMove`: reassigns the
 * pages, then repeatedly drops any unit or module left with no pages (a
 * unit also needs no remaining children to qualify — otherwise an empty
 * parent with real grandchildren would vanish). Dropping a unit can make
 * its now-childless parent empty too, hence the repeat; a module that ends
 * up with zero pages takes every one of its units with it (impossible for
 * any of them to still hold a page once the module holds none).
 */
export function applyMove(
  a: ReportAnnotation,
  ids: readonly number[],
  toKey: ReportDeckKey,
): { next: ReportAnnotation; removedSegments: number } {
  let next = reassignPages(a, ids, toKey);
  let removedSegments = 0;

  let again = true;
  while (again) {
    again = false;
    const deadUnits = next.units.filter(
      (u) => !unitPages(next, u.id).length && !next.units.some((k) => k.pid === u.id),
    );
    if (deadUnits.length) {
      const deadIds = new Set(deadUnits.map((u) => u.id));
      next = { ...next, units: next.units.filter((u) => !deadIds.has(u.id)) };
      removedSegments += deadUnits.length;
      again = true;
    }
  }

  const deadModules = next.modules.filter((m) => !modulePages(next, m.id).length);
  if (deadModules.length) {
    const deadModIds = new Set(deadModules.map((m) => m.id));
    next = {
      ...next,
      units: next.units.filter((u) => !deadModIds.has(u.mid)),
      modules: next.modules.filter((m) => !deadModIds.has(m.id)),
    };
    removedSegments += deadModules.length;
  }

  return { next, removedSegments };
}

/* ============================ Creating / removing boxes ============================ */

function defaultIdSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

/** Draws a new module around `ids` (expected to be a contiguous run of currently-free pages). */
export function assignToNewModule(
  a: ReportAnnotation,
  ids: readonly number[],
  idFactory: () => string = defaultIdSuffix,
): { next: ReportAnnotation; moduleId: string } {
  const moduleId = `M${idFactory()}`;
  const claimed = new Set(ids);
  const pages = a.pages.map((p) => (claimed.has(p.n) ? { ...p, mid: moduleId, uid: null } : p));
  const modules = [...a.modules, { id: moduleId, name: "", rel: DEFAULT_RELATION, role: "" }];
  return { next: { ...a, modules, pages }, moduleId };
}

/**
 * Draws a new unit around `ids` inside `containerKey` — a module tray
 * (`mod:<id>`, making a root unit) or a unit tray (`unit:<id>`, making a
 * child unit). `ids` are expected to already belong to that container.
 */
export function assignToNewUnit(
  a: ReportAnnotation,
  containerKey: ReportDeckKey,
  ids: readonly number[],
  idFactory: () => string = defaultIdSuffix,
): { next: ReportAnnotation; unitId: string } {
  const [kind, id] = splitDeckKey(containerKey);
  const mid = kind === "mod" ? id : (unitOf(a, id)?.mid ?? "");
  const pid = kind === "mod" ? null : id;
  const unitId = `U${idFactory()}`;
  const claimed = new Set(ids);
  const pages = a.pages.map((p) => (claimed.has(p.n) ? { ...p, uid: unitId } : p));
  const units = [
    ...a.units,
    { id: unitId, mid, pid, name: "", rel: DEFAULT_RELATION, task: "", role: "", psy: "", concl: "" },
  ];
  return { next: { ...a, units, pages }, unitId };
}

/** Deletes a module: its pages fall all the way back to the free tray, and its units go with it. */
export function removeModule(a: ReportAnnotation, mid: string): ReportAnnotation {
  const pages = a.pages.map((p) => (p.mid === mid ? { ...p, mid: null, uid: null } : p));
  return {
    ...a,
    pages,
    units: a.units.filter((u) => u.mid !== mid),
    modules: a.modules.filter((m) => m.id !== mid),
  };
}

/** Deletes a unit: its children are promoted one level, and its direct pages fall back to its parent. */
export function removeUnit(a: ReportAnnotation, uid: string): ReportAnnotation {
  const target = unitOf(a, uid);
  const parent = target ? target.pid : null;
  const units = a.units
    .filter((u) => u.id !== uid)
    .map((u) => (u.pid === uid ? { ...u, pid: parent } : u));
  const pages = a.pages.map((p) => (p.uid === uid ? { ...p, uid: parent } : p));
  return { ...a, pages, units };
}

/* ============================ Fill-in status ============================ */

export type PageStatus = { done: boolean; touched: boolean; missing: string[] };

/**
 * "已填完" = page purpose filled in + at least one block drawn + every
 * block has both a content type and a block role. "在标" = anything on the
 * page has been touched but it isn't done yet. Matches the demo's
 * `pageStatus`/`DONEP`, plus an explicit content-type check: the demo never
 * exercises it because its own UI always seeds a default type when a block
 * is drawn, but nothing in the data model guarantees that, so we check it
 * here too (see report at the end of the task for this and other
 * resolved-ambiguity notes).
 */
export function pageStatus(p: ReportPage): PageStatus {
  const missing: string[] = [];
  if (!p.func) missing.push("页面作用");
  if (!p.blocks.length) {
    missing.push("内容组块");
  } else {
    const missingType = p.blocks.filter((b) => !b.type).length;
    if (missingType) missing.push(`${missingType} 个组块的内容类型`);
    const missingRole = p.blocks.filter((b) => !(b.roles && b.roles.length)).length;
    if (missingRole) missing.push(`${missingRole} 个组块的作用`);
  }
  return {
    done: !missing.length,
    touched: !!(p.func || p.org || p.blocks.length),
    missing,
  };
}

/* ============================ Colors ============================ */

const MODULE_COLOR_PALETTE: readonly string[] =
  ["#ff8d4d", "#6ca0d8", "#dfff4f", "#75b985", "#d86aae", "#e0a458", "#8fd4c8", "#c79ede"];

/** Module color comes from its position in the deck, cycling an 8-color palette — never from its name. */
export function moduleColor(index: number): string {
  const i = index < 0 ? 0 : index;
  return MODULE_COLOR_PALETTE[i % MODULE_COLOR_PALETTE.length];
}

const UNIT_DEPTH_TINTS: readonly number[] = [0.3, 0.48, 0.62, 0.72];
/** The demo's dark canvas background — units fade toward it the deeper they nest. */
const DIM_TOWARD: readonly [number, number, number] = [21, 23, 15];

function dimHexColor(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return `#${channels
    .map((v, i) => Math.round(v + (DIM_TOWARD[i] - v) * t).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** A unit's color is its module's color, faded further for each level of nesting. */
export function unitColorFor(a: ReportAnnotation, uid: string): string {
  const unit = unitOf(a, uid);
  if (!unit) return moduleColor(0);
  const moduleIndex = sortedModules(a).findIndex((m) => m.id === unit.mid);
  const base = moduleColor(moduleIndex);
  let depth = 0;
  let cursor: ReportUnit | undefined = unit;
  while (cursor && cursor.pid) {
    depth += 1;
    cursor = unitOf(a, cursor.pid);
  }
  return dimHexColor(base, UNIT_DEPTH_TINTS[Math.min(depth, UNIT_DEPTH_TINTS.length - 1)]);
}

/* ============================ Initial payload ============================ */

/** The payload right after upload: no modules, no units, one blank entry per page. */
export function emptyReportAnnotation(pageNumbers: readonly number[]): ReportAnnotation {
  return {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [],
    units: [],
    pages: [...pageNumbers].sort((x, y) => x - y).map((n) => ({
      n, mid: null, uid: null, transition: false, func: "", org: "", blocks: [],
    })),
  };
}

/* ============================ Server-side validation ============================ */

export type ReportAnnotationValidation =
  | { ok: true; value: ReportAnnotation }
  | { ok: false; errors: string[] };

const RELATION_SET = new Set(REPORT_RELATIONS);
const WRITING_STYLE_SET = new Set(WRITING_STYLES);
const BLOCK_ROLE_SET = new Set(BLOCK_ROLES);
const REPORT_MODEL_SET = new Set(REPORT_MODELS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

/**
 * Server-side save validation from spec §3.3: rejects, never repairs.
 * Collects every problem found (like `validateApprovalCandidate` in
 * `lib/annotation-validation.ts`) rather than stopping at the first one, so
 * the caller can report everything wrong with a save attempt at once.
 */
export function validateReportAnnotation(
  payload: unknown,
  pageNumbers: readonly number[],
): ReportAnnotationValidation {
  const errors: string[] = [];
  if (!isRecord(payload)) return { ok: false, errors: ["payload 必须是对象"] };

  const backgroundRaw = payload.background;
  let background: ReportAnnotation["background"] = {
    city: "", developer: "", projectBackground: "", businessBackground: "",
  };
  if (
    !isRecord(backgroundRaw)
    || !isString(backgroundRaw.city) || !isString(backgroundRaw.developer)
    || !isString(backgroundRaw.projectBackground) || !isString(backgroundRaw.businessBackground)
  ) {
    errors.push("案例背景与资料（background）字段缺失或类型不对");
  } else {
    background = {
      city: backgroundRaw.city,
      developer: backgroundRaw.developer,
      projectBackground: backgroundRaw.projectBackground,
      businessBackground: backgroundRaw.businessBackground,
    };
  }

  const strategyRaw = payload.strategy;
  let strategy: ReportAnnotation["strategy"] = { narrative: "", model: "" };
  if (!isRecord(strategyRaw) || !isString(strategyRaw.narrative) || !isString(strategyRaw.model)) {
    errors.push("竞争与提报策略（strategy）字段缺失或类型不对");
  } else {
    if (strategyRaw.model !== "" && !REPORT_MODEL_SET.has(strategyRaw.model)) {
      errors.push(`报告模型「${strategyRaw.model}」不在词表内`);
    }
    strategy = { narrative: strategyRaw.narrative, model: strategyRaw.model };
  }

  const modulesRaw = payload.modules;
  const modules: ReportModule[] = [];
  const moduleIds = new Set<string>();
  if (!Array.isArray(modulesRaw)) {
    errors.push("modules 必须是数组");
  } else {
    modulesRaw.forEach((raw, index) => {
      if (
        !isRecord(raw) || !isString(raw.id) || !isString(raw.name)
        || !isString(raw.rel) || !isString(raw.role)
      ) {
        errors.push(`模块第 ${index + 1} 项字段缺失或类型不对`);
        return;
      }
      if (moduleIds.has(raw.id)) {
        errors.push(`模块 id「${raw.id}」重复`);
        return;
      }
      moduleIds.add(raw.id);
      if (!RELATION_SET.has(raw.rel)) {
        errors.push(`模块「${raw.name || raw.id}」的模块间组织关系「${raw.rel}」不在词表内`);
      }
      modules.push({ id: raw.id, name: raw.name, rel: raw.rel, role: raw.role });
    });
  }

  const unitsRaw = payload.units;
  const units: ReportUnit[] = [];
  const unitIds = new Set<string>();
  if (!Array.isArray(unitsRaw)) {
    errors.push("units 必须是数组");
  } else {
    unitsRaw.forEach((raw, index) => {
      if (
        !isRecord(raw) || !isString(raw.id) || !isString(raw.mid)
        || (raw.pid !== null && !isString(raw.pid))
        || !isString(raw.name) || !isString(raw.rel) || !isString(raw.task)
        || !isString(raw.role) || !isString(raw.psy) || !isString(raw.concl)
      ) {
        errors.push(`讲述单元第 ${index + 1} 项字段缺失或类型不对`);
        return;
      }
      if (unitIds.has(raw.id)) {
        errors.push(`单元 id「${raw.id}」重复`);
        return;
      }
      unitIds.add(raw.id);
      if (!RELATION_SET.has(raw.rel)) {
        errors.push(`单元「${raw.name || raw.id}」的单元间组织关系「${raw.rel}」不在词表内`);
      }
      units.push({
        id: raw.id, mid: raw.mid, pid: raw.pid as string | null, name: raw.name,
        rel: raw.rel, task: raw.task, role: raw.role, psy: raw.psy, concl: raw.concl,
      });
    });
  }

  const unitById = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    if (!moduleIds.has(u.mid)) errors.push(`单元「${u.name || u.id}」所属的模块「${u.mid}」不存在`);
    if (u.pid !== null && !unitIds.has(u.pid)) errors.push(`单元「${u.name || u.id}」的父单元「${u.pid}」不存在`);
  }
  // A pid cycle anywhere makes the child-direction walk that unitPages() does
  // (via childUnitsOf) unsafe for every unit that can reach it, not just the
  // units on the cycle itself — so a single cycle anywhere in the payload
  // disables the recursive contiguity/emptiness checks below entirely,
  // rather than trying to isolate just the affected units.
  let hasAnyCycle = false;
  for (const u of units) {
    const visited = new Set<string>([u.id]);
    let cursor = u.pid !== null ? unitById.get(u.pid) : undefined;
    let hasCycle = false;
    let hasCrossModule = false;
    while (cursor) {
      if (visited.has(cursor.id)) { hasCycle = true; break; }
      if (cursor.mid !== u.mid) { hasCrossModule = true; break; }
      visited.add(cursor.id);
      cursor = cursor.pid !== null ? unitById.get(cursor.pid) : undefined;
    }
    if (hasCycle) { errors.push(`单元「${u.name || u.id}」的父级链成环`); hasAnyCycle = true; }
    if (hasCrossModule) errors.push(`单元「${u.name || u.id}」的父级链跨了模块`);
  }

  const pagesRaw = payload.pages;
  const pages: ReportPage[] = [];
  const seenPageNos = new Set<number>();
  if (!Array.isArray(pagesRaw)) {
    errors.push("pages 必须是数组");
  } else {
    pagesRaw.forEach((raw, index) => {
      if (
        !isRecord(raw) || !isFiniteNumber(raw.n) || !Number.isInteger(raw.n)
        || (raw.mid !== null && !isString(raw.mid)) || (raw.uid !== null && !isString(raw.uid))
        || !isBoolean(raw.transition) || !isString(raw.func) || !isString(raw.org)
        || !Array.isArray(raw.blocks)
      ) {
        errors.push(`页第 ${index + 1} 项字段缺失或类型不对`);
        return;
      }
      if (seenPageNos.has(raw.n)) {
        errors.push(`页 p${raw.n} 重复`);
        return;
      }
      seenPageNos.add(raw.n);

      const blocks: ReportBlock[] = [];
      raw.blocks.forEach((braw: unknown, bi: number) => {
        if (
          !isRecord(braw) || !isString(braw.id) || !isString(braw.name)
          || !isFiniteNumber(braw.x) || !isFiniteNumber(braw.y)
          || !isFiniteNumber(braw.w) || !isFiniteNumber(braw.h)
          || !isString(braw.type) || !isStringArray(braw.roles) || !isString(braw.style)
          || !isString(braw.rel) || !isString(braw.narr) || !isString(braw.mark)
        ) {
          errors.push(`页 p${raw.n} 第 ${bi + 1} 个组块字段缺失或类型不对`);
          return;
        }
        if (braw.x < 0 || braw.x > 100 || braw.y < 0 || braw.y > 100) {
          errors.push(`页 p${raw.n} 的组块「${braw.name}」坐标必须在 0–100 之间`);
        }
        if (!(braw.w > 0) || !(braw.h > 0)) {
          errors.push(`页 p${raw.n} 的组块「${braw.name}」宽高必须大于 0`);
        }
        if (!WRITING_STYLE_SET.has(braw.style)) {
          errors.push(`页 p${raw.n} 的组块「${braw.name}」文风类型「${braw.style}」不在词表内`);
        }
        if (!RELATION_SET.has(braw.rel)) {
          errors.push(`页 p${raw.n} 的组块「${braw.name}」组块间组织关系「${braw.rel}」不在词表内`);
        }
        if (braw.roles.some((role) => !BLOCK_ROLE_SET.has(role))) {
          errors.push(`页 p${raw.n} 的组块「${braw.name}」组块作用含有不在词表内的值`);
        }
        blocks.push({
          id: braw.id, name: braw.name, x: braw.x, y: braw.y, w: braw.w, h: braw.h,
          type: braw.type, roles: braw.roles, style: braw.style, rel: braw.rel,
          narr: braw.narr, mark: braw.mark,
        });
      });

      pages.push({
        n: raw.n, mid: (raw.mid as string | null) ?? null, uid: (raw.uid as string | null) ?? null,
        transition: raw.transition, func: raw.func, org: raw.org, blocks,
      });
    });
  }

  const expectedPageNos = new Set(pageNumbers);
  const missingPages = [...expectedPageNos].filter((n) => !seenPageNos.has(n)).sort((x, y) => x - y);
  const extraPages = [...seenPageNos].filter((n) => !expectedPageNos.has(n)).sort((x, y) => x - y);
  if (missingPages.length) errors.push(`缺少页 ${missingPages.map((n) => `p${n}`).join("、")}`);
  if (extraPages.length) errors.push(`出现了不属于本报告的页 ${extraPages.map((n) => `p${n}`).join("、")}`);

  for (const p of pages) {
    if (p.mid !== null && !moduleIds.has(p.mid)) errors.push(`页 p${p.n} 引用了不存在的模块`);
    if (p.uid !== null) {
      if (!unitIds.has(p.uid)) {
        errors.push(`页 p${p.n} 引用了不存在的单元`);
      } else {
        const owner = unitById.get(p.uid);
        if (owner && owner.mid !== p.mid) errors.push(`页 p${p.n} 所属的单元与所属模块不一致`);
      }
    }
  }

  const draft: ReportAnnotation = { background, strategy, modules, units, pages: [...pages].sort(byPageNo) };

  for (const m of modules) {
    const pagesInModule = modulePages(draft, m.id);
    if (!pagesInModule.length) errors.push(`模块「${m.name || m.id}」没有任何页`);
    else if (!isContiguous(pagesInModule)) errors.push(`模块「${m.name || m.id}」所辖页不连续`);
  }
  // Skip once any pid cycle was found above: unitPages()/childUnitsOf() walk
  // the child direction and would recurse forever over a cyclic unit graph.
  // The cycle error already reported is enough to reject the payload.
  if (!hasAnyCycle) {
    for (const u of units) {
      const pagesInUnit = unitPages(draft, u.id);
      const hasChildren = units.some((k) => k.pid === u.id);
      if (!pagesInUnit.length && !hasChildren) {
        errors.push(`单元「${u.name || u.id}」既没有页也没有子单元`);
      } else if (pagesInUnit.length && !isContiguous(pagesInUnit)) {
        errors.push(`单元「${u.name || u.id}」所辖页不连续`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: draft };
}
