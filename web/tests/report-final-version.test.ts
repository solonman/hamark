// 纯函数单测：报告拆解工作台「集成版」的汇入算法。见 lib/report-final-version.ts
// 与 docs/21_报告集成版_实施规格_V0.1.md 三（汇入算法）/ 六（验收清单）/ 3.7
// （SPAN 冲突示例）。不接触数据库——db 函数（ensureReportFinalVersion 等）走
// 本机 Postgres 的走查，不在这份单测覆盖范围内（同 tests/final-version.test.ts
// 的分工）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReportFinalIntake,
  applyReportFinalIntakeBatch,
  computeReportFinalFromHistory,
  diffReportAnnotation,
  type ReportFinalHistoryVersion,
  type ReportFinalIntakeDraft,
} from "../lib/report-final-version.ts";
import {
  modulePages,
  type ReportAnnotation,
  type ReportBlock,
  type ReportModule,
  type ReportPage,
  type ReportUnit,
} from "../lib/report-structure.ts";

/* ============================ Fixture helpers ============================ */

function bg(): ReportAnnotation["background"] {
  return { city: "", developer: "", projectBackground: "", businessBackground: "" };
}
function strat(): ReportAnnotation["strategy"] {
  return { narrative: "", model: "" };
}
function mkPage(n: number, overrides: Partial<ReportPage> = {}): ReportPage {
  return { n, mid: null, uid: null, transition: false, func: "", org: "", blocks: [], ...overrides };
}
function mkModule(id: string, overrides: Partial<ReportModule> = {}): ReportModule {
  return { id, name: "", rel: "推导", role: "", ...overrides };
}
function mkUnit(id: string, mid: string, pid: string | null, overrides: Partial<ReportUnit> = {}): ReportUnit {
  return { id, mid, pid, name: "", rel: "推导", task: "", role: "", psy: "", concl: "", ...overrides };
}
function mkBlock(id: string, overrides: Partial<ReportBlock> = {}): ReportBlock {
  return {
    id, name: "组块", x: 10, y: 10, w: 20, h: 20, type: "标题", roles: ["核心结论"],
    style: "理性", rel: "展开", narr: "", mark: "", ...overrides,
  };
}
function mkAnnotation(input: {
  modules?: ReportModule[]; units?: ReportUnit[]; pages: ReportPage[];
  background?: ReportAnnotation["background"]; strategy?: ReportAnnotation["strategy"];
}): ReportAnnotation {
  return {
    background: input.background ?? bg(),
    strategy: input.strategy ?? strat(),
    modules: input.modules ?? [],
    units: input.units ?? [],
    pages: input.pages,
  };
}
function kinds(drafts: readonly ReportFinalIntakeDraft[]): string[] {
  return drafts.map((d) => d.kind);
}
function pageOwners(a: ReportAnnotation, ns: readonly number[]): Array<[number, string | null, string | null]> {
  const byNo = new Map(a.pages.map((p) => [p.n, p]));
  return ns.map((n) => {
    const p = byNo.get(n);
    return [n, p?.mid ?? null, p?.uid ?? null];
  });
}

/* ============================ 3.1 diffReportAnnotation ============================ */

test("diff: 删除整个模块 → 只出一条 REMOVE_MODULE，模块自己的单元不再单独出 REMOVE_UNIT", () => {
  const before = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    units: [mkUnit("U1", "M1", null)],
    pages: [mkPage(1, { mid: "M1", uid: "U1" }), mkPage(2, { mid: "M2" })],
  });
  const after = mkAnnotation({
    modules: [mkModule("M2")],
    units: [],
    pages: [mkPage(1), mkPage(2, { mid: "M2" })],
  });
  const drafts = diffReportAnnotation(before, after);
  assert.deepEqual(kinds(drafts), ["REMOVE_MODULE"]);
  assert.equal(drafts[0].targetKey, "module:M1");
});

test("diff: 删除模块下的单个单元（模块本身保留）→ REMOVE_UNIT，父单元的页退给模块（体现在 after 里）", () => {
  const before = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null)],
    pages: [mkPage(1, { mid: "M1", uid: "U1" }), mkPage(2, { mid: "M1" })],
  });
  const after = mkAnnotation({
    modules: [mkModule("M1")],
    units: [],
    pages: [mkPage(1, { mid: "M1" }), mkPage(2, { mid: "M1" })],
  });
  const drafts = diffReportAnnotation(before, after);
  // 删除 U1 之后 p1 从"嵌套在 U1 里"变成"直属 M1"——M1 自己的直属（openPagesOf）
  // 集合也跟着从 {2} 变成 {1,2}，所以还会跟着出一条 SPAN(module:M1,...)。
  assert.deepEqual(kinds(drafts), ["REMOVE_UNIT", "SPAN"]);
  assert.deepEqual(drafts[0], { kind: "REMOVE_UNIT", targetKey: "unit:U1", targetLabel: "讲述单元", value: {} });
  assert.equal(drafts[1].targetKey, "module:M1");
  assert.deepEqual(drafts[1].value, { pageNumbers: [1, 2] });
});

