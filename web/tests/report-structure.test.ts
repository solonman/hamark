import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMove,
  assignToNewModule,
  assignToNewUnit,
  carrySet,
  emptyReportAnnotation,
  isContiguous,
  modulePages,
  moduleNumbers,
  openPagesOf,
  pageRangeLabel,
  pageStatus,
  planMove,
  removeModule,
  removeUnit,
  shownPagesOf,
  sortedModules,
  structureOk,
  unitDirectPages,
  unitPages,
  validateReportAnnotation,
  type ReportAnnotation,
  type ReportBlock,
  type ReportModule,
  type ReportPage,
  type ReportUnit,
} from "../lib/report-structure.ts";

/* ============================ Fixtures ============================ */

/**
 * The 红谷滩 case from the approved demo: 5 modules, 26 units three levels
 * deep (M3 → U10 → U10b → U10b1/U10b2), 50 pages. Copied from the demo's
 * `MODULES`/`UNITS`/`PAGE_UNIT` — our own project's fixture data, not a
 * third-party source — with `func`/`org` narrowed to the handful of pages
 * the demo actually annotates (the rest stay blank, same as the demo).
 */
function buildHonggutanFixture(): ReportAnnotation {
  const modules: ReportModule[] = [
    { id: "M1", name: "营销命题", rel: "相对独立", role: "把命题从项目操作抬到区域操作。" },
    { id: "M2", name: "价值故事仓", rel: "推导", role: "用功能与体验两条线把红谷滩讲成一座可被感知的城市。" },
    { id: "M3", name: "核心成果", rel: "收敛", role: "把前面的城市判断收敛成可交付的三件套。" },
    { id: "M4", name: "营销行动", rel: "转折", role: "从新城市转身回到首期住宅的销售号召。" },
    { id: "M5", name: "路线选择", rel: "收敛", role: "用企业长期品牌收益完成竞标说服。" },
  ];

  const u = (
    id: string, mid: string, pid: string | null, name: string, rel: string,
  ): ReportUnit => ({ id, mid, pid, name, rel, task: "", role: "", psy: "", concl: "" });

  const units: ReportUnit[] = [
    u("U1", "M1", null, "前言：直接进入操作思路", "相对独立"),
    u("U2", "M1", null, "不是一个项目，而是一座新城市", "推导"),
    u("U3", "M1", null, "划江而治：新城与老城的关系", "对比"),
    u("U4", "M2", null, "新城市功能：两带一圈十字轴", "收敛"),
    u("U5", "M2", null, "新城市体验：城市景观型商圈", "推导"),
    u("U6", "M2", null, "资源整合：合大于竞", "并列"),
    u("U7", "M3", null, "项目定位：城市综合体 HOPSCA", "收敛"),
    u("U8", "M3", null, "案名建议", "并列"),
    u("U8a", "M3", "U8", "主建议案名", "相对独立"),
    u("U8b", "M3", "U8", "备选案名", "并列"),
    u("U9", "M3", null, "推广口号", "展开"),
    u("U10", "M3", null, "视觉方向：总案名 LOGO", "展开"),
    u("U10a", "M3", "U10", "LOGO 提案", "并列"),
    u("U10b", "M3", "U10", "LOGO 标准与应用", "展开"),
    u("U10b1", "M3", "U10b", "标准字与基本色", "并列"),
    u("U10b2", "M3", "U10b", "反白应用", "展开"),
    u("U11", "M4", null, "顺势而发：寻找首批原住民", "转折"),
    u("U12", "M4", null, "四个必须传播、四个必须兴奋", "并列"),
    u("U12a", "M4", "U12", "一、城市题材·权威形象", "推导"),
    u("U12b", "M4", "U12", "二、发展题材·理论导入", "并列"),
    u("U12c", "M4", "U12", "三、体验题材·文化渗透", "并列"),
    u("U12d", "M4", "U12", "四、验证题材·商家遴选", "并列"),
    u("U12e", "M4", "U12", "四大内容穿插与热潮", "收敛"),
    u("U13", "M4", null, "传播节奏：由势入事", "时间"),
    u("U14", "M5", null, "项目目标与企业品牌", "推导"),
    u("U15", "M5", null, "后记与合作邀请", "收敛"),
  ];

  const pageUnit: Record<number, string> = {
    1: "U1", 2: "U1", 3: "U2", 4: "U2", 5: "U2", 6: "U2", 7: "U3", 8: "U3", 9: "U3",
    10: "U4", 11: "U4", 12: "U4", 13: "U4", 14: "U5", 15: "U5", 16: "U5", 17: "U5", 18: "U5",
    19: "U6", 20: "U6", 21: "U6",
    22: "U7", 23: "U7", 24: "U8a", 25: "U8b", 26: "U9", 27: "U10a", 28: "U10a",
    29: "U10b1", 30: "U10b1", 31: "U10b2",
    32: "U11", 33: "U11", 34: "U11", 35: "U11", 36: "U12", 37: "U12a", 38: "U12a", 39: "U12a",
    40: "U12a", 41: "U12b", 42: "U12c", 43: "U12d", 44: "U12e",
    45: "U13", 46: "U13", 47: "U14", 48: "U14", 49: "U15", 50: "U15",
  };
  const transitionPages = new Set([1, 3, 7, 10, 14, 19, 22, 32, 36, 45, 47, 50]);
  const pageFunc: Record<number, string> = {
    2: "交代前提并交出命题。", 5: "用三条并列证据回答上一页提出的设问。", 6: "把本模块的推理收成一句总纲。",
    9: "给出本单元的行动结论。", 13: "把功能解读收束为可复用的规划理念。", 23: "交付第一件核心成果。",
    26: "用一句面向全南昌的口号，把定位翻译成可传播的语言。", 37: "分述四类传播内容中的第一类。",
    46: "用一张节奏图把四类内容排进时间。",
  };
  const pageOrg: Record<number, string> = {
    2: "标题领起，三段依次为背景、命题、目标。", 5: "设问在上，三条证据并列在下。",
    12: "标题＋引导句在上，两带／一圈／十字轴三块并列展开。", 13: "引导句—金句—收束句。",
    23: "引导短句带出定位陈述，三句理念并列排在下方。", 46: "图形为主：时间轴居中。",
  };

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const pages: ReportPage[] = [];
  for (let n = 1; n <= 50; n += 1) {
    const uid = pageUnit[n];
    const mid = unitById.get(uid)?.mid ?? null;
    pages.push({
      n, mid, uid, transition: transitionPages.has(n),
      func: pageFunc[n] ?? "", org: pageOrg[n] ?? "", blocks: [],
    });
  }

  return { background: { city: "南昌", developer: "世纪地产", projectBackground: "", businessBackground: "" }, strategy: { narrative: "", model: "问题章回型" }, modules, units, pages };
}

