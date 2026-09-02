"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import V19ReviewComment from "@/components/v04/V19ReviewComment";
import styles from "./ReportDeck.module.css";
import type { DeckReviewComment } from "./deck-types";

/**
 * ReportSectionPopover 与 ReportPageModal 共用的一批小部件：条目外壳、
 * 点击即改的文本值（demo 的 `val()`/`startEdit()`）、只读派生值
 * （demo 的 `sys()`）、单选／多选 chip、以及套壳过的评论入口
 * （复用 `components/v04/V19ReviewComment.tsx` 的视觉与交互）。
 * 不在契约文件清单里，是这两个组件都要用到、不值得各抄一遍的胶水层，
 * 放在自己名下的 deck/ 目录内。
 */

/* ============================ 条目外壳 ============================ */

export function DeckItem({
  label, children, wide, commentSlot,
}: { label: string; children: ReactNode; wide?: boolean; commentSlot?: ReactNode }) {
  return (
    <div className={wide ? `${styles.item} ${styles.wide}` : styles.item}>
      <small>{label}{commentSlot}</small>
      {children}
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
  comment?: DeckReviewComment;
  canReview: boolean;
  disabled?: boolean;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

/** 套壳 `V19ReviewComment`：把 deck 的 `{body,authorName,updatedAt}` 拼回它要的 `CaseReviewComment`。 */
export function DeckCommentEntry({ targetKey, targetLabel, comment, canReview, disabled, onSave }: DeckCommentEntryProps) {
  return (
    <V19ReviewComment
      targetKey={targetKey}
      targetLabel={targetLabel}
      comment={comment ? { targetKey, targetLabel, body: comment.body, authorName: comment.authorName, updatedAt: comment.updatedAt } : undefined}
      canReview={canReview}
      disabled={disabled}
      onSave={onSave}
    />
  );
}
