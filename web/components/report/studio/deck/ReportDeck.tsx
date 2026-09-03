"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MODULE_NAME_CANDIDATES,
  applyMove,
  assignToNewModule,
  assignToNewUnit,
  moduleColor,
  moduleNumbers,
  openPagesOf,
  pageRangeLabel,
  pageStatus,
  removeModule,
  removeUnit,
  shownPagesOf,
  sortedChildUnits,
  sortedModules,
  sortedRootUnits,
  unitColorFor,
  type ReportAnnotation,
  type ReportDeckKey,
  type ReportModule,
  type ReportPage,
  type ReportUnit,
} from "@/lib/report-structure";
import {
  DECK_COLUMN_WIDTH_STORAGE_KEY,
  DECK_DEFAULT_COLUMN_WIDTH,
  clampColumnWidth,
  clampFloatingPosition,
  describePlanMove,
  fabDescriptor,
  insertMarkerPageNo,
  marqueeHits,
  moveToastText,
  pageMarkKind,
  placeFloatingToolbar,
  rangeLabelForPageNumbers,
  resolveMarqueeSelection,
  resolveShiftExtend,
  toggleOrReplaceSingle,
  type PlanMoveDescription,
  type SelectionState,
} from "./deck-view";
import ReportGuide from "./ReportGuide";
import ReportSectionPopover from "./ReportSectionPopover";
import ReportPageModal from "./ReportPageModal";
import { DeckEditableValue } from "./DeckField";
import styles from "./ReportDeck.module.css";
import type { ReportDeckProps } from "./deck-types";

/**
 * 报告拆解工作台第三部分：左列未归入页 ＋ 右列模块/单元收纳框，外加框选、
 * 拖动改归属、标注浮层、页面 modal、脑图、分步引导的全部交互。移植自
 * demo 第三部分（`docs/demos/2026-09-01-报告拆解工作台demo-V2.html`
 * 约 640-1513 行）：结构变更一律经 `lib/report-structure.ts`，选区/落点/
 * 着色的纯计算在 `./deck-view.ts`，这个文件只做状态编排与指针事件。
 *
 * 与 demo 的关键差异（详见任务报告）：
 * - 选中态用 React state 驱动 class（而不是 demo 手工 DOM class 打补丁），
 *   但同样不触发整列重渲染布局——选区变化只影响卡片自身的 class。
 * - 冻结态（浮层打开）靠 CSS `pointer-events:none` 而不是 JS 里拦截点击再
 *   弹 toast；"标注" 按钮用 `pointer-events:auto` 单独豁免，行为对齐 demo
 *   的 `.has-pop [data-anno]` 覆盖规则（可以直接切到另一个框的浮层）。
 * - 双击开 modal 用原生 `onDoubleClick`，不用 demo 那套时间戳比对。
 * - "查看脑图"按钮（`ReportMindMapButton`，导出自 `./ReportMindMap`）不在
 *   这个组件里渲染：外壳把它放在"第三部分"标题栏右侧，这里的统计条只留
 *   模块/单元/组块计数和已填完进度，避免两处各出一个脑图入口。
 */

type PressState =
  | { mode: "move"; key: ReportDeckKey; n: number; x: number; y: number; moved: boolean }
  | { mode: "range"; key: ReportDeckKey; n: number | null; x: number; y: number; moved: boolean };

type Toast = { id: string; text: string };

function elementFromPointClosest(x: number, y: number, selector: string): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return el ? (el as HTMLElement).closest<HTMLElement>(selector) : null;
}

