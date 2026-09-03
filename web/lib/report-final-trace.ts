// 报告集成版·溯源视图的纯函数：从 `originPayload`（空白起点）+ `intakes`（按
// seq 升序的写法记录）+ `finalPayload`（集成版当前内容）推出每处内容的写法链
// ——哪一条是当前采用、哪些是被盖掉的旧写法、哪些还没被采纳。移植自视频侧
// `lib/v19-final-trace.ts` 的算法（相邻同值合并、空白不算一次写法），但输出
// 形状是任务里定下的更简单的 `ReportFinalTraceRow`/`*FieldTrace`（不是照抄
// 视频侧那套 `hasTrace`/`currentSourceLabel`/`overridden` 的形状）。
//
// 报告没有视频侧「v1 就是一份有内容的原稿」那种历史包袱——`originPayload`
// 永远是 `emptyReportAnnotation` 吐出来的全空白模板（`report-final-version.ts`
// `loadReportFinalVersion`/`loadReportFinalTrace` 两条路径都是这样构造的），
// 所以「原稿行」在实践中永远是空白、永远不会真的显示——这就是用户决定①
// 「不显示空白原稿行，某处第一次被写入的版本就是第一行」在这里的样子：不用
// 特殊补丁去「隐藏」它，只要把「空白值不产生一行」这条规则套用到原稿值上，
// 自然就不会有原稿行，链条的第一行自然是第一次真正写入的那条记录。
//
// 只依赖 `ReportAnnotation`/`ReportDeckKey` 的形状与 `report-final-version.ts`
// 导出的 `ReportFinalTraceIntake` 形状，不引入任何服务端专属模块（这两个
// 依赖都是纯类型/纯函数，可以放心进浏览器包，同 `report-structure.ts` 本身
// 已经建立的约定）。

import { openPagesOf, type ReportAnnotation } from "./report-structure";
import type { ReportFinalTraceIntake } from "./report-final-version";

export type ReportFinalTraceRow = {
  versionLabel: string;
  actorName: string;
  at: string;
  value: string;
  state: "CURRENT" | "OVERRIDDEN" | "PENDING";
  intakeId?: string;
};

export type ReportFinalFieldTrace = {
  current: ReportFinalTraceRow | null;
  history: ReportFinalTraceRow[];
  pending: ReportFinalTraceRow[];
};

/** value 是页范围文本，如 "p03–p07 · 5 页"，不是别的字段那种自由文本。 */
export type ReportFinalSpanTrace = ReportFinalFieldTrace;

export type ReportFinalTraceModel = {
  /** 以评论用的 targetKey 索引：`background.*`／`strategy.*`／`module:<id>:<field>`／`unit:<id>:<field>`／`page:<n>:<field>`／`block:<id>:<field>`。 */
  fields: Record<string, ReportFinalFieldTrace>;
  /** 以 `module:<id>` / `unit:<id>` 索引（不带字段后缀）。 */
  spans: Record<string, ReportFinalSpanTrace>;
  /** 还没被采纳的结构改动（新增/删除模块·单元·组块），供横幅列出、只读一条一条摘要。 */
  structurePending: ReportFinalTraceRow[];
};

/* ============================ 取值 / 判空 / 显示 ============================ */

/** 同视频侧 `isEmptyV19TraceValue`，多覆盖数组（`roles`）与布尔（`transition`）——空数组、false 也不算"写过"。 */
function isBlankTraceValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  return value == null;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 固定选项字段翻标签：布尔（过渡页）→ 是/否，多选（组块作用）→ 顿号连接；其余字段本来存的就是词表里的中文，原样显示。 */
function formatFieldDisplayValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).join("、");
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return String(value);
}

/** "p03–p07 · 5 页" / "p03 · 1 页" / "空"——同 `pageRangeLabel` 的补零规则，多加页数。 */
function formatSpanDisplayValue(pageNumbers: readonly number[]): string {
  if (!pageNumbers.length) return "空";
  const sorted = [...pageNumbers].slice().sort((a, b) => a - b);
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const range = first === last ? `p${pad(first)}` : `p${pad(first)}–p${pad(last)}`;
  return `${range} · ${sorted.length} 页`;
}