test("diff: 新模块带自己的单元与初始页范围——INSERT_MODULE/INSERT_UNIT 不带页，页范围由紧跟的 SPAN 记录建立", () => {
  const before = mkAnnotation({ pages: [mkPage(1), mkPage(2)] });
  const after = mkAnnotation({
    modules: [mkModule("M1", { name: "新模块" })],
    units: [mkUnit("U1", "M1", null, { name: "新单元" })],
    pages: [mkPage(1, { mid: "M1" }), mkPage(2, { mid: "M1", uid: "U1" })],
  });
  const drafts = diffReportAnnotation(before, after);
  assert.deepEqual(kinds(drafts), ["INSERT_MODULE", "INSERT_UNIT", "SPAN", "SPAN"]);
  assert.deepEqual(drafts[0], {
    kind: "INSERT_MODULE", targetKey: "module:M1", targetLabel: "新模块",
    value: { item: mkModule("M1", { name: "新模块" }) },
  });
  assert.deepEqual(drafts[1], {
    kind: "INSERT_UNIT", targetKey: "unit:U1", targetLabel: "新单元",
    value: { item: mkUnit("U1", "M1", null, { name: "新单元" }) },
  });
  // SPAN 顺序：模块先于单元（3.1）。
  assert.equal(drafts[2].targetKey, "module:M1");
  assert.deepEqual(drafts[2].value, { pageNumbers: [1] }); // 只有 p1 是 M1 的直属页，p2 直属 U1
  assert.equal(drafts[3].targetKey, "unit:U1");
  assert.deepEqual(drafts[3].value, { pageNumbers: [2] });
});

test("diff: 同一页组块增删改——先 REMOVE_BLOCK，再 INSERT_BLOCK，再 FIELD", () => {
  const before = mkAnnotation({
    pages: [mkPage(1, { blocks: [mkBlock("b1", { name: "A" }), mkBlock("b2", { name: "B" })] })],
  });
  const after = mkAnnotation({
    pages: [mkPage(1, { blocks: [mkBlock("b1", { name: "A-改" }), mkBlock("b3", { name: "C" })] })],
  });
  const drafts = diffReportAnnotation(before, after);
  assert.deepEqual(kinds(drafts), ["REMOVE_BLOCK", "INSERT_BLOCK", "FIELD"]);
  assert.equal(drafts[0].targetKey, "block:b2");
  assert.equal(drafts[0].targetLabel, "B");
  assert.deepEqual(drafts[1], {
    kind: "INSERT_BLOCK", targetKey: "block:b3", targetLabel: "C",
    value: { item: mkBlock("b3", { name: "C" }), pageNo: 1 },
  });
  assert.equal(drafts[2].targetKey, "block:b1:name");
  assert.equal(drafts[2].value, "A-改");
});

test("diff: 页字段变化（func/org/transition）各出一条 FIELD 记录", () => {
  const before = mkAnnotation({ pages: [mkPage(5, { func: "旧作用", org: "旧组织", transition: false })] });
  const after = mkAnnotation({ pages: [mkPage(5, { func: "新作用", org: "旧组织", transition: true })] });
  const drafts = diffReportAnnotation(before, after);
  assert.deepEqual(kinds(drafts), ["FIELD", "FIELD"]);
  assert.deepEqual(drafts[0], { kind: "FIELD", targetKey: "page:5:func", targetLabel: "第 5 页·页面作用", value: "新作用" });
  assert.deepEqual(drafts[1], { kind: "FIELD", targetKey: "page:5:transition", targetLabel: "第 5 页·过渡页", value: true });
});

test("diff: 固定顺序 REMOVE → INSERT → SPAN → FIELD，一次 diff 里四类都出现时次序不乱", () => {
  const before = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    pages: [mkPage(1, { mid: "M1" }), mkPage(2, { mid: "M1" }), mkPage(3, { mid: "M2", func: "old" }), mkPage(4, { mid: "M2" })],
  });
  const after = mkAnnotation({
    // M1 removed entirely; a brand-new M3 claims its old pages 1-2; M2 keeps
    // its pages but page 3's func field changes.
    modules: [mkModule("M2"), mkModule("M3")],
    pages: [mkPage(1, { mid: "M3" }), mkPage(2, { mid: "M3" }), mkPage(3, { mid: "M2", func: "new" }), mkPage(4, { mid: "M2" })],
  });
  const drafts = diffReportAnnotation(before, after);
  assert.deepEqual(kinds(drafts), ["REMOVE_MODULE", "INSERT_MODULE", "SPAN", "FIELD"]);
  assert.equal(drafts[0].targetKey, "module:M1");
  assert.equal(drafts[1].targetKey, "module:M3");
  assert.equal(drafts[2].targetKey, "module:M3");
  assert.deepEqual(drafts[2].value, { pageNumbers: [1, 2] });
  assert.equal(drafts[3].targetKey, "page:3:func");
});

test("diff: 两份完全相同的 payload 不产生任何记录", () => {
  const a = mkAnnotation({
    modules: [mkModule("M1")],
    pages: [mkPage(1, { mid: "M1", func: "一样" })],
  });
  assert.deepEqual(diffReportAnnotation(a, structuredClone(a)), []);
});

