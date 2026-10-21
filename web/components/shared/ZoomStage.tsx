"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ZOOM_FIT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoomOffset, zoomViewAt, type ZoomView } from "@/lib/zoom-view";
import styles from "./ZoomStage.module.css";

/**
 * 大图预览的缩放舞台（2026-10-21，复盘库、公共视觉库、报告库三处共用）：
 * - 滚轮／触控板双指捏合（浏览器给的是 ctrl+wheel）以光标为中心缩放；双击在适应和 2 倍之间切换；
 * - 放大后按住拖动（移动超过 4px 才算拖，点一下照样是点击，报告库的标注框还能点选）；
 * - 右下角「－ 百分比 ＋ 适应」，键盘 + − 0 同效；resetKey 变了（换图、翻页）就回到适应窗口；
 * - panDisabled（报告库框选模式）时不拖动，让子元素自己处理指针；
 * - 「全屏」先用浏览器的全屏接口铺满屏幕；浏览器不支持或拒绝（iPhone 的 Safari、内嵌浏览器）就退回「页面内铺满」：
 *   舞台盖满整个窗口。两种都是按 Esc 或再点一次退出，键盘 F 同效；页面内铺满时 Esc 只退出铺满，不会把预览弹层也关掉。
 * 100% 指「适应窗口」的大小，不是图片原始像素。内容由 render 渲染，把 ref 和 style 挂到要缩放的那个元素上。
 */

type ContentProps = { ref: (element: HTMLElement | null) => void; style: CSSProperties };

const DRAG_THRESHOLD_PX = 4;
const FULLSCREEN_WAIT_MS = 600;
const subscribeNothing = () => () => undefined;

export default function ZoomStage({
  resetKey,
  panDisabled = false,
  children,
}: {
  resetKey: string;
  panDisabled?: boolean;
  children: (content: ContentProps) => ReactNode;
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 要缩放的那个元素：用 state 存（setState 本身就能当 ref 回调），measure 时读它的未缩放尺寸。
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<{ key: string; view: ZoomView }>({ key: resetKey, view: ZOOM_FIT });
  const view = state.key === resetKey ? state.view : ZOOM_FIT;
  const drag = useRef<{ id: number; startX: number; startY: number; from: ZoomView; active: boolean } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [filling, setFilling] = useState(false);
  // 只在浏览器里判断（iPhone 的 Safari 不支持对普通元素全屏）；服务端渲染时当不支持，免得对不上。
  const canFullscreen = useSyncExternalStore(subscribeNothing, () => Boolean(document.fullscreenEnabled), () => false);
  useEffect(() => {
    const onChange = () => {
      const on = document.fullscreenElement === boxRef.current;
      setFullscreen(on);
      if (on) setFilling(false); // 迟到的全屏批准：从页面内铺满切到真全屏
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement === box) { void document.exitFullscreen().catch(() => undefined); return; }
    if (filling) { setFilling(false); return; }
    if (!canFullscreen) { setFilling(true); return; }
    box.requestFullscreen().catch(() => setFilling(true));
    // 有的内嵌浏览器（含部分企业微信、内置预览）把全屏请求挂起不回：0.6 秒还没进全屏就先铺满页面。
    window.setTimeout(() => { if (document.fullscreenElement !== box) setFilling(true); }, FULLSCREEN_WAIT_MS);
  }, [canFullscreen, filling]);
  // 页面内铺满时：Esc 只退出铺满。挂在 window 的捕获阶段，先于各库弹层挂在 document 上的 Esc（那个会关掉整个预览）。
  useEffect(() => {
    if (!filling) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFilling(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filling]);

  const measure = useCallback(() => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !content) return null;
    // offsetWidth/Height 不受 transform 影响，是未缩放时的显示尺寸。
    return { box, base: { width: content.offsetWidth, height: content.offsetHeight } };
  }, [content]);

  const apply = useCallback((next: ZoomView) => {
    const size = measure();
    setState({ key: resetKey, view: size ? clampZoomOffset(next, size.base, size.box) : next });
  }, [measure, resetKey]);

  const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const size = measure();
    if (!size) return;
    const px = clientX === undefined ? 0 : clientX - size.box.left - size.box.width / 2;
    const py = clientY === undefined ? 0 : clientY - size.box.top - size.box.height / 2;
    apply(zoomViewAt(view, nextScale, px, py));
  }, [apply, measure, view]);

  // 滚轮要 passive: false 才能阻止页面跟着滚，所以手动挂。
  const wheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    wheelRef.current = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(view.scale * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
    };
  });
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (event: WheelEvent) => wheelRef.current(event);
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  // 键盘 + − 0：同一时间只有一个预览弹层开着。输入框里打字不算。
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyRef.current = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(view.scale * ZOOM_STEP); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomAt(view.scale / ZOOM_STEP); }
      else if (event.key === "0") { event.preventDefault(); apply(ZOOM_FIT); }
      else if (event.key === "f" || event.key === "F") { event.preventDefault(); toggleFullscreen(); }
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const zoomed = view.scale > ZOOM_MIN;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!zoomed || panDisabled || event.button !== 0) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, from: view, active: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      current.active = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 指针已经抬起等情况：不捕获也照样能拖 */ }
    }
    apply({ scale: current.from.scale, x: current.from.x + dx, y: current.from.y + dy });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  return (
    <div
      ref={boxRef}
      className={styles.box}
      data-zoomed={zoomed ? "1" : undefined}
      data-full={filling ? "1" : undefined}
      data-pan={zoomed && !panDisabled ? "1" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => {
        if (panDisabled) return;
        if (zoomed) apply(ZOOM_FIT);
        else zoomAt(2, event.clientX, event.clientY);
      }}
    >
      {children({
        ref: setContent,
        style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "center center", transition: "transform .08s ease-out" },
      })}
      <div className={styles.bar} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="缩小" disabled={!zoomed} onClick={() => zoomAt(view.scale / ZOOM_STEP)}>－</button>
        <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label="放大" disabled={view.scale >= ZOOM_MAX} onClick={() => zoomAt(view.scale * ZOOM_STEP)}>＋</button>
        <button type="button" disabled={!zoomed} onClick={() => apply(ZOOM_FIT)}>适应</button>
        <button type="button" aria-pressed={fullscreen || filling} onClick={toggleFullscreen}>{fullscreen || filling ? "退出全屏" : "全屏"}</button>
      </div>
    </div>
  );
}