/** 规格五、18：`source === "FINAL_DIRECT"` 显示"集成版·直接修改"，不是裸"集成版"。 */
function describeVersionLabel(intake: ReportFinalTraceIntake): string {
  if (intake.source === "FINAL_DIRECT") return "集成版·直接修改";
  return `v${intake.sourceVersionNumber ?? "?"}`;
}

/**
 * 结构类未纳入记录的一句话描述，动词表照抄规格五、18：
 * INSERT_MODULE→"新增模块"、INSERT_UNIT→"新增单元"、
 * INSERT_BLOCK→"在第 N 页新增组块"、REMOVE_MODULE→"删除模块「名称」"、
 * REMOVE_UNIT→"删除单元「名称」"、REMOVE_BLOCK→"删除第 N 页的组块"、
 * SPAN→"把 pXX–pYY 划进「容器名」"。位置/容器名按集成版当前已保存的
 * `finalPayload` 现查，找不到就退化到裸动词（同视频侧
 * `describeV19StructuralIntake` 的做法）——REMOVE_BLOCK 尤其如此：组块一旦
 * 删除，它原来在哪一页这件事在 `ReportFinalTraceIntake` 里没有留痕
 * （`diffReportAnnotation` 的 REMOVE_BLOCK 记录不带 `pageNo`），只能退化成
 * 不带页码的"删除组块「名称」"。
 */
function describeStructuralIntakeLabel(intake: ReportFinalTraceIntake, finalPayload: ReportAnnotation): string {
  if (intake.kind === "INSERT_MODULE") return "新增模块";
  if (intake.kind === "INSERT_UNIT") return "新增单元";
  if (intake.kind === "INSERT_BLOCK") {
    const pageNo = (intake.value as { pageNo?: number } | null)?.pageNo;
    return pageNo == null ? "新增组块" : `在第 ${pageNo} 页新增组块`;
  }
  if (intake.kind === "REMOVE_MODULE") return `删除模块「${intake.targetLabel}」`;
  if (intake.kind === "REMOVE_UNIT") return `删除单元「${intake.targetLabel}」`;
  if (intake.kind === "REMOVE_BLOCK") return `删除组块「${intake.targetLabel}」`;
  // SPAN
  const pageNumbers = (intake.value as { pageNumbers?: number[] } | null)?.pageNumbers ?? [];
  const range = formatSpanDisplayValue(pageNumbers);
  const containerId = intake.targetKey.split(":").slice(1).join(":");
  const containerName = intake.targetKey.startsWith("module:")
    ? finalPayload.modules.find((item) => item.id === containerId)?.name
    : finalPayload.units.find((item) => item.id === containerId)?.name;
  return `把 ${range} 划进「${containerName || intake.targetLabel}」`;
}

/** FIELD targetKey → 该处在 `payload` 里当前的原始值；容器（模块/单元/页/组块）不存在时 `undefined`。 */
function locateReportFinalFieldValue(payload: ReportAnnotation, targetKey: string): unknown {
  if (targetKey.startsWith("background.")) {
    const key = targetKey.slice("background.".length) as keyof ReportAnnotation["background"];
    return payload.background[key];
  }
  if (targetKey.startsWith("strategy.")) {
    const key = targetKey.slice("strategy.".length) as keyof ReportAnnotation["strategy"];
    return payload.strategy[key];
  }
  const moduleMatch = /^module:([^:]+):(.+)$/.exec(targetKey);
  if (moduleMatch) {
    const found = payload.modules.find((item) => item.id === moduleMatch[1]);
    return found ? (found as unknown as Record<string, unknown>)[moduleMatch[2]] : undefined;
  }
  const unitMatch = /^unit:([^:]+):(.+)$/.exec(targetKey);
  if (unitMatch) {
    const found = payload.units.find((item) => item.id === unitMatch[1]);
    return found ? (found as unknown as Record<string, unknown>)[unitMatch[2]] : undefined;
  }
  const pageMatch = /^page:(\d+):(.+)$/.exec(targetKey);
  if (pageMatch) {
    const found = payload.pages.find((item) => item.n === Number(pageMatch[1]));
    return found ? (found as unknown as Record<string, unknown>)[pageMatch[2]] : undefined;
  }
  const blockMatch = /^block:([^:]+):(.+)$/.exec(targetKey);
  if (blockMatch) {
    for (const page of payload.pages) {
      const found = page.blocks.find((item) => item.id === blockMatch[1]);
      if (found) return (found as unknown as Record<string, unknown>)[blockMatch[2]];
    }
    return undefined;
  }
  return undefined;
}

