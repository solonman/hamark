"use client";

import { useId, useState, type ReactNode } from "react";
import type { V04ChoiceValue } from "@/lib/v04-contract";
import type { V04VocabularyOption } from "@/lib/v04-vocabulary";
import styles from "./V04Surface.module.css";

export default function V04ChoiceField({
  label, value, options, multiple = false, max = 2, customLabel, showAdvanced = false, readOnly = false, targetId, advancedTargetId, onComment, onChange,
  locked = false, sourceHint, after,
}: {
  label: string;
  value: V04ChoiceValue;
  options: readonly V04VocabularyOption[];
  multiple?: boolean;
  max?: number;
  customLabel: string;
  showAdvanced?: boolean;
  readOnly?: boolean;
  targetId?: string;
  advancedTargetId?: string;
  onComment?: () => void;
  onChange: (value: V04ChoiceValue) => void;
  /**
   * Final-version viewer who isn't 老孙 (spec 五、16 for text fields — this
   * mirrors `V19EditableValue`'s `locked`): the trigger still looks
   * clickable rather than plain disabled text, but hovering it turns amber
   * instead of the usual accent, matching the locked treatment everywhere
   * else. Actually vetoing the edit happens the same way it already did
   * before this prop existed — `onChange` routes through `applyEdit`, which
   * already blocks and toasts on a locked final version — this prop is
   * purely the visual signal.
   */
  locked?: boolean;
  /** Spec 五、19: appended to the trigger's hover title as `· 来自 {sourceHint}`, same format as `V19EditableValue`. */
  sourceHint?: string;
  /** 溯源视图 (spec 五、18): the current-source line + collapsible 旧写法 summaries + 未纳入 list, rendered below the field — same slot `V19EditableValue` exposes. */
  after?: ReactNode;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const selectedLabels = options.filter((item) => value.selectedOptionIds.includes(item.optionId)).map((item) => item.labelZhCn);
  const toggle = (optionId: string) => {
    let selected = value.selectedOptionIds;
    if (multiple) {
      selected = selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : selected.length >= max ? selected : [...selected, optionId];
    } else {
      selected = [optionId];
      setOpen(false);
    }
    onChange({ ...value, selectedOptionIds: selected });
  };
  const triggerTitle = (() => {
    const base = locked ? "集成版只有老孙可以编辑" : "点击选择";
    return sourceHint ? `${base} · 来自 ${sourceHint}` : base;
  })();
  return (
    <section className={styles.choiceField} data-choice-field id={targetId}>
      <label className={styles.choiceLabel}><span>{label}</span>{onComment ? <button type="button" onClick={onComment}>批注</button> : null}</label>
      <button
        type="button"
        className={locked ? `${styles.choiceTrigger} ${styles.choiceTriggerLocked}` : styles.choiceTrigger}
        data-v04-primary-focus
        aria-expanded={open}
        aria-controls={panelId}
        title={triggerTitle}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedLabels.length ? selectedLabels.join("、") : `展开固定选项 · 共 ${options.length} 项`}</span><b>{open ? "收起" : "选择"}</b>
      </button>
      {open && (
        <div id={panelId} className={styles.choicePanel}>
          {options.map((option) => (
            <button type="button" key={option.optionId} className={value.selectedOptionIds.includes(option.optionId) ? styles.isSelected : ""} onClick={() => toggle(option.optionId)} disabled={readOnly}>
              {option.labelZhCn}
            </button>
          ))}
        </div>
      )}
      <label className={styles.customInput}>{customLabel}<input value={value.customText} readOnly={readOnly} onChange={(event) => onChange({ ...value, customText: event.target.value })} placeholder="可只填自定义，也可与固定值并存" /></label>
      {showAdvanced && <label className={styles.advancedInput} id={advancedTargetId}>进阶机制层 · 条件必填<input data-v04-primary-focus value={value.advancedText ?? ""} readOnly={readOnly} onChange={(event) => onChange({ ...value, advancedText: event.target.value })} /></label>}
      {after}
    </section>
  );
}
