// 报告拆解工作台「集成版」：每份报告一份，内容按处取各版本里最新的一次修改。
// 见 docs/21_报告集成版_实施规格_V0.1.md 二（数据）/ 三（汇入算法）/ 四、4.1-4.3。
// 对照视频侧 lib/final-version.ts——同一形状，但汇入源头不同（报告没有客户端
// 变更集，只能拿保存前后两份完整 payload 现算 diff，见 3.1 前言），且多了 SPAN
// 这一类视频没有的「页范围结构记录」（三、C）。
//
// 与 lib/report-version-chain.ts 互相引用（该文件的写路径 saveReportVersion 在
// 写完自己那一版之后调用本文件的 intakeReportVersionIntoFinal；
// createReportVersionFrom 在 fromVersionId === "final" 时调用本文件的
// ensureReportFinalVersion）。两个模块的引用只发生在函数体内部（从不在模块顶层
// 求值对方的导出），与视频侧 final-version.ts 顶部注释描述的双向 import 一样安全。

import { randomUUID } from "node:crypto";
import type { DbClient, QueryResultRow } from "@/db";
import { isCaseReviewer } from "./case-review";
import {
  emptyReportAnnotation,
  isContiguous,
  modulePages,
  moduleNumbers,
  openPagesOf,
  pruneEmptyStructure,
  removeModule,
  removeUnit,
  unitPages,
  validateReportAnnotation,
  type ReportAnnotation,
  type ReportBlock,
  type ReportModule,
  type ReportUnit,
} from "./report-structure";
import {
  hashReportPayload,
  loadPageNumbers,
  requireReadyReport,
  ReportVersionError,
  type ReportVersionActor,
} from "./report-version-chain";

const genId = (prefix: string) => `${prefix}_${randomUUID()}`;
const iso = (value: Date) => value.toISOString();

function parseJsonPayload(value: ReportAnnotation | string): ReportAnnotation {
  return typeof value === "string" ? (JSON.parse(value) as ReportAnnotation) : value;
}

// pg 已经把 jsonb 列解析成 JS 值，一条 jsonb 记录的*内容*恰好是字符串
// （""或"李晓芸的商业意图"）时，在这一层跟"还需要再 JSON.parse 一次的编码串"
// 是分不清的。解析失败就用原值兜底——与 lib/final-version.ts 的 parseJsonValue
// 同一处理方式。
function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Pure types & helpers — no I/O, unit-tested directly in
// tests/report-final-version.test.ts.
// ---------------------------------------------------------------------------

export type ReportFinalIntakeKind =
  | "FIELD"
  | "INSERT_MODULE" | "INSERT_UNIT" | "INSERT_BLOCK"
  | "REMOVE_MODULE" | "REMOVE_UNIT" | "REMOVE_BLOCK"
  | "SPAN";
export type ReportFinalIntakeSource = "VERSION" | "FINAL_DIRECT";

/** One "某处的一次修改" before it has a database identity (id/seq/applied). */
export type ReportFinalIntakeDraft = {
  kind: ReportFinalIntakeKind;
  targetKey: string;
  targetLabel: string;
  value: unknown;
};

export type ReportFinalApplyEffect = "APPLIED" | "NOOP";

function changed(before: unknown, after: unknown) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function byIdAscending<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

const UNIT_DEPTH_TITLES = ["讲述单元", "子单元", "孙单元", "曾孙单元"];

/** Matches `ReportSectionPopover.tsx`'s own `unitDepth` — kept as a small private
 * copy here rather than shared, since that component is frontend-only and out of
 * scope for this change (see task notes: components/report/** is untouched). */
function unitDepth(a: ReportAnnotation, uid: string): number {
  let depth = 0;
  let cursor = a.units.find((u) => u.id === uid);
  while (cursor && cursor.pid) {
    depth += 1;
    cursor = a.units.find((u) => u.id === cursor!.pid);
  }
  return depth;
}

/**
 * 3.1 — compares two full `ReportAnnotation` payloads (this version's content
 * before and after one save) and produces the ordered intake drafts. Order is
 * fixed: REMOVE (module, unit, block) → INSERT (module, unit, block) → SPAN
 * (module, unit) → FIELD (background/strategy → module → unit → page →
 * block, ascending by id/page number for determinism only).
 */
