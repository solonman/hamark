"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  outlineBackspace,
  outlineDeleteRange,
  outlineIndent,
  outlineMove,
  outlineMoveRange,
  outlineOutdent,
  outlineRowNumbers,
  outlinePaste,
  outlineRangeText,
  outlineReplaceRange,
  outlineSelectionRange,
  outlineShiftRange,
  outlineSplit,
  parseThinkingChainRows,
  thinkingChainRowsToText,
  type OutlineEdit,
  type OutlineFocus,
  type OutlineSelection,
  type ThinkingChainRow,
} from "@/lib/thinking-chain";
import V19ThinkingChainFlow from "./V19ThinkingChainFlow";
import styles from "./V19ThinkingChain.module.css";

/**
 * 创意思维链的编辑态：左边带项目符号的大纲，右边实时预览（docs/24 第五节）。
 *
 * - 每个节点一个文本框；回车、Tab、退格、整枝移动、多行粘贴都是 `lib/thinking-chain.ts` 里的纯函数。
 * - 跨节点选择（拖过几行、Shift+↑↓、Shift+点击、连按 ⌘A）时焦点落在大纲容器上，按键由容器接。
 * - 编辑器自己的撤销：浏览器自带的撤销只认单个文本框里的打字，结构改动撤不回，所以每一步改动前
 *   记一份大纲快照；同一节点连续打字（停顿不超过 1.2 秒）合成一步。⌘Z 不外传给工作台。
 * - 焦点离开整个编辑区＝保存并收起（`onDone(text)`）；Esc＝放弃（`onDone(null)`）。左栏空白处点击
 *   不算离开，右边预览点击算。
 */

const HISTORY_LIMIT = 100;
const TYPING_MERGE_MS = 1200;

type Snapshot = { rows: ThinkingChainRow[]; selection: OutlineSelection | null; focus: OutlineFocus };
type PendingFocus = OutlineFocus | "outline" | null;

const ROW_TIPS = (
  <>
    <kbd>回车</kbd> 同级新节点　<kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> 下一级 / 上一级　<kbd>Alt+Shift+↑↓</kbd> 整枝移动
    拖过几行或 <kbd>Shift+↑↓</kbd> 跨节点选择　点外面保存　<kbd>Esc</kbd> 放弃
  </>
);

function blockTips(count: number): JSX.Element {
  return (
    <>
      <b>已选中 {count} 个节点（含下级）</b>　<kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> 一起调层级　<kbd>Alt+Shift+↑↓</kbd> 一起移动
      <kbd>⌘C</kbd> / <kbd>⌘X</kbd> / <kbd>⌘V</kbd> 复制 / 剪切 / 粘贴替换　<kbd>⌫</kbd> 删除　<kbd>Esc</kbd> 取消选择
    </>
  );
}

const UNDO_ICON = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.2 6.6h6.3a3.3 3.3 0 0 1 0 6.6H6.1" /><path d="M5.8 3.6 3 6.6l2.8 3" />
  </svg>
);
const REDO_ICON = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12.8 6.6H6.5a3.3 3.3 0 0 0 0 6.6h3.4" /><path d="M10.2 3.6 13 6.6l-2.8 3" />
  </svg>
);

function autosize(node: HTMLTextAreaElement): void {
  node.style.height = "28px";
  node.style.height = `${Math.max(28, node.scrollHeight)}px`;
}

/** 写剪贴板：优先用剪贴板接口；不可用时退回临时文本框＋复制命令，焦点随后回到大纲。 */
function writeClipboard(text: string, host: HTMLElement, refocus: HTMLElement): void {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    void navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  host.appendChild(temp);
  temp.select();
  document.execCommand("copy");
  temp.remove();
  refocus.focus({ preventScroll: true });
}

