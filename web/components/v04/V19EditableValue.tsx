"use client";

import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { formatV19Timecode, parseV19TimecodeInput } from "@/lib/v19-timeline";
import styles from "./V04Surface.module.css";

/**
 * V1.9 二合一工作台的原位编辑控件：阅读态渲染为普通正文（点击/Enter/Space 进入编辑），
 * 编辑态渲染为输入框，失焦或回车即提交（无保存按钮）。行为对齐
 * `docs/demos/2026-08-24-二合一工作台交互demo.html` 中的 `edSpan` / `beginEdit`。
 */

export type V19EditableKind = "text" | "textarea" | "timecode" | "select";

export type V19EditableOption = {
  value: string;
  label: string;
};

export type V19EditableProps = {
  value: string;
  kind?: V19EditableKind;
  options?: ReadonlyArray<V19EditableOption>;
  placeholder?: string;
  block?: boolean;
  monospace?: boolean;
  warning?: string;
  readOnly?: boolean;
  /** Vetoes opening the editor. Returning false leaves the value untouched. */
  onBeforeEdit?: () => boolean;
  ariaLabel: string;
  id?: string;
  baseValue?: string | null;
  onCommit: (next: string) => void;
  onInvalid?: (message: string) => void;
};

export const V19_TIMECODE_INVALID_MESSAGE = "时间可直接输入数字，如 0102 = 01:02（秒数不超过 59）";

export type V19CommitResolution =
  | { status: "commit"; value: string }
  | { status: "invalid"; message: string }
  | { status: "unchanged" };

/**
 * Pure decision logic shared by every field kind: given what the input holds
 * on commit (`raw`) and the value the component was last told to show
 * (`previous`), decide whether to commit, reject as invalid, or skip because
 * nothing actually changed. Kept dependency-free (no React, no DOM) so it is
 * directly unit-testable — see `tests/v19-editable-value.test.ts`.
 */
export function resolveV19CommitValue(kind: V19EditableKind, raw: string, previous: string): V19CommitResolution {
  const previousTrimmed = previous.trim();

  if (kind === "timecode") {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return previousTrimmed === "" ? { status: "unchanged" } : { status: "commit", value: "" };
    }
    const parsed = parseV19TimecodeInput(trimmed);
    if (parsed == null) return { status: "invalid", message: V19_TIMECODE_INVALID_MESSAGE };
    const formatted = formatV19Timecode(parsed);
    return formatted === previousTrimmed ? { status: "unchanged" } : { status: "commit", value: formatted };
  }

  const trimmed = raw.trim();
  return trimmed === previousTrimmed ? { status: "unchanged" } : { status: "commit", value: trimmed };
}

function joinClassNames(...classNames: Array<string | false | null | undefined>): string {
  return classNames.filter((name): name is string => Boolean(name)).join(" ");
}

type EditableInputNode = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Grows a textarea to fit what it holds, up to its CSS max-height. A fixed
 * height means a third line already needs scrolling, which hides the writing
 * from the person doing it; past the cap the box stops growing and scrolls, so
 * a long answer cannot push the rest of the page out of reach.
 */
function autosizeTextarea(node: HTMLTextAreaElement | null): void {
  if (!node) return;
  node.style.height = "auto";
  const cap = Number.parseFloat(getComputedStyle(node).maxHeight);
  const next = Number.isFinite(cap) ? Math.min(node.scrollHeight, cap) : node.scrollHeight;
  node.style.height = `${next}px`;
}