export function diffReportAnnotation(
  before: ReportAnnotation,
  after: ReportAnnotation,
): ReportFinalIntakeDraft[] {
  const drafts: ReportFinalIntakeDraft[] = [];

  const beforeModuleById = new Map(before.modules.map((m) => [m.id, m]));
  const afterModuleIds = new Set(after.modules.map((m) => m.id));
  const beforeUnitById = new Map(before.units.map((u) => [u.id, u]));
  const afterUnitIds = new Set(after.units.map((u) => u.id));

  // ---- REMOVE: module, then unit, then block ----
  const removedModules = byIdAscending(before.modules.filter((m) => !afterModuleIds.has(m.id)));
  for (const m of removedModules) {
    drafts.push({ kind: "REMOVE_MODULE", targetKey: `module:${m.id}`, targetLabel: m.name || "模块", value: {} });
  }
  const removedModuleIds = new Set(removedModules.map((m) => m.id));

  const removedUnits = byIdAscending(
    before.units.filter((u) => !afterUnitIds.has(u.id) && !removedModuleIds.has(u.mid)),
  );
  for (const u of removedUnits) {
    drafts.push({ kind: "REMOVE_UNIT", targetKey: `unit:${u.id}`, targetLabel: u.name || "讲述单元", value: {} });
  }

  const beforePageByNo = new Map(before.pages.map((p) => [p.n, p]));
  const afterPageByNo = new Map(after.pages.map((p) => [p.n, p]));
  const sharedPageNos = [...beforePageByNo.keys()].filter((n) => afterPageByNo.has(n)).sort((a, b) => a - b);

  for (const n of sharedPageNos) {
    const bp = beforePageByNo.get(n)!;
    const ap = afterPageByNo.get(n)!;
    const afterBlockIds = new Set(ap.blocks.map((b) => b.id));
    for (const b of byIdAscending(bp.blocks.filter((b) => !afterBlockIds.has(b.id)))) {
      drafts.push({ kind: "REMOVE_BLOCK", targetKey: `block:${b.id}`, targetLabel: b.name || "组块", value: {} });
    }
  }

  // ---- INSERT: module, then unit, then block (no afterId needed — order is
  // always page-position-derived, see spec 3.1) ----
  for (const m of byIdAscending(after.modules.filter((m) => !beforeModuleById.has(m.id)))) {
    drafts.push({ kind: "INSERT_MODULE", targetKey: `module:${m.id}`, targetLabel: m.name || "模块", value: { item: m } });
  }
  for (const u of byIdAscending(after.units.filter((u) => !beforeUnitById.has(u.id)))) {
    drafts.push({ kind: "INSERT_UNIT", targetKey: `unit:${u.id}`, targetLabel: u.name || "讲述单元", value: { item: u } });
  }
  for (const n of sharedPageNos) {
    const bp = beforePageByNo.get(n)!;
    const ap = afterPageByNo.get(n)!;
    const beforeBlockIds = new Set(bp.blocks.map((b) => b.id));
    for (const b of byIdAscending(ap.blocks.filter((b) => !beforeBlockIds.has(b.id)))) {
      drafts.push({
        kind: "INSERT_BLOCK", targetKey: `block:${b.id}`, targetLabel: b.name || "组块",
        value: { item: b, pageNo: n },
      });
    }
  }

  // ---- SPAN: module, then unit — only for containers still present in
  // `after` (new ones included); "从无到有" falls out naturally because
  // openPagesOf(before, key) is [] for an id that never appeared in
  // before.pages, with no need to special-case brand-new containers. ----
  for (const m of byIdAscending(after.modules)) {
    const beforePages = openPagesOf(before, `mod:${m.id}`).map((p) => p.n);
    const afterPages = openPagesOf(after, `mod:${m.id}`).map((p) => p.n);
    if (changed(beforePages, afterPages)) {
      drafts.push({
        kind: "SPAN", targetKey: `module:${m.id}`, targetLabel: m.name || "未命名模块",
        value: { pageNumbers: afterPages },
      });
    }
  }
  for (const u of byIdAscending(after.units)) {
    const beforePages = openPagesOf(before, `unit:${u.id}`).map((p) => p.n);
    const afterPages = openPagesOf(after, `unit:${u.id}`).map((p) => p.n);
    if (changed(beforePages, afterPages)) {
      drafts.push({
        kind: "SPAN", targetKey: `unit:${u.id}`, targetLabel: u.name || "未命名单元",
        value: { pageNumbers: afterPages },
      });
    }
  }

  // ---- FIELD: background → strategy → module → unit → page → block ----
  const push = (targetKey: string, targetLabel: string, b: unknown, a: unknown) => {
    if (changed(b, a)) drafts.push({ kind: "FIELD", targetKey, targetLabel, value: a });
  };
  push("background.city", "城市", before.background.city, after.background.city);
  push("background.developer", "开发商", before.background.developer, after.background.developer);
  push("background.projectBackground", "项目背景", before.background.projectBackground, after.background.projectBackground);
  push("background.businessBackground", "业务背景", before.background.businessBackground, after.background.businessBackground);
  push("strategy.narrative", "竞争与提报策略", before.strategy.narrative, after.strategy.narrative);
  push("strategy.model", "报告模型", before.strategy.model, after.strategy.model);

  const nums = moduleNumbers(after);
  for (const m of byIdAscending(after.modules)) {
    const bm = beforeModuleById.get(m.id);
    if (!bm) continue; // brand-new module — its fields already shipped whole in INSERT_MODULE
    const title = `模块 ${nums[m.id] ?? ""}`;
    push(`module:${m.id}:name`, `${title}·名称`, bm.name, m.name);
    push(`module:${m.id}:rel`, `${title}·模块间组织关系`, bm.rel, m.rel);
    push(`module:${m.id}:role`, `${title}·策略作用`, bm.role, m.role);
  }
  for (const u of byIdAscending(after.units)) {
    const bu = beforeUnitById.get(u.id);
    if (!bu) continue;
    const depth = unitDepth(after, u.id);
    const title = `${UNIT_DEPTH_TITLES[Math.min(depth, UNIT_DEPTH_TITLES.length - 1)]} ${nums[u.id] ?? ""}`;
    push(`unit:${u.id}:name`, `${title}·单元名称`, bu.name, u.name);
    push(`unit:${u.id}:rel`, `${title}·单元间组织关系`, bu.rel, u.rel);
    push(`unit:${u.id}:task`, `${title}·传播／讲述任务`, bu.task, u.task);
    push(`unit:${u.id}:role`, `${title}·讲述作用`, bu.role, u.role);
    push(`unit:${u.id}:psy`, `${title}·预期心理`, bu.psy, u.psy);
    push(`unit:${u.id}:concl`, `${title}·候选结论`, bu.concl, u.concl);
  }
  for (const n of sharedPageNos) {
    const bp = beforePageByNo.get(n)!;
    const ap = afterPageByNo.get(n)!;
    push(`page:${n}:func`, `第 ${n} 页·页面作用`, bp.func, ap.func);
    push(`page:${n}:org`, `第 ${n} 页·本页组织关系`, bp.org, ap.org);
    push(`page:${n}:transition`, `第 ${n} 页·过渡页`, bp.transition, ap.transition);
  }
  for (const n of sharedPageNos) {
    const bp = beforePageByNo.get(n)!;
    const ap = afterPageByNo.get(n)!;
    const beforeBlockById = new Map(bp.blocks.map((b) => [b.id, b]));
    const naturalIndexById = new Map(ap.blocks.map((b, index) => [b.id, index]));
    for (const b of byIdAscending(ap.blocks)) {
      const bb = beforeBlockById.get(b.id);
      if (!bb) continue; // brand-new block — its fields already shipped whole in INSERT_BLOCK
      const label = `第 ${n} 页·组块 ${(naturalIndexById.get(b.id) ?? 0) + 1}`;
      push(`block:${b.id}:name`, label, bb.name, b.name);
      push(`block:${b.id}:type`, `${label}·内容类型`, bb.type, b.type);
      push(`block:${b.id}:style`, `${label}·文风类型`, bb.style, b.style);
      push(`block:${b.id}:rel`, `${label}·组块间组织关系`, bb.rel, b.rel);
      push(`block:${b.id}:roles`, `${label}·组块作用`, bb.roles, b.roles);
      push(`block:${b.id}:narr`, `${label}·叙述作用`, bb.narr, b.narr);
      push(`block:${b.id}:mark`, `${label}·关键标记`, bb.mark, b.mark);
      push(`block:${b.id}:x`, `${label}·横坐标`, bb.x, b.x);
      push(`block:${b.id}:y`, `${label}·纵坐标`, bb.y, b.y);
      push(`block:${b.id}:w`, `${label}·宽度`, bb.w, b.w);
      push(`block:${b.id}:h`, `${label}·高度`, bb.h, b.h);
    }
  }

  return drafts;
}

/**
 * Retreats every unit whose combined (direct + nested) pages are not one
 * contiguous run, deepest units first — spec 3.2 SPAN step 2(a). Only the
 * contiguous run containing the smallest page number survives; the rest
 * fall back to the unit's own direct parent (a parent unit if it has one,
 * otherwise the module itself). Processing deepest-first in one descending-
 * depth pass is enough to cascade correctly: by the time a unit is checked,
 * every unit nested inside it has already been fixed, so its own direct
 * pages already include whatever those children retreated up to it.
 */
function retreatNonContiguousUnits(a: ReportAnnotation): ReportAnnotation {
  let next = a;
  const depthOf = (uid: string) => unitDepth(next, uid);
  const order = [...next.units].sort((x, y) => depthOf(y.id) - depthOf(x.id));
  for (const u of order) {
    const pages = unitPages(next, u.id); // sorted ascending
    if (isContiguous(pages)) continue;
    const pageNums = new Set(pages.map((p) => p.n));
    const keep = new Set<number>();
    let cursor = pages[0].n;
    while (pageNums.has(cursor)) {
      keep.add(cursor);
      cursor += 1;
    }
    const retreat = new Set(pages.filter((p) => !keep.has(p.n)).map((p) => p.n));
    const parent = u.pid ? next.units.find((k) => k.id === u.pid) : undefined;
    next = {
      ...next,
      pages: next.pages.map((p) => {
        if (!retreat.has(p.n)) return p;
        return parent ? { ...p, mid: parent.mid, uid: parent.id } : { ...p, mid: u.mid, uid: null };
      }),
    };
  }
  return next;
}