export default function V19ThinkingChainEditor({
  initialText,
  caseTitle,
  onDone,
}: {
  initialText: string;
  caseTitle?: string;
  /** 保存并收起时给规范化后的文字；放弃时给 null。 */
  onDone: (text: string | null) => void;
}): JSX.Element {
  const [rows, setRows] = useState<ThinkingChainRow[]>(() => {
    const parsed = parseThinkingChainRows(initialText);
    return parsed.length ? parsed : [{ level: 0, text: "" }];
  });
  const [selection, setSelection] = useState<OutlineSelection | null>(null);
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });

  const rootRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  // 事件处理（含文档级监听）读最新的行与选区；每次提交后同步
  const rowsRef = useRef(rows);
  const selectionRef = useRef(selection);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const typingRef = useRef<{ row: number; at: number } | null>(null);
  const lastRowRef = useRef(Math.max(0, rows.length - 1));
  const dragRef = useRef<{ anchor: number } | null>(null);
  const pendingFocusRef = useRef<PendingFocus>({ row: Math.max(0, rows.length - 1), caret: "end" });
  const doneRef = useRef(false);

  const finish = useCallback((text: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(text);
  }, [onDone]);

  // ---------- 焦点 ----------
  const focusRow = useCallback((index: number, caret: number | "end") => {
    const outline = outlineRef.current;
    if (!outline) return;
    const clamped = Math.max(0, Math.min(index, rowsRef.current.length - 1));
    const node = outline.querySelector<HTMLTextAreaElement>(`textarea[data-row="${clamped}"]`);
    if (!node) return;
    node.focus({ preventScroll: false });
    const position = caret === "end" ? node.value.length : Math.min(caret, node.value.length);
    node.setSelectionRange(position, position);
  }, []);

  useLayoutEffect(() => {
    rowsRef.current = rows;
    selectionRef.current = selection;
  });

  useLayoutEffect(() => {
    outlineRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea[data-row]").forEach(autosize);
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    if (pending === "outline") outlineRef.current?.focus({ preventScroll: true });
    else focusRow(pending.row, pending.caret);
  });

  const currentFocus = (): OutlineFocus => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.dataset.row != null) {
      return { row: Number(active.dataset.row), caret: active.selectionStart };
    }
    return { row: lastRowRef.current, caret: "end" };
  };
  const snapshot = (): Snapshot => ({
    rows: rowsRef.current.map((row) => ({ ...row })),
    selection: selectionRef.current && { ...selectionRef.current },
    focus: currentFocus(),
  });

  // ---------- 编辑器自己的撤销 ----------
  const syncHistorySize = () => setHistorySize({ undo: undoRef.current.length, redo: redoRef.current.length });
  const pushUndo = (entry: Snapshot) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    syncHistorySize();
  };
  const restore = (entry: Snapshot) => {
    typingRef.current = null;
    setRows(entry.rows.map((row) => ({ ...row })));
    setSelection(entry.selection);
    pendingFocusRef.current = entry.selection ? "outline" : entry.focus;
  };
  const undo = () => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push(snapshot());
    restore(entry);
    syncHistorySize();
  };
  const redo = () => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push(snapshot());
    restore(entry);
    syncHistorySize();
  };

  /** 结构改动都从这里过：记一步撤销，换上新行，光标落到改动给的位置。 */
  const apply = (edit: OutlineEdit | null) => {
    if (!edit) return;
    pushUndo(snapshot());
    typingRef.current = null;
    setRows(edit.rows);
    setSelection(null);
    pendingFocusRef.current = edit.focus;
  };

  // ---------- 跨节点选择 ----------
  const enterBlock = (anchor: number, focus: number) => {
    const last = rowsRef.current.length - 1;
    setSelection({ anchor: Math.max(0, Math.min(anchor, last)), focus: Math.max(0, Math.min(focus, last)) });
    pendingFocusRef.current = "outline";
  };
  const exitBlock = (row?: number, caret: number | "end" = "end") => {
    setSelection(null);
    if (row != null) pendingFocusRef.current = { row, caret };
  };
  const applyBlock = (nextRows: ThinkingChainRow[] | null, nextSelection: OutlineSelection | null) => {
    if (!nextRows) return;
    pushUndo(snapshot());
    typingRef.current = null;
    setRows(nextRows);
    setSelection(nextSelection);
    pendingFocusRef.current = nextSelection ? "outline" : null;
  };
  const deleteSelection = () => {
    const current = selectionRef.current;
    if (!current) return;
    apply(outlineDeleteRange(rowsRef.current, outlineSelectionRange(rowsRef.current, current)));
  };
  const copySelection = () => {
    const current = selectionRef.current;
    if (!current || !rootRef.current || !outlineRef.current) return;
    writeClipboard(outlineRangeText(rowsRef.current, outlineSelectionRange(rowsRef.current, current)), rootRef.current, outlineRef.current);
  };
  const shiftSelection = (delta: -1 | 1) => {
    const current = selectionRef.current;
    if (!current) return;
    applyBlock(outlineShiftRange(rowsRef.current, outlineSelectionRange(rowsRef.current, current), delta), current);
  };
  const moveSelection = (dir: -1 | 1) => {
    const current = selectionRef.current;
    if (!current) return;
    const moved = outlineMoveRange(rowsRef.current, outlineSelectionRange(rowsRef.current, current), dir);
    if (moved) applyBlock(moved.rows, moved.selection);
  };

  // 复制、剪切、粘贴在整节点选择时接管；只在一个节点里选字时照常走浏览器
  useEffect(() => {
    if (!selection) return;
    const onCopy = (event: ClipboardEvent) => {
      const current = selectionRef.current;
      if (!current) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", outlineRangeText(rowsRef.current, outlineSelectionRange(rowsRef.current, current)));
    };
    const onCut = (event: ClipboardEvent) => {
      onCopy(event);
      deleteSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      const current = selectionRef.current;
      if (!current) return;
      event.preventDefault();
      apply(outlineReplaceRange(rowsRef.current, outlineSelectionRange(rowsRef.current, current), event.clipboardData?.getData("text/plain") ?? ""));
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
    // apply/deleteSelection 只读 ref，随每次渲染重建也无妨；这里只关心选区开关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection != null]);

  // 鼠标从一个节点拖到另一个节点：切成整节点选择，继续拖动扩缩选区
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || !(event.buttons & 1)) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const row = hit instanceof Element ? hit.closest<HTMLElement>("[data-outline-row]") : null;
      if (!row || !outlineRef.current?.contains(row)) return;
      const index = Number(row.dataset.outlineRow);
      const current = selectionRef.current;
      if (!current) {
        if (index !== drag.anchor) enterBlock(drag.anchor, index);
      } else if (current.focus !== index) {
        setSelection({ ...current, focus: index });
      }
    };
    const onUp = () => { dragRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  // ---------- 按键 ----------
  const onBlockKey = (event: ReactKeyboardEvent<HTMLDivElement>, current: OutlineSelection) => {
    const key = event.key;
    const lower = key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    const range = outlineSelectionRange(rowsRef.current, current);
    if (mod && !event.shiftKey && (lower === "c" || lower === "x")) {
      // 在按键这一步处理：焦点在大纲容器上时，有的浏览器不会再派发复制事件
      event.preventDefault();
      copySelection();
      if (lower === "x") deleteSelection();
      return;
    }
    if (key === "Escape") { event.preventDefault(); event.stopPropagation(); exitBlock(current.focus); return; }
    if (key === "Tab") { event.preventDefault(); shiftSelection(event.shiftKey ? -1 : 1); return; }
    if (key === "Backspace" || key === "Delete") { event.preventDefault(); deleteSelection(); return; }
    if (event.altKey && event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) { event.preventDefault(); moveSelection(key === "ArrowUp" ? -1 : 1); return; }
    if (event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      event.preventDefault();
      const focus = Math.max(0, Math.min(rowsRef.current.length - 1, current.focus + (key === "ArrowUp" ? -1 : 1)));
      setSelection({ ...current, focus });
      return;
    }
    if (key === "ArrowUp") { event.preventDefault(); exitBlock(range.start, 0); return; }
    if (key === "ArrowDown" || key === "Enter") { event.preventDefault(); exitBlock(range.end - 1, "end"); return; }
    if (mod && lower === "a") { event.preventDefault(); setSelection({ anchor: 0, focus: rowsRef.current.length - 1 }); }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return; // 输入法组字时的回车是上屏，不接管
    const lower = event.key.toLowerCase();
    // ⌘Z / ⇧⌘Z / Ctrl+Y：编辑器开着时撤的是编辑器里的步骤，不往外传给工作台
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (lower === "z" || lower === "y")) {
      event.preventDefault();
      event.stopPropagation();
      if (lower === "y" || event.shiftKey) redo(); else undo();
      return;
    }
    const current = selectionRef.current;
    if (current && event.target === outlineRef.current) { onBlockKey(event, current); return; }
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || target.dataset.row == null) return;
    const index = Number(target.dataset.row);
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const list = rowsRef.current;
    const key = event.key;
    if (key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); return; }
    // 选到节点边上再往外扩，就切成整节点选择；整行文字已全选时再按 ⌘A 选中全部节点
    if (event.shiftKey && !event.altKey && key === "ArrowUp" && start === 0 && index > 0) { event.preventDefault(); enterBlock(index, index - 1); return; }
    if (event.shiftKey && !event.altKey && key === "ArrowDown" && end === target.value.length && index < list.length - 1) { event.preventDefault(); enterBlock(index, index + 1); return; }
    if ((event.metaKey || event.ctrlKey) && lower === "a" && start === 0 && end === target.value.length) { event.preventDefault(); enterBlock(0, list.length - 1); return; }
    if (key === "Tab") { event.preventDefault(); apply(event.shiftKey ? outlineOutdent(list, index, start) : outlineIndent(list, index, start)); return; }
    if (key === "Enter") { event.preventDefault(); apply(outlineSplit(list, index, start, end)); return; }
    if (key === "Backspace" && start === 0 && end === 0) {
      const edit = outlineBackspace(list, index);
      if (edit) { event.preventDefault(); apply(edit); }
      return;
    }
    if (event.altKey && event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) { event.preventDefault(); apply(outlineMove(list, index, key === "ArrowUp" ? -1 : 1)); return; }
    if (key === "ArrowUp" && start === 0 && end === 0 && index > 0) { event.preventDefault(); focusRow(index - 1, "end"); return; }
    if (key === "ArrowDown" && start === target.value.length && end === start && index < list.length - 1) { event.preventDefault(); focusRow(index + 1, 0); }
  };

  const onType = (index: number, node: HTMLTextAreaElement, now: number) => {
    const value = node.value.replace(/\r?\n/g, " ");
    const list = rowsRef.current;
    const typing = typingRef.current;
    if (!typing || typing.row !== index || now - typing.at > TYPING_MERGE_MS) {
      const caret = Math.max(0, node.selectionStart - (value.length - list[index].text.length));
      pushUndo({ rows: list.map((row) => ({ ...row })), selection: null, focus: { row: index, caret } });
    }
    typingRef.current = { row: index, at: now };
    setRows(list.map((row, i) => (i === index ? { ...row, text: value } : row)));
    autosize(node);
  };

  const onPasteRow = (index: number, event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (selectionRef.current) return; // 整节点选择时由文档级的粘贴处理
    const text = event.clipboardData.getData("text/plain");
    if (!/\r?\n/.test(text.trim())) return; // 单行照常粘贴
    event.preventDefault();
    const node = event.currentTarget;
    apply(outlinePaste(rowsRef.current, index, node.selectionStart, node.selectionEnd, text));
  };

  // ---------- 鼠标 ----------
  const onOutlineMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-outline-row]");
    if (!row) return;
    const index = Number(row.dataset.outlineRow);
    if (event.shiftKey) { // Shift+点击：从当前行选到这一行
      event.preventDefault();
      enterBlock(selectionRef.current ? selectionRef.current.anchor : lastRowRef.current, index);
      return;
    }
    if (selectionRef.current) exitBlock(); // 单击某一行：退出整节点选择，照常放光标
    if (!(event.target instanceof HTMLTextAreaElement)) { // 点在记号、引导线上也落到这一行
      event.preventDefault();
      focusRow(index, "end");
    }
    dragRef.current = { anchor: index };
  };

  // 左栏（工具栏、大纲、提示）里的空白处不算「点外面」：按下时不让焦点离开；
  // 点右边的预览或两栏之间照常算点外面
  const onRootMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("[data-outline-panel]") && !target.closest("textarea, button, summary, [data-outline]")) event.preventDefault();
  };

  // 焦点离开整个编辑区才算「点外面」；重排时焦点会在同一轮里落回新的行
  const onRootBlur = () => {
    window.setTimeout(() => {
      const root = rootRef.current;
      if (!root || doneRef.current) return;
      if (!root.contains(document.activeElement)) finish(thinkingChainRowsToText(rowsRef.current));
    }, 0);
  };

  const runTool = (action: "outdent" | "indent" | "up" | "down" | "chain" | "undo" | "redo") => {
    if (action === "undo") { undo(); return; }
    if (action === "redo") { redo(); return; }
    const current = selectionRef.current;
    if (current && action !== "chain") { // 整节点选择时，按钮作用于整个选区
      if (action === "indent") shiftSelection(1);
      if (action === "outdent") shiftSelection(-1);
      if (action === "up") moveSelection(-1);
      if (action === "down") moveSelection(1);
      return;
    }
    const list = rowsRef.current;
    const index = Math.min(lastRowRef.current, list.length - 1);
    if (action === "indent") apply(outlineIndent(list, index));
    if (action === "outdent") apply(outlineOutdent(list, index));
    if (action === "up") apply(outlineMove(list, index, -1));
    if (action === "down") apply(outlineMove(list, index, 1));
    if (action === "chain") apply({ rows: [...list.map((row) => ({ ...row })), { level: 0, text: "" }], focus: { row: list.length, caret: 0 } });
  };

  const range = selection ? outlineSelectionRange(rows, selection) : null;
  const text = thinkingChainRowsToText(rows);
  const numbers = outlineRowNumbers(rows);

  return (
    <div className={styles.editor} ref={rootRef} onMouseDown={onRootMouseDown} onBlur={onRootBlur}>
      <div className={styles.olPanel} data-outline-panel>
        <div className={styles.olTools} role="toolbar" aria-label="大纲操作" onMouseDown={(event) => event.preventDefault()}>
          <button type="button" onClick={() => runTool("outdent")}>← 上一级<kbd>⇧Tab</kbd></button>
          <button type="button" onClick={() => runTool("indent")}>→ 下一级<kbd>Tab</kbd></button>
          <button type="button" onClick={() => runTool("up")}>↑ 上移</button>
          <button type="button" onClick={() => runTool("down")}>↓ 下移</button>
          <button type="button" onClick={() => runTool("chain")}>＋ 新思维链</button>
          <i className={styles.olSep} aria-hidden="true" />
          <button type="button" onClick={() => runTool("undo")} disabled={!historySize.undo} title="撤销（⌘/Ctrl+Z）">{UNDO_ICON}撤销</button>
          <button type="button" onClick={() => runTool("redo")} disabled={!historySize.redo} title="重做（⌘/Ctrl+Shift+Z）">{REDO_ICON}重做</button>
        </div>
        <div
          className={`${styles.outline} ${selection ? styles.outlineBlock : ""}`.trim()}
          ref={outlineRef}
          data-outline
          role="group"
          aria-label="创意思维链大纲"
          tabIndex={selection ? 0 : -1}
          onKeyDown={onKeyDown}
          onMouseDown={onOutlineMouseDown}
          onFocus={(event) => {
            const target = event.target;
            if (target instanceof HTMLTextAreaElement && target.dataset.row != null) lastRowRef.current = Number(target.dataset.row);
          }}
        >
          {rows.map((row, index) => {
            const { chain: chainNumber, step: stepNumber } = numbers[index];
            const levelClass = styles[`lv${Math.min(row.level, 3)}` as "lv0" | "lv1" | "lv2" | "lv3"];
            const selected = range != null && index >= range.start && index < range.end;
            const className = [styles.olRow, levelClass, row.level === 0 && styles.olRoot, selected && styles.olSelected].filter(Boolean).join(" ");
            const label = row.level === 0 ? `思维链 ${chainNumber} 的中心` : row.level === 1 ? `第 ${stepNumber} 步` : `第 ${row.level} 层分叉`;
            return (
              <div className={className} style={{ "--lv": row.level } as CSSProperties} data-outline-row={index} key={index}>
                {Array.from({ length: row.level }, (_, guide) => (
                  <span className={styles.olGuide} style={{ "--g": guide } as CSSProperties} key={guide} />
                ))}
                <span className={styles.olBullet} aria-hidden="true"><i>{row.level === 1 ? stepNumber : ""}</i></span>
                <textarea
                  className={styles.olText}
                  rows={1}
                  data-row={index}
                  value={row.text}
                  spellCheck={false}
                  aria-label={label}
                  placeholder={row.level === 0 ? "这条思维链的中心" : row.level === 1 ? "下一步" : "分叉"}
                  onChange={(event) => onType(index, event.currentTarget, event.timeStamp)}
                  onPaste={(event) => onPasteRow(index, event)}
                />
                {row.level === 0 ? <span className={styles.olChainTag}>思维链 {chainNumber}</span> : null}
              </div>
            );
          })}
        </div>
        <div className={styles.olKeys}>{range ? blockTips(range.end - range.start) : ROW_TIPS}</div>
        <details className={styles.olStore}>
          <summary>存进库里的文字</summary>
          <pre>{text || "（空）"}</pre>
        </details>
      </div>
      <div className={styles.preview} aria-hidden="true">
        <span className={styles.previewLabel}>预览</span>
        <V19ThinkingChainFlow text={text} caseTitle={caseTitle} />
      </div>
    </div>
  );
}