/* ============================ 3.2 applyReportFinalIntake — APPLIED / NOOP ============================ */

test("REMOVE_MODULE: 存在则模块与其单元一并删除，页退回未归入；不存在 → NOOP", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null)],
    pages: [mkPage(1, { mid: "M1", uid: "U1" }), mkPage(2, { mid: "M1" })],
  });
  const applied = applyReportFinalIntake(payload, { kind: "REMOVE_MODULE", targetKey: "module:M1", value: {} });
  assert.equal(applied.effect, "APPLIED");
  assert.deepEqual(applied.payload.modules, []);
  assert.deepEqual(applied.payload.units, []);
  assert.deepEqual(pageOwners(applied.payload, [1, 2]), [[1, null, null], [2, null, null]]);

  const noop = applyReportFinalIntake(payload, { kind: "REMOVE_MODULE", targetKey: "module:missing", value: {} });
  assert.equal(noop.effect, "NOOP");
  assert.equal(noop.payload, payload);
});

test("REMOVE_UNIT: 存在则子单元提升、直属页退给父级（无父单元退给模块）；不存在 → NOOP", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null), mkUnit("U2", "M1", "U1")],
    pages: [mkPage(1, { mid: "M1", uid: "U1" }), mkPage(2, { mid: "M1", uid: "U2" })],
  });
  const applied = applyReportFinalIntake(payload, { kind: "REMOVE_UNIT", targetKey: "unit:U1", value: {} });
  assert.equal(applied.effect, "APPLIED");
  assert.equal(applied.payload.units.length, 1);
  assert.equal(applied.payload.units[0].id, "U2");
  assert.equal(applied.payload.units[0].pid, null); // promoted to root
  assert.deepEqual(pageOwners(applied.payload, [1]), [[1, "M1", null]]); // U1's own page falls to the module

  const noop = applyReportFinalIntake(payload, { kind: "REMOVE_UNIT", targetKey: "unit:missing", value: {} });
  assert.equal(noop.effect, "NOOP");
});

test("REMOVE_BLOCK: 存在则从所在页删除；哪一页都找不到 → NOOP", () => {
  const payload = mkAnnotation({ pages: [mkPage(1, { blocks: [mkBlock("b1")] })] });
  const applied = applyReportFinalIntake(payload, { kind: "REMOVE_BLOCK", targetKey: "block:b1", value: {} });
  assert.equal(applied.effect, "APPLIED");
  assert.deepEqual(applied.payload.pages[0].blocks, []);

  const noop = applyReportFinalIntake(payload, { kind: "REMOVE_BLOCK", targetKey: "block:missing", value: {} });
  assert.equal(noop.effect, "NOOP");
});

test("INSERT_MODULE: id 不存在则 push（此时允许零页——validate 不在这一步跑）；id 已存在 → NOOP", () => {
  const payload = mkAnnotation({ modules: [mkModule("M1")], pages: [mkPage(1, { mid: "M1" })] });
  const item = mkModule("M2", { name: "新模块" });
  const applied = applyReportFinalIntake(payload, { kind: "INSERT_MODULE", targetKey: "module:M2", value: { item } });
  assert.equal(applied.effect, "APPLIED");
  assert.deepEqual(applied.payload.modules.map((m) => m.id), ["M1", "M2"]);

  const noop = applyReportFinalIntake(payload, {
    kind: "INSERT_MODULE", targetKey: "module:M1", value: { item: mkModule("M1") },
  });
  assert.equal(noop.effect, "NOOP");
});

test("INSERT_UNIT: 三种 NOOP（id 冲突／mid 不存在／pid 不存在），以及成功插入", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null)],
    pages: [mkPage(1, { mid: "M1", uid: "U1" })],
  });
  const dup = applyReportFinalIntake(payload, {
    kind: "INSERT_UNIT", targetKey: "unit:U1", value: { item: mkUnit("U1", "M1", null) },
  });
  assert.equal(dup.effect, "NOOP");

  const badMid = applyReportFinalIntake(payload, {
    kind: "INSERT_UNIT", targetKey: "unit:U2", value: { item: mkUnit("U2", "missing-module", null) },
  });
  assert.equal(badMid.effect, "NOOP");

  const badPid = applyReportFinalIntake(payload, {
    kind: "INSERT_UNIT", targetKey: "unit:U2", value: { item: mkUnit("U2", "M1", "missing-unit") },
  });
  assert.equal(badPid.effect, "NOOP");

  const ok = applyReportFinalIntake(payload, {
    kind: "INSERT_UNIT", targetKey: "unit:U2", value: { item: mkUnit("U2", "M1", "U1") },
  });
  assert.equal(ok.effect, "APPLIED");
  assert.deepEqual(ok.payload.units.map((u) => u.id), ["U1", "U2"]);
});

