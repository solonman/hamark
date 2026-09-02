/**
 * 报告拆解工作台外壳用到的纯函数：撤销/重做快照栈、脏标记、保存状态机、
 * 版本按钮该显示哪个动作、错误码 → 界面文案。不碰网络、不碰 DOM，
 * `ReportStudioClient` 只管把这些纯函数接到 `fetch` 和 React state 上。
 *
 * 之所以不直接从 `lib/report-version-chain.ts` 引入 `canonicalReportPayload`：
 * 那个模块顶部 `import { createHash, randomUUID } from "node:crypto"`，被客户端
 * 组件间接 import 会把 node 内置模块打进浏览器包。这里的脏检查也用不上服务端
 * 那套“哈希对比”的强度——本地永远是拿“刚加载/刚保存成功那一份”和“当前草稿”
 * 比较，两边都是我们自己代码产出的普通对象，`JSON.stringify` 足够。
 */

import {
  validateReportAnnotation,
  type ReportAnnotation,
} from "@/lib/report-structure";
import type { ReportVersionErrorCode } from "@/lib/report-version-chain";

/* ============================ 撤销 / 重做 ============================ */

export type ReportHistoryState = {
  past: ReportAnnotation[];
  present: ReportAnnotation;
  future: ReportAnnotation[];
};

/** 记多少步撤销，够用又不至于无限增长（对齐二合一工作台 `V19_HISTORY_LIMIT`）。 */
export const REPORT_HISTORY_LIMIT = 50;

export function initReportHistory(initial: ReportAnnotation): ReportHistoryState {
  return { past: [], present: initial, future: [] };
}

/** 从服务端重新读到一份标注（初次加载、切换版本、409 后重新载入）：换底，不留撤销痕迹。 */
export function resetReportHistory(initial: ReportAnnotation): ReportHistoryState {
  return initReportHistory(initial);
}

/** 记一次编辑：旧的当前值入撤销栈，重做栈清空（新分支覆盖旧的重做路径）。 */
export function pushReportHistory(
  history: ReportHistoryState,
  next: ReportAnnotation,
): ReportHistoryState {
  const past = [...history.past, history.present].slice(-REPORT_HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function undoReportHistory(history: ReportHistoryState): ReportHistoryState {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoReportHistory(history: ReportHistoryState): ReportHistoryState {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

/* ============================ 脏标记 ============================ */

/**
 * 当前草稿是否与“已保存/已加载”的那一份不同。两边都只会是我们自己的代码
 * （不可变更新、初次解析服务端 JSON）产出的对象，key 顺序天然稳定，
 * 用不着服务端那套按 key 排序再比较的严格哈希。
 */
export function reportAnnotationsEqual(a: ReportAnnotation, b: ReportAnnotation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isReportDraftDirty(saved: ReportAnnotation, draft: ReportAnnotation): boolean {
  return !reportAnnotationsEqual(saved, draft);
}

/** 编辑后多久才自动保存一次；显式的「保存」按钮绕开这个等待，立刻发。 */
export const REPORT_AUTOSAVE_DEBOUNCE_MS = 1500;

/* ============================ 本地预校验 ============================ */

/**
 * 保存前先在本地跑一遍服务端会做的同一套结构校验（`validateReportAnnotation`），
 * 错误就地显示，不必先打一次网络请求才知道哪里不对。返回空数组表示可以保存。
 */
export function validateReportDraftLocally(
  draft: ReportAnnotation,
  pageNumbers: readonly number[],
): string[] {
  const result = validateReportAnnotation(draft, pageNumbers);
  return result.ok ? [] : result.errors;
}

/* ============================ 保存状态机 ============================ */

export type ReportSaveStatus =
  | { kind: "IDLE" }
  | { kind: "SAVING" }
  | { kind: "SAVED"; at: string }
  | { kind: "UNCHANGED"; at: string }
  | { kind: "INVALID"; errors: string[] }
  | { kind: "CONFLICT"; message: string }
  | { kind: "ERROR"; message: string };

/** PUT /annotation 失败时，路由返回的是 `{error, code, details}` 这个扁平信封（见 `reportVersionErrorResponse`）。 */
export type ReportSaveApiError = {
  code?: string;
  message?: string;
  errors?: string[];
  serverRevision?: number;
};

const KNOWN_CODES = new Set<ReportVersionErrorCode>([
  "REPORT_NOT_FOUND",
  "REPORT_NOT_READY",
  "VERSION_NOT_FOUND",
  "REVISION_CONFLICT",
  "VALIDATION_FAILED",
  "ALREADY_HAS_VERSION",
  "INVALID_INPUT",
]);

/**
 * 把保存请求的失败原因翻成界面能直接显示的中文，不出现 revision / payload /
 * READY 这类开发用语。未识别的错误码退回到服务端给的 message（同样是中文），
 * 再兜底一句通用提示。
 */
export function describeReportSaveFailure(error: ReportSaveApiError): ReportSaveStatus {
  const code = KNOWN_CODES.has(error.code as ReportVersionErrorCode)
    ? (error.code as ReportVersionErrorCode)
    : null;

  if (code === "REVISION_CONFLICT") {
    return { kind: "CONFLICT", message: "这一版在别处被改过，请重新载入后再保存。" };
  }
  if (code === "VALIDATION_FAILED") {
    return {
      kind: "INVALID",
      errors: error.errors && error.errors.length ? error.errors : ["内容不符合规则，未能保存。"],
    };
  }
  if (code === "REPORT_NOT_READY") {
    return { kind: "ERROR", message: "报告还没有生成页图，暂时不能标注。" };
  }
  if (code === "VERSION_NOT_FOUND" || code === "ALREADY_HAS_VERSION" || code === "REPORT_NOT_FOUND") {
    return { kind: "ERROR", message: "版本状态已变化，请刷新页面后重试。" };
  }
  return { kind: "ERROR", message: error.message?.trim() || "保存未完成，请稍后重试。" };
}

/** 离开页面前要不要拦一下：有没保存的改动，或者正在保存中都算。 */
export function shouldWarnBeforeUnload(status: ReportSaveStatus, dirty: boolean): boolean {
  return dirty || status.kind === "SAVING";
}

/* ============================ 版本切换按钮 ============================ */

export type ReportVersionAction =
  | { action: "NONE" }
  | { action: "CREATE_FROM_CURRENT" }
  | { action: "SWITCH_TO_MINE"; versionId: string };

/**
 * 版本条右上角那颗按钮该做什么：正在看自己的版本就不出现；已经有自己的版本、
 * 但正看着别人的，按钮是「切到我的版本」；还没有自己的版本，按钮是
 * 「基于此版创建我的版本」（基于当前正在看的那版）。
 */
export function resolveReportVersionAction(chain: {
  mineId: string | null;
  current: { id: string | null; isMine: boolean };
}): ReportVersionAction {
  if (chain.current.isMine) return { action: "NONE" };
  if (chain.mineId) return { action: "SWITCH_TO_MINE", versionId: chain.mineId };
  return { action: "CREATE_FROM_CURRENT" };
}
