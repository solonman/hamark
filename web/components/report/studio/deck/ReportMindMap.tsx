"use client";

import { useEffect, type CSSProperties } from "react";
import { useState } from "react";
import {
  modulePages, moduleColor, moduleNumbers, pageRangeLabel, sortedChildUnits, sortedModules,
  sortedRootUnits, unitColorFor, unitPages,
  type ReportAnnotation, type ReportModule, type ReportUnit,
} from "@/lib/report-structure";
import styles from "./ReportDeck.module.css";
import type { ReportMindMapButtonProps } from "./deck-types";

/**
 * 「查看脑图」：按钮 + 模块 → 单元 → 子单元树状 modal，节点带页码范围与关键
 * 结论（模块取策略作用，单元取候选结论），点节点跳到对应收纳框。移植自 demo
 * 的 `mindMap()`（约 799 行）。`ReportMindMapButtonProps` 只给了
 * `{annotation, pages}`，没有回调，所以"跳到收纳框"直接用 DOM 查询
 * `[data-box="..."]` 滚过去——不需要跟 ReportDeck 的内部状态打通。
 */

function kColorStyle(hex: string): CSSProperties {
  return { "--rd-k": hex } as CSSProperties;
}

function goToBox(key: string, close: () => void) {
  close();
  // 让 modal 先卸载，再滚——否则目标框还被 modal 盖着，量出来的位置不对。
  requestAnimationFrame(() => {
    document.querySelector(`[data-box="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function UnitNode({ a, u, nums, close }: { a: ReportAnnotation; u: ReportUnit; nums: Record<string, string>; close: () => void }) {
  const kids = sortedChildUnits(a, u.id);
  const key = (u.concl || u.role || "").trim();
  return (
    <div className={styles.kid}>
      <div className={styles.node} style={kColorStyle(unitColorFor(a, u.id))} onClick={() => goToBox(`unit:${u.id}`, close)}>
        <b>单元 {nums[u.id]}</b>
        <span className={styles.nodeNm}>{u.name || "未起名"}</span>
        <span className={styles.nodeRg}>{pageRangeLabel(unitPages(a, u.id))}</span>
        {key
          ? <p className={styles.nodeKey}>{key}</p>
          : <p className={`${styles.nodeKey} ${styles.nodeKeyEmpty}`}>候选结论未填</p>}
      </div>
      {kids.length ? (
        <div className={styles.kids}>
          {kids.map((k) => <UnitNode key={k.id} a={a} u={k} nums={nums} close={close} />)}
        </div>
      ) : null}
    </div>
  );
}

function ModuleNode({ a, m, nums, close }: { a: ReportAnnotation; m: ReportModule; nums: Record<string, string>; close: () => void }) {
  const roots = sortedRootUnits(a, m.id);
  const index = sortedModules(a).findIndex((x) => x.id === m.id);
  const key = (m.role || "").trim();
  return (
    <div className={styles.kid}>
      <div className={styles.node} style={kColorStyle(moduleColor(index))} onClick={() => goToBox(`mod:${m.id}`, close)}>
        <b>模块 {nums[m.id]}</b>
        <span className={styles.nodeNm}>{m.name || "未起名"}</span>
        <span className={styles.nodeRg}>{pageRangeLabel(modulePages(a, m.id))}</span>
        {key
          ? <p className={styles.nodeKey}>{key}</p>
          : <p className={`${styles.nodeKey} ${styles.nodeKeyEmpty}`}>策略作用未填</p>}
      </div>
      {roots.length ? (
        <div className={styles.kids}>
          {roots.map((u) => <UnitNode key={u.id} a={a} u={u} nums={nums} close={close} />)}
        </div>
      ) : null}
    </div>
  );
}

export function ReportMindMapButton({ annotation, pages }: ReportMindMapButtonProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 空结构时脑图没有东西可画——跟 demo 一致，模块划出来之前不露这个按钮。
  if (!annotation.modules.length) return null;

  const nums = moduleNumbers(annotation);
  const narrative = annotation.strategy.narrative || "";

  return (
    <>
      <button
        type="button"
        className={styles.smBtn}
        title="模块 → 单元 → 子单元，连同各段的关键结论"
        onClick={() => setOpen(true)}
      >
        ◎ 查看脑图
      </button>
      {open ? (
        <div className={styles.ov} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div className={`${styles.ovbox} ${styles.mindbox}`}>
            <div className={styles.ovhead}>
              <b>脑图</b>
              <span className={styles.ovheadT}>
                模块 → 单元 → 子单元，附各段关键结论 · 点节点跳到对应收纳框
              </span>
              <button type="button" className={styles.smBtn} onClick={close}>关闭 esc</button>
            </div>
            <div className={styles.mindstage}>
              <div className={styles.tree}>
                <div className={`${styles.node} ${styles.nodeRoot}`}>
                  <b>报告</b>
                  <span className={styles.nodeNm}>{pages.length} 页</span>
                  {narrative ? (
                    <p className={styles.nodeKey}>{narrative.slice(0, 60)}{narrative.length > 60 ? "…" : ""}</p>
                  ) : null}
                </div>
                <div className={styles.kids}>
                  {sortedModules(annotation).map((m) => (
                    <ModuleNode key={m.id} a={annotation} m={m} nums={nums} close={close} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