test("INSERT_BLOCK: id 冲突或页码不存在 → NOOP；否则插入目标页", () => {
  const payload = mkAnnotation({ pages: [mkPage(1, { blocks: [mkBlock("b1")] }), mkPage(2)] });
  const dup = applyReportFinalIntake(payload, {
    kind: "INSERT_BLOCK", targetKey: "block:b1", value: { item: mkBlock("b1"), pageNo: 2 },
  });
  assert.equal(dup.effect, "NOOP");

  const badPage = applyReportFinalIntake(payload, {
    kind: "INSERT_BLOCK", targetKey: "block:b2", value: { item: mkBlock("b2"), pageNo: 99 },
  });
  assert.equal(badPage.effect, "NOOP");

  const ok = applyReportFinalIntake(payload, {
    kind: "INSERT_BLOCK", targetKey: "block:b2", value: { item: mkBlock("b2"), pageNo: 2 },
  });
  assert.equal(ok.effect, "APPLIED");
  assert.deepEqual(ok.payload.pages[1].blocks.map((b) => b.id), ["b2"]);
});

test("SPAN: 目标模块/单元不存在 → NOOP；存在则整段替换直属页集合", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    pages: [mkPage(1, { mid: "M1" }), mkPage(2, { mid: "M1" }), mkPage(3, { mid: "M2" })],
  });
  const noop = applyReportFinalIntake(payload, {
    kind: "SPAN", targetKey: "module:missing", value: { pageNumbers: [1] },
  });
  assert.equal(noop.effect, "NOOP");

  const applied = applyReportFinalIntake(payload, {
    kind: "SPAN", targetKey: "module:M2", value: { pageNumbers: [2, 3] },
  });
  assert.equal(applied.effect, "APPLIED");
  assert.deepEqual(pageOwners(applied.payload, [1, 2, 3]), [[1, "M1", null], [2, "M2", null], [3, "M2", null]]);
});

test("FIELD: 四类目标（background/strategy/module/unit/page/block）不存在 → NOOP，存在则写入", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1", { name: "旧" })],
    units: [mkUnit("U1", "M1", null, { name: "旧" })],
    pages: [mkPage(1, { mid: "M1", uid: "U1", func: "旧", blocks: [mkBlock("b1", { name: "旧" })] })],
  });
  assert.equal(
    applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "module:missing:name", value: "新" }).effect,
    "NOOP",
  );
  assert.equal(
    applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "unit:missing:name", value: "新" }).effect,
    "NOOP",
  );
  assert.equal(
    applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "page:99:func", value: "新" }).effect,
    "NOOP",
  );
  assert.equal(
    applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "block:missing:name", value: "新" }).effect,
    "NOOP",
  );

  const bgResult = applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "background.city", value: "南昌" });
  assert.equal(bgResult.effect, "APPLIED");
  assert.equal(bgResult.payload.background.city, "南昌");

  const stratResult = applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "strategy.model", value: "标准型" });
  assert.equal(stratResult.effect, "APPLIED");
  assert.equal(stratResult.payload.strategy.model, "标准型");

  const modResult = applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "module:M1:name", value: "新" });
  assert.equal(modResult.effect, "APPLIED");
  assert.equal(modResult.payload.modules[0].name, "新");

  const unitResult = applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "unit:U1:name", value: "新" });
  assert.equal(unitResult.effect, "APPLIED");
  assert.equal(unitResult.payload.units[0].name, "新");

  const pageResult = applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "page:1:func", value: "新" });
  assert.equal(pageResult.effect, "APPLIED");
  assert.equal(pageResult.payload.pages[0].func, "新");

  const blockResult = applyReportFinalIntake(payload, { kind: "FIELD", targetKey: "block:b1:name", value: "新" });
  assert.equal(blockResult.effect, "APPLIED");
  assert.equal(blockResult.payload.pages[0].blocks[0].name, "新");
});

test("validate 不通过则整条记为 NOOP，payload 回退到应用前——用一个不在词表内的关系值触发", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1", { rel: "推导" })],
    pages: [mkPage(1, { mid: "M1" })],
  });
  const result = applyReportFinalIntake(payload, {
    kind: "FIELD", targetKey: "module:M1:rel", value: "不存在的组织关系",
  });
  assert.equal(result.effect, "NOOP");
  assert.equal(result.payload, payload);
  assert.equal(result.payload.modules[0].rel, "推导"); // 没有被污染
});

/* ============================ SPAN 落地后的收拢 ============================ */

