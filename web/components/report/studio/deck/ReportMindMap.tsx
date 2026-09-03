"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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
 * `[data-box="..."]` 滚过去；`onGoTo` 是可选的第三条通道——demo 第
 * 1230～1234 行的 `data-mindgo` 处理器跳转前顺手 `S.focus=key`，点亮左列，
 * 这个按钮自己不持有 `ReportDeck` 的 state，所以把 key 往外递，外壳负责接到
 * `ReportDeckProps.onFocusKeyChange` 上（见 `ReportDeck.tsx` 的 `focusKey`
 * 受控/不受控说明）。
 *
 * 按钮本身留在原位（外壳把它放进 PART 03 标题栏），但 `.ov` 遮罩必须
 * `createPortal` 到 `document.body`：真实工作台的标题栏是
 * `position:sticky` 且带 `backdrop-filter`（`ReportStudio.module.css` 的
 * `.modHeader`），`backdrop-filter` 会给它的后代重新建立一个
 * `position:fixed` 的包含块——不 portal 的话，`.ov` 就会被这层标题栏的矩形
 * 关住，脑图整个挤扁贴在标题栏那一条上，这正是协调方在真实工作台里看到、
 * 预览页（按钮外层没有 backdrop-filter 祖先）复现不出来的那个 bug。SSR 阶段
 * 没有 `document`，`mounted` 挂载后才第一次真正 portal；portal 出去之后这块
 * 内容脱离了 `ReportDeck` 自己的 `.root`（那里定义了全部 `--rd-*` 深色主题
 * 变量），所以额外套一层 `styles.root` 把变量作用域接回来，不然面板会因为
 * 变量取不到值而背景透明、边框隐形。
 */

function kColorStyle(hex: string): CSSProperties {
  return { "--rd-k": hex } as CSSProperties;
}

