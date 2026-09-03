"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ReportStudio.module.css";

/**
 * 报告拆解工作台统一的下拉控件，样式与交互对齐
 * `docs/demos/2026-09-01-报告拆解工作台demo-V2.html` 里所有下拉共用的一套规格
 * （同高、同圆角、同箭头，见 demo CSS 顶部 `select,.cb .combo{...}`）。
 *
 * 两个导出：
 * - `ReportSelect`　固定候选，原生 `<select>`（报告模型、组织关系这类词表字段）。
 * - `ReportCombobox`　固定候选 ＋ 自由填写、只有一个值（模块名称、内容类型这类字段）。
 *   原生 `<input list>` 会拿已填内容去过滤候选，字段一有值下拉就空了，所以自己做一个
 *   菜单（对应 demo 的 `combo()` / `#cbmenu`）。
 *
 * 这两个组件同时是「第三部分」拆解 deck 的公共契约的一部分：deck 里凡是用到同一类
 * 下拉的地方（模块名称、单元名称等），都直接 `import { ReportSelect, ReportCombobox }
 * from "@/components/report/studio/ReportSelect"`，不要另起一套样式。
 */

export type ReportSelectProps = {
  value: string;
  onChange: (next: string) => void;
  options: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /**
   * 集成版专属（规格五、16）：非老孙看集成版时为 true——原生 `disabled` 已经
   * 物理上挡住了交互，这个只是叠一层视觉／提示，让人看得出"为什么锁着"，跟
   * "只是因为在看别人的普通版本"区分开（同 `V19EditableValue` 的 `locked`、
   * `V04ChoiceField` 的 `.choiceTriggerLocked` 一套语言）。可选，不传时行为
   * 与之前完全一样。
   */
  locked?: boolean;
  title?: string;
};

export function ReportSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  disabled = false,
  ariaLabel,
  locked = false,
  title,
}: ReportSelectProps) {
  return (
    <select
      className={[styles.dd, locked ? styles.ddLocked : ""].filter(Boolean).join(" ")}
      value={value}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
    >
      {!value ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export type ReportComboboxProps = {
  value: string;
  onChange: (next: string) => void;
  options: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
};

export function ReportCombobox({
  value,
  onChange,
  options,
  placeholder = "选一个，或直接写",
  disabled = false,
  ariaLabel,
}: ReportComboboxProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 外部值变了（比如切换了版本、被别处的操作改写）就跟着换，未提交的手感草稿不保留。
  // 渲染期间比较并纠正，而不是用 effect——这是 React 文档推荐的"根据 prop 调整
  // state"写法：条件命中时才 setState，同一轮渲染内立刻生效，不会多闪一帧。
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const commit = (next: string) => {
    const trimmed = next;
    if (trimmed !== value) onChange(trimmed);
  };

  return (
    <span ref={wrapRef} className={styles.cb} data-open={open || undefined}>
      <input
        className={styles.combo}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          commit(event.currentTarget.value);
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className={styles.cbtn}
        disabled={disabled}
        aria-label="全部候选"
        aria-expanded={open}
        title="全部候选"
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <div className={styles.cbmenu} role="listbox">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              className={option === value ? styles.cbmenuOn : undefined}
              onClick={() => {
                setDraft(option);
                commit(option);
                setOpen(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
