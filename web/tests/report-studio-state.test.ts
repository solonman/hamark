import assert from "node:assert/strict";
import test from "node:test";
import {
  describeReportFinalIntakeToast,
  describeReportSaveFailure,
  initReportHistory,
  isReportDraftDirty,
  pushReportHistory,
  redoReportHistory,
  reportAnnotationsEqual,
  resetReportHistory,
  resolveReportEditReadOnly,
  resolveReportVersionAction,
  shouldWarnBeforeUnload,
  undoReportHistory,
  validateReportDraftLocally,
  REPORT_HISTORY_LIMIT,
  type ReportHistoryState,
} from "../lib/report-studio-state.ts";
import { emptyReportAnnotation, type ReportAnnotation } from "../lib/report-structure.ts";

/* ============================ Fixtures ============================ */

function withCity(base: ReportAnnotation, city: string): ReportAnnotation {
  return { ...base, background: { ...base.background, city } };
}

/* ============================ 撤销 / 重做 ============================ */

test("pushReportHistory 把旧的当前值压进撤销栈，并清空重做栈", () => {
  const a = emptyReportAnnotation([1, 2, 3]);
  const b = withCity(a, "南昌");
  let history = initReportHistory(a);
  history = pushReportHistory(history, b);
  assert.equal(history.present, b);
  assert.deepEqual(history.past, [a]);
  assert.deepEqual(history.future, []);
});

test("undoReportHistory 回到上一步，把当前值挪进重做栈", () => {
  const a = emptyReportAnnotation([1]);
  const b = withCity(a, "南昌");
  let history = initReportHistory(a);
  history = pushReportHistory(history, b);
  history = undoReportHistory(history);
  assert.equal(history.present, a);
  assert.deepEqual(history.past, []);
  assert.deepEqual(history.future, [b]);
});

test("undoReportHistory 撤销栈为空时原样返回", () => {
  const a = emptyReportAnnotation([1]);
  const history = initReportHistory(a);
  const next = undoReportHistory(history);
  assert.equal(next, history);
});

test("redoReportHistory 撤销之后能重新走回去；一次新编辑会清空重做栈", () => {
  const a = emptyReportAnnotation([1]);
  const b = withCity(a, "南昌");
  const c = withCity(a, "上海");
  let history = initReportHistory(a);
  history = pushReportHistory(history, b);
  history = undoReportHistory(history);
  history = redoReportHistory(history);
  assert.equal(history.present, b);
  assert.deepEqual(history.future, []);

  // 撤销之后另起一次新编辑：旧的重做分支（c 之前设想的另一条路）应当被丢弃。
  history = undoReportHistory(history);
  history = pushReportHistory(history, c);
  assert.equal(history.present, c);
  assert.deepEqual(history.future, []);
  assert.deepEqual(history.past, [a]);
});

test("redoReportHistory 重做栈为空时原样返回", () => {
  const a = emptyReportAnnotation([1]);
  const history = initReportHistory(a);
  const next = redoReportHistory(history);
  assert.equal(next, history);
});

test("pushReportHistory 有上限，超过之后最老的一步被丢掉", () => {
  const base = emptyReportAnnotation([1]);
  let history = initReportHistory(base);
  for (let i = 0; i < REPORT_HISTORY_LIMIT + 10; i += 1) {
    history = pushReportHistory(history, withCity(base, `城市${i}`));
  }
  assert.equal(history.past.length, REPORT_HISTORY_LIMIT);
  // 最早的几步已经被挤出去了，past[0] 不再是最初的空白稿。
  assert.notEqual(history.past[0], base);
});

test("resetReportHistory 换底且不留撤销痕迹（切换版本、409 重新载入用它）", () => {
  const a = emptyReportAnnotation([1]);
  const b = withCity(a, "南昌");
  let history: ReportHistoryState = initReportHistory(a);
  history = pushReportHistory(history, b);
  const fromServer = withCity(a, "杭州");
  history = resetReportHistory(fromServer);
  assert.equal(history.present, fromServer);
  assert.deepEqual(history.past, []);
  assert.deepEqual(history.future, []);
});

/* ============================ 脏标记 ============================ */

test("reportAnnotationsEqual 对同结构不同引用返回 true", () => {
  const a = emptyReportAnnotation([1, 2]);
  const b = emptyReportAnnotation([1, 2]);
  assert.notEqual(a, b);
  assert.ok(reportAnnotationsEqual(a, b));
});

test("isReportDraftDirty 在草稿改动后返回 true，回到原值后返回 false", () => {
  const saved = emptyReportAnnotation([1]);
  const edited = withCity(saved, "南昌");
  assert.ok(isReportDraftDirty(saved, edited));
  const revertedBack = withCity(edited, "");
  assert.ok(!isReportDraftDirty(saved, revertedBack));
});

/* ============================ 本地预校验 ============================ */

