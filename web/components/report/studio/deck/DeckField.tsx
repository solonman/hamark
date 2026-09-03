"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import V19ReviewComment from "@/components/v04/V19ReviewComment";
import type { CaseReviewComment } from "@/lib/case-review";
import { formatShortDateTime } from "@/lib/date-format";
import type { ReportFinalFieldTrace, ReportFinalTraceRow } from "@/lib/report-final-trace";
import {
  reportFinalCurrentLabel,
  reportFinalHoverTitle,
  reportFinalTraceFirstLine,
  reportFinalTraceFullValue,
  reportFinalTraceRowLabel,
} from "./deck-view";
import styles from "./ReportDeck.module.css";

/**
 * ReportSectionPopover 与 ReportPageModal 共用的一批小部件：条目外壳、
 * 点击即改的文本值（demo 的 `val()`/`startEdit()`）、只读派生值
 * （demo 的 `sys()`）、单选／多选 chip、以及套壳过的评论入口
 * （复用 `components/v04/V19ReviewComment.tsx` 的视觉与交互）。
 * 不在契约文件清单里，是这两个组件都要用到、不值得各抄一遍的胶水层，
 * 放在自己名下的 deck/ 目录内。
 */

/* ============================ 条目外壳 ============================ */

/**
 * `trace`/`traceMode`/`canAdopt`/`onAdopt` 都不传（或 `trace` 为 `null`）时
 * 这个组件跟改动前逐字节一样——`title` 是 `undefined`，`DeckFinalTrace` 整段
 * 不渲染，见 docs/21 一之 D「finalTrace 为 null 或 traceMode 为 false 时，
 * 界面与现在完全一致」这条验收要求。`title` 直接放在最外层 `.item` div 上
 * 而不是包一层新 `<span>` 摸每个字段控件——浏览器对着一个没有自己 `title`
 * 的元素 hover 时，会顺着祖先链找最近一个有 `title` 的元素来出 tooltip，
 * `ReportSelect`/`ReportCombobox`（外壳交付，见 ReportSelect.tsx）自己没有
 * `title`，天然吃得到这里的，不用改那个文件、也不用给每种字段控件单独包壳。
 */
export function DeckItem({
  label, children, wide, commentSlot, trace, traceMode, canAdopt, onAdopt,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  commentSlot?: ReactNode;
  /** 这个字段的溯源链；`null`／不传＝没有数据，脚注不渲染。 */
  trace?: ReportFinalFieldTrace | null;
  /** 溯源视图开关——`false` 时哪怕 `trace` 有数据也不画脚注（默认视图只留 hover）。 */
  traceMode?: boolean;
  /** 老孙为 true——决定未纳入行是否出现「采纳这一版」。 */
  canAdopt?: boolean;
  onAdopt?: (intakeIds: string[]) => Promise<void>;
}) {
  return (
    <div className={wide ? `${styles.item} ${styles.wide}` : styles.item} title={reportFinalHoverTitle(trace)}>
      <small>{label}{commentSlot}</small>
      {children}
      {traceMode && trace ? (
        <DeckFinalTrace trace={trace} currentPrefix="当前采用 · " canAdopt={!!canAdopt} onAdopt={onAdopt} />
      ) : null}
    </div>
  );
}

/* ============================ 集成版·溯源脚注 ============================ */

/**
 * 一条「旧写法」摘要行：整行可点，默认收起只显示第一行预览（超出一行由 CSS
 * 省略号截断），点开换成整段正文。展开状态是这一行自己的本地 state——每个
 * 摘要行独立记，收起来不影响别的行。照抄视频侧 `V19FinalTraceSummaryRow`
 * （`V19StudioDocument.tsx`）的交互，只是喂给它的行形状换成
 * `ReportFinalTraceRow`。
 */
function DeckFinalTraceSummaryRow({ row }: { row: ReportFinalTraceRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className={styles.finalTraceSummaryRow}
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className={styles.finalTraceSummaryLabel}>{reportFinalTraceRowLabel(row)}</span>
      <span className={styles.finalTraceSummaryPreview}>
        {expanded ? reportFinalTraceFullValue(row.value) : reportFinalTraceFirstLine(row.value)}
      </span>
    </button>
  );
}

/**
 * 溯源视图的脚注整段：「当前采用」永远单独一行排最前（`currentPrefix` 由
 * 调用方定，字段是"当前采用 · "，收纳框的划分来源是"这段划分来自 "——
 * 见 `ReportDeck.tsx` 的 `boxSpanTrace`），旧写法折叠成摘要行跟在后面，
 * 未纳入照旧完整展开、带「采纳这一版」（仅 `canAdopt`）。`ReportFinalSpanTrace`
 * 跟 `ReportFinalFieldTrace` 是同一个形状（类型别名），字段脚注与收纳框的
 * 划分来源共用这一个组件，不用各写一份。
 */
