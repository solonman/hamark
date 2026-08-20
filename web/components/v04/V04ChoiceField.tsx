"use client";

import { useId, useState } from "react";
import type { V04ChoiceValue } from "@/lib/v04-contract";
import type { V04VocabularyOption } from "@/lib/v04-vocabulary";
import styles from "./V04Surface.module.css";

export default function V04ChoiceField({
  label, value, options, multiple = false, max = 2, customLabel, showAdvanced = false, disabled = false, onChange,
}: {
  label: string;
  value: V04ChoiceValue;
  options: readonly V04VocabularyOption[];
  multiple?: boolean;
  max?: number;
  customLabel: string;
  showAdvanced?: boolean;
  disabled?: boolean;
  onChange: (value: V04ChoiceValue) => void;
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
  return (
    <section className={styles.choiceField} data-choice-field>
      <label>{label}</label>
      <button type="button" className={styles.choiceTrigger} aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={() => setOpen((current) => !current)}>
        <span>{selectedLabels.length ? selectedLabels.join("、") : `展开固定选项 · 共 ${options.length} 项`}</span><b>{open ? "收起" : "选择"}</b>
      </button>
      {open && (
        <div id={panelId} className={styles.choicePanel}>
          {options.map((option) => (
            <button type="button" key={option.optionId} className={value.selectedOptionIds.includes(option.optionId) ? styles.isSelected : ""} onClick={() => toggle(option.optionId)} disabled={disabled}>
              {option.labelZhCn}
            </button>
          ))}
        </div>
      )}
      <label className={styles.customInput}>{customLabel}<input value={value.customText} disabled={disabled} onChange={(event) => onChange({ ...value, customText: event.target.value })} placeholder="可只填自定义，也可与固定值并存" /></label>
      {showAdvanced && <label className={styles.advancedInput}>进阶机制层 · 条件必填<input value={value.advancedText ?? ""} disabled={disabled} onChange={(event) => onChange({ ...value, advancedText: event.target.value })} /></label>}
    </section>
  );
}
