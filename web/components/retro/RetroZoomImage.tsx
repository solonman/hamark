"use client";

import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { RETRO_ZOOM_MAX, RETRO_ZOOM_MIN, clampRetroZoomOffset, zoomRetroViewAt, type RetroZoomView } from "@/lib/retro-ui";
import styles from "./Retro.module.css";

/**
 * 预览弹层里可缩放的图（图片附件的展示图、文档的逐页大图，2026-10-21）：
 * - 滚轮／触控板双指捏合（浏览器给的是 ctrl+wheel）以光标为中心缩放；双击在适应和 2 倍之间切换；
 * - 放大后按住拖动；右下角「－ 百分比 ＋ 适应」，键盘 + − 0 同效；
 * - resetKey 变了（换一张图、翻一页）就回到适应窗口。
 * 100% 指「适应窗口」的大小，不是图片原始像素。
 */

const STEP = 1.25;
const FIT: RetroZoomView = { scale: 1, x: 0, y: 0 };

export default function RetroZoomImage({ src, alt, resetKey }: { src: string; alt: string; resetKey: string }): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [state, setState] = useState<{ key: string; view: RetroZoomView }>({ key: resetKey, view: FIT });
  const view = state.key === resetKey ? state.view : FIT;
  const drag = useRef<{ id: number; startX: number; startY: number; from: RetroZoomView } | null>(null);

  const measure = useCallback(() => {
    const box = boxRef.current?.getBoundingClientRect();
    const img = imgRef.current;
    if (!box || !img) return null;
    // 未缩放时的显示尺寸：offsetWidth/Height 不受 transform 影响。
    return { box: { width: box.width, height: box.height, left: box.left, top: box.top }, base: { width: img.offsetWidth, height: img.offsetHeight } };
  }, []);

  const apply = useCallback((next: RetroZoomView) => {
    const size = measure();
    setState({ key: resetKey, view: size ? clampRetroZoomOffset(next, size.base, size.box) : next });
  }, [measure, resetKey]);

  const zoomAt = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const size = measure();
    if (!size) return;
    const px = clientX === undefined ? 0 : clientX - size.box.left - size.box.width / 2;
    const py = clientY === undefined ? 0 : clientY - size.box.top - size.box.height / 2;
    apply(zoomRetroViewAt(view, nextScale, px, py));
  }, [apply, measure, view]);

  // 滚轮要 passive: false 才能阻止页面跟着滚，所以手动挂。
  const wheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    wheelRef.current = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      zoomAt(view.scale * factor, event.clientX, event.clientY);
    };
  });
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (event: WheelEvent) => wheelRef.current(event);
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  // 键盘 + − 0：弹层里同一时间只有一张可缩放的图。
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyRef.current = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(view.scale * STEP); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomAt(view.scale / STEP); }
      else if (event.key === "0") { event.preventDefault(); apply(FIT); }
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (view.scale <= RETRO_ZOOM_MIN || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, from: view };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    apply({ scale: current.from.scale, x: current.from.x + event.clientX - current.startX, y: current.from.y + event.clientY - current.startY });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };

  const zoomed = view.scale > RETRO_ZOOM_MIN;
  return (
    <div
      ref={boxRef}
      className={styles.zoomBox}
      data-zoomed={zoomed ? "1" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => (zoomed ? apply(FIT) : zoomAt(2, event.clientX, event.clientY))}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 展示图／页图来自对象存储签名 URL，不走 next/image 的远程域名白名单 */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
      <div className={styles.zoomBar} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="缩小" disabled={!zoomed} onClick={() => zoomAt(view.scale / STEP)}>－</button>
        <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" aria-label="放大" disabled={view.scale >= RETRO_ZOOM_MAX} onClick={() => zoomAt(view.scale * STEP)}>＋</button>
        <button type="button" disabled={!zoomed} onClick={() => apply(FIT)}>适应</button>
      </div>
    </div>
  );
}