test("SPAN 收拢：单元不连续时保留含最小页码的连续游程，其余退回直接上级（父单元存在）", () => {
  // U1（根单元）自己直属 {1,4}；U2（U1 的子单元）直属 {2,3}；M1 自己直属 {5}。
  // U1.unitPages = {1,2,3,4}（自己的 + U2 的），与 M1 自己的 {5} 拼起来正好
  // 连续 {1..5}——初始是合法状态。
  const payload = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null), mkUnit("U2", "M1", "U1")],
    pages: [
      mkPage(1, { mid: "M1", uid: "U1" }), mkPage(2, { mid: "M1", uid: "U2" }), mkPage(3, { mid: "M1", uid: "U2" }),
      mkPage(4, { mid: "M1", uid: "U1" }), mkPage(5, { mid: "M1" }),
    ],
  });
  // U2 想额外多要一页 5（原本是 M1 自己直属的）——U2 的新直属集合 {2,3,5} 本身
  // 不连续（缺 4，4 是 U1 自己的）。
  const result = applyReportFinalIntake(payload, {
    kind: "SPAN", targetKey: "unit:U2", value: { pageNumbers: [2, 3, 5] },
  });
  assert.equal(result.effect, "APPLIED");
  // U2 只保留含最小页码 2 的连续游程 {2,3}；5 退给它的直接上级——父单元 U1
  // （不是模块，也不是自由页）。退回后 U1 自己直属变成 {1,4,5}，U1.unitPages
  // （连同 U2 的 {2,3}）正好又是 {1,2,3,4,5}，整体依然连续，不再继续往上退。
  assert.deepEqual(pageOwners(result.payload, [1, 2, 3, 4, 5]), [
    [1, "M1", "U1"], [2, "M1", "U2"], [3, "M1", "U2"], [4, "M1", "U1"], [5, "M1", "U1"],
  ]);
  const u2 = result.payload.units.find((u) => u.id === "U2")!;
  assert.deepEqual(pageOwners(result.payload, [2, 3]), [[2, "M1", "U2"], [3, "M1", "U2"]]);
  assert.equal(u2.pid, "U1"); // 单元层级本身没有变化，只是页归属变了
});

test("SPAN 收拢：根单元不连续时没有父单元，退回模块", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null)],
    pages: [1, 2, 3, 4].map((n) => mkPage(n, { mid: "M1" })),
  });
  const result = applyReportFinalIntake(payload, {
    kind: "SPAN", targetKey: "unit:U1", value: { pageNumbers: [1, 3] },
  });
  assert.equal(result.effect, "APPLIED");
  // 保留含最小页码 1 的游程（只有 {1} 本身连续），3 退给模块（U1 没有父单元）。
  assert.deepEqual(pageOwners(result.payload, [1, 3]), [[1, "M1", "U1"], [3, "M1", null]]);
});

test("SPAN 收拢：模块不连续时退到未归入（模块之上没有更高容器）", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    pages: [1, 2, 3, 4, 5].map((n) => mkPage(n, { mid: n <= 3 ? "M1" : "M2" })),
  });
  // M1 原本 {1,2,3}；SPAN 把 4 也划进来但制造出不连续（模块自己不会连续，因为
  // 3,4 之间实际相邻——换用一个真正制造缺口的场景：M1 收到 {1,2,4}，缺 3。
  const result = applyReportFinalIntake(payload, {
    kind: "SPAN", targetKey: "module:M1", value: { pageNumbers: [1, 2, 4] },
  });
  assert.equal(result.effect, "APPLIED");
  // 保留 {1,2}（含最小页码 1 的连续游程），4 退到未归入（mid=null,uid=null）。
  // 3 从没被这条记录碰过，原样留在 M2（不受影响，因为它一直都是 M2 的页,
  // 这条 SPAN 只处理 M1 的直属集合）。
  assert.deepEqual(pageOwners(result.payload, [1, 2, 4]), [[1, "M1", null], [2, "M1", null], [4, null, null]]);
});

test("SPAN 收拢：容器变空时按 applyMove 现有语义整体撤销（模块连带其单元一起撤销）", () => {
  const payload = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    units: [mkUnit("U1", "M1", null)],
    pages: [mkPage(1, { mid: "M1", uid: "U1" }), mkPage(2, { mid: "M2" })],
  });
  // U1 是唯一持有 page1 的容器（M1 自己没有直属页，全靠 U1）。把 U1 的 SPAN
  // 设成空集合，直接清空 U1——U1 自己变空（无页无子单元）先被撤销，紧接着
  // M1 也失去了唯一的页，跟着被整体撤销（同 applyMove 既有的级联语义）。
  const result = applyReportFinalIntake(payload, { kind: "SPAN", targetKey: "unit:U1", value: { pageNumbers: [] } });
  assert.equal(result.effect, "APPLIED");
  assert.equal(result.payload.units.some((u) => u.id === "U1"), false);
  assert.equal(result.payload.modules.some((m) => m.id === "M1"), false);
  assert.equal(result.payload.modules.some((m) => m.id === "M2"), true); // 不相关的模块不受影响
  assert.deepEqual(pageOwners(result.payload, [1]), [[1, null, null]]);
});

/* ============================ 3.7 SPAN 冲突示例（原样搬成用例） ============================ */

