"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import {
  computeThinkingChainFlowColumns,
  parseThinkingChains,
  placeThinkingChainFlowItem,
  splitThinkingChainTitle,
  stripThinkingChainStepNumber,
  thinkingChainFlowConnectors,
  type ThinkingChain,
  type ThinkingChainFlowConnector,
  type ThinkingChainNode,
} from "@/lib/thinking-chain";
import styles from "./V19ThinkingChain.module.css";

/**
 * 创意思维链的阅读态：横向流程图（docs/24 第四节）。每条思维链一块：中心是第 0 格，
 * 步骤依次往后排，蛇形折行，连线一笔到底；分叉从步骤框底下画成分支图。
 * 只读、无交互——点哪里进入编辑由外层 `V19ThinkingChainField` 管。
 */
export default function V19ThinkingChainFlow({ text, caseTitle }: { text: string; caseTitle?: string }): JSX.Element {
  const chains = useMemo(() => parseThinkingChains(text), [text]);
  if (!chains.length) return <span className={styles.flowEmpty}>—</span>;
  return (
    <div className={styles.flowForest}>
      {chains.map((chain, index) => <FlowChain key={index} chain={chain} caseTitle={caseTitle} />)}
    </div>
  );
}

/** 「短标题：说明」的短标题加粗。 */
export function ThinkingChainNodeText({ text }: { text: string }): ReactNode {
  const { title, detail } = splitThinkingChainTitle(text);
  return title ? <><b>{title}</b>：{detail}</> : text;
}

function ForkTree({ nodes, top }: { nodes: readonly ThinkingChainNode[]; top?: boolean }): JSX.Element {
  return (
    <ul className={top ? styles.forkTree : undefined}>
      {nodes.map((node, index) => (
        <li key={index}>
          <span className={styles.forkNode}><ThinkingChainNodeText text={node.text} /></span>
          {node.kids.length ? <ForkTree nodes={node.kids} /> : null}
        </li>
      ))}
    </ul>
  );
}

type FlowLayout = { columns: number; columnWidth: number };

const sameConnectors = (a: readonly ThinkingChainFlowConnector[], b: readonly ThinkingChainFlowConnector[]) =>
  a.length === b.length && a.every((item, index) => item.line === b[index].line && item.tip === b[index].tip);

function FlowChain({ chain, caseTitle }: { chain: ThinkingChain; caseTitle?: string }): JSX.Element {
  const treeRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLOListElement>(null);
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  const [connectors, setConnectors] = useState<ThinkingChainFlowConnector[]>([]);
  const itemCount = 1 + chain.kids.length;

  // 按实际宽度算每行几格、格宽；连线要等格子落好位再量。宽度变了、字体加载完、
  // 内容换行导致高度变了，都要重来一遍。
  const measure = useCallback(() => {
    const tree = treeRef.current;
    const grid = gridRef.current;
    if (!tree || !grid) return;
    const fontSize = Number.parseFloat(getComputedStyle(grid).fontSize) || 14;
    const next = computeThinkingChainFlowColumns(grid.clientWidth, itemCount, fontSize);
    let current = layout;
    if (!current || current.columns !== next.columns || Math.abs(current.columnWidth - next.columnWidth) > 0.5) {
      setLayout(next);
      current = next;
      return; // 新的列数先渲染，落位之后下一轮再量连线
    }
    const box = tree.getBoundingClientRect();
    const rects = Array.from(grid.children, (item) => {
      const target = item.querySelector<HTMLElement>("[data-flow-box]") ?? (item as HTMLElement);
      const rect = target.getBoundingClientRect();
      return { left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top };
    });
    const nextConnectors = thinkingChainFlowConnectors(rects, current.columns);
    setConnectors((previous) => (sameConnectors(previous, nextConnectors) ? previous : nextConnectors));
  }, [itemCount, layout]);

  useLayoutEffect(() => {
    measure();
  }, [measure, chain]);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(grid);
    return () => observer.disconnect();
  }, [measure]);

  const gridStyle: CSSProperties | undefined = layout
    ? { gridTemplateColumns: `repeat(${layout.columns}, ${layout.columnWidth}px)` }
    : undefined;
  const cellStyle = (index: number): CSSProperties | undefined => {
    if (!layout) return undefined;
    const place = placeThinkingChainFlowItem(index, layout.columns);
    return { gridRow: place.row + 1, gridColumn: place.column };
  };
  const centreLabel = chain.implicit ? caseTitle?.trim() || "创意思维链" : null;

  return (
    <div className={styles.flowChain}>
      <div className={styles.flowTree} ref={treeRef}>
        <svg className={styles.flowLinks} aria-hidden="true">
          {connectors.map((connector, index) => (
            <g key={index}>
              <path className={styles.flowLine} d={connector.line} />
              <path className={styles.flowTip} d={connector.tip} />
            </g>
          ))}
        </svg>
        <ol className={styles.flowGrid} ref={gridRef} style={gridStyle} aria-label={chain.implicit ? "创意思维链" : `思维链：${chain.text}`}>
          <li className={styles.flowHead} data-flow-box style={cellStyle(0)}>
            {centreLabel != null ? (
              <>
                {centreLabel}
                {caseTitle?.trim() ? <span className={styles.flowHeadSub}>创意思维链</span> : null}
              </>
            ) : (
              <ThinkingChainNodeText text={chain.text} />
            )}
          </li>
          {chain.kids.map((step, index) => (
            <li className={styles.flowStep} key={index} style={cellStyle(index + 1)}>
              <div className={styles.stepBox} data-flow-box>
                <span className={styles.stepNo} aria-label={`第 ${index + 1} 步`}>{index + 1}</span>
                <span><ThinkingChainNodeText text={stripThinkingChainStepNumber(step.text, index + 1)} /></span>
              </div>
              {step.kids.length ? <ForkTree nodes={step.kids} top /> : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
