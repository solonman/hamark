// 纯函数单测：报告集成版·溯源视图的推导（lib/report-final-trace.ts）。覆盖
// 任务清单要求的五点：相邻同值合并、空白不算写法、固定选项翻标签、SPAN 页
// 范围文本、pending 分流。不接触数据库——`ReportFinalTraceIntake` 全部手工
// 构造，跟 tests/report-final-version.test.ts 的 fixture 风格一致。
import assert from "node:assert/strict";
import test from "node:test";
import { deriveReportFinalTraceModel } from "../lib/report-final-trace.ts";
import { emptyReportAnnotation, type ReportAnnotation, type ReportBlock, type ReportModule, type ReportUnit } from "../lib/report-structure.ts";
import type { ReportFinalTraceIntake } from "../lib/report-final-version.ts";

/* ============================ Fixture helpers ============================ */

function origin(pageNumbers: number[] = [1, 2, 3]): ReportAnnotation {
  return emptyReportAnnotation(pageNumbers);
}

function mkModule(id: string, overrides: Partial<ReportModule> = {}): ReportModule {
  return { id, name: "", rel: "推导", role: "", ...overrides };
}
function mkUnit(id: string, mid: string, overrides: Partial<ReportUnit> = {}): ReportUnit {
  return { id, mid, pid: null, name: "", rel: "推导", task: "", role: "", psy: "", concl: "", ...overrides };
}
function mkBlock(id: string, overrides: Partial<ReportBlock> = {}): ReportBlock {
  return { id, name: "", x: 0, y: 0, w: 10, h: 10, type: "标题", roles: [], style: "理性", rel: "推导", narr: "", mark: "", ...overrides };
}

let seqCounter = 0;
function mkIntake(overrides: Partial<ReportFinalTraceIntake> & Pick<ReportFinalTraceIntake, "kind" | "targetKey" | "value">): ReportFinalTraceIntake {
  seqCounter += 1;
  return {
    id: `intake_${seqCounter}`,
    seq: seqCounter,
    targetLabel: "字段",
    source: "VERSION",
    sourceVersionNumber: 1,
    actorName: "李工",
    applied: true,
    createdAt: `2026-09-0${seqCounter}T00:00:00.000Z`,
    ...overrides,
  };
}

test.beforeEach(() => { seqCounter = 0; });

/* ============================ 相邻同值合并 ============================ */

test("adjacent identical values collapse into one row, keeping the earliest occurrence", () => {
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "background.city", value: "南昌", sourceVersionNumber: 1, actorName: "王策划" }),
    // v2 写回同一个值——不该多出一行。
    mkIntake({ kind: "FIELD", targetKey: "background.city", value: "南昌", sourceVersionNumber: 2, actorName: "李工" }),
    mkIntake({ kind: "FIELD", targetKey: "background.city", value: "上海", sourceVersionNumber: 3, actorName: "赵雅诗" }),
  ];
  const model = deriveReportFinalTraceModel(origin(), intakes, {
    ...origin(),
    background: { ...origin().background, city: "上海" },
  });
  const trace = model.fields["background.city"];
  assert.ok(trace);
  assert.equal(trace.current?.value, "上海");
  assert.equal(trace.current?.versionLabel, "v3");
  // 历史只剩一行"南昌"（v1 与重复的 v2 合并成一条，v2 不再单独出现）。
  assert.equal(trace.history.length, 1);
  assert.equal(trace.history[0].value, "南昌");
  assert.equal(trace.history[0].versionLabel, "v1");
});

/* ============================ 空白不算写法 ============================ */

test("a blank field with no intakes produces no trace entry at all", () => {
  const model = deriveReportFinalTraceModel(origin(), [], origin());
  assert.equal(model.fields["background.developer"], undefined);
});

test("writing back to blank doesn't create a history row for the blank state, but is still shown when it's the current value", () => {
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "background.developer", value: "世纪地产", sourceVersionNumber: 1, actorName: "王策划" }),
    mkIntake({ kind: "FIELD", targetKey: "background.developer", value: "", sourceVersionNumber: 2, actorName: "李工" }),
  ];
  const finalPayload = { ...origin(), background: { ...origin().background, developer: "" } };
  const model = deriveReportFinalTraceModel(origin(), intakes, finalPayload);
  const trace = model.fields["background.developer"];
  assert.ok(trace);
  // 当前采用如实显示"被写回空白"这个真实状态。
  assert.equal(trace.current?.value, "");
  assert.equal(trace.current?.versionLabel, "v2");
  // 但"世纪地产"作为历史行还在——它本身不是空白，只是被空白盖掉了。
  assert.equal(trace.history.length, 1);
  assert.equal(trace.history[0].value, "世纪地产");
});