test("3.7 示例一：两个版本把同一页分别划给不同模块，后改覆盖先改", () => {
  const initial = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => mkPage(n, { mid: n <= 5 ? "M1" : "M2" })),
  });
  // seq=10: v2 把 p05 从 M1 拖进 M2 → SPAN(M1,{1,2,3,4})
  // seq=11: 同一保存里 → SPAN(M2,{5,6,7,8,9,10})
  // seq=20: v3（更晚保存，基于更早的快照）把 p05 拖回 M1 → SPAN(M1,{1,2,3,4,5})
  const batch: ReportFinalIntakeDraft[] = [
    { kind: "SPAN", targetKey: "module:M1", targetLabel: "M1", value: { pageNumbers: [1, 2, 3, 4] } },
    { kind: "SPAN", targetKey: "module:M2", targetLabel: "M2", value: { pageNumbers: [5, 6, 7, 8, 9, 10] } },
    { kind: "SPAN", targetKey: "module:M1", targetLabel: "M1", value: { pageNumbers: [1, 2, 3, 4, 5] } },
  ];
  const { payload, applied } = applyReportFinalIntakeBatch(initial, batch, "OPEN");
  assert.equal(applied, true);
  // p05 最终归 M1（seq=20 是最后一条动到 p05 的记录）。
  assert.deepEqual(pageOwners(payload, [1, 2, 3, 4, 5]), [
    [1, "M1", null], [2, "M1", null], [3, "M1", null], [4, "M1", null], [5, "M1", null],
  ]);
  // M2 的"当前有效集合"是 {p06..p10}——不需要 M2 自己再出一条新 SPAN。
  assert.deepEqual(pageOwners(payload, [6, 7, 8, 9, 10]), [
    [6, "M2", null], [7, "M2", null], [8, "M2", null], [9, "M2", null], [10, "M2", null],
  ]);
});

test("3.7 示例二：一页被踢出两层嵌套，波及父单元与祖父模块的连续性", () => {
  // M2 一开始 0 页——如同刚被 INSERT_MODULE 插入、还在等自己的第一条 SPAN
  // （这正是它将要在这批记录里拿到的 {p03}）。
  const initial = mkAnnotation({
    modules: [mkModule("M1"), mkModule("M2")],
    units: [mkUnit("U1", "M1", null)],
    pages: [
      mkPage(1, { mid: "M1" }), mkPage(2, { mid: "M1", uid: "U1" }), mkPage(3, { mid: "M1", uid: "U1" }),
      mkPage(4, { mid: "M1" }), mkPage(5, { mid: "M1" }),
    ],
  });
  // v2 把 p03 单独拖出 U1、拖进 M2：产生 SPAN(M2,{p03}) 与 SPAN(U1,{p02})。
  // SPAN 顺序模块先于单元：M2 的记录先于 U1 的记录。
  const batch: ReportFinalIntakeDraft[] = [
    { kind: "SPAN", targetKey: "module:M2", targetLabel: "M2", value: { pageNumbers: [3] } },
    { kind: "SPAN", targetKey: "unit:U1", targetLabel: "U1", value: { pageNumbers: [2] } },
  ];
  const { payload } = applyReportFinalIntakeBatch(initial, batch, "OPEN");
  // M1 = {p01,p02}（U1 仍嵌在里面，{p02}）；p04,p05 变成未归入页；M2 正常拿到 p03。
  assert.deepEqual(pageOwners(payload, [1, 2, 4, 5]), [
    [1, "M1", null], [2, "M1", "U1"], [4, null, null], [5, null, null],
  ]);
  assert.deepEqual(pageOwners(payload, [3]), [[3, "M2", null]]);
  assert.equal(payload.units.some((u) => u.id === "U1"), true); // U1 自己没有变空，没被撤销
  assert.equal(payload.modules.some((m) => m.id === "M2"), true);
});