export function DeckFinalTrace({
  trace, currentPrefix, canAdopt, onAdopt,
}: {
  trace: ReportFinalFieldTrace;
  currentPrefix: string;
  canAdopt: boolean;
  onAdopt?: (intakeIds: string[]) => Promise<void>;
}) {
  const currentLabel = reportFinalCurrentLabel(trace, currentPrefix);
  if (!currentLabel && !trace.history.length && !trace.pending.length) return null;
  return (
    <div className={styles.finalTrace}>
      {currentLabel ? <div className={styles.finalTraceCurrent}>{currentLabel}</div> : null}
      {trace.history.map((row, index) => (
        <DeckFinalTraceSummaryRow key={row.intakeId ?? `h${index}`} row={row} />
      ))}
      {trace.pending.map((row, index) => (
        <div key={row.intakeId ?? `p${index}`} className={`${styles.finalTraceRow} ${styles.finalTraceRowPending}`}>
          <span className={styles.finalTraceVersion}>{row.versionLabel}</span>
          <span className={styles.finalTraceWho}>{row.actorName}</span>
          {row.at ? <span className={styles.finalTraceTime}>{formatShortDateTime(row.at)}</span> : null}
          <span className={styles.finalTraceTag}>未纳入</span>
          <div className={styles.finalTraceValue}>{reportFinalTraceFullValue(row.value)}</div>
          {canAdopt && row.intakeId ? (
            <button
              type="button"
              className={styles.finalTraceAdopt}
              onClick={() => { const id = row.intakeId; if (id) void onAdopt?.([id]); }}
            >
              采纳这一版
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ============================ 点击即改的文本值 ============================ */

export type DeckEditableValueProps = {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
};

/** 平时是一个可点击的只读 span，点一下变成输入框；失焦或 Enter 提交，Esc 取消。 */
export function DeckEditableValue({ value, onCommit, placeholder = "待填写", multiline, disabled }: DeckEditableValueProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // demo 的 startEdit() 也用这个 done 标记：Esc 取消会把 editing 设回 false，
  // 但被移出 DOM 的输入框失焦时浏览器还会再补一个 blur 事件，若不挡住，
  // blur 的 commit(true) 会在 commit(false) 之后又把刚取消的草稿提交一遍。
  const committedRef = useRef(false);

  // 进入编辑态时把草稿设成当前值，和"开始编辑"这一个用户动作绑在一起提交，
  // 不用另开一个 effect 去追 editing 的变化（那样等于在 effect 里同步 setState）。
  const startEditing = () => { committedRef.current = false; setDraft(value); setEditing(true); };

  useEffect(() => {
    if (!editing) return;
    const el = multiline ? textareaRef.current : inputRef.current;
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not all input types support it */ }
  }, [editing, multiline]);

  const spanClassName = [styles.val, !value ? styles.valBlank : "", multiline ? styles.valBlock : ""]
    .filter(Boolean).join(" ");

  if (disabled) {
    return <span className={spanClassName}>{value || placeholder}</span>;
  }

  if (!editing) {
    return (
      <span
        tabIndex={0}
        role="button"
        className={spanClassName}
        onClick={startEditing}
        onKeyDown={(event) => { if (event.key === "Enter") startEditing(); }}
      >
        {value || placeholder}
      </span>
    );
  }

  const commit = (save: boolean) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    if (save && draft !== value) onCommit(draft);
  };

  if (multiline) {
    return (
      <textarea
        ref={textareaRef}
        className={styles.editing}
        value={draft}
        rows={Math.max(3, Math.min(10, Math.ceil(draft.length / 40) + 2))}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); commit(false); }
          else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(true); }
        }}
      />
    );
  }
  return (
    <input
      ref={inputRef}
      className={styles.editing}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => commit(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); commit(false); }
        else if (event.key === "Enter") { event.preventDefault(); commit(true); }
      }}
    />
  );
}

/* ============================ 只读派生值 ============================ */

export function DeckStaticValue({ text, title }: { text: string; title?: string }) {
  return <span className={styles.sysval} title={title ?? "自动生成，不用填"}>{text}</span>;
}

/* ============================ chip 单选／多选 ============================ */

export function DeckChipToggle({
  active, label, onToggle, disabled,
}: { active: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <div className={styles.chips}>
      <button type="button" className={active ? styles.chipOn : undefined} disabled={disabled} onClick={onToggle}>
        {label}
      </button>
    </div>
  );
}

export function DeckChipsMulti({
  values, options, onToggle, disabled,
}: { values: readonly string[]; options: readonly string[]; onToggle: (value: string) => void; disabled?: boolean }) {
  return (
    <div className={styles.chips}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          className={values.includes(option) ? styles.chipOn : undefined}
          onClick={() => onToggle(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/* ============================ 评论入口 ============================ */

export type DeckCommentEntryProps = {
  targetKey: string;
  targetLabel: string;
  /** 这个条目在所有版本上的评论，按写入时间升序——同 `ReportPartOne`/`V19StudioDocument` 的口径。 */
  comments: readonly CaseReviewComment[];
  /** 当前正在看的版本 id；决定 `comments` 里哪一条是"本版"。 */
  currentVersionId: string;
  canReview: boolean;
  disabled?: boolean;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

/** 套壳 `V19ReviewComment`：deck 这一层不再做"只留当前版本那条"的单条适配，
 * 跨版本汇总、标"本版"直接透传给它，跟 `ReportPartOne`/`V19StudioDocument`
 * 是同一套评论口径（`ReportDeckProps.review`，见 `deck-types.ts` 顶部注释）。 */
export function DeckCommentEntry({ targetKey, targetLabel, comments, currentVersionId, canReview, disabled, onSave }: DeckCommentEntryProps) {
  return (
    <V19ReviewComment
      targetKey={targetKey}
      targetLabel={targetLabel}
      comments={comments}
      currentVersionId={currentVersionId}
      canReview={canReview}
      disabled={disabled}
      onSave={onSave}
    />
  );
}