test("a blank origin never surfaces as a row — the first version to actually write something is the first row", () => {
  // origin 恒定全空白（emptyReportAnnotation），这里显式验证：即使字段从
  // v1 起就有值，溯源里也看不到"原稿"这一行，只看得到 v1 自己的写入。
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "strategy.narrative", value: "先商业后住宅", sourceVersionNumber: 1, actorName: "王策划" }),
  ];
  const model = deriveReportFinalTraceModel(origin(), intakes, {
    ...origin(),
    strategy: { ...origin().strategy, narrative: "先商业后住宅" },
  });
  const trace = model.fields["strategy.narrative"];
  assert.ok(trace);
  assert.equal(trace.history.length, 0, "no synthetic blank-origin row");
  assert.equal(trace.current?.versionLabel, "v1");
  assert.notEqual(trace.current?.versionLabel, "原稿");
});

/* ============================ 固定选项翻标签 ============================ */

test("a boolean field (page transition) is translated to 是/否, not the raw boolean", () => {
  const originAnn = origin([1]);
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "page:1:transition", value: true, sourceVersionNumber: 1, actorName: "王策划" }),
  ];
  const finalPayload: ReportAnnotation = {
    ...originAnn,
    pages: originAnn.pages.map((p) => (p.n === 1 ? { ...p, transition: true } : p)),
  };
  const model = deriveReportFinalTraceModel(originAnn, intakes, finalPayload);
  const trace = model.fields["page:1:transition"];
  assert.ok(trace);
  assert.equal(trace.current?.value, "是");
});

test("a multi-select field (block roles) is joined with 顿号, not shown as a raw array", () => {
  const originAnn = origin([1]);
  const withBlock = (a: ReportAnnotation, block: ReportBlock): ReportAnnotation => ({
    ...a, pages: a.pages.map((p) => (p.n === 1 ? { ...p, blocks: [block] } : p)),
  });
  const block = mkBlock("b1", { roles: ["核心结论", "核心观点"] });
  const finalPayload = withBlock(originAnn, block);
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "block:b1:roles", value: ["核心结论", "核心观点"], sourceVersionNumber: 1, actorName: "王策划" }),
  ];
  const model = deriveReportFinalTraceModel(originAnn, intakes, finalPayload);
  const trace = model.fields["block:b1:roles"];
  assert.ok(trace);
  assert.equal(trace.current?.value, "核心结论、核心观点");
});

test("plain vocabulary fields (already stored as their Chinese label) pass through unchanged", () => {
  const originAnn = origin([]);
  const mod: ReportModule = mkModule("m1", { rel: "收敛" });
  const finalPayload: ReportAnnotation = { ...originAnn, modules: [mod] };
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "module:m1:rel", value: "收敛", sourceVersionNumber: 1, actorName: "王策划" }),
  ];
  const model = deriveReportFinalTraceModel(originAnn, intakes, finalPayload);
  assert.equal(model.fields["module:m1:rel"]?.current?.value, "收敛");
});

/* ============================ SPAN 页范围文本 ============================ */

test("a SPAN row formats its page numbers as 'p03–p07 · 5 页'", () => {
  const originAnn = origin([1, 2, 3, 4, 5, 6, 7]);
  const unit: ReportUnit = mkUnit("u1", "m1");
  const finalPayload: ReportAnnotation = {
    ...originAnn,
    units: [unit],
    pages: originAnn.pages.map((p) => (p.n >= 3 && p.n <= 7 ? { ...p, mid: "m1", uid: "u1" } : p)),
  };
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "SPAN", targetKey: "unit:u1", value: { pageNumbers: [3, 4, 5, 6, 7] }, sourceVersionNumber: 1, actorName: "王策划" }),
  ];
  const model = deriveReportFinalTraceModel(originAnn, intakes, finalPayload);
  const trace = model.spans["unit:u1"];
  assert.ok(trace);
  assert.equal(trace.current?.value, "p03–p07 · 5 页");
});