test("3.7 示例三：REMOVE 必须先于 SPAN——颠倒顺序会让 SPAN 记录算错，进而产生错误结果", () => {
  // M1 直属 {1,6}；U1（根单元）直属 {2,3}；U2（U1 的子单元）直属 {4,5}。
  // v2 删除 U1（U2 提升、U1 的页临时并入 M1），同一份保存还把 p03 挪去新建的
  // 模块 M2。正确顺序：REMOVE_UNIT(U1) → INSERT_MODULE(M2) → SPAN(M1,...) →
  // SPAN(M2,...)（REMOVE 排最前；INSERT 次之；SPAN 里模块间按 id 升序）。
  const initial = mkAnnotation({
    modules: [mkModule("M1")],
    units: [mkUnit("U1", "M1", null), mkUnit("U2", "M1", "U1")],
    pages: [
      mkPage(1, { mid: "M1" }), mkPage(2, { mid: "M1", uid: "U1" }), mkPage(3, { mid: "M1", uid: "U1" }),
      mkPage(4, { mid: "M1", uid: "U2" }), mkPage(5, { mid: "M1", uid: "U2" }), mkPage(6, { mid: "M1" }),
    ],
  });
  const correctOrder: ReportFinalIntakeDraft[] = [
    { kind: "REMOVE_UNIT", targetKey: "unit:U1", targetLabel: "U1", value: {} },
    { kind: "INSERT_MODULE", targetKey: "module:M2", targetLabel: "M2", value: { item: mkModule("M2") } },
    { kind: "SPAN", targetKey: "module:M1", targetLabel: "M1", value: { pageNumbers: [1, 2, 6] } },
    { kind: "SPAN", targetKey: "module:M2", targetLabel: "M2", value: { pageNumbers: [3] } },
  ];
  const correct = applyReportFinalIntakeBatch(initial, correctOrder, "OPEN");
  assert.equal(correct.applied, true);
  // M2 正常拿到 p03，独立成一个单页模块。p04,p05（原本经 U2 挂在 M1 下）
  // 因为 M1 自己缩到 {1,2} 之后不再跟 p03 相邻，被收拢规则一并退回未归入——
  // 同示例二"页被后来的记录划走可能连带产生原容器不连续、进而丢页"的代价。
  assert.deepEqual(pageOwners(correct.payload, [1, 2, 3]), [[1, "M1", null], [2, "M1", null], [3, "M2", null]]);
  assert.deepEqual(pageOwners(correct.payload, [4, 5, 6]), [[4, null, null], [5, null, null], [6, null, null]]);
  assert.equal(correct.payload.modules.some((m) => m.id === "M2"), true);
  // U1 被显式删除；U2 因为跟着 M1 一起失去了 {4,5}，被收拢规则连带撤销
  // （变空、无子单元）——U1/U2 都不再存在。
  assert.equal(correct.payload.units.length, 0);

  // 颠倒顺序：SPAN 先于 REMOVE_UNIT，且 INSERT_MODULE(M2) 排在了它自己的
  // SPAN 后面。这一步步都会把状态算错：
  //  1. SPAN(M1,{1,2,6}) 落地时 U1 还没被删——它会直接把原本属于 U1 的 p02
  //     越过 U1 摘给模块 M1（"无论 p 当前挂在谁名下，一律先摘掉再赋值"对
  //     SPAN 记录本身是无害的隔离设计，但当 REMOVE 还没发生时，这个"谁当前
  //     挂在谁名下"的判断依据的是错误的中间状态）。此时 U1 自己只剩 p03，
  //     连同子单元 U2 的 {4,5} 依然连续（{3,4,5}），不会被误删。
  //  2. SPAN(M2,{3}) 落地时 M2 还不存在（INSERT_MODULE 还没排到）→ NOOP，
  //     p03 因此没能转手，仍留在 U1 名下。
  //  3. INSERT_MODULE(M2) 此时才把 M2 建出来，但已经没有任何后续记录再给它
  //     页——M2 从此永远停在"0 页待定"的状态，不会被判定为死容器清除掉
  //     （因为它一直被当作"待定的新容器"保护），但也永远等不到内容。
  //  4. REMOVE_UNIT(U1) 最后落地，正常把 p03 交还模块（U1 没有父单元），
  //     U2 提升为根单元——p03 最终留在 M1，而不是 M2。
  const wrongOrder: ReportFinalIntakeDraft[] = [
    { kind: "SPAN", targetKey: "module:M1", targetLabel: "M1", value: { pageNumbers: [1, 2, 6] } },
    { kind: "SPAN", targetKey: "module:M2", targetLabel: "M2", value: { pageNumbers: [3] } },
    { kind: "INSERT_MODULE", targetKey: "module:M2", targetLabel: "M2", value: { item: mkModule("M2") } },
    { kind: "REMOVE_UNIT", targetKey: "unit:U1", targetLabel: "U1", value: {} },
  ];
  const wrong = applyReportFinalIntakeBatch(initial, wrongOrder, "OPEN");
  assert.equal(wrong.applied, true);
  // p03 错误地留在了 M1（正确顺序下它应该属于 M2）——顺序错乱产生的是
  // 一个不同的、错误的最终结果，不只是记录不完整。
  assert.deepEqual(pageOwners(wrong.payload, [3]), [[3, "M1", null]]);
  assert.notDeepEqual(pageOwners(wrong.payload, [3]), pageOwners(correct.payload, [3]));
  // M2 被创建了，却永远拿不到任何页——一个空壳模块，不会被判定为死容器
  // 清除（它一直被当作"待定新容器"保护），但也永远等不到内容。
  const m2 = wrong.payload.modules.find((m) => m.id === "M2");
  assert.ok(m2);
  assert.equal(modulePages(wrong.payload, "M2").length, 0);
});

/* ============================ applyReportFinalIntakeBatch：DONE 不应用 / OPEN 按顺序应用 ============================ */

test("applyReportFinalIntakeBatch: DONE 状态下 payload 原样不变，applied 为 false", () => {
  const payload = mkAnnotation({ modules: [mkModule("M1", { name: "定稿前" })], pages: [mkPage(1, { mid: "M1" })] });
  const drafts: ReportFinalIntakeDraft[] = [
    { kind: "FIELD", targetKey: "module:M1:name", targetLabel: "名称", value: "定稿后想改的值" },
  ];
  const result = applyReportFinalIntakeBatch(payload, drafts, "DONE");
  assert.equal(result.applied, false);
  assert.equal(result.payload, payload);
});

test("applyReportFinalIntakeBatch: OPEN 状态下按数组顺序应用，后一条覆盖前一条同目标的写法", () => {
  const payload = mkAnnotation({ modules: [mkModule("M1", { name: "origin" })], pages: [mkPage(1, { mid: "M1" })] });
  const drafts: ReportFinalIntakeDraft[] = [
    { kind: "FIELD", targetKey: "module:M1:name", targetLabel: "名称", value: "第一条" },
    { kind: "FIELD", targetKey: "module:M1:name", targetLabel: "名称", value: "第二条" },
  ];
  const result = applyReportFinalIntakeBatch(payload, drafts, "OPEN");
  assert.equal(result.applied, true);
  assert.equal(result.payload.modules[0].name, "第二条");
});