export default function V19EditableValue({
  value,
  kind = "text",
  options,
  placeholder = "—",
  block = false,
  monospace = false,
  warning,
  readOnly = false,
  onBeforeEdit,
  ariaLabel,
  id,
  baseValue,
  onCommit,
  onInvalid,
}: V19EditableProps): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<EditableInputNode | null>(null);

  // Autofocus whenever the editor opens, and pre-select existing text for the
  // free-typing kinds so retyping replaces the value (matches the demo's
  // `input.select && type!=="select"`).
  useEffect(() => {
    if (!isEditing) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    if (node instanceof HTMLTextAreaElement) autosizeTextarea(node);
    if (kind !== "select" && "select" in node && typeof node.select === "function") {
      node.select();
    }
  }, [isEditing, kind]);

  const isEmpty = value.trim() === "";
  const hasWarning = Boolean(warning);
  const isMonospace = monospace || kind === "timecode";

  const displayLabel = (raw: string): string => {
    if (kind !== "select" || !options) return raw;
    const matched = options.find((option) => option.value === raw);
    return matched ? matched.label : raw;
  };

  const startEditing = () => {
    if (readOnly || isEditing) return;
    // Asked before the editor opens, not after typing: a surface that may need
    // to redirect this edit elsewhere has to say so while the field is still
    // empty of the person's words, rather than discard them afterwards.
    if (onBeforeEdit && !onBeforeEdit()) return;
    setDraft(value);
    setIsEditing(true);
  };

  const finish = (commitIt: boolean, raw: string) => {
    if (!isEditing) return;
    setIsEditing(false);
    if (!commitIt) return;
    const resolution = resolveV19CommitValue(kind, raw, value);
    if (resolution.status === "commit") {
      onCommit(resolution.value);
    } else if (resolution.status === "invalid") {
      onInvalid?.(resolution.message);
    }
  };

  const diffMarkup: ReactNode = (() => {
    if (baseValue === undefined || baseValue === null) return null;
    const baseTrimmed = baseValue.trim();
    const baseDisplay = baseTrimmed === "" ? "—" : displayLabel(baseValue);
    return (
      <>
        <span className={styles.diffTag} data-v19-diff="changed">已修改</span>
        <span className={styles.diffBase}>基版：{baseDisplay}</span>
      </>
    );
  })();

  if (!isEditing) {
    const ReadingTag = block ? "div" : "span";

    if (readOnly) {
      return (
        <>
          <ReadingTag id={id} style={block ? { whiteSpace: "pre-wrap" } : undefined}>
            {isEmpty ? placeholder : displayLabel(value)}
          </ReadingTag>
          {diffMarkup}
        </>
      );
    }

    const className = joinClassNames(
      styles.editable,
      block && styles.editableBlock,
      isEmpty && styles.editableEmpty,
      hasWarning && styles.editableWarn,
      isMonospace && styles.editableTimecode,
    );

    return (
      <>
        <ReadingTag
          id={id}
          className={className}
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          title={hasWarning ? warning : "点击编辑"}
          onClick={startEditing}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              startEditing();
            }
          }}
        >
          {isEmpty ? placeholder : displayLabel(value)}
        </ReadingTag>
        {diffMarkup}
      </>
    );
  }

  if (kind === "textarea") {
    return (
      <>
        <textarea
          id={id}
          ref={(node) => { inputRef.current = node; }}
          className={joinClassNames(styles.editableInput, styles.editableTextarea)}
          aria-label={ariaLabel}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); autosizeTextarea(event.currentTarget); }}
          onBlur={(event) => finish(true, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              finish(false, draft);
            }
            // Enter deliberately falls through: it inserts a newline, commit happens on blur only.
          }}
        />
        {diffMarkup}
      </>
    );
  }

  if (kind === "select") {
    return (
      <>
        <select
          id={id}
          ref={(node) => { inputRef.current = node; }}
          className={styles.editableInput}
          aria-label={ariaLabel}
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            finish(true, next);
          }}
          onBlur={(event) => finish(true, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              finish(false, draft);
            }
          }}
        >
          {(options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {diffMarkup}
      </>
    );
  }

  return (
    <>
      <input
        id={id}
        ref={(node) => { inputRef.current = node; }}
        type="text"
        inputMode={kind === "timecode" ? "numeric" : undefined}
        placeholder={kind === "timecode" ? "如 0102" : undefined}
        className={joinClassNames(styles.editableInput, isMonospace && styles.editableTimecode)}
        aria-label={ariaLabel}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => finish(true, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false, draft);
          } else if (event.key === "Enter") {
            event.preventDefault();
            finish(true, event.currentTarget.value);
          }
        }}
      />
      {diffMarkup}
    </>
  );
}

/**
 * Machine-maintained value (bridge/shot numbers) that must look distinct from
 * editable content and can never be clicked into an editor. Sibling of
 * `V19EditableValue` — mirrors the demo's `.sys` (`<h4 class="sys" ...>`).
 */
export function V19SystemValue({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
  return (
    <span className={styles.systemField} title={title}>
      {children}
    </span>
  );
}