test("validateReportDraftLocally 对合法稿返回空数组", () => {
  const draft = emptyReportAnnotation([1, 2, 3]);
  assert.deepEqual(validateReportDraftLocally(draft, [1, 2, 3]), []);
});

test("validateReportDraftLocally 缺页时返回中文错误，不吞掉问题", () => {
  const draft = emptyReportAnnotation([1, 2]);
  const errors = validateReportDraftLocally(draft, [1, 2, 3]);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((message) => message.includes("p3")));
});

/* ============================ 保存状态机 ============================ */

test("describeReportSaveFailure 把 REVISION_CONFLICT 翻成可读提示，不出现 revision 字样", () => {
  const status = describeReportSaveFailure({ code: "REVISION_CONFLICT", serverRevision: 4 });
  assert.equal(status.kind, "CONFLICT");
  if (status.kind === "CONFLICT") {
    assert.ok(!status.message.includes("revision"));
    assert.ok(status.message.includes("重新载入"));
  }
});

test("describeReportSaveFailure 透传 VALIDATION_FAILED 的详细错误列表", () => {
  const status = describeReportSaveFailure({ code: "VALIDATION_FAILED", errors: ["页 p5 重复"] });
  assert.equal(status.kind, "INVALID");
  if (status.kind === "INVALID") assert.deepEqual(status.errors, ["页 p5 重复"]);
});

test("describeReportSaveFailure 对 VALIDATION_FAILED 但没给 errors 时给一句兜底文案", () => {
  const status = describeReportSaveFailure({ code: "VALIDATION_FAILED" });
  assert.equal(status.kind, "INVALID");
  if (status.kind === "INVALID") assert.equal(status.errors.length, 1);
});

test("describeReportSaveFailure 对未识别的错误码退回服务端给的中文 message", () => {
  const status = describeReportSaveFailure({ code: "SOME_UNKNOWN_CODE", message: "网络出问题了" });
  assert.equal(status.kind, "ERROR");
  if (status.kind === "ERROR") assert.equal(status.message, "网络出问题了");
});

test("describeReportSaveFailure 什么都没给时有兜底文案，不是空字符串", () => {
  const status = describeReportSaveFailure({});
  assert.equal(status.kind, "ERROR");
  if (status.kind === "ERROR") assert.ok(status.message.length > 0);
});

test("shouldWarnBeforeUnload 有未保存改动或正在保存时都拦", () => {
  assert.ok(shouldWarnBeforeUnload({ kind: "IDLE" }, true));
  assert.ok(shouldWarnBeforeUnload({ kind: "SAVING" }, false));
  assert.ok(!shouldWarnBeforeUnload({ kind: "SAVED", at: "12:00" }, false));
});

/* ============================ 版本按钮 ============================ */

test("resolveReportVersionAction 正在看自己的版本时不出现按钮", () => {
  const action = resolveReportVersionAction({ mineId: "v1", current: { id: "v1", isMine: true } });
  assert.deepEqual(action, { action: "NONE" });
});

test("resolveReportVersionAction 已有自己的版本、正看别人的：按钮是切到我的版本", () => {
  const action = resolveReportVersionAction({ mineId: "v1", current: { id: "v2", isMine: false } });
  assert.deepEqual(action, { action: "SWITCH_TO_MINE", versionId: "v1" });
});

test("resolveReportVersionAction 还没有自己的版本：按钮是基于当前版本创建", () => {
  const action = resolveReportVersionAction({ mineId: null, current: { id: "v2", isMine: false } });
  assert.deepEqual(action, { action: "CREATE_FROM_CURRENT" });
});

/* ============================ 集成版：编辑权限 / toast ============================ */

test("resolveReportEditReadOnly 集成版视角：只有老孙不是只读，其他人都是", () => {
  assert.equal(resolveReportEditReadOnly({ current: { isFinal: true, isMine: false } }, "老孙"), false);
  assert.equal(resolveReportEditReadOnly({ current: { isFinal: true, isMine: false } }, "李工"), true);
  // isMine 在集成版视角不参与判断——集成版天然不属于任何人。
  assert.equal(resolveReportEditReadOnly({ current: { isFinal: true, isMine: true } }, "李工"), true);
});

test("resolveReportEditReadOnly 普通版本视角：照旧看是不是自己的版本，跟身份是不是老孙无关", () => {
  assert.equal(resolveReportEditReadOnly({ current: { isFinal: false, isMine: true } }, "李工"), false);
  assert.equal(resolveReportEditReadOnly({ current: { isFinal: false, isMine: false } }, "老孙"), true);
});

test("describeReportFinalIntakeToast 汇入成功：不点名具体条目（用户决定②）", () => {
  assert.equal(describeReportFinalIntakeToast({ merged: true, pending: 0 }), "这次的修改已同步进入集成版");
});

test("describeReportFinalIntakeToast 集成版已定稿：修改记为未纳入", () => {
  assert.equal(describeReportFinalIntakeToast({ merged: false, pending: 1 }), "集成版已定稿，这次的修改记为未纳入");
});