function page(n: number, overrides: Partial<ReportPage> = {}): ReportPage {
  return { n, mid: null, uid: null, transition: false, func: "", org: "", blocks: [], ...overrides };
}

function block(overrides: Partial<ReportBlock> = {}): ReportBlock {
  return {
    id: "b1", name: "组块", x: 10, y: 10, w: 20, h: 20, type: "标题", roles: ["核心结论"],
    style: "理性", rel: "展开", narr: "", mark: "", ...overrides,
  };
}

/* ============================ 编号与范围 ============================ */

test("moduleNumbers derives 1 / 1-1 / 1-1-1 numbering from the honggutan fixture's page order", () => {
  const fixture = buildHonggutanFixture();
  assert.equal(structureOk(fixture), true, "the fixture itself must be a legal structure");

  const numbers = moduleNumbers(fixture);
  assert.deepEqual(
    sortedModules(fixture).map((m) => numbers[m.id]),
    ["1", "2", "3", "4", "5"],
  );
  assert.equal(numbers.U1, "1-1");
  assert.equal(numbers.U3, "1-3");
  assert.equal(numbers.U7, "3-1");
  // U8 has two direct pages (24, 25) but they're split across its two
  // children U8a/U8b — U8 itself holds no page directly.
  assert.equal(numbers.U8, "3-2");
  assert.equal(numbers.U8a, "3-2-1");
  assert.equal(numbers.U8b, "3-2-2");
  assert.equal(numbers.U9, "3-3");
  // Three levels deep: module → U10 → U10b → U10b1/U10b2.
  assert.equal(numbers.U10, "3-4");
  assert.equal(numbers.U10a, "3-4-1");
  assert.equal(numbers.U10b, "3-4-2");
  assert.equal(numbers.U10b1, "3-4-2-1");
  assert.equal(numbers.U10b2, "3-4-2-2");
  assert.equal(numbers.U12, "4-2");
  assert.equal(numbers.U12a, "4-2-1");
  assert.equal(numbers.U12e, "4-2-5");
  assert.equal(numbers.U14, "5-1");
  assert.equal(numbers.U15, "5-2");
});