/** SPAN targetKey（`module:<id>` / `unit:<id>`）→ 该容器在 `payload` 里当前占的页号；容器不存在时 `undefined`。 */
function locateReportFinalSpanValue(payload: ReportAnnotation, targetKey: string): number[] | undefined {
  const moduleMatch = /^module:(.+)$/.exec(targetKey);
  if (moduleMatch) {
    if (!payload.modules.some((item) => item.id === moduleMatch[1])) return undefined;
    return openPagesOf(payload, `mod:${moduleMatch[1]}`).map((page) => page.n);
  }
  const unitMatch = /^unit:(.+)$/.exec(targetKey);
  if (unitMatch) {
    if (!payload.units.some((item) => item.id === unitMatch[1])) return undefined;
    return openPagesOf(payload, `unit:${unitMatch[1]}`).map((page) => page.n);
  }
  return undefined;
}

/* ============================ 合并 / 分流 ============================ */

type RawRow = {
  versionLabel: string;
  actorName: string;
  at: string;
  intakeId?: string;
  rawValue: unknown;
  displayValue: string;
  applied: boolean;
};

function buildRows(
  originValue: unknown,
  intakesAscending: readonly ReportFinalTraceIntake[],
  formatValue: (value: unknown) => string,
): RawRow[] {
  const rows: RawRow[] = [];
  // 原稿行：报告的 originPayload 永远全空白（见文件头注释），isBlankTraceValue
  // 天然把它挡在外面——不需要为"用户决定①"单独写判断分支。
  if (originValue !== undefined && !isBlankTraceValue(originValue)) {
    rows.push({
      versionLabel: "原稿", actorName: "", at: "",
      rawValue: originValue, displayValue: formatValue(originValue), applied: true,
    });
  }
  for (const intake of intakesAscending) {
    rows.push({
      versionLabel: describeVersionLabel(intake),
      actorName: intake.actorName,
      at: intake.createdAt,
      intakeId: intake.id,
      rawValue: intake.value,
      displayValue: formatValue(intake.value),
      applied: intake.applied,
    });
  }
  // 简化规则：相邻写法值相同就合并成一行，只留先出现的那条。
  const deduped: RawRow[] = [];
  for (const row of rows) {
    const previous = deduped[deduped.length - 1];
    if (previous && jsonEqual(previous.rawValue, row.rawValue)) continue;
    deduped.push(row);
  }
  return deduped;
}

function toTraceRow(row: RawRow, state: ReportFinalTraceRow["state"]): ReportFinalTraceRow {
  const out: ReportFinalTraceRow = {
    versionLabel: row.versionLabel, actorName: row.actorName, at: row.at, value: row.displayValue, state,
  };
  if (row.intakeId) out.intakeId = row.intakeId;
  return out;
}

function reduceRows(rows: readonly RawRow[]): ReportFinalFieldTrace {
  const appliedRows = rows.filter((row) => row.applied);
  const pendingRows = rows.filter((row) => !row.applied);
  const current = appliedRows.length ? appliedRows[appliedRows.length - 1] : null;
  // 空白值不单独占一行历史——同视频侧"空白不算写法"；当前采用行不受这条限制
  // （字段被写回空白也是一种真实的"当前状态"，要如实显示）。
  const history = appliedRows.slice(0, -1).filter((row) => !isBlankTraceValue(row.rawValue));

  return {
    current: current ? toTraceRow(current, "CURRENT") : null,
    history: history.map((row) => toTraceRow(row, "OVERRIDDEN")),
    pending: pendingRows.map((row) => toTraceRow(row, "PENDING")),
  };
}

function buildFieldTrace(
  originValue: unknown,
  intakesAscending: readonly ReportFinalTraceIntake[],
): ReportFinalFieldTrace {
  return reduceRows(buildRows(originValue, intakesAscending, formatFieldDisplayValue));
}