function readStoredColumnWidth(): number {
  try {
    const raw = window.localStorage.getItem(DECK_COLUMN_WIDTH_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? clampColumnWidth(n) : DECK_DEFAULT_COLUMN_WIDTH;
  } catch {
    return DECK_DEFAULT_COLUMN_WIDTH;
  }
}
function storeColumnWidth(px: number) {
  try { window.localStorage.setItem(DECK_COLUMN_WIDTH_STORAGE_KEY, String(px)); } catch { /* ignore */ }
}

export default function ReportDeck({
  pages, annotation, readOnly, onChange, guideOff, onGuideOffChange,
  focusKey: controlledFocusKey, onFocusKeyChange, review,
}: ReportDeckProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<SelectionState>({ key: "free", ids: [] });
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pop, setPop] = useState<{ key: ReportDeckKey; anchorRect: { top: number; bottom: number; left: number } } | null>(null);
  const [modalPage, setModalPage] = useState<number | null>(null);
  const [colw, setColw] = useState(DECK_DEFAULT_COLUMN_WIDTH);
  const [openTrays, setOpenTrays] = useState<Set<string>>(new Set());
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  // 点收纳框标题栏（非按钮区域）＝"定位"：50 页里已归入的页在左列会被压暗，
  // 这个开关让所属页在左列亮起来，方便找——demo 的 `S.focus`/`data-focus`/
  // `.pc.lit`（约 704、738、749、758 行），只影响左列卡片，不影响托盘卡片。
  // 受控/不受控两态同 `guideOff`：外壳传了 `focusKey`/`onFocusKeyChange` 就
  // 受外壳摆布（这样 `ReportMindMapButton` 点节点才能点亮左列），没传就退回
  // 内部 state 自己记账。
  const [internalFocusKey, setInternalFocusKey] = useState<ReportDeckKey | null>(null);
  const focusKey = controlledFocusKey !== undefined ? controlledFocusKey : internalFocusKey;
  const setFocusKey = onFocusKeyChange ?? setInternalFocusKey;
  // 模块名称候选菜单：header 里紧跟名称的圆形 chevron 按钮，等价 demo 的
  // `.cbtn.inline` + `#cbmenu`（约 761、643 行）——header 上的名称本身用
  // `DeckEditableValue` 直接可编辑（demo 的 `val()`），这个菜单只负责从
  // `MODULE_NAME_CANDIDATES` 里选一个候选值回填，不是另一套下拉组件。
  const [nameMenu, setNameMenu] = useState<{ moduleId: string; x: number; y: number } | null>(null);
  const nameMenuRef = useRef<HTMLDivElement>(null);
  const [press, setPress] = useState<PressState | null>(null);
  const [split, setSplit] = useState<{ x: number; w: number } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [dragTip, setDragTip] = useState<{ x: number; y: number; text: string; ok: boolean } | null>(null);
  const [dropZoneKey, setDropZoneKey] = useState<ReportDeckKey | null>(null);
  const [insertMarker, setInsertMarker] = useState<{ zoneKey: ReportDeckKey; beforeN: number | null } | null>(null);
  const [peek, setPeek] = useState<{ n: number; x: number; y: number } | null>(null);
  const [peekPos, setPeekPos] = useState<{ x: number; y: number } | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(null);
  const fabRef = useRef<HTMLDivElement>(null);
  const justDraggedRef = useRef(false);

  // localStorage 只在浏览器有，SSR 首帧读不到——先按默认宽度出，挂载后这一次
  // 同步纠正，跟 V04LibraryClient 读 URL 初始页签是同一个道理（避免水合不一致）。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 从 localStorage 读初始列宽，SSR 期间不存在更早的时机
    setColw(readStoredColumnWidth());
  }, []);

  const pushToast = useCallback((text: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((current) => [...current, { id, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 2800);
  }, []);

  const pageByNo = useCallback((n: number) => pages.find((p) => p.pageNo === n), [pages]);

  const clearSelection = useCallback(() => { setSel({ key: "free", ids: [] }); setAnchor(null); }, []);

  const commit = useCallback((next: ReportAnnotation) => {
    if (readOnly) return;
    onChange(next);
  }, [readOnly, onChange]);

  /* ---------------- 框选 / 单击 / Shift 扩选 ---------------- */

  const handlePlainClick = useCallback((key: ReportDeckKey, n: number, shiftKey: boolean) => {
    if (shiftKey) {
      const extended = resolveShiftExtend(annotation, sel, anchor, key, n);
      if (extended) { setSel({ key, ids: extended.ids }); setAnchor(extended.anchor); return; }
      pushToast("只能选连续的、还没被收走的页。");
      return;
    }
    const result = toggleOrReplaceSingle(sel, key, n);
    if (!result) { clearSelection(); return; }
    setSel({ key, ids: result.ids }); setAnchor(result.anchor);
  }, [annotation, sel, anchor, pushToast, clearSelection]);

  /* ---------------- 拖动搬运 / 框选：document 级指针事件 ---------------- */

  useEffect(() => {
    if (!press && !split) return;

    const onMove = (event: PointerEvent) => {
      if (split) {
        const w = clampColumnWidth(split.w + event.clientX - split.x);
        setColw(w);
        return;
      }
      if (!press) return;
      if (!press.moved && Math.abs(event.clientX - press.x) + Math.abs(event.clientY - press.y) < 4) return;
      setPress((current) => (current ? { ...current, moved: true } : current));

      if (press.mode === "range") {
        const rect = {
          left: Math.min(press.x, event.clientX), top: Math.min(press.y, event.clientY),
          right: Math.max(press.x, event.clientX), bottom: Math.max(press.y, event.clientY),
        };
        setMarqueeRect(rect);
        const cardEls = rootRef.current?.querySelectorAll<HTMLElement>(`[data-pick="${CSS.escape(press.key)}"]`);
        const cards = cardEls ? Array.from(cardEls).map((el) => ({ n: Number(el.dataset.n), rect: el.getBoundingClientRect() })) : [];
        const ids = resolveMarqueeSelection(annotation, press.key, cards, rect);
        if (ids) { setSel({ key: press.key, ids }); setAnchor(ids[0]); }
        return;
      }

      const zoneEl = elementFromPointClosest(event.clientX, event.clientY, "[data-drop]");
      const zoneKey = zoneEl?.dataset.drop as ReportDeckKey | undefined;
      if (!zoneKey || zoneKey === press.key) {
        setDropZoneKey(null);
        setInsertMarker(null);
        setDragTip({ x: event.clientX + 14, y: event.clientY + 16, text: "拖到别的收纳框上松开", ok: false });
        return;
      }
      setDropZoneKey(zoneKey);
      const selIds = sel.key === press.key ? sel.ids : [];
      const plan: PlanMoveDescription = describePlanMove(annotation, press.key, zoneKey, press.n, selIds);
      setDragTip({ x: event.clientX + 14, y: event.clientY + 16, text: plan.text, ok: plan.ok });
      if (plan.ok) {
        const shownIds = shownPagesOf(annotation, zoneKey).map((p) => p.n);
        setInsertMarker({ zoneKey, beforeN: insertMarkerPageNo(shownIds, plan.ids) });
      } else {
        setInsertMarker(null);
      }
    };

    const onUp = (event: PointerEvent) => {
      if (split) { setSplit(null); storeColumnWidth(colw); return; }
      const pr = press;
      setPress(null);
      setMarqueeRect(null);
      setDragTip(null);
      setDropZoneKey(null);
      setInsertMarker(null);
      if (!pr) return;

      if (pr.mode === "move") {
        if (!pr.moved) { handlePlainClick(pr.key, pr.n, event.shiftKey); return; }
        const zoneEl = elementFromPointClosest(event.clientX, event.clientY, "[data-drop]");
        const target = zoneEl?.dataset.drop as ReportDeckKey | undefined;
        if (target && target !== pr.key) {
          const selIds = sel.key === pr.key ? sel.ids : [];
          const plan = describePlanMove(annotation, pr.key, target, pr.n, selIds);
          if (plan.ok) {
            if (!readOnly) {
              const { next, removedSegments } = applyMove(annotation, plan.ids, target);
              onChange(next);
              pushToast(moveToastText(plan.ids.length, removedSegments));
            }
            clearSelection();
          } else {
            pushToast(plan.text);
          }
        }
        return;
      }

      // mode === "range"
      if (pr.moved) {
        justDraggedRef.current = true;
        // 松开时按最终位置再算一遍：pointermove 只在算出有效选区时才更新
        // sel，算不出来时 sel 停在"上一次成功的位置"（可能是空，也可能是
        // 更早一步的选区），用户根本看不出这次到底发生了什么。这里单独判断
        // "这次真的碰到了卡片、但被已归入的页挡住了"，才弹一句解释——纯粹
        // 拖在空白处（hits 为空）不算这种情况，不用打扰。
        const rect = {
          left: Math.min(pr.x, event.clientX), top: Math.min(pr.y, event.clientY),
          right: Math.max(pr.x, event.clientX), bottom: Math.max(pr.y, event.clientY),
        };
        const cardEls = rootRef.current?.querySelectorAll<HTMLElement>(`[data-pick="${CSS.escape(pr.key)}"]`);
        const cards = cardEls ? Array.from(cardEls).map((el) => ({ n: Number(el.dataset.n), rect: el.getBoundingClientRect() })) : [];
        const hits = marqueeHits(cards, rect);
        const ids = resolveMarqueeSelection(annotation, pr.key, cards, rect);
        if (ids) { setSel({ key: pr.key, ids }); setAnchor(ids[0]); }
        else if (hits.length) { pushToast("框选里有已归入的页，只能框选连续的未归入页。"); }
        return;
      }
      if (pr.n == null) { clearSelection(); return; }
      handlePlainClick(pr.key, pr.n, event.shiftKey);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [press, split, annotation, sel, readOnly]);

  /* ---------------- 点空白处清选区；拖完那次 click 不清 ---------------- */

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // 模块名称候选菜单：点菜单本身或触发它的 chevron 按钮以外的任何地方都关掉
      // ——demo 全局 click 里的 `S.cb&&!closest("#cbmenu")&&!closest("[data-cb]")`。
      if (nameMenu && !target.closest("[data-name-menu]") && !target.closest("[data-name-chevron]")) {
        setNameMenu(null);
      }
      if (justDraggedRef.current) { justDraggedRef.current = false; return; }
      if (target.closest("select,input,textarea,option,datalist,button")) return;
      if (sel.ids.length && !target.closest("[data-fab]") && !target.closest("[data-pick]")) {
        clearSelection();
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [sel, clearSelection, nameMenu]);

  /* ---------------- Esc：先关名称候选菜单，再清选区（浮层/modal 自己处理各自的 Esc） ----------------
   * 优先级对齐 demo 全局 keydown 的 `mind > cb > drawMode > modal > sel` 链——
   * mind/drawMode/modal 分别是 ReportMindMapButton／ReportPageModal 自己的
   * Esc 监听，这里只需要在 `cb`（名称候选菜单）和 `sel`（选区）之间排先后。
   * demo 没有"选中的页按 Delete/Backspace 退回未归入"这个功能——退回未归入
   * 只能靠拖到左列，这里不要发明一个键盘快捷方式。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pop || modalPage != null) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key !== "Escape") return;
      if (nameMenu) { setNameMenu(null); return; }
      if (sel.ids.length) clearSelection();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pop, modalPage, sel, nameMenu, clearSelection]);

  /* ---------------- hover 预览：只在浮层打开、且不在拖动/modal 时生效 ---------------- */

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      if (!pop || modalPage != null || press) { setPeek(null); return; }
      const card = (event.target as HTMLElement).closest<HTMLElement>("[data-pick]");
      if (card) setPeek({ n: Number(card.dataset.n), x: event.clientX, y: event.clientY });
      else if (!(event.target as HTMLElement).closest("[data-peek]")) setPeek(null);
    };
    document.addEventListener("pointerover", onPointerOver);
    return () => document.removeEventListener("pointerover", onPointerOver);
  }, [pop, modalPage, press]);

  /* ---------------- 浮出工具栏定位：贴着选区，不是文档流里随便一个位置 ---------------- */
  // `.fab` 是 position:fixed 但从来没被真正定位过（没有任何地方设过 top/left），
  // 于是它一直停在自己的"静态流"位置——挂在 50 页的 .deck 之后，那自然会落在
  // 视口外面很远的地方，越往下滚（或 viewport 越高）越明显。用 getBoundingClientRect
  // 量选中卡片的真实视口坐标（这个 API 本来就把所有祖先的滚动都算进去了，
  // 左列自己有滚动条也不例外），配 placeFloatingToolbar 算出正确位置。
  const placeFab = useCallback(() => {
    if (!sel.ids.length) { setFabPos(null); return; }
    const root = rootRef.current;
    if (!root) return;
    const cardEls = root.querySelectorAll<HTMLElement>(`[data-pick="${CSS.escape(sel.key)}"]`);
    const rects: { left: number; top: number; right: number; bottom: number }[] = [];
    cardEls.forEach((el) => {
      if (sel.ids.includes(Number(el.dataset.n))) rects.push(el.getBoundingClientRect());
    });
    const width = fabRef.current?.offsetWidth ?? 220;
    setFabPos(placeFloatingToolbar({
      cardRects: rects, toolbarWidth: width,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    }));
  }, [sel]);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 量 DOM 定位悬浮工具栏，这是 React 文档认可的"渲染后调整"写法（同类见 ReportSectionPopover 的位置计算），不是可以挪到渲染期间算的普通状态
    placeFab();
  }, [placeFab]);

  // hover 预览的定位：demo `placePeek`——宽度定死 440，高度用 `el.offsetHeight
  // ||380` 兜底，且遮住正在填的标注框时翻到指针左边（查 `#pop` 的真实屏幕位
  // 置）。这些都要读 DOM（`peekRef`/`rootRef`），不能放进渲染期间的普通表达
  // 式里算（ref 只能在事件处理器/effect 里读），所以放效果里、算完存 state，
  // JSX 直接用 state，不摸 ref.current。
  useLayoutEffect(() => {
    let next: { x: number; y: number } | null = null;
    if (peek) {
      const width = 440;
      const popEl = pop ? rootRef.current?.querySelector<HTMLElement>("[data-pop-panel]") : null;
      const popRect = popEl?.getBoundingClientRect() ?? null;
      let left = peek.x + 20;
      const top = peek.y - 60;
      if (popRect && left + width > popRect.left && peek.x < popRect.right) left = peek.x - 20 - width;
      const height = peekRef.current?.offsetHeight || 380;
      next = clampFloatingPosition({
        x: left, y: top, width, height,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        margin: 8,
      });
    }
    setPeekPos((current) => (current?.x === next?.x && current?.y === next?.y ? current : next));
  }, [peek, pop]);

  useEffect(() => {
    if (!sel.ids.length) return;
    window.addEventListener("resize", placeFab);
    window.addEventListener("scroll", placeFab, true);
    return () => {
      window.removeEventListener("resize", placeFab);
      window.removeEventListener("scroll", placeFab, true);
    };
  }, [sel.ids.length, placeFab]);

  /* ---------------- 结构操作 ---------------- */

  // demo 的 `makeModule`/`makeUnit`（约 1061、1071 行）建完框只发一条 toast，
  // 从不自动弹标注浮层——浮层只能靠标题栏「标注」按钮手动打开。之前一版在
  // 这里顺手 `setPop(...)`，是 demo 没有的"加戏"：新建模块/单元不会自动打断
  // 用户，继续框选下一段才是 demo 的节奏。

  const makeModule = useCallback((ids: number[]) => {
    if (readOnly) return;
    const { next } = assignToNewModule(annotation, ids);
    onChange(next);
    clearSelection();
    pushToast("已建模块，左边这些页变灰＝已归入。标题栏「标注」可以就地填这一段的条目。");
  }, [annotation, onChange, readOnly, clearSelection, pushToast]);

  const makeUnit = useCallback((containerKey: ReportDeckKey, ids: number[]) => {
    if (readOnly) return;
    const { next } = assignToNewUnit(annotation, containerKey, ids);
    onChange(next);
    clearSelection();
  }, [annotation, onChange, readOnly, clearSelection]);

  const handleFabAction = useCallback(() => {
    if (!sel.ids.length) return;
    if (sel.key === "free") makeModule(sel.ids);
    else makeUnit(sel.key, sel.ids);
  }, [sel, makeModule, makeUnit]);

  const openAnno = useCallback((key: ReportDeckKey, anchorEl: HTMLElement) => {
    clearSelection();
    const rect = anchorEl.getBoundingClientRect();
    setPop((current) => (current && current.key === key ? null : {
      key,
      anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left },
    }));
  }, [clearSelection]);

  const requestDelete = useCallback((key: string) => {
    if (confirmDeleteKey === key) {
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const next = kind === "mod" ? removeModule(annotation, id) : removeUnit(annotation, id);
      onChange(next);
      clearSelection();
      setConfirmDeleteKey(null);
      pushToast(kind === "mod" ? "模块已删除，这些页退回左边，重新可选。" : "单元已删除，页退回上一级。");
      return;
    }
    setConfirmDeleteKey(key);
    window.setTimeout(() => setConfirmDeleteKey((current) => (current === key ? null : current)), 3500);
  }, [confirmDeleteKey, annotation, onChange, clearSelection, pushToast]);

  /* ---------------- 分隔条 ---------------- */

  const onSplitterPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    setSplit({ x: event.clientX, w: colw });
  };

  /* ---------------- 页图区块：起手判断是搬运还是框选 ---------------- */

  const onDeckPointerDown = (event: React.PointerEvent) => {
    if (pop || modalPage != null || readOnly) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-open-hint]")) return;
    const cardEl = target.closest<HTMLElement>("[data-pick]");
    const contEl = target.closest<HTMLElement>("[data-container]");
    const onThumb = !!(cardEl && target.closest("[data-thumb]"));
    if (cardEl && onThumb) {
      const key = cardEl.dataset.pick as ReportDeckKey;
      const n = Number(cardEl.dataset.n);
      if (!openPagesOf(annotation, key).some((p) => p.n === n)) return;
      setPress({ mode: "move", key, n, x: event.clientX, y: event.clientY, moved: false });
      return;
    }
    if (contEl) {
      const key = contEl.dataset.container as ReportDeckKey;
      const n = cardEl && openPagesOf(annotation, key).some((p) => p.n === Number(cardEl.dataset.n)) ? Number(cardEl.dataset.n) : null;
      setPress({ mode: "range", key, n, x: event.clientX, y: event.clientY, moved: false });
    }
  };

  /* ---------------- 派生数据 ---------------- */

  const nums = moduleNumbers(annotation);
  const frozen = !!pop;
  const fab = fabDescriptor(annotation, sel.key, sel.ids);

  /* ---------------- 渲染：一页卡片 ---------------- */

  function pageThumb(n: number) {
    const view = pageByNo(n);
    const failed = !view || view.renderStatus !== "OK" || !view.thumbUrl;
    if (failed) return <div className={styles.pcFail} data-thumb="1">该页渲染失败</div>;
    // eslint-disable-next-line @next/next/no-img-element -- 本地对象存储签名 URL，不适用 next/image 远程域名白名单
    return <img src={view!.thumbUrl ?? undefined} alt="" loading="lazy" draggable={false} data-thumb="1" />;
  }

  /**
   * "已填完"／"在标"两种标记照抄 demo 的 `doneBadge`（约 609 行）：两种都是
   * 一个 ✓，靠 `.dot`（实心）／`.dot.half`（描边、半透明）的形状区分，不是
   * "在标就不放勾"——之前一版把"在标"改成纯空心圆、还把"已填完"的 title 从
   * demo 的"已标注完成"错写成"已填完"，两处都是自行发挥，按验收清单第 5 条
   * 改回 demo 原样。
   */
  function pageMarkBadge(p: ReportPage, extraClassName?: string) {
    const mark = pageMarkKind(p);
    if (mark === "none") return null;
    const cls = (extra: string) => [styles.dot, extra, extraClassName].filter(Boolean).join(" ");
    if (mark === "done") {
      return <i className={cls("")} title="已标注完成">✓</i>;
    }
    const status = pageStatus(p);
    return <i className={cls(styles.dotHalf)} title={`在标：还差 ${status.missing.join("、")}`}>✓</i>;
  }

  function openHintButton(n: number) {
    if (readOnly) return null;
    return (
      <button
        type="button"
        className={styles.openHint}
        data-open-hint="1"
        title="标注"
        onClick={(event) => { event.stopPropagation(); setModalPage(n); }}
      >
        标注
      </button>
    );
  }

  function freeColumn() {
    const allPages = [...annotation.pages].sort((a, b) => a.n - b.n);
    const claimedCount = allPages.filter((p) => p.mid).length;
    // "定位"高亮：focusKey 所指的框名下的全部页（含已被下级收走的），只点亮
    // 左列——demo 的 `S.focus&&shownPagesOf(S.focus).some(...)`（约 704 行）。
    const litPageNos = focusKey ? new Set(shownPagesOf(annotation, focusKey).map((p) => p.n)) : null;
    const litColorForMid = (mid: string) => moduleColor(sortedModules(annotation).findIndex((m) => m.id === mid));
    return (
      <aside className={styles.pagecol} data-container="free" data-drop="free">
        <div className={styles.colhead}>
          <b>PPT 页序</b><span>原件</span>
          <span className={styles.colheadN}>{claimedCount}/{allPages.length} 已归入</span>
        </div>
        <div className={styles.pagelist}>
          {allPages.map((p) => {
            const taken = !!p.mid;
            const selected = sel.key === "free" && sel.ids.includes(p.n);
            const lit = !!litPageNos?.has(p.n);
            const litColor = lit && p.mid ? litColorForMid(p.mid) : undefined;
            const cls = [styles.pc, selected ? styles.pcSel : "", taken ? styles.pcTaken : "", lit ? styles.pcLit : ""].filter(Boolean).join(" ");
            return (
              <div
                key={p.n}
                className={cls}
                data-pick="free"
                data-n={p.n}
                title={pageByNo(p.n)?.textExcerpt || undefined}
                style={litColor ? ({ "--rd-lit": litColor } as React.CSSProperties) : undefined}
                onDoubleClick={() => setModalPage(p.n)}
              >
                <span className={styles.pcN}>{String(p.n).padStart(2, "0")}</span>
                {pageThumb(p.n)}
                {pageMarkBadge(p, styles.pcDot)}
                {openHintButton(p.n)}
              </div>
            );
          })}
        </div>
      </aside>
    );
  }

  function renderTray(key: ReportDeckKey, emptyText: string) {
    const shown = shownPagesOf(annotation, key);
    const open = openPagesOf(annotation, key);
    const allTaken = shown.length > 0 && open.length === 0;
    const trayIsDropTarget = dropZoneKey === key;
    const showInsertBefore = insertMarker && insertMarker.zoneKey === key ? insertMarker.beforeN : undefined;
    const insertAtEnd = insertMarker && insertMarker.zoneKey === key && insertMarker.beforeN == null;

    if (!shown.length) {
      return (
        <div className={`${styles.tray} ${styles.trayEmpty}${trayIsDropTarget ? ` ${styles.dropok}` : ""}`} data-container={key} data-drop={key}>
          {emptyText}
        </div>
      );
    }
    if (allTaken && !openTrays.has(key)) {
      return (
        <div
          className={`${styles.trayfold}${trayIsDropTarget ? ` ${styles.dropok}` : ""}`}
          data-drop={key}
          onClick={() => setOpenTrays((current) => new Set(current).add(key))}
        >
          <b>{pageRangeLabel(shown)} · {shown.length} 页</b><span>已全部收进下级</span>
          <span className={styles.trayfoldMore}>展开</span>
        </div>
      );
    }
    return (
      <>
        {allTaken ? (
          <div
            className={styles.trayfold}
            onClick={() => setOpenTrays((current) => { const next = new Set(current); next.delete(key); return next; })}
          >
            <b>{pageRangeLabel(shown)} · {shown.length} 页</b><span>已全部收进下级</span>
            <span className={styles.trayfoldMore}>收起</span>
          </div>
        ) : null}
        <div className={`${styles.tray}${trayIsDropTarget ? ` ${styles.dropok}` : ""}`} data-container={key} data-drop={key}>
          {shown.map((p) => {
            const taken = key.startsWith("mod:") ? !!p.uid : p.uid !== key.slice(key.indexOf(":") + 1);
            const selected = sel.key === key && sel.ids.includes(p.n);
            const view = pageByNo(p.n);
            const failed = !view || view.renderStatus !== "OK" || !view.thumbUrl;
            const cls = [styles.tk, selected ? styles.tkSel : "", taken ? styles.tkTaken : ""].filter(Boolean).join(" ");
            return (
              <div key={p.n}>
                {showInsertBefore === p.n ? <span className={styles.insbar} /> : null}
                <div className={cls} data-pick={key} data-n={p.n} title={view?.textExcerpt || undefined} onDoubleClick={() => setModalPage(p.n)}>
                  {failed ? <div className={styles.tkFail} data-thumb="1">渲染失败</div>
                    // eslint-disable-next-line @next/next/no-img-element
                    : <img src={view!.thumbUrl ?? undefined} alt="" loading="lazy" draggable={false} data-thumb="1" />}
                  {pageMarkBadge(p)}
                  {openHintButton(p.n)}
                  <b className={styles.tkCaption}>p{String(p.n).padStart(2, "0")}</b>
                </div>
              </div>
            );
          })}
          {insertAtEnd ? <span className={styles.insbar} /> : null}
        </div>
      </>
    );
  }

  /**
   * 点标题栏背景（不是任一按钮）＝ demo 的 `data-focus`：切换这个框的
   * "定位"态——`.box.focus` 描边，并让它名下的页在左列 `.pc.lit` 亮起来。
   */
  function onBoxHeaderClick(key: ReportDeckKey) {
    // 直接读已解出的 `focusKey`（受控时就是外壳传的值），不用函数式 updater
    // ——`setFocusKey` 受控时是外壳给的普通回调，不支持 `(current) => ...`
    // 那种只有真正的 state setter 才有的写法。
    setFocusKey(focusKey === key ? null : key);
  }

  function boxHeader(kind: "mod" | "unit", id: string, name: string, range: ReportPage[]) {
    const key: ReportDeckKey = kind === "mod" ? `mod:${id}` : `unit:${id}`;
    const commitName = (next: string) => {
      if (readOnly) return;
      onChange(kind === "mod"
        ? { ...annotation, modules: annotation.modules.map((m) => (m.id === id ? { ...m, name: next } : m)) }
        : { ...annotation, units: annotation.units.map((u) => (u.id === id ? { ...u, name: next } : u)) });
    };
    return (
      <header className={styles.boxHead} onClick={() => onBoxHeaderClick(key)}>
        <span className={styles.boxNo}>{kind === "mod" ? "模块 " : "单元 "}{nums[id]}</span>
        <span className={styles.boxNm} onClick={(event) => event.stopPropagation()}>
          <DeckEditableValue
            value={name} disabled={readOnly} placeholder="未起名 · 点此填写"
            onCommit={commitName}
          />
          {kind === "mod" && !readOnly ? (
            <button
              type="button"
              className={styles.boxNameChevron}
              data-name-chevron="1"
              title="从候选里选一个"
              onClick={(event) => {
                event.stopPropagation();
                const r = event.currentTarget.getBoundingClientRect();
                setNameMenu((current) => (current && current.moduleId === id ? null : {
                  moduleId: id,
                  x: Math.max(8, Math.min(window.innerWidth - 160, r.left - 100)),
                  y: Math.min(window.innerHeight - 200, r.bottom + 6),
                }));
              }}
            />
          ) : null}
        </span>
        <span className={styles.boxRg}>{pageRangeLabel(range)} · {range.length} 页</span>
        {sel.ids.length === 0 ? (
          <button
            type="button"
            className={pop?.key === key ? `${styles.boxAct} ${styles.boxActOn}` : styles.boxAct}
            data-anno={key}
            onClick={(event) => { event.stopPropagation(); openAnno(key, event.currentTarget); }}
          >
            标注
          </button>
        ) : null}
        {!readOnly ? (
          <button
            type="button"
            className={`${styles.boxAct} ${styles.boxActDel}`}
            onClick={(event) => { event.stopPropagation(); requestDelete(key); }}
          >
            {confirmDeleteKey === key ? "再点一次删除" : "删除"}
          </button>
        ) : null}
      </header>
    );
  }

  function renderUnitBox(u: ReportUnit) {
    const key: ReportDeckKey = `unit:${u.id}`;
    const color = unitColorFor(annotation, u.id);
    const range = shownPagesOf(annotation, key);
    return (
      <div key={u.id} className={styles.unitbox}>
        <div
          className={focusKey === key ? `${styles.box} ${styles.boxFocus}` : styles.box}
          data-box={key} data-drop={key} style={{ "--rd-k": color } as React.CSSProperties}
        >
          {boxHeader("unit", u.id, u.name, range)}
          {renderTray(key, "这个单元里还没有页")}
        </div>
        {sortedChildUnits(annotation, u.id).map((k) => renderUnitBox(k))}
      </div>
    );
  }

  function renderModuleBox(m: ReportModule) {
    const key: ReportDeckKey = `mod:${m.id}`;
    const index = sortedModules(annotation).findIndex((x) => x.id === m.id);
    const color = moduleColor(index);
    const range = shownPagesOf(annotation, key);
    return (
      <div
        key={m.id}
        className={focusKey === key ? `${styles.box} ${styles.boxFocus}` : styles.box}
        data-box={key} data-drop={key} style={{ "--rd-k": color } as React.CSSProperties}
      >
        {boxHeader("mod", m.id, m.name, range)}
        {renderTray(key, "这个模块里还没有页")}
        {sortedRootUnits(annotation, m.id).map((u) => renderUnitBox(u))}
      </div>
    );
  }

  /* ---------------- fab ---------------- */

  function renderFab() {
    if (!sel.ids.length || readOnly) return null;
    const label = fab.available ? fab.label : null;
    // 没量出位置前先不画——量的动作在 useLayoutEffect 里，跟这次渲染同一帧
    // 结束在浏览器画出来之前，用户不会看到"先出现在错的地方、再跳到对的地方"。
    const style: React.CSSProperties = fabPos
      ? { left: fabPos.x, top: fabPos.y }
      : { left: -9999, top: -9999, visibility: "hidden" };
    const rangeLabel = rangeLabelForPageNumbers(sel.ids);
    return (
      <div ref={fabRef} className={styles.fab} data-fab="1" style={style}>
        已选 <b>{sel.ids.length}</b> 页 · {rangeLabel}
        {fab.available ? (
          <button type="button" className={styles.fabAct} onClick={handleFabAction}>{label}</button>
        ) : (
          <span className={styles.fabReason}>{fab.reason}</span>
        )}
        <button type="button" className={styles.fabX} onClick={clearSelection}>取消</button>
      </div>
    );
  }

  const empty = annotation.modules.length === 0;

  return (
    <div ref={rootRef} className={`${styles.root}${frozen ? ` ${styles.frozen}` : ""}`}>
      <div
        className={styles.deck}
        style={{ "--rd-colw": `${colw}px` } as React.CSSProperties}
        onPointerDown={onDeckPointerDown}
      >
        {freeColumn()}
        <div
          className={split ? `${styles.splitter} ${styles.splitterOn}` : styles.splitter}
          data-split="1"
          title="拖动改变左列宽度"
          onPointerDown={onSplitterPointerDown}
        />
        {/* 引导卡和空态文案放进右列（收纳区），不要摆在 .deck 上面——那样会把
            左列页序也一起往下挤：非空结构时左列该从顶部开始，跟右列有没有
            内容无关。 */}
        <div className={styles.boxcol}>
          <ReportGuide annotation={annotation} guideOff={guideOff} onGuideOffChange={onGuideOffChange} />
          {empty ? (
            <div className={styles.startpanel}>
              <div className={styles.startpanelBig}>从左边的页序开始</div>
              <p>在页图外面按住、拉一个框，选中一段连续的页；或者点一页、再 Shift＋点另一页。</p>
            </div>
          ) : null}
          {sortedModules(annotation).map((m) => renderModuleBox(m))}
        </div>
      </div>

      {renderFab()}

      {marqueeRect ? (
        <div
          className={styles.marquee}
          style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.right - marqueeRect.left, height: marqueeRect.bottom - marqueeRect.top }}
        />
      ) : null}

      {dragTip ? (
        <div className={dragTip.ok ? styles.dragtip : `${styles.dragtip} ${styles.dragtipNo}`} style={{ left: dragTip.x, top: dragTip.y }}>
          {dragTip.text}
        </div>
      ) : null}

      {peek && pageByNo(peek.n) ? (() => {
        const view = pageByNo(peek.n)!;
        // 位置由上面的 effect 算好存进 peekPos——没算出来之前先摆在视口外、
        // 隐藏起来（同 fab 的"没量出位置前先不画"手法），这一帧 peekRef 也才
        // 挂得上，下一效应周期就能量出真实高度。
        const style: React.CSSProperties = peekPos
          ? { left: peekPos.x, top: peekPos.y }
          : { left: -9999, top: -9999, visibility: "hidden" };
        return (
          <div ref={peekRef} className={styles.peek} data-peek="1" style={style}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={(view.largeUrl || view.thumbUrl) ?? undefined} alt="" />
            <div className={styles.peekCap}><b>p{String(peek.n).padStart(2, "0")}</b><span>{view.textExcerpt}</span></div>
          </div>
        );
      })() : null}

      {nameMenu ? (() => {
        const mod = annotation.modules.find((m) => m.id === nameMenu.moduleId);
        if (!mod) return null;
        return (
          <div ref={nameMenuRef} className={styles.cbMenu} data-name-menu="1" style={{ left: nameMenu.x, top: nameMenu.y }} role="listbox">
            {MODULE_NAME_CANDIDATES.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === mod.name}
                className={option === mod.name ? styles.cbMenuOn : undefined}
                onClick={() => {
                  if (!readOnly) {
                    onChange({ ...annotation, modules: annotation.modules.map((m) => (m.id === nameMenu.moduleId ? { ...m, name: option } : m)) });
                  }
                  setNameMenu(null);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        );
      })() : null}

      {pop ? (
        <ReportSectionPopover
          annotation={annotation}
          targetKey={pop.key}
          anchorRect={pop.anchorRect}
          readOnly={readOnly}
          onChange={commit}
          onClose={() => setPop(null)}
          review={review}
        />
      ) : null}

      {modalPage != null ? (
        // key=modalPage：换页就整个重挂载，组块选中态/框选态天然清空，
        // 不用额外写一个"pageNo 变了就清状态"的 effect（那是在 effect 里
        // 同步 setState 的反模式，见 https://react.dev/learn/you-might-not-need-an-effect）。
        <ReportPageModal
          key={modalPage}
          annotation={annotation}
          pages={pages}
          pageNo={modalPage}
          readOnly={readOnly}
          onChange={commit}
          onNavigate={setModalPage}
          onClose={() => setModalPage(null)}
          pushToast={pushToast}
          review={review}
        />
      ) : null}

      <div className={styles.toastHost}>
        {toasts.map((t) => <div key={t.id}>{t.text}</div>)}
      </div>
    </div>
  );
}