/**
 * Retreats every module whose pages are not one contiguous run — spec 3.2
 * SPAN step 2(b). Runs after `retreatNonContiguousUnits`, so every unit's
 * own pages are already internally contiguous by this point; the excess
 * here can only fall on whole units or whole direct-page stretches, never
 * split one still-standing unit's block in two (see docs/21 §3.7 example 2
 * for why that invariant holds). Excess pages fall all the way back to
 * "未归入" (mid=null, uid=null) — a module has no higher container to
 * retreat to.
 */
function retreatNonContiguousModules(a: ReportAnnotation): ReportAnnotation {
  let next = a;
  for (const m of next.modules) {
    const pages = modulePages(next, m.id); // sorted ascending
    if (isContiguous(pages)) continue;
    const pageNums = new Set(pages.map((p) => p.n));
    const keep = new Set<number>();
    let cursor = pages[0].n;
    while (pageNums.has(cursor)) {
      keep.add(cursor);
      cursor += 1;
    }
    const retreat = new Set(pages.filter((p) => !keep.has(p.n)).map((p) => p.n));
    next = { ...next, pages: next.pages.map((p) => (retreat.has(p.n) ? { ...p, mid: null, uid: null } : p)) };
  }
  return next;
}

/** Rejects on failed validation by returning the pre-apply payload as a NOOP — never lets a merge failure surface. */
function finalizeApply(
  next: ReportAnnotation,
  original: ReportAnnotation,
): { payload: ReportAnnotation; effect: ReportFinalApplyEffect } {
  const pageNumbers = original.pages.map((p) => p.n);
  const validated = validateReportAnnotation(next, pageNumbers);
  if (!validated.ok) return { payload: original, effect: "NOOP" };
  return { payload: validated.value, effect: "APPLIED" };
}

/**
 * Ids of modules/units that are *already* page-less (and, for units,
 * childless) before the current record's own mutation. The only way a
 * module/unit can be sitting in that state going into a merge step is that
 * it was just pushed by an `INSERT_MODULE`/`INSERT_UNIT` record moments ago
 * and hasn't had its own companion `SPAN` applied yet (3.1: "此时模块还没有
 * 页...落地顺序上 INSERT 必须先于 SPAN") — a container that instead just lost
 * its last page as a result of an *earlier* step in this same batch would
 * already have been swept away by that earlier step's own
 * `pruneEmptyStructure` call, so it would not still be sitting in `a.modules`/
 * `a.units` to be found here. Used to exempt exactly those pending
 * containers from both the "drop if empty" sweep and the structural
 * soundness check below, so an unrelated record elsewhere in the same batch
 * (or a different container's own SPAN, alphabetically ahead of a
 * newly-inserted one — ids are random suffixes, so this is not a rare
 * ordering fluke) can never sweep away or reject-as-invalid a fresh
 * container that just hasn't had its turn yet.
 */
function pendingProtectSets(a: ReportAnnotation): { moduleIds: Set<string>; unitIds: Set<string> } {
  return {
    moduleIds: new Set(a.modules.filter((m) => !modulePages(a, m.id).length).map((m) => m.id)),
    unitIds: new Set(a.units.filter((u) => !unitPages(a, u.id).length).map((u) => u.id)),
  };
}

/**
 * Structural-only soundness check used in place of the full
 * `validateReportAnnotation` for kinds that only ever move pages/containers
 * around in an already-typed, already-shape-valid `ReportAnnotation` (never
 * raw untrusted JSON) — REMOVE_*, INSERT_BLOCK, and SPAN. Those kinds can
 * only possibly break two things: a module/unit's page contiguity, or
 * leaving a module/unit with no pages and no children — never a vocabulary
 * violation (they never write a new field value), so the schema/word-list
 * portions of `validateReportAnnotation` would be pure overhead here, and
 * worse, would wrongly reject a legitimately-pending fresh container (see
 * `pendingProtectSets`) since that function has no way to know "still
 * waiting on its own SPAN" isn't simply "broken". FIELD keeps the full
 * `validateReportAnnotation` (it is the one kind that writes an
 * attacker-arbitrary-shaped value, e.g. an out-of-vocabulary `rel`, and
 * FIELD records only ever apply after every SPAN in a diff-generated batch
 * has already run, so it never legitimately encounters a pending container).
 */
function structurallySound(a: ReportAnnotation, protect: { moduleIds: ReadonlySet<string>; unitIds: ReadonlySet<string> }): boolean {
  for (const m of a.modules) {
    const pages = modulePages(a, m.id);
    if (!pages.length) {
      if (!protect.moduleIds.has(m.id)) return false;
      continue;
    }
    if (!isContiguous(pages)) return false;
  }
  for (const u of a.units) {
    const pages = unitPages(a, u.id);
    const hasChildren = a.units.some((k) => k.pid === u.id);
    if (!pages.length && !hasChildren) {
      if (!protect.unitIds.has(u.id)) return false;
      continue;
    }
    if (pages.length && !isContiguous(pages)) return false;
  }
  return true;
}

function finalizeStructural(
  next: ReportAnnotation,
  original: ReportAnnotation,
  protect: { moduleIds: ReadonlySet<string>; unitIds: ReadonlySet<string> },
): { payload: ReportAnnotation; effect: ReportFinalApplyEffect } {
  if (!structurallySound(next, protect)) return { payload: original, effect: "NOOP" };
  return { payload: next, effect: "APPLIED" };
}