test("pageRangeLabel derives module/unit page ranges from the pages they hold, not stored numbers", () => {
  const fixture = buildHonggutanFixture();
  assert.equal(pageRangeLabel(modulePages(fixture, "M1")), "p01–p09");
  assert.equal(pageRangeLabel(modulePages(fixture, "M5")), "p47–p50");
  // U10b holds no page directly — its whole range comes from its children.
  assert.equal(pageRangeLabel(unitDirectPages(fixture, "U10b")), "空");
  assert.equal(pageRangeLabel(unitPages(fixture, "U10b")), "p29–p31");
  assert.equal(pageRangeLabel(unitPages(fixture, "U12")), "p36–p44");
  assert.equal(pageRangeLabel([]), "空");
  assert.equal(pageRangeLabel([page(5)]), "p05");
});

/* ============================ openPagesOf / shownPagesOf ============================ */

test("openPagesOf excludes pages a nested unit already claimed; shownPagesOf still shows them", () => {
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M", name: "", rel: "推导", role: "" }],
    units: [{ id: "U1", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" }],
    pages: [
      page(1, { mid: "M", uid: "U1" }),
      page(2, { mid: "M", uid: "U1" }),
      page(3, { mid: "M" }),
      page(4, { mid: "M" }),
      page(5, { mid: null }),
    ],
  };
  assert.deepEqual(openPagesOf(a, "mod:M").map((p) => p.n), [3, 4]);
  assert.deepEqual(shownPagesOf(a, "mod:M").map((p) => p.n), [1, 2, 3, 4]);
  assert.deepEqual(openPagesOf(a, "unit:U1").map((p) => p.n), [1, 2]);
  assert.deepEqual(shownPagesOf(a, "unit:U1").map((p) => p.n), [1, 2]);
  assert.deepEqual(openPagesOf(a, "free").map((p) => p.n), [5]);
  assert.deepEqual(shownPagesOf(a, "free").map((p) => p.n), [1, 2, 3, 4, 5]);
});

/* ============================ isContiguous ============================ */

test("isContiguous only accepts an unbroken ascending run of page numbers", () => {
  assert.equal(isContiguous([]), true);
  assert.equal(isContiguous([page(7)]), true);
  assert.equal(isContiguous([page(1), page(2), page(3)]), true);
  assert.equal(isContiguous([page(1), page(2), page(4)]), false);
});

/* ============================ carrySet：三个方向 + 空目标 ============================ */

function buildCarryFixture(): ReportAnnotation {
  // Module M spans pages 1-6: unit L owns [1,2], pages [3,4,5] are open
  // directly in the module tray, unit R owns [6]. Unit E is a sibling with
  // no pages at all, standing in for "the target box is empty".
  return {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M", name: "", rel: "推导", role: "" }],
    units: [
      { id: "L", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
      { id: "R", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
      { id: "E", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
    ],
    pages: [
      page(1, { mid: "M", uid: "L" }),
      page(2, { mid: "M", uid: "L" }),
      page(3, { mid: "M" }),
      page(4, { mid: "M" }),
      page(5, { mid: "M" }),
      page(6, { mid: "M", uid: "R" }),
    ],
  };
}

test("carrySet carries the dragged page to whichever end of its run the target sits on", () => {
  const a = buildCarryFixture();
  // Target R is entirely to the right of the open run [3,4,5]: carries the
  // dragged page through to the run's right end, not the whole run.
  assert.deepEqual(carrySet(a, "mod:M", "unit:R", 4), [4, 5]);
  // Target L is entirely to the left: carries from the run's left end
  // through to the dragged page.
  assert.deepEqual(carrySet(a, "mod:M", "unit:L", 4), [3, 4]);
});

test("carrySet retreats toward the nearer end when the target encloses the whole run", () => {
  // Unit L now owns the module's entire page range, so dropping one of its
  // pages back onto the module tray has a target that encloses the run.
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M", name: "", rel: "推导", role: "" }],
    units: [{ id: "L", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" }],
    pages: [1, 2, 3, 4].map((n) => page(n, { mid: "M", uid: "L" })),
  };
  // Page 2 is closer to the left end (distance 1) than the right end
  // (distance 2), so the retreat takes the left side.
  assert.deepEqual(carrySet(a, "unit:L", "mod:M", 2), [1, 2]);
  // Page 3 is closer to the right end.
  assert.deepEqual(carrySet(a, "unit:L", "mod:M", 3), [3, 4]);
});

test("carrySet returns null when the page isn't open where dragged from, or the target box is empty", () => {
  const a = buildCarryFixture();
  // Page 1 belongs to unit L, so it isn't "open" in the module tray.
  assert.equal(carrySet(a, "mod:M", "unit:R", 1), null);
  // Unit E holds no pages — an empty box has no direction to carry toward.
  assert.equal(carrySet(a, "mod:M", "unit:E", 4), null);
});

/* ============================ planMove / applyMove ============================ */

function buildTwoModuleFixture(withUnit: boolean): ReportAnnotation {
  const units: ReportUnit[] = withUnit
    ? [{ id: "U", mid: "M1", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" }]
    : [];
  const pages = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
    if (n <= 4) {
      const uid = withUnit && n >= 3 ? "U" : null;
      return page(n, { mid: "M1", uid });
    }
    return page(n, { mid: "M2" });
  });
  return {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [
      { id: "M1", name: "", rel: "推导", role: "" },
      { id: "M2", name: "", rel: "推导", role: "" },
    ],
    units,
    pages,
  };
}

test("planMove accepts a boundary carry that keeps both sides contiguous", () => {
  const a = buildTwoModuleFixture(false);
  const result = planMove(a, "mod:M1", "mod:M2", 2, []);
  assert.deepEqual(result, { ok: true, ids: [2, 3, 4], carried: true });
  // planMove must not have touched the input.
  assert.deepEqual(modulePages(a, "M1").map((p) => p.n), [1, 2, 3, 4]);
});

test("planMove rejects a manual selection that would split a run into two pieces", () => {
  const a = buildTwoModuleFixture(false);
  // Selecting the middle pages [2,3] and dropping them on M2 would leave
  // M1 holding {1,4} — not contiguous.
  const result = planMove(a, "mod:M1", "mod:M2", 2, [2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /拆成两截/);
});

test("planMove approves moving a unit's whole run out, and applyMove then drops the emptied unit", () => {
  const a = buildTwoModuleFixture(true); // unit U owns pages [3,4] inside M1
  const planned = planMove(a, "unit:U", "mod:M2", 3, []);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.deepEqual(planned.ids, [3, 4]);

  const { next, removedSegments } = applyMove(a, planned.ids, "mod:M2");
  assert.equal(removedSegments, 1);
  assert.equal(next.units.some((u) => u.id === "U"), false);
  assert.deepEqual(modulePages(next, "M1").map((p) => p.n), [1, 2]);
  assert.deepEqual(modulePages(next, "M2").map((p) => p.n), [3, 4, 5, 6, 7, 8]);
  // The source annotation is untouched — applyMove is pure.
  assert.equal(a.units.some((u) => u.id === "U"), true);
});

test("applyMove cascades: emptying a child unit can in turn empty its now-childless parent", () => {
  // Page 2 stays directly under M1 (outside any unit) so the module itself
  // survives the move — isolating this test to the unit-level cascade only.
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [
      { id: "M1", name: "", rel: "推导", role: "" },
      { id: "M2", name: "", rel: "推导", role: "" },
    ],
    units: [
      { id: "Parent", mid: "M1", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
      { id: "Child", mid: "M1", pid: "Parent", name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
    ],
    pages: [
      page(1, { mid: "M1", uid: "Child" }),
      page(2, { mid: "M1" }),
      page(3, { mid: "M2" }),
    ],
  };
  const { next, removedSegments } = applyMove(a, [1], "mod:M2");
  // Child loses its only page (round 1), which then leaves Parent with no
  // pages and no children left (round 2) — two segments, not the page's
  // module, which still holds page 2.
  assert.equal(removedSegments, 2);
  assert.deepEqual(next.units, []);
  assert.equal(next.modules.some((m) => m.id === "M1"), true);
  assert.deepEqual(modulePages(next, "M1").map((p) => p.n), [2]);
});

/* ============================ assignToNewUnit：模块托盘与单元托盘 ============================ */

test("assignToNewUnit makes a root unit from a module tray and a child unit from a unit tray", () => {
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M", name: "", rel: "推导", role: "" }],
    units: [],
    pages: [page(1, { mid: "M" }), page(2, { mid: "M" })],
  };

  const rootResult = assignToNewUnit(a, "mod:M", [1, 2], () => "root1");
  assert.equal(rootResult.unitId, "Uroot1");
  const rootUnit = rootResult.next.units.find((u) => u.id === "Uroot1");
  assert.deepEqual(rootUnit, {
    id: "Uroot1", mid: "M", pid: null, name: "", rel: "推导", task: "", role: "", psy: "", concl: "",
  });
  assert.deepEqual(rootResult.next.pages.map((p) => p.uid), ["Uroot1", "Uroot1"]);

  // From the unit tray: split page 1 off into a child of the unit just made.
  const childResult = assignToNewUnit(rootResult.next, "unit:Uroot1", [1], () => "child1");
  assert.equal(childResult.unitId, "Uchild1");
  const childUnit = childResult.next.units.find((u) => u.id === "Uchild1");
  assert.deepEqual(childUnit, {
    id: "Uchild1", mid: "M", pid: "Uroot1", name: "", rel: "推导", task: "", role: "", psy: "", concl: "",
  });
  const uidByPage = new Map(childResult.next.pages.map((p) => [p.n, p.uid]));
  assert.equal(uidByPage.get(1), "Uchild1");
  assert.equal(uidByPage.get(2), "Uroot1");
});

test("assignToNewModule draws a new module around a run of currently-free pages", () => {
  const a = emptyReportAnnotation([1, 2, 3]);
  const { next, moduleId } = assignToNewModule(a, [1, 2], () => "m1");
  assert.equal(moduleId, "Mm1");
  assert.deepEqual(next.modules, [{ id: "Mm1", name: "", rel: "推导", role: "" }]);
  const midByPage = new Map(next.pages.map((p) => [p.n, p.mid]));
  assert.equal(midByPage.get(1), "Mm1");
  assert.equal(midByPage.get(2), "Mm1");
  assert.equal(midByPage.get(3), null);
});

/* ============================ removeUnit：子单元升级 ============================ */

test("removeUnit promotes children one level and returns the unit's own pages to its parent", () => {
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M", name: "", rel: "推导", role: "" }],
    units: [
      { id: "Parent", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
      { id: "Child", mid: "M", pid: "Parent", name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
      { id: "Grandchild", mid: "M", pid: "Child", name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
    ],
    pages: [
      page(5, { mid: "M", uid: "Parent" }),
      page(6, { mid: "M", uid: "Child" }),
      page(7, { mid: "M", uid: "Child" }),
      page(8, { mid: "M", uid: "Grandchild" }),
    ],
  };
  const next = removeUnit(a, "Child");
  assert.equal(next.units.some((u) => u.id === "Child"), false);
  const grandchild = next.units.find((u) => u.id === "Grandchild");
  assert.equal(grandchild?.pid, "Parent");
  const uidByPage = new Map(next.pages.map((p) => [p.n, p.uid]));
  // Child's own direct pages fall back to the parent it deleted from...
  assert.equal(uidByPage.get(6), "Parent");
  assert.equal(uidByPage.get(7), "Parent");
  // ...but the grandchild's own pages are untouched.
  assert.equal(uidByPage.get(8), "Grandchild");
  assert.equal(uidByPage.get(5), "Parent");
});

test("removeModule frees every one of its pages and drops all of its units", () => {
  const a: ReportAnnotation = {
    background: { city: "", developer: "", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "", model: "" },
    modules: [{ id: "M", name: "", rel: "推导", role: "" }],
    units: [{ id: "U", mid: "M", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" }],
    pages: [page(1, { mid: "M", uid: "U" }), page(2, { mid: "M" })],
  };
  const next = removeModule(a, "M");
  assert.deepEqual(next.modules, []);
  assert.deepEqual(next.units, []);
  assert.deepEqual(next.pages.map((p) => [p.mid, p.uid]), [[null, null], [null, null]]);
});

/* ============================ pageStatus：三种状态 ============================ */

test("pageStatus: blank, in-progress, and done", () => {
  const blank = pageStatus(page(1));
  assert.deepEqual(blank, { done: false, touched: false, missing: ["页面作用", "内容组块"] });

  const inProgress = pageStatus(page(2, {
    func: "交代命题",
    blocks: [block({ id: "b1", type: "" }), block({ id: "b2", roles: [] })],
  }));
  assert.equal(inProgress.done, false);
  assert.equal(inProgress.touched, true);
  assert.deepEqual(inProgress.missing, ["1 个组块的内容类型", "1 个组块的作用"]);

  const done = pageStatus(page(3, { func: "交代命题", blocks: [block()] }));
  assert.deepEqual(done, { done: true, touched: true, missing: [] });
});

/* ============================ validateReportAnnotation ============================ */

// A loose (non-literal) shape for hand-built payloads: validateReportAnnotation
// takes `unknown`, and these fixtures get mutated field-by-field per test to
// trigger one specific validation error, so `mid`/`uid`/`pid` need to accept
// both a string and null rather than whatever a single literal happened to be.
type LoosePayload = {
  background: { city: string; developer: string; projectBackground: string; businessBackground: string };
  strategy: { narrative: string; model: string };
  modules: Array<{ id: string; name: string; rel: string; role: string }>;
  units: Array<{
    id: string; mid: string; pid: string | null; name: string; rel: string;
    task: string; role: string; psy: string; concl: string;
  }>;
  pages: Array<{
    n: number; mid: string | null; uid: string | null; transition: boolean; func: string; org: string;
    blocks: Array<{
      id: string; name: string; x: number; y: number; w: number; h: number;
      type: string; roles: string[]; style: string; rel: string; narr: string; mark: string;
    }>;
  }>;
};

function validBasePayload(): LoosePayload {
  return {
    background: { city: "南昌", developer: "世纪地产", projectBackground: "", businessBackground: "" },
    strategy: { narrative: "先商业后住宅", model: "标准型" },
    modules: [{ id: "M1", name: "自定义模块名", rel: "推导", role: "" }],
    units: [
      { id: "U1", mid: "M1", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" },
    ],
    pages: [
      { n: 1, mid: "M1", uid: null, transition: false, func: "开场", org: "", blocks: [] },
      {
        n: 2, mid: "M1", uid: "U1", transition: false, func: "论证", org: "",
        blocks: [{ id: "b1", name: "标题块", x: 10, y: 10, w: 30, h: 10, type: "自由填写的类型", roles: ["核心结论"], style: "理性", rel: "展开", narr: "", mark: "" }],
      },
      { n: 3, mid: "M1", uid: "U1", transition: true, func: "收束", org: "", blocks: [] },
    ],
  };
}

test("validateReportAnnotation accepts a well-formed payload, free text and all", () => {
  const result = validateReportAnnotation(validBasePayload(), [1, 2, 3]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.modules[0].name, "自定义模块名"); // module name is free text, not vocab-checked
    assert.equal(result.value.pages[1].blocks[0].type, "自由填写的类型"); // content type is free text too
  }
});

test("validateReportAnnotation rejects a payload missing one of report_pages' page numbers", () => {
  const payload = validBasePayload();
  payload.pages = payload.pages.filter((p) => p.n !== 3);
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("缺少页 p3")));
});

test("validateReportAnnotation rejects a fixed-vocabulary field outside the word list", () => {
  const payload = validBasePayload();
  payload.modules[0].rel = "不存在的关系";
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("不在词表内")));
});

test("validateReportAnnotation rejects a unit whose module id doesn't exist", () => {
  const payload = validBasePayload();
  payload.units[0].mid = "M-does-not-exist";
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("所属的模块「M-does-not-exist」不存在")));
});

test("validateReportAnnotation rejects a module whose pages aren't one contiguous run", () => {
  const payload = validBasePayload();
  // Break the module's contiguity: page 2 goes back to the free tray while
  // page 1 and page 3 both stay in M1.
  payload.pages[1].mid = null;
  payload.pages[1].uid = null;
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("所辖页不连续")));
});

test("validateReportAnnotation rejects a page whose unit belongs to a different module", () => {
  const payload = validBasePayload();
  payload.modules.push({ id: "M2", name: "另一个模块", rel: "推导", role: "" });
  payload.pages[1].mid = "M2"; // page says M2, but its uid (U1) belongs to M1
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("所属的单元与所属模块不一致")));
});