function buildSpanTrace(
  originPageNumbers: number[] | undefined,
  intakesAscending: readonly ReportFinalTraceIntake[],
): ReportFinalSpanTrace {
  return reduceRows(
    buildRows(
      originPageNumbers,
      intakesAscending,
      (value) => formatSpanDisplayValue((value as { pageNumbers: number[] }).pageNumbers),
    ),
  );
}

/* ============================ 入口 ============================ */

/**
 * `finalTrace` API 响应（`originPayload` + `intakes`）与集成版当前内容
 * （`finalPayload`）→ 溯源视图要的模型。`finalPayload` 只用来把已经不在
 * 当前集成版里的容器（模块/单元/页/组块被删掉之后）的残留写法链过滤掉——
 * 不展示已经不存在的东西的历史，跟"删掉的收纳框在收纳框列表里也不再出现"
 * 是同一个道理。
 */
export function deriveReportFinalTraceModel(
  origin: ReportAnnotation,
  intakes: ReportFinalTraceIntake[],
  finalPayload: ReportAnnotation,
): ReportFinalTraceModel {
  const sorted = [...intakes].sort((a, b) => a.seq - b.seq);

  const fieldIntakesByKey = new Map<string, ReportFinalTraceIntake[]>();
  const spanIntakesByKey = new Map<string, ReportFinalTraceIntake[]>();
  const structurePending: ReportFinalTraceRow[] = [];

  for (const intake of sorted) {
    if (intake.kind === "FIELD") {
      const list = fieldIntakesByKey.get(intake.targetKey);
      if (list) list.push(intake); else fieldIntakesByKey.set(intake.targetKey, [intake]);
      continue;
    }
    if (intake.kind === "SPAN") {
      const list = spanIntakesByKey.get(intake.targetKey);
      if (list) list.push(intake); else spanIntakesByKey.set(intake.targetKey, [intake]);
      // SPAN 未纳入同时也进横幅的"结构改动未纳入"清单（规格五、18 第三条把
      // INSERT_*/REMOVE_*/SPAN 归成一组一起列），不影响它继续留在
      // `spans[key].pending` 里供收纳框标题栏自己的来源提示用——两处呈现，
      // 同一条底层记录。
      if (!intake.applied) {
        structurePending.push({
          versionLabel: describeVersionLabel(intake), actorName: intake.actorName, at: intake.createdAt,
          value: describeStructuralIntakeLabel(intake, finalPayload), state: "PENDING", intakeId: intake.id,
        });
      }
      continue;
    }
    // INSERT_MODULE / INSERT_UNIT / INSERT_BLOCK / REMOVE_MODULE / REMOVE_UNIT
    // / REMOVE_BLOCK：结构类改动没有"当前采用/旧写法"的概念（一处收纳框不会
    // 被"覆盖"，只会存在或不存在），未采纳的原样列出即可，交给横幅逐条展示。
    if (!intake.applied) {
      structurePending.push({
        versionLabel: describeVersionLabel(intake), actorName: intake.actorName, at: intake.createdAt,
        value: describeStructuralIntakeLabel(intake, finalPayload), state: "PENDING", intakeId: intake.id,
      });
    }
  }

  const fields: Record<string, ReportFinalFieldTrace> = {};
  for (const [targetKey, list] of fieldIntakesByKey) {
    // 容器已经从集成版当前内容里被删掉（REMOVE_* 已采纳）——不再展示它的写法链。
    const stillExists = locateReportFinalFieldValue(finalPayload, targetKey) !== undefined
      || locateReportFinalFieldValue(origin, targetKey) !== undefined;
    if (!stillExists) continue;
    fields[targetKey] = buildFieldTrace(locateReportFinalFieldValue(origin, targetKey), list);
  }

  const spans: Record<string, ReportFinalSpanTrace> = {};
  for (const [targetKey, list] of spanIntakesByKey) {
    const stillExists = locateReportFinalSpanValue(finalPayload, targetKey) !== undefined
      || locateReportFinalSpanValue(origin, targetKey) !== undefined;
    if (!stillExists) continue;
    spans[targetKey] = buildSpanTrace(locateReportFinalSpanValue(origin, targetKey), list);
  }

  return { fields, spans, structurePending };
}