function applyFieldIntake(payload: ReportAnnotation, targetKey: string, value: unknown): ReportAnnotation | null {
  if (targetKey.startsWith("background.")) {
    const field = targetKey.slice("background.".length) as keyof ReportAnnotation["background"];
    if (!(field in payload.background)) return null;
    return { ...payload, background: { ...payload.background, [field]: value } };
  }
  if (targetKey.startsWith("strategy.")) {
    const field = targetKey.slice("strategy.".length) as keyof ReportAnnotation["strategy"];
    if (!(field in payload.strategy)) return null;
    return { ...payload, strategy: { ...payload.strategy, [field]: value } };
  }
  if (targetKey.startsWith("module:")) {
    const rest = targetKey.slice("module:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    const id = rest.slice(0, sep);
    const field = rest.slice(sep + 1) as keyof ReportModule;
    if (!payload.modules.some((m) => m.id === id)) return null;
    return { ...payload, modules: payload.modules.map((m) => (m.id === id ? { ...m, [field]: value } : m)) };
  }
  if (targetKey.startsWith("unit:")) {
    const rest = targetKey.slice("unit:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    const id = rest.slice(0, sep);
    const field = rest.slice(sep + 1) as keyof ReportUnit;
    if (!payload.units.some((u) => u.id === id)) return null;
    return { ...payload, units: payload.units.map((u) => (u.id === id ? { ...u, [field]: value } : u)) };
  }
  if (targetKey.startsWith("page:")) {
    const rest = targetKey.slice("page:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    const n = Number(rest.slice(0, sep));
    const field = rest.slice(sep + 1) as "func" | "org" | "transition";
    if (!payload.pages.some((p) => p.n === n)) return null;
    return { ...payload, pages: payload.pages.map((p) => (p.n === n ? { ...p, [field]: value } : p)) };
  }
  if (targetKey.startsWith("block:")) {
    const rest = targetKey.slice("block:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return null;
    const id = rest.slice(0, sep);
    const field = rest.slice(sep + 1) as keyof ReportBlock;
    let found = false;
    const pages = payload.pages.map((p) => {
      if (!p.blocks.some((b) => b.id === id)) return p;
      found = true;
      return { ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, [field]: value } : b)) };
    });
    if (!found) return null;
    return { ...payload, pages };
  }
  return null;
}

/** 3.2 — applies one intake draft to a report-final payload. */
export function applyReportFinalIntake(
  payload: ReportAnnotation,
  intake: Pick<ReportFinalIntakeDraft, "kind" | "targetKey" | "value">,
): { payload: ReportAnnotation; effect: ReportFinalApplyEffect } {
  const next = structuredClone(payload);
  switch (intake.kind) {
    case "REMOVE_MODULE": {
      const mid = intake.targetKey.slice("module:".length);
      if (!next.modules.some((m) => m.id === mid)) return { payload, effect: "NOOP" };
      return finalizeStructural(removeModule(next, mid), payload, pendingProtectSets(next));
    }
    case "REMOVE_UNIT": {
      const uid = intake.targetKey.slice("unit:".length);
      if (!next.units.some((u) => u.id === uid)) return { payload, effect: "NOOP" };
      return finalizeStructural(removeUnit(next, uid), payload, pendingProtectSets(next));
    }
    case "REMOVE_BLOCK": {
      const bid = intake.targetKey.slice("block:".length);
      if (!next.pages.some((p) => p.blocks.some((b) => b.id === bid))) return { payload, effect: "NOOP" };
      const pages = next.pages.map((p) => ({ ...p, blocks: p.blocks.filter((b) => b.id !== bid) }));
      return finalizeStructural({ ...next, pages }, payload, pendingProtectSets(next));
    }
    case "INSERT_MODULE": {
      // 不跑 finalizeApply 的整份 validate：这一步之后模块还没有页（3.1 明确
      // 说"此时模块还没有页"），validateReportAnnotation 会因"模块没有任何页"
      // 硬性拒绝这个必然存在的中间态——落地顺序上 INSERT 必须先于 SPAN，
      // 紧随其后的 SPAN 记录落地时才会跑完整 validate 补上页范围。这里的
      // NOOP 判定只看 3.2 明文列出的那一条（id 已存在），已经足够安全：
      // item 本身取自某一版已经通过校验的 payload，结构不可能有问题。
      const { item } = intake.value as { item: ReportModule };
      if (next.modules.some((m) => m.id === item.id)) return { payload, effect: "NOOP" };
      return { payload: { ...next, modules: [...next.modules, structuredClone(item)] }, effect: "APPLIED" };
    }
    case "INSERT_UNIT": {
      // 同 INSERT_MODULE：新单元这一步也可能还没有页（也没有子单元），
      // validateReportAnnotation 的"单元既没有页也没有子单元"检查会误杀这个
      // 中间态，同样只跑 3.2 明文列出的三条 NOOP 判定（id 冲突、mid 不存在、
      // pid 不存在），不跑整份 validate。
      const { item } = intake.value as { item: ReportUnit };
      if (next.units.some((u) => u.id === item.id)) return { payload, effect: "NOOP" };
      if (!next.modules.some((m) => m.id === item.mid)) return { payload, effect: "NOOP" };
      if (item.pid !== null && !next.units.some((u) => u.id === item.pid)) return { payload, effect: "NOOP" };
      return { payload: { ...next, units: [...next.units, structuredClone(item)] }, effect: "APPLIED" };
    }
    case "INSERT_BLOCK": {
      const { item, pageNo } = intake.value as { item: ReportBlock; pageNo: number };
      if (next.pages.some((p) => p.blocks.some((b) => b.id === item.id))) return { payload, effect: "NOOP" };
      if (!next.pages.some((p) => p.n === pageNo)) return { payload, effect: "NOOP" };
      const pages = next.pages.map((p) => (p.n === pageNo ? { ...p, blocks: [...p.blocks, structuredClone(item)] } : p));
      return finalizeStructural({ ...next, pages }, payload, pendingProtectSets(next));
    }
    case "SPAN": {
      const isModule = intake.targetKey.startsWith("module:");
      const id = intake.targetKey.slice(intake.targetKey.indexOf(":") + 1);
      if (isModule) {
        if (!next.modules.some((m) => m.id === id)) return { payload, effect: "NOOP" };
      } else if (!next.units.some((u) => u.id === id)) {
        return { payload, effect: "NOOP" };
      }
      const { pageNumbers: targetPages } = intake.value as { pageNumbers: number[] };
      const pageSet = new Set(targetPages);
      const unitMid = isModule ? undefined : next.units.find((u) => u.id === id)!.mid;
      // SPAN 的 pageNumbers 是"这个容器的全部新直属页，不是增量"（3.1）：一页
      // 若原本直属这个容器、却不在新列表里，必须被摘除——不摘除的话，例如
      // "模块 M1 从 {1..5} 缩成 {1..4}"这样的记录会什么都不做（因为 5 从没
      // 出现在 pageNumbers 里）。多数情况下这页会被"谁抢到了它"那条配对的
      // SPAN 记录顺带认领（3.7 示例一），但也可能没有任何容器认领它（页被
      // 拖去了未归入区）——那种情况下这里的摘除就是唯一让它真正变自由的地方。
      const currentDirect = isModule
        ? next.pages.filter((p) => p.mid === id && !p.uid).map((p) => p.n)
        : next.pages.filter((p) => p.uid === id).map((p) => p.n);
      const evictSet = new Set(currentDirect.filter((n) => !pageSet.has(n)));
      let reassigned: ReportAnnotation = {
        ...next,
        pages: next.pages.map((p) => {
          if (pageSet.has(p.n)) {
            return isModule ? { ...p, mid: id, uid: null } : { ...p, mid: unitMid!, uid: id };
          }
          if (evictSet.has(p.n)) return { ...p, mid: null, uid: null };
          return p;
        }),
      };
      reassigned = retreatNonContiguousUnits(reassigned);
      reassigned = retreatNonContiguousModules(reassigned);
      // 保护"这条记录动手之前就已经是 0 页"的模块/单元——见 pendingProtectSets
      // 与 lib/report-structure.ts 的 pruneEmptyStructure 顶部注释：不保护的话，
      // 字母序排在后面的新容器会被排在前面的另一个容器的这次收拢连坐清除，
      // 永远等不到自己的 SPAN。
      const protect = pendingProtectSets(next);
      const { next: pruned } = pruneEmptyStructure(reassigned, {
        protectModuleIds: protect.moduleIds, protectUnitIds: protect.unitIds,
      });
      return finalizeStructural(pruned, payload, protect);
    }
    case "FIELD": {
      const result = applyFieldIntake(next, intake.targetKey, intake.value);
      if (result === null) return { payload, effect: "NOOP" };
      return finalizeApply(result, payload);
    }
    default:
      return { payload, effect: "NOOP" };
  }
}

/**
 * Applies a whole batch of intake drafts (one save's worth, or one adoption
 * batch) in order — but only when `status` is OPEN. `DONE` never touches the
 * payload; the drafts still get recorded by the caller with `applied = false`
 * (spec 3.2 / 3.4).
 */
export function applyReportFinalIntakeBatch(
  payload: ReportAnnotation,
  drafts: readonly ReportFinalIntakeDraft[],
  status: "OPEN" | "DONE",
): { payload: ReportAnnotation; applied: boolean } {
  if (status !== "OPEN") return { payload, applied: false };
  let next = payload;
  for (const draft of drafts) {
    next = applyReportFinalIntake(next, draft).payload;
  }
  return { payload: next, applied: true };
}

/** One `report_versions` row, flattened for the version-level replay (spec 3.3). */
export type ReportFinalHistoryVersion = {
  id: string;
  versionNumber: number;
  updatedAt: string;
  ownerUserId: string;
  ownerName: string;
  /** This version's own `base_payload_json` — null exactly for a report's first version. */
  basePayload: ReportAnnotation | null;
  payload: ReportAnnotation;
};

export type ReportFinalComputedIntake = ReportFinalIntakeDraft & {
  source: "VERSION";
  sourceVersionId: string;
  sourceVersionNumber: number;
  actorUserId: string;
  actorName: string;
  applied: true;
  createdAt: string;
};

/**
 * 3.3 — replays every `report_versions` row (ordered by `updated_at` ASC,
 * `id` ASC as a tiebreak) on top of the report's blank origin, producing the
 * resulting final-version payload plus the ordered intake ledger. This is
 * version-level granularity, not edit-level like the video side's replay of
 * `collaboration_revision_events` — reports keep no such per-edit history
 * (see this file's header and spec 3.3's "已知局限" for the accepted
 * trade-off). `applied` is always true here: OPEN is the only state a final
 * version can be freshly computed/backfilled in.
 */
export function computeReportFinalFromHistory(
  origin: ReportAnnotation,
  versions: readonly ReportFinalHistoryVersion[],
): { payload: ReportAnnotation; intakes: ReportFinalComputedIntake[] } {
  let payload = structuredClone(origin);
  const intakes: ReportFinalComputedIntake[] = [];
  const sorted = [...versions].sort((left, right) => {
    const diff = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    if (diff !== 0) return diff;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  for (const version of sorted) {
    const before = version.basePayload ?? origin;
    const drafts = diffReportAnnotation(before, version.payload);
    for (const draft of drafts) {
      const { payload: next } = applyReportFinalIntake(payload, draft);
      payload = next;
      intakes.push({
        ...draft,
        source: "VERSION",
        sourceVersionId: version.id,
        sourceVersionNumber: version.versionNumber,
        actorUserId: version.ownerUserId,
        actorName: version.ownerName,
        applied: true,
        createdAt: version.updatedAt,
      });
    }
  }
  return { payload, intakes };
}

// ---------------------------------------------------------------------------
// Row shapes and small DB helpers.
// ---------------------------------------------------------------------------

type ReportFinalVersionRow = QueryResultRow & {
  id: string;
  report_id: string;
  status: "OPEN" | "DONE";
  done_at: string | null;
  done_by_user_id: string | null;
  done_by_name: string | null;
  origin_payload_json: ReportAnnotation | string;
  payload_json: ReportAnnotation | string;
  content_hash: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

type ReportFinalIntakeRow = QueryResultRow & {
  id: string;
  final_id: string;
  report_id: string;
  seq: number | string;
  kind: ReportFinalIntakeKind;
  target_key: string;
  target_label: string;
  value_json: unknown;
  source: ReportFinalIntakeSource;
  source_version_id: string | null;
  source_version_number: number | null;
  actor_user_id: string;
  actor_name: string;
  applied: boolean;
  applied_at: string | null;
  created_at: string;
};

const FINAL_VERSION_COLUMNS = `id, report_id, status, done_at, done_by_user_id, done_by_name,
  origin_payload_json, payload_json, content_hash, revision, created_at, updated_at`;

const FINAL_INTAKE_COLUMNS = `id, final_id, report_id, seq, kind, target_key, target_label,
  value_json, source, source_version_id, source_version_number, actor_user_id, actor_name,
  applied, applied_at, created_at`;

async function countPending(db: DbClient, finalId: string) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM report_final_intakes WHERE final_id = ? AND applied = false`,
  ).bind(finalId).first<{ count: number } & QueryResultRow>();
  return Number(row?.count ?? 0);
}

async function insertIntakeRow(
  db: DbClient,
  finalId: string,
  reportId: string,
  draft: ReportFinalIntakeDraft,
  meta: {
    source: ReportFinalIntakeSource;
    sourceVersionId: string | null;
    sourceVersionNumber: number | null;
    actorUserId: string;
    actorName: string;
    applied: boolean;
    appliedAt: string | null;
    createdAt: string;
  },
) {
  await db.prepare(
    `INSERT INTO report_final_intakes (
      id, final_id, report_id, kind, target_key, target_label, value_json,
      source, source_version_id, source_version_number, actor_user_id, actor_name,
      applied, applied_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)`,
  ).bind(
    genId("report_final_intake"), finalId, reportId,
    draft.kind, draft.targetKey, draft.targetLabel, JSON.stringify(draft.value ?? {}),
    meta.source, meta.sourceVersionId, meta.sourceVersionNumber, meta.actorUserId, meta.actorName,
    meta.applied, meta.appliedAt, meta.createdAt,
  ).run();
}

type BackfillVersionRow = QueryResultRow & {
  id: string;
  version_number: number;
  owner_user_id: string;
  owner_name_snapshot: string;
  base_payload_json: ReportAnnotation | string | null;
  payload_json: ReportAnnotation | string;
  updated_at: string;
};

async function loadOrderedVersionsForBackfill(db: DbClient, reportId: string): Promise<BackfillVersionRow[]> {
  return (await db.prepare(
    `SELECT id, version_number, owner_user_id, owner_name_snapshot, base_payload_json, payload_json, updated_at
    FROM report_versions WHERE report_id = ? ORDER BY updated_at ASC, id ASC`,
  ).bind(reportId).all<BackfillVersionRow>()).results;
}

// ---------------------------------------------------------------------------
// Creation & backfill (spec 3.3).
// ---------------------------------------------------------------------------

/**
 * Materializes the report's final version the first time anything needs it,
 * backfilling from every `report_versions` row. Idempotent: a concurrent
 * creator's row wins and this call just re-reads it, never inserting a
 * duplicate intake ledger. Safe to call even when the report has zero real
 * versions yet (origin === payload, no intakes) — this lets 老孙 use "定稿"
 * or "直接编辑集成版" as the very first action on a brand-new report, the
 * same leniency the video side gives a case never saved through V1.9.
 */
export async function ensureReportFinalVersion(
  db: DbClient,
  reportId: string,
  now: Date,
): Promise<ReportFinalVersionRow> {
  const existing = await db.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE report_id = ?`)
    .bind(reportId).first<ReportFinalVersionRow>();
  if (existing) return existing;

  const pageNumbers = await loadPageNumbers(db, reportId);
  const origin = emptyReportAnnotation(pageNumbers);
  const versionRows = await loadOrderedVersionsForBackfill(db, reportId);
  const historyVersions: ReportFinalHistoryVersion[] = versionRows.map((row) => ({
    id: row.id,
    versionNumber: Number(row.version_number),
    updatedAt: row.updated_at,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name_snapshot,
    basePayload: row.base_payload_json == null ? null : parseJsonPayload(row.base_payload_json),
    payload: parseJsonPayload(row.payload_json),
  }));
  const { payload, intakes } = computeReportFinalFromHistory(origin, historyVersions);

  const newId = genId("report_final");
  const savedAt = iso(now);
  const inserted = await db.prepare(
    `INSERT INTO report_final_versions (
      id, report_id, status, origin_payload_json, payload_json, content_hash, revision,
      created_at, updated_at
    ) VALUES (?, ?, 'OPEN', ?::jsonb, ?::jsonb, ?, 1, ?::timestamptz, ?::timestamptz)
    ON CONFLICT (report_id) DO NOTHING
    RETURNING ${FINAL_VERSION_COLUMNS}`,
  ).bind(
    newId, reportId, JSON.stringify(origin), JSON.stringify(payload), hashReportPayload(payload), savedAt, savedAt,
  ).first<ReportFinalVersionRow>();

  if (!inserted) {
    // Someone else materialized it first — use their row, discard our replay.
    const winner = await db.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE report_id = ?`)
      .bind(reportId).first<ReportFinalVersionRow>();
    if (!winner) throw new ReportVersionError("VERSION_NOT_FOUND", "集成版创建未完成，请重试。");
    return winner;
  }

  for (const intake of intakes) {
    await insertIntakeRow(db, inserted.id, reportId, intake, {
      source: "VERSION",
      sourceVersionId: intake.sourceVersionId,
      sourceVersionNumber: intake.sourceVersionNumber,
      actorUserId: intake.actorUserId,
      actorName: intake.actorName,
      applied: true,
      appliedAt: intake.createdAt,
      createdAt: intake.createdAt,
    });
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// 3.4 — intake from a normal version save.
// ---------------------------------------------------------------------------

export type ReportFinalIntakeResult = { merged: boolean; pending: number };

/**
 * Called from lib/report-version-chain.ts's saveReportVersion, inside the
 * same transaction, right after that version's own row is written. Any
 * failure here must never fail the caller's save — this function only
 * throws for programmer errors, never for a payload that doesn't apply
 * cleanly (that becomes a per-record NOOP, spec 3.2's closing rule).
 *
 * Unlike the video side there is no change-set/idempotency key to dedupe
 * against here: `saveReportVersion`'s own `revision` optimistic lock already
 * guarantees this is called at most once per successful write (spec 3.4's
 * "幂等性" paragraph).
 */
export async function intakeReportVersionIntoFinal(
  db: DbClient,
  reportId: string,
  input: {
    before: ReportAnnotation;
    after: ReportAnnotation;
    sourceVersionId: string;
    sourceVersionNumber: number;
    actorUserId: string;
    actorName: string;
    now: Date;
  },
): Promise<ReportFinalIntakeResult> {
  const finalRow = await ensureReportFinalVersion(db, reportId, input.now);
  const drafts = diffReportAnnotation(input.before, input.after);
  if (drafts.length === 0) {
    return { merged: true, pending: await countPending(db, finalRow.id) };
  }

  const savedAt = iso(input.now);
  const { payload, applied: applyNow } = applyReportFinalIntakeBatch(
    parseJsonPayload(finalRow.payload_json), drafts, finalRow.status,
  );
  for (const draft of drafts) {
    await insertIntakeRow(db, finalRow.id, reportId, draft, {
      source: "VERSION",
      sourceVersionId: input.sourceVersionId,
      sourceVersionNumber: input.sourceVersionNumber,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      applied: applyNow,
      appliedAt: applyNow ? savedAt : null,
      createdAt: savedAt,
    });
  }
  if (applyNow) {
    const contentHash = hashReportPayload(payload);
    await db.prepare(
      `UPDATE report_final_versions
      SET payload_json = ?::jsonb, content_hash = ?, revision = revision + 1, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(JSON.stringify(payload), contentHash, savedAt, finalRow.id).run();
  }
  return { merged: applyNow, pending: await countPending(db, finalRow.id) };
}

// ---------------------------------------------------------------------------
// 3.5 — 老孙直接编辑集成版.
// ---------------------------------------------------------------------------

export type ReportFinalCurrentVersion = {
  id: string;
  number: 0;
  ownerUserId: "";
  ownerName: "集成版";
  baseNumber: null;
  createdAt: string;
  updatedAt: string;
  isMine: false;
  isVirtual: boolean;
  isFinal: true;
  payload: ReportAnnotation;
  basePayload: null;
  revision: number;
  contentHash: string;
};

function toFinalCurrentVersion(row: ReportFinalVersionRow): ReportFinalCurrentVersion {
  return {
    id: row.id,
    number: 0,
    ownerUserId: "",
    ownerName: "集成版",
    baseNumber: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isMine: false,
    isVirtual: false,
    isFinal: true,
    payload: parseJsonPayload(row.payload_json),
    basePayload: null,
    revision: Number(row.revision),
    contentHash: row.content_hash,
  };
}

export type ReportFinalSaveResult = {
  version: ReportFinalCurrentVersion;
  revision: number;
  changed: boolean;
  finalIntake: ReportFinalIntakeResult;
};

/** actor_email 兜底：报告的 audit_logs 只按 email 归属，ReportVersionActor 本身不带邮箱时退化用显示名，
 * 审计记录仍然可读，只是少一个可点开查用户资料的邮箱——见本文件同一改动里对 ReportVersionActor 的 email 扩展。 */
async function insertReportFinalAudit(
  db: DbClient,
  actor: ReportVersionActor,
  action: string,
  objectId: string,
  detail: Record<string, unknown>,
) {
  await db.prepare(
    `INSERT INTO audit_logs (id, actor_email, action, object_type, object_id, detail_json)
    VALUES (?, ?, ?, 'REPORT_FINAL', ?, ?)`,
  ).bind(genId("audit"), actor.email ?? actor.displayName, action, objectId, JSON.stringify(detail)).run();
}

export async function saveReportFinalVersionDirect(
  db: DbClient,
  actor: ReportVersionActor,
  input: { reportId: string; revision: number; payload: unknown; now?: Date },
): Promise<ReportFinalSaveResult> {
  if (!isCaseReviewer(actor.displayName)) {
    throw new ReportVersionError("FORBIDDEN", "集成版只有老孙可以编辑。");
  }
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new ReportVersionError("INVALID_INPUT", "保存请求缺少有效的 revision。");
  }
  const now = input.now ?? new Date();

  return db.withTransaction(async (tx) => {
    await requireReadyReport(tx, input.reportId, true);
    const pageNumbers = await loadPageNumbers(tx, input.reportId);
    await ensureReportFinalVersion(tx, input.reportId, now);
    const current = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE report_id = ? FOR UPDATE`)
      .bind(input.reportId).first<ReportFinalVersionRow>();
    if (!current) throw new ReportVersionError("VERSION_NOT_FOUND", "集成版不存在。");

    if (Number(current.revision) !== input.revision) {
      throw new ReportVersionError("REVISION_CONFLICT", "集成版已被更新，请刷新后再保存。", {
        serverRevision: Number(current.revision),
      });
    }
    const validated = validateReportAnnotation(input.payload, pageNumbers);
    if (!validated.ok) {
      throw new ReportVersionError("VALIDATION_FAILED", "标注内容不符合规则，未保存。", { errors: validated.errors });
    }

    const before = parseJsonPayload(current.payload_json);
    const after = validated.value;
    const nextHash = hashReportPayload(after);
    if (nextHash === current.content_hash) {
      return {
        version: toFinalCurrentVersion(current),
        revision: Number(current.revision),
        changed: false,
        finalIntake: { merged: true, pending: await countPending(tx, current.id) },
      };
    }

    const nextRevision = Number(current.revision) + 1;
    const savedAt = iso(now);
    await tx.prepare(
      `UPDATE report_final_versions
      SET payload_json = ?::jsonb, content_hash = ?, revision = ?, updated_at = ?::timestamptz
      WHERE id = ?`,
    ).bind(JSON.stringify(after), nextHash, nextRevision, savedAt, current.id).run();

    // 按 3.1 拆解写汇入记录：这里不是「靠汇入应用变更」，变更已经直接生效——
    // 记录只是为了让溯源视图能显示「集成版·直接修改」。
    const drafts = diffReportAnnotation(before, after);
    for (const draft of drafts) {
      await insertIntakeRow(tx, current.id, input.reportId, draft, {
        source: "FINAL_DIRECT",
        sourceVersionId: null,
        sourceVersionNumber: null,
        actorUserId: actor.userId,
        actorName: actor.displayName,
        applied: true,
        appliedAt: savedAt,
        createdAt: savedAt,
      });
    }

    await insertReportFinalAudit(tx, actor, "REPORT_FINAL_SAVED", current.id, {
      reportId: input.reportId,
      appliedRevision: nextRevision,
      targets: drafts.map((item) => item.targetKey),
      contentHash: nextHash,
    });

    const refreshed: ReportFinalVersionRow = {
      ...current, payload_json: after, content_hash: nextHash, revision: nextRevision, updated_at: savedAt,
    };
    return {
      version: toFinalCurrentVersion(refreshed),
      revision: nextRevision,
      changed: true,
      finalIntake: { merged: true, pending: await countPending(tx, current.id) },
    };
  });
}

// ---------------------------------------------------------------------------
// 3.6 — 定稿 / 取消定稿 / 采纳.
// ---------------------------------------------------------------------------

export type ReportFinalSummary = {
  id: string | null;
  status: "OPEN" | "DONE";
  doneAt: string | null;
  doneByName: string | null;
  updatedAt: string;
  pendingCount: number;
  isVirtual: boolean;
};

function toFinalSummary(row: ReportFinalVersionRow, pending: number): ReportFinalSummary {
  return {
    id: row.id,
    status: row.status,
    doneAt: row.done_at,
    doneByName: row.done_by_name,
    updatedAt: row.updated_at,
    pendingCount: pending,
    isVirtual: false,
  };
}

function requireReportReviewerActor(actor: ReportVersionActor, message: string) {
  if (!isCaseReviewer(actor.displayName)) {
    throw new ReportVersionError("FORBIDDEN", message);
  }
}

export async function setReportFinalVersionStatus(
  db: DbClient,
  actor: ReportVersionActor,
  input: { reportId: string; status: "OPEN" | "DONE"; now?: Date },
): Promise<ReportFinalSummary> {
  requireReportReviewerActor(actor, "只有老孙可以定稿或取消定稿。");
  const now = input.now ?? new Date();
  return db.withTransaction(async (tx) => {
    await requireReadyReport(tx, input.reportId, true);
    // 报告可能从没被任何人保存过（还没有 report_versions 行）——同视频侧
    // ensureFinalVersion 的道理，老孙的第一次操作可以就是「定稿」，这里必须先
    // 物化（哪怕是空白起点）而不是对着一行还不存在的记录报 404。
    await ensureReportFinalVersion(tx, input.reportId, now);
    const finalRow = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE report_id = ? FOR UPDATE`)
      .bind(input.reportId).first<ReportFinalVersionRow>();
    if (!finalRow) throw new ReportVersionError("VERSION_NOT_FOUND", "集成版尚不存在，无法定稿。");

    const savedAt = iso(now);
    if (input.status === "DONE") {
      await tx.prepare(
        `UPDATE report_final_versions
        SET status = 'DONE', done_at = ?::timestamptz, done_by_user_id = ?, done_by_name = ?, updated_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(savedAt, actor.userId, actor.displayName, savedAt, finalRow.id).run();
    } else {
      await tx.prepare(
        `UPDATE report_final_versions
        SET status = 'OPEN', done_at = NULL, done_by_user_id = NULL, done_by_name = NULL, updated_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(savedAt, finalRow.id).run();
    }
    await insertReportFinalAudit(tx, actor, "REPORT_FINAL_STATUS_CHANGED", finalRow.id, {
      reportId: input.reportId, status: input.status,
    });

    const refreshed = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE id = ?`)
      .bind(finalRow.id).first<ReportFinalVersionRow>();
    return toFinalSummary(refreshed!, await countPending(tx, finalRow.id));
  });
}

export async function adoptReportFinalIntakes(
  db: DbClient,
  actor: ReportVersionActor,
  input: { reportId: string; intakeIds?: string[]; all?: boolean; now?: Date },
): Promise<{ final: ReportFinalSummary; adopted: number }> {
  requireReportReviewerActor(actor, "只有老孙可以采纳未纳入的修改。");
  const now = input.now ?? new Date();
  return db.withTransaction(async (tx) => {
    await requireReadyReport(tx, input.reportId, true);
    await ensureReportFinalVersion(tx, input.reportId, now);
    const finalRow = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE report_id = ? FOR UPDATE`)
      .bind(input.reportId).first<ReportFinalVersionRow>();
    if (!finalRow) throw new ReportVersionError("VERSION_NOT_FOUND", "集成版尚不存在。");

    let targets: ReportFinalIntakeRow[];
    if (input.all) {
      targets = (await tx.prepare(
        `SELECT ${FINAL_INTAKE_COLUMNS} FROM report_final_intakes WHERE final_id = ? AND applied = false ORDER BY seq ASC`,
      ).bind(finalRow.id).all<ReportFinalIntakeRow>()).results;
    } else {
      const ids = Array.isArray(input.intakeIds) ? input.intakeIds.filter((v) => typeof v === "string" && v.trim()) : [];
      if (ids.length === 0) {
        return { final: toFinalSummary(finalRow, await countPending(tx, finalRow.id)), adopted: 0 };
      }
      const placeholders = ids.map(() => "?").join(", ");
      targets = (await tx.prepare(
        `SELECT ${FINAL_INTAKE_COLUMNS} FROM report_final_intakes
        WHERE final_id = ? AND applied = false AND id IN (${placeholders})
        ORDER BY seq ASC`,
      ).bind(finalRow.id, ...ids).all<ReportFinalIntakeRow>()).results;
    }

    let payload = parseJsonPayload(finalRow.payload_json);
    const savedAt = iso(now);
    let adopted = 0;
    for (const row of targets) {
      const draft: ReportFinalIntakeDraft = {
        kind: row.kind, targetKey: row.target_key, targetLabel: row.target_label,
        value: parseJsonValue(row.value_json),
      };
      const result = applyReportFinalIntake(payload, draft);
      payload = result.payload;
      await tx.prepare(`UPDATE report_final_intakes SET applied = true, applied_at = ?::timestamptz WHERE id = ?`)
        .bind(savedAt, row.id).run();
      adopted += 1;
    }
    if (adopted > 0) {
      const contentHash = hashReportPayload(payload);
      await tx.prepare(
        `UPDATE report_final_versions
        SET payload_json = ?::jsonb, content_hash = ?, revision = revision + 1, updated_at = ?::timestamptz
        WHERE id = ?`,
      ).bind(JSON.stringify(payload), contentHash, savedAt, finalRow.id).run();
    }
    await insertReportFinalAudit(tx, actor, "REPORT_FINAL_INTAKE_ADOPTED", finalRow.id, {
      reportId: input.reportId, adopted, intakeIds: targets.map((row) => row.id),
    });

    const refreshed = await tx.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE id = ?`)
      .bind(finalRow.id).first<ReportFinalVersionRow>();
    return { final: toFinalSummary(refreshed!, await countPending(tx, finalRow.id)), adopted };
  });
}

// ---------------------------------------------------------------------------
// Read path — never writes (spec 3.3: GET never materializes).
// ---------------------------------------------------------------------------

export type LoadedReportFinalVersion = ReportFinalSummary & {
  createdAt: string;
  payload: ReportAnnotation;
  originPayload: ReportAnnotation;
  contentHash: string;
  revision: number;
};

/**
 * Reads the report's final version. When no row exists yet, computes the
 * virtual final version in memory from the report's whole version history —
 * never inserting anything. Callers must only invoke this once they know the
 * report has at least one real `report_versions` row (spec 二、11 — a report
 * with none has no meaningful "final" at all, so this throws rather than
 * fabricating one from nothing; GET's caller already gates on `rows.length`).
 */
export async function loadReportFinalVersion(
  db: DbClient,
  reportId: string,
): Promise<LoadedReportFinalVersion> {
  const row = await db.prepare(`SELECT ${FINAL_VERSION_COLUMNS} FROM report_final_versions WHERE report_id = ?`)
    .bind(reportId).first<ReportFinalVersionRow>();
  if (row) {
    const pending = await countPending(db, row.id);
    return {
      ...toFinalSummary(row, pending),
      createdAt: row.created_at,
      payload: parseJsonPayload(row.payload_json),
      originPayload: parseJsonPayload(row.origin_payload_json),
      contentHash: row.content_hash,
      revision: Number(row.revision),
    };
  }

  const pageNumbers = await loadPageNumbers(db, reportId);
  const origin = emptyReportAnnotation(pageNumbers);
  const versionRows = await loadOrderedVersionsForBackfill(db, reportId);
  const historyVersions: ReportFinalHistoryVersion[] = versionRows.map((v) => ({
    id: v.id,
    versionNumber: Number(v.version_number),
    updatedAt: v.updated_at,
    ownerUserId: v.owner_user_id,
    ownerName: v.owner_name_snapshot,
    basePayload: v.base_payload_json == null ? null : parseJsonPayload(v.base_payload_json),
    payload: parseJsonPayload(v.payload_json),
  }));
  const { payload, intakes } = computeReportFinalFromHistory(origin, historyVersions);
  const updatedAt = intakes.length ? intakes[intakes.length - 1].createdAt
    : (historyVersions.length ? historyVersions[historyVersions.length - 1].updatedAt : iso(new Date()));

  return {
    id: null,
    status: "OPEN",
    doneAt: null,
    doneByName: null,
    updatedAt,
    pendingCount: 0,
    isVirtual: true,
    createdAt: updatedAt,
    payload,
    originPayload: origin,
    contentHash: hashReportPayload(payload),
    revision: 1,
  };
}

export type ReportFinalTraceIntake = {
  id: string;
  seq: number;
  kind: ReportFinalIntakeKind;
  targetKey: string;
  targetLabel: string;
  value: unknown;
  source: ReportFinalIntakeSource;
  sourceVersionNumber: number | null;
  actorName: string;
  applied: boolean;
  createdAt: string;
};

/** `?version=final` 时的溯源数据：原稿（空白初始标注） + 每处内容按 seq 升序的写法链。 */
export async function loadReportFinalTrace(
  db: DbClient,
  reportId: string,
): Promise<{ originPayload: ReportAnnotation; intakes: ReportFinalTraceIntake[] }> {
  const row = await db.prepare(`SELECT id, origin_payload_json FROM report_final_versions WHERE report_id = ?`)
    .bind(reportId).first<{ id: string; origin_payload_json: ReportAnnotation | string } & QueryResultRow>();
  if (row) {
    const rows = (await db.prepare(
      `SELECT ${FINAL_INTAKE_COLUMNS} FROM report_final_intakes WHERE final_id = ? ORDER BY seq ASC`,
    ).bind(row.id).all<ReportFinalIntakeRow>()).results;
    return {
      originPayload: parseJsonPayload(row.origin_payload_json),
      intakes: rows.map((intake) => ({
        id: intake.id,
        seq: Number(intake.seq),
        kind: intake.kind,
        targetKey: intake.target_key,
        targetLabel: intake.target_label,
        value: parseJsonValue(intake.value_json),
        source: intake.source,
        sourceVersionNumber: intake.source_version_number === null ? null : Number(intake.source_version_number),
        actorName: intake.actor_name,
        applied: intake.applied,
        createdAt: intake.created_at,
      })),
    };
  }

  const pageNumbers = await loadPageNumbers(db, reportId);
  const origin = emptyReportAnnotation(pageNumbers);
  const versionRows = await loadOrderedVersionsForBackfill(db, reportId);
  const historyVersions: ReportFinalHistoryVersion[] = versionRows.map((v) => ({
    id: v.id,
    versionNumber: Number(v.version_number),
    updatedAt: v.updated_at,
    ownerUserId: v.owner_user_id,
    ownerName: v.owner_name_snapshot,
    basePayload: v.base_payload_json == null ? null : parseJsonPayload(v.base_payload_json),
    payload: parseJsonPayload(v.payload_json),
  }));
  const { intakes } = computeReportFinalFromHistory(origin, historyVersions);
  return {
    originPayload: origin,
    intakes: intakes.map((intake, index) => ({
      id: `virtual_${index}`,
      seq: index + 1,
      kind: intake.kind,
      targetKey: intake.targetKey,
      targetLabel: intake.targetLabel,
      value: intake.value,
      source: intake.source,
      sourceVersionNumber: intake.sourceVersionNumber,
      actorName: intake.actorName,
      applied: intake.applied,
      createdAt: intake.createdAt,
    })),
  };
}