test("a single-page SPAN formats as 'p03 · 1 页', and an emptied SPAN formats as '空'", () => {
  const originAnn = origin([3]);
  const mod: ReportModule = mkModule("m1");
  const withPages = (pageNumbers: number[]): ReportAnnotation => ({
    ...originAnn,
    modules: [mod],
    pages: originAnn.pages.map((p) => (pageNumbers.includes(p.n) ? { ...p, mid: "m1", uid: null } : p)),
  });
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "SPAN", targetKey: "module:m1", value: { pageNumbers: [3] }, sourceVersionNumber: 1, actorName: "王策划" }),
    mkIntake({ kind: "SPAN", targetKey: "module:m1", value: { pageNumbers: [] }, sourceVersionNumber: 2, actorName: "李工" }),
  ];
  const model = deriveReportFinalTraceModel(originAnn, intakes, withPages([]));
  const trace = model.spans["module:m1"];
  assert.ok(trace);
  assert.equal(trace.current?.value, "空");
  assert.equal(trace.history[0]?.value, "p03 · 1 页");
});

/* ============================ pending 分流 ============================ */

test("an unapplied FIELD intake lands in that field's pending list, not history or current", () => {
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "background.city", value: "南昌", sourceVersionNumber: 1, actorName: "王策划", applied: true }),
    mkIntake({ kind: "FIELD", targetKey: "background.city", value: "重庆", sourceVersionNumber: 2, actorName: "李工", applied: false }),
  ];
  const finalPayload = { ...origin(), background: { ...origin().background, city: "南昌" } };
  const model = deriveReportFinalTraceModel(origin(), intakes, finalPayload);
  const trace = model.fields["background.city"];
  assert.ok(trace);
  assert.equal(trace.current?.value, "南昌");
  assert.equal(trace.pending.length, 1);
  assert.equal(trace.pending[0].value, "重庆");
  assert.equal(trace.pending[0].state, "PENDING");
  assert.equal(trace.pending[0].intakeId, "intake_2");
});

test("unapplied structural intakes (insert/remove module·unit·block/span) go to structurePending with spec 五、18's verb phrasing, not fields or spans", () => {
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "INSERT_MODULE", targetKey: "module:m2", targetLabel: "新模块", value: { item: mkModule("m2") }, applied: false, actorName: "李工" }),
    mkIntake({ kind: "REMOVE_UNIT", targetKey: "unit:u9", targetLabel: "讲述单元", value: {}, applied: false, actorName: "李工" }),
    mkIntake({ kind: "INSERT_BLOCK", targetKey: "block:b2", targetLabel: "组块", value: { item: mkBlock("b2"), pageNo: 3 }, applied: false, actorName: "李工" }),
    mkIntake({ kind: "REMOVE_BLOCK", targetKey: "block:b3", targetLabel: "组块", value: {}, applied: false, actorName: "李工" }),
    mkIntake({ kind: "SPAN", targetKey: "module:m1", targetLabel: "开场", value: { pageNumbers: [1, 2, 3] }, applied: false, actorName: "李工" }),
    // 已采纳的结构改动不进 structurePending。
    mkIntake({ kind: "INSERT_BLOCK", targetKey: "block:b1", targetLabel: "组块", value: { item: mkBlock("b1"), pageNo: 1 }, applied: true, actorName: "王策划" }),
  ];
  const finalPayload = { ...origin([1, 2, 3]), modules: [mkModule("m1", { name: "开场" })] };
  const model = deriveReportFinalTraceModel(origin([1, 2, 3]), intakes, finalPayload);
  assert.deepEqual(model.structurePending.map((row) => row.value), [
    "新增模块",
    "删除单元「讲述单元」",
    "在第 3 页新增组块",
    "删除组块「组块」",
    "把 p01–p03 · 3 页 划进「开场」",
  ]);
  assert.ok(model.structurePending.every((row) => row.state === "PENDING"));
  assert.equal(Object.keys(model.fields).length, 0);
});

/* ============================ 容器已被删除：不再展示残留写法链 ============================ */

test("a field whose container no longer exists in the final payload (nor the origin) is dropped from the model", () => {
  const intakes: ReportFinalTraceIntake[] = [
    mkIntake({ kind: "FIELD", targetKey: "module:gone:role", value: "已经被删掉的模块", sourceVersionNumber: 1, actorName: "王策划" }),
  ];
  const model = deriveReportFinalTraceModel(origin(), intakes, origin());
  assert.equal(model.fields["module:gone:role"], undefined);
});
