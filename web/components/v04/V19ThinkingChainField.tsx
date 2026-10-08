"use client";

import { useState, type JSX, type ReactNode } from "react";
import { normalizeThinkingChainText } from "@/lib/thinking-chain";
import V19ThinkingChainEditor from "./V19ThinkingChainEditor";
import V19ThinkingChainFlow from "./V19ThinkingChainFlow";
import surface from "./V04Surface.module.css";
import styles from "./V19ThinkingChain.module.css";

/**
 * 工作台里的「创意思维链」条目（docs/24）：阅读态是横向流程图，点击进入大纲编辑，
 * 点外面保存。可编辑与否的规则与 `V19EditableValue` 完全一致：
 * - `readOnly` 且不 `locked`：只读，点了没反应；
 * - `locked`（集成版、看的人不是老孙）：看起来能点，点了由 `onBeforeEdit` 拦下并提示；
 * - `onBeforeEdit` 返回 false 时不打开编辑器。
 * 提交给外层的是规范化后的文字，与原来相同就不提交——整次编辑在工作台撤销里只占一步。
 */
export default function V19ThinkingChainField({
  value,
  ariaLabel,
  caseTitle,
  readOnly = false,
  locked = false,
  sourceHint,
  after,
  baseValue,
  onBeforeEdit,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  caseTitle?: string;
  readOnly?: boolean;
  locked?: boolean;
  sourceHint?: string;
  after?: ReactNode;
  baseValue?: string | null;
  onBeforeEdit?: () => boolean;
  onCommit: (next: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);

  const startEditing = () => {
    if (editing) return;
    if (readOnly && !locked) return;
    if (onBeforeEdit && !onBeforeEdit()) return;
    if (readOnly) return; // locked：永远不真正打开编辑器
    setEditing(true);
  };

  const diffMarkup = baseValue == null ? null : (
    <>
      <span className={surface.diffTag} data-v19-diff="changed">已修改</span>
      <span className={`${surface.diffBase} ${styles.fieldDiffBase}`}>基版：{baseValue.trim() || "—"}</span>
    </>
  );

  if (editing) {
    return (
      <>
        <div className={styles.field}>
          <V19ThinkingChainEditor
            initialText={value}
            caseTitle={caseTitle}
            onDone={(text) => {
              setEditing(false);
              if (text == null) return;
              const next = normalizeThinkingChainText(text);
              if (next !== normalizeThinkingChainText(value)) onCommit(next);
            }}
          />
        </div>
        {diffMarkup}
        {after}
      </>
    );
  }

  if (readOnly && !locked) {
    return (
      <>
        <div className={styles.field}><V19ThinkingChainFlow text={value} caseTitle={caseTitle} /></div>
        {diffMarkup}
        {after}
      </>
    );
  }

  const baseTitle = locked ? "集成版只有老孙可以编辑" : "点击编辑";
  return (
    <>
      <div
        className={`${styles.field} ${styles.fieldEditable} ${locked ? styles.fieldLocked : ""}`.trim()}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        title={sourceHint ? `${baseTitle} · 来自 ${sourceHint}` : baseTitle}
        onClick={startEditing}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            startEditing();
          }
        }}
      >
        {!locked && <span className={styles.editHint} aria-hidden="true">点击编辑大纲</span>}
        <V19ThinkingChainFlow text={value} caseTitle={caseTitle} />
      </div>
      {diffMarkup}
      {after}
    </>
  );
}
