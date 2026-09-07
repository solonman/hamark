"use client";

import { useId, useState, type ReactNode } from "react";
import type { V04ChoiceValue } from "@/lib/v04-contract";
import type { V04VocabularyOption } from "@/lib/v04-vocabulary";
import styles from "./V04Surface.module.css";

/**
 * 一个 `V04ChoiceValue` 在界面上是三行：固定选项行、自定义文本行、以及
 * 只在「待形成新机制」下露出的进阶机制层。绝大多数地方这三行紧挨着，就是
 * 下面那个 `V04ChoiceField`；但 V1.9 工作台第一模块把它们拆成了「创意机制」
 * 与「创意手法」两张卡——两个机制字段的选项行归机制卡，自定义行归手法卡
 * ——所以每一行都要能单独拿出来摆。底层字段没变，只是界面重新分组。
 */
export function V04ChoiceOptionsRow({
  label, value, options, multiple = false, max = 2, readOnly = false, triggerId, onComment, onChange,
  locked = false, sourceHint, after,
}: {
  label: string;
  value: V04ChoiceValue;
  options: readonly V04VocabularyOption[];
  multiple?: boolean;
  max?: number;
  readOnly?: boolean;
  /**
   * 目录跳转／缺项定位的锚点。挂在触发器按钮本身，而不是外面包一层
   * div：`locateV04Target` 对可聚焦元素直接 focus + 滚动，包一层反而要
   * 它再去里面找一次；而卡片里同时有两个字段，外层 section 的 id 只能给
   * 一个用。
   */
  triggerId?: string;
  onComment?: () => void;
  onChange: (value: V04ChoiceValue) => void;
  locked?: boolean;
  sourceHint?: string;
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
    <>
      <label className={styles.choiceLabel}><span>{label}</span>{onComment ? <button type="button" onClick={onComment}>批注</button> : null}</label>
      <button
        type="button"
        id={triggerId}
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
      {after}
    </>
  );
}

/**
 * 自定义文本行。拆分理由见 `V04ChoiceOptionsRow`。`asField` 是给工作台
 * 「创意手法」卡用的：那里这一行就是条目本身（主导手法／辅助手法），
 * 得按条目名的字号字重排，而不是选项行下面那句灰色补充说明。
 */
export function V04ChoiceCustomRow({
  label, value, readOnly = false, asField = false, placeholder = "可只填自定义，也可与固定值并存", onChange,
}: {
  label: string;
  value: V04ChoiceValue;
  readOnly?: boolean;
  asField?: boolean;
  placeholder?: string;
  onChange: (value: V04ChoiceValue) => void;
}) {
  return (
    <label className={asField ? `${styles.customInput} ${styles.customInputAsField}` : styles.customInput}>
      <span>{label}</span>
      <input value={value.customText} readOnly={readOnly} onChange={(event) => onChange({ ...value, customText: event.target.value })} placeholder={placeholder} />
    </label>
  );
}

/** 进阶机制层：只在选了「待形成新机制」时出现，条件必填。拆分理由见 `V04ChoiceOptionsRow`。 */
export function V04ChoiceAdvancedRow({
  value, readOnly = false, targetId, onChange,
}: {
  value: V04ChoiceValue;
  readOnly?: boolean;
  targetId?: string;
  onChange: (value: V04ChoiceValue) => void;
}) {
  return (
    <label className={styles.advancedInput} id={targetId}>进阶机制层 · 条件必填<input data-v04-primary-focus value={value.advancedText ?? ""} readOnly={readOnly} onChange={(event) => onChange({ ...value, advancedText: event.target.value })} /></label>
  );
}

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
  return (
    <section className={styles.choiceField} data-choice-field id={targetId}>
      <V04ChoiceOptionsRow
        label={label} value={value} options={options} multiple={multiple} max={max} readOnly={readOnly}
        onComment={onComment} onChange={onChange} locked={locked} sourceHint={sourceHint}
      />
      <V04ChoiceCustomRow label={customLabel} value={value} readOnly={readOnly} onChange={onChange} />
      {showAdvanced && <V04ChoiceAdvancedRow value={value} readOnly={readOnly} targetId={advancedTargetId} onChange={onChange} />}
      {after}
    </section>
  );
}