test("validateReportAnnotation rejects a leaf unit with no pages and no children", () => {
  const payload = validBasePayload();
  payload.units.push({ id: "U2", mid: "M1", pid: null, name: "", rel: "并列", task: "", role: "", psy: "", concl: "" });
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("既没有页也没有子单元")));
});

test("validateReportAnnotation rejects an out-of-range block coordinate and a non-positive block size", () => {
  const payload = validBasePayload();
  payload.pages[1].blocks[0].x = 150;
  payload.pages[1].blocks[0].w = 0;
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.includes("坐标必须在 0–100 之间")));
    assert.ok(result.errors.some((e) => e.includes("宽高必须大于 0")));
  }
});

test("validateReportAnnotation rejects a block role outside the fixed 12-item vocabulary", () => {
  const payload = validBasePayload();
  payload.pages[1].blocks[0].roles = ["不存在的作用"];
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("组块作用含有不在词表内的值")));
});

test("validateReportAnnotation reports a pid cycle instead of hanging on it", () => {
  const payload = validBasePayload();
  payload.units[0].pid = "U2";
  payload.units.push({ id: "U2", mid: "M1", pid: "U1", name: "", rel: "并列", task: "", role: "", psy: "", concl: "" });
  const result = validateReportAnnotation(payload, [1, 2, 3]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes("父级链成环")));
});