function goToBox(key: string, close: () => void, onGoTo?: (key: string) => void) {
  close();
  onGoTo?.(key);
  // 让 modal 先卸载，再滚——否则目标框还被 modal 盖着，量出来的位置不对。
  requestAnimationFrame(() => {
    document.querySelector(`[data-box="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

type NodeCommon = { nums: Record<string, string>; close: () => void; onGoTo?: (key: string) => void };

function UnitNode({ a, u, nums, close, onGoTo }: { a: ReportAnnotation; u: ReportUnit } & NodeCommon) {
  const kids = sortedChildUnits(a, u.id);
  const key = (u.concl || u.role || "").trim();
  return (
    <div className={styles.kid}>
      <div className={styles.node} style={kColorStyle(unitColorFor(a, u.id))} onClick={() => goToBox(`unit:${u.id}`, close, onGoTo)}>
        <b>单元 {nums[u.id]}</b>
        <span className={styles.nodeNm}>{u.name || "未起名"}</span>
        <span className={styles.nodeRg}>{pageRangeLabel(unitPages(a, u.id))}</span>
        {key
          ? <p className={styles.nodeKey}>{key}</p>
          : <p className={`${styles.nodeKey} ${styles.nodeKeyEmpty}`}>候选结论未填</p>}
      </div>
      {kids.length ? (
        <div className={styles.kids}>
          {kids.map((k) => <UnitNode key={k.id} a={a} u={k} nums={nums} close={close} onGoTo={onGoTo} />)}
        </div>
      ) : null}
    </div>
  );
}

function ModuleNode({ a, m, nums, close, onGoTo }: { a: ReportAnnotation; m: ReportModule } & NodeCommon) {
  const roots = sortedRootUnits(a, m.id);
  const index = sortedModules(a).findIndex((x) => x.id === m.id);
  const key = (m.role || "").trim();
  return (
    <div className={styles.kid}>
      <div className={styles.node} style={kColorStyle(moduleColor(index))} onClick={() => goToBox(`mod:${m.id}`, close, onGoTo)}>
        <b>模块 {nums[m.id]}</b>
        <span className={styles.nodeNm}>{m.name || "未起名"}</span>
        <span className={styles.nodeRg}>{pageRangeLabel(modulePages(a, m.id))}</span>
        {key
          ? <p className={styles.nodeKey}>{key}</p>
          : <p className={`${styles.nodeKey} ${styles.nodeKeyEmpty}`}>策略作用未填</p>}
      </div>
      {roots.length ? (
        <div className={styles.kids}>
          {roots.map((u) => <UnitNode key={u.id} a={a} u={u} nums={nums} close={close} onGoTo={onGoTo} />)}
        </div>
      ) : null}
    </div>
  );
}

export function ReportMindMapButton({ annotation, pages, reportTitle = "", onGoTo }: ReportMindMapButtonProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const close = () => setOpen(false);

  // portal 到 body 前先确认已经挂载——SSR/首帧渲染时 `document.body` 不该被
  // 摸（这里其实用不上 body，但同一套"先出不带 portal 的那一帧、挂载后再补
  // 真正内容"的写法在这个文件里保持一致，也避免 hydration 时 server/client
  // 输出不一致）。
  // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记"已经在浏览器挂载"，SSR 期间没有更早的时机能做这件事（同类见 ReportDeck.tsx 读 localStorage 列宽的那个 effect）
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 打开时锁住 body 的滚动——`.ov` 铺满视口但本身不是滚动容器，鼠标划到脑图
  // 树以外的地方（比如 header）时滚轮事件会一路冒泡到 body，把身后的工作台
  // 也带着滚起来。`ReportReaderButton`（`./ReportReader`）同一套做法，两个
  // 全屏浮层要一致。
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // 空结构时脑图没有东西可画——跟 demo 一致，模块划出来之前不露这个按钮。
  if (!annotation.modules.length) return null;

  const nums = moduleNumbers(annotation);
  const narrative = annotation.strategy.narrative || "";

  const modal = open ? (
    <div className={styles.ov} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className={`${styles.ovbox} ${styles.mindbox}`}>
        <div className={styles.ovhead}>
          <b>脑图</b>
          <span className={styles.ovheadT}>
            {reportTitle ? `${reportTitle} · ` : ""}模块 → 单元 → 子单元，附各段关键结论 · 点节点跳到对应收纳框
          </span>
          <button type="button" className={styles.smBtn} onClick={close}>关闭 esc</button>
        </div>
        <div className={styles.mindstage}>
          <div className={styles.tree}>
            <div className={`${styles.node} ${styles.nodeRoot}`}>
              <b>报告</b>
              <span className={styles.nodeNm}>{reportTitle}</span>
              <span className={styles.nodeRg}>{pages.length} 页</span>
              {narrative ? (
                <p className={styles.nodeKey}>{narrative.slice(0, 60)}{narrative.length > 60 ? "…" : ""}</p>
              ) : null}
            </div>
            <div className={styles.kids}>
              {sortedModules(annotation).map((m) => (
                <ModuleNode key={m.id} a={annotation} m={m} nums={nums} close={close} onGoTo={onGoTo} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {/* 触发按钮由外壳摆进 PART 03 标题栏，不在 `ReportDeck` 自己的 `.root`
          子树里——跟浮层同理，摸不到 `--rd-*` 那套变量（`.smBtn` 的边框/文字色
          全部落空），所以单独包一层 `.root` 就地补上。 */}
      <span className={styles.root}>
        <button
          type="button"
          className={`${styles.smBtn} ${styles.smBtnIcon}`}
          title="模块 → 单元 → 子单元，连同各段的关键结论"
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="3" cy="8" r="1.6" />
            <path d="M4.5 8 11 3M4.5 8h6.7M4.5 8 11 13" />
            <circle cx="12" cy="3" r="1.3" />
            <circle cx="12" cy="8" r="1.3" />
            <circle cx="12" cy="13" r="1.3" />
          </svg>
          查看脑图
        </button>
      </span>
      {modal && mounted
        ? createPortal(<div className={styles.root}>{modal}</div>, document.body)
        : null}
    </>
  );
}