test("采纳按 seq 升序应用：后一条覆盖前一条，与输入顺序无关", () => {
  const payload = mkAnnotation({ modules: [mkModule("M1", { name: "origin" })], pages: [mkPage(1, { mid: "M1" })] });
  const pending = [
    { seq: 2, draft: { kind: "FIELD", targetKey: "module:M1:name", targetLabel: "名称", value: "第二条" } as ReportFinalIntakeDraft },
    { seq: 1, draft: { kind: "FIELD", targetKey: "module:M1:name", targetLabel: "名称", value: "第一条" } as ReportFinalIntakeDraft },
  ];
  const sortedBySeq = [...pending].sort((left, right) => left.seq - right.seq).map((entry) => entry.draft);
  const result = applyReportFinalIntakeBatch(payload, sortedBySeq, "OPEN");
  assert.equal(result.payload.modules[0].name, "第二条");
});

/* ============================ 3.3 computeReportFinalFromHistory ============================ */

function historyVersion(overrides: Partial<ReportFinalHistoryVersion>): ReportFinalHistoryVersion {
  return {
    id: "version_1",
    versionNumber: 1,
    updatedAt: "2026-09-01T10:00:00.000Z",
    ownerUserId: "user_1",
    ownerName: "张三",
    basePayload: null,
    payload: mkAnnotation({ pages: [mkPage(1)] }),
    ...overrides,
  };
}

test("computeReportFinalFromHistory: 两版本先后改同一字段，按 updated_at 排序后取后改者", () => {
  const origin = mkAnnotation({ modules: [mkModule("M1", { name: "origin" })], pages: [mkPage(1, { mid: "M1" })] });
  // 有意乱序传入：v3 的行排在 v2 前面，函数必须自己按 updatedAt 排序。
  const versions: ReportFinalHistoryVersion[] = [
    historyVersion({
      id: "v3", versionNumber: 3, updatedAt: "2026-09-01T12:00:00.000Z", ownerName: "王五",
      basePayload: origin, payload: mkAnnotation({ modules: [mkModule("M1", { name: "v3改的值" })], pages: [mkPage(1, { mid: "M1" })] }),
    }),
    historyVersion({
      id: "v2", versionNumber: 2, updatedAt: "2026-09-01T11:00:00.000Z", ownerName: "李四",
      basePayload: origin, payload: mkAnnotation({ modules: [mkModule("M1", { name: "v2改的值" })], pages: [mkPage(1, { mid: "M1" })] }),
    }),
  ];
  const { payload, intakes } = computeReportFinalFromHistory(origin, versions);
  assert.equal(payload.modules[0].name, "v3改的值");
  assert.equal(intakes.length, 2);
  // 重放顺序遵从 updatedAt 升序，不是数组的输入顺序。
  assert.equal(intakes[0].sourceVersionNumber, 2);
  assert.equal(intakes[1].sourceVersionNumber, 3);
  assert.ok(intakes.every((i) => i.applied === true && i.source === "VERSION"));
});

test("computeReportFinalFromHistory: updated_at 相同时用 id 兜底排序，结果稳定", () => {
  const origin = mkAnnotation({ modules: [mkModule("M1", { name: "origin" })], pages: [mkPage(1, { mid: "M1" })] });
  const sameTime = "2026-09-01T10:00:00.000Z";
  const versions: ReportFinalHistoryVersion[] = [
    historyVersion({
      id: "version_b", versionNumber: 2, updatedAt: sameTime, basePayload: origin,
      payload: mkAnnotation({ modules: [mkModule("M1", { name: "b" })], pages: [mkPage(1, { mid: "M1" })] }),
    }),
    historyVersion({
      id: "version_a", versionNumber: 1, updatedAt: sameTime, basePayload: origin,
      payload: mkAnnotation({ modules: [mkModule("M1", { name: "a" })], pages: [mkPage(1, { mid: "M1" })] }),
    }),
  ];
  const { payload } = computeReportFinalFromHistory(origin, versions);
  // "version_a" < "version_b" 字典序更小，先重放；"version_b" 后重放，最终生效。
  assert.equal(payload.modules[0].name, "b");
});

test("computeReportFinalFromHistory: 第一版没有基版（basePayload=null）时以 origin 为 before", () => {
  const origin = mkAnnotation({ modules: [mkModule("M1", { name: "origin" })], pages: [mkPage(1, { mid: "M1" })] });
  const versions: ReportFinalHistoryVersion[] = [
    historyVersion({
      id: "v1", versionNumber: 1, basePayload: null,
      payload: mkAnnotation({ modules: [mkModule("M1", { name: "v1第一次保存" })], pages: [mkPage(1, { mid: "M1" })] }),
    }),
  ];
  const { payload, intakes } = computeReportFinalFromHistory(origin, versions);
  assert.equal(payload.modules[0].name, "v1第一次保存");
  assert.equal(intakes.length, 1);
  assert.equal(intakes[0].targetKey, "module:M1:name");
});
