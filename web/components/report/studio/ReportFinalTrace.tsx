"use client";

import { useState } from "react";
import { formatShortDateTime } from "@/lib/date-format";
import type { ReportFinalFieldTrace, ReportFinalTraceRow } from "@/lib/report-final-trace";
import type { ReportFinalFieldExtras } from "./ReportFieldItem";
import v04styles from "@/components/v04/V04Surface.module.css";

/**
 * 集成版·溯源视图的渲染层（规格五、18/19），跟视频侧 `V19StudioDocument.tsx`
 * 里 `V19FinalTraceRows`/`finalTraceRenderProps` 是同一件事的报告侧版本——
 * 差别是这里不用再从原始 `intake.value` 现算显示文案：`lib/report-final-trace.ts`
 * 的 `deriveReportFinalTraceModel` 已经把每一行的 `versionLabel`/`actorName`/
 * `at`/`value`（固定选项翻好标签、SPAN 格式化成页范围文本）都算好了，这里
 * 只管拼版式、管"旧写法摘要行"的展开/收起这一点点自己的 UI 状态。
 *
 * 复用 `V04Surface.module.css` 里视频侧已经打磨好的 `.finalTrace*` 一整套
 * 样式（`.surface` 作用域下就能直接吃到，见 ReportStudioClient 顶层的
 * `v04styles.surface`），不新起一份 CSS。
 *
 * 简化说明（跟视频侧的差异，写进最终报告）：视频侧「当前采用」用的行文案
 * 和 hover 提示文案是两套不同的拼法（前者"v2 谁 时间"，后者"v2·谁 时间"，
 * 且 FINAL_DIRECT 在两处的措辞也不同）。报告侧的 `ReportFinalTraceRow` 只有
 * 一份已经拼好的 `versionLabel`/`actorName`/`at`，这里统一用一种拼法
 * （"{versionLabel} {actorName} {时间}"）覆盖当前采用行、旧写法摘要行、
 * 未纳入行与默认视图 hover 提示四处，不为 hover 单独再拼一份"用点连接"的
 * 变体——效果等价（都能看出是哪一版谁在什么时候写的），只是字面上更统一。
 */

function formatRowLabel(row: ReportFinalTraceRow): string {
  return [row.versionLabel, row.actorName, row.at ? formatShortDateTime(row.at) : ""].filter(Boolean).join(" ");
}

/** 一条「旧写法」摘要行：整行可点，默认收起只显示预览，点开换成完整正文。展开态是这一行自己的本地 state。 */
function ReportFinalTraceSummaryRow({ row }: { row: ReportFinalTraceRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className={v04styles.finalTraceSummaryRow}
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className={v04styles.finalTraceSummaryLabel}>{formatRowLabel(row)}</span>
      <span className={v04styles.finalTraceSummaryPreview}>{row.value.trim() === "" ? "—" : row.value}</span>
    </button>
  );
}

export type ReportFinalTraceFootnoteProps = {
  trace: ReportFinalFieldTrace;
  canAdopt: boolean;
  onAdopt: (intakeId: string) => void;
};

/** 溯源视图挂在正文下方的来源链：当前采用永远单独一行，旧写法折叠成摘要，未纳入完整展开带「采纳这一版」。 */
export function ReportFinalTraceFootnote({ trace, canAdopt, onAdopt }: ReportFinalTraceFootnoteProps) {
  if (!trace.current && trace.history.length === 0 && trace.pending.length === 0) return null;
  return (
    <div className={v04styles.finalTrace}>
      {trace.current ? (
        <div className={v04styles.finalTraceCurrent}>{`当前采用 · ${formatRowLabel(trace.current)}`}</div>
      ) : null}
      {trace.history.map((row, index) => (
        <ReportFinalTraceSummaryRow key={row.intakeId ?? `history-${index}`} row={row} />
      ))}
      {trace.pending.map((row, index) => (
        <div key={row.intakeId ?? `pending-${index}`} className={`${v04styles.finalTraceRow} ${v04styles.finalTraceRowPending}`}>
          <span className={v04styles.finalTraceVersion}>{row.versionLabel}</span>
          <span className={v04styles.finalTraceWho}>{row.actorName}</span>
          {row.at ? <span className={v04styles.finalTraceTime}>{formatShortDateTime(row.at)}</span> : null}
          <span className={v04styles.finalTraceTag}>未纳入</span>
          <div className={v04styles.finalTraceValue}>{row.value.trim() === "" ? "—" : row.value}</div>
          {canAdopt && row.intakeId ? (
            <button type="button" className={v04styles.finalTraceAdopt} onClick={() => onAdopt(row.intakeId as string)}>
              采纳这一版
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * `ReportStudioClient` 每个字段的一站式入口：给定这个字段的溯源数据（可能
 * 还没有——没人碰过这个字段），拼出 `ReportFieldItem`/`V19EditableValue`
 * 要的 `{locked, sourceHint, after}`。`locked` 永远按传入值原样返回（哪怕
 * 这个字段完全没有 trace 数据）——它只取决于"是不是非老孙在看集成版"，
 * 不依赖 finalTrace 有没有加载到，同视频侧 `finalFieldExtras` 的注释。
 */
export function buildReportFinalFieldExtras(input: {
  trace: ReportFinalFieldTrace | undefined;
  locked: boolean;
  traceMode: boolean;
  canAdopt: boolean;
  onAdopt: (intakeId: string) => void;
}): ReportFinalFieldExtras {
  const { trace, locked, traceMode, canAdopt, onAdopt } = input;
  if (!trace || (!trace.current && trace.history.length === 0 && trace.pending.length === 0)) return { locked };
  if (traceMode) {
    return { locked, after: <ReportFinalTraceFootnote trace={trace} canAdopt={canAdopt} onAdopt={onAdopt} /> };
  }
  return { locked, sourceHint: trace.current ? formatRowLabel(trace.current) : undefined };
}
