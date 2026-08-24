"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { shouldDockV04DetailPlayer } from "@/lib/v04-media-loading";
import { clampPlayerPosition, isVideoControlStrip, type PlayerPosition } from "@/lib/v19-player-drag";
import type { V04UiMediaReference } from "@/lib/v04-ui-model";
import { useV04VideoSession } from "./V04VideoSessionProvider";
import styles from "./V04Surface.module.css";

// 只读成果页的播放器随页面滚动收进右下角，和工作稿页的浮窗落点一致。
export default function V04VideoPlayer({ caseId, title, surface, media, onDuration }: { caseId: string; title: string; surface: "detail" | "workspace"; media?: V04UiMediaReference | null; onDuration?: (seconds: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  // 顶部展示位除画面外的固定高度（工具条与边框），用于滚动收起时按当前宽度还原占位。
  const heroExtraHeight = useRef(0);
  // 拖动落点记忆：只在这个组件实例存活期间生效，供 hero↔浮窗 之间来回切换时复用。
  const dragPositionRef = useRef<PlayerPosition | null>(null);
  // 正在进行中的拖动：记录指针相对浮窗左上角的偏移，拖动结束即清空。
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const [docked, setDocked] = useState(false);
  const { video, updateVideo } = useV04VideoSession();
  const active = video.caseId === caseId;
  useEffect(() => {
    if (!active) updateVideo({ caseId, currentTime: 0, floating: surface === "workspace" });
  }, [active, caseId, surface, updateVideo]);
  useEffect(() => {
    if (ref.current && active && Math.abs(ref.current.currentTime - video.currentTime) > 0.5) ref.current.currentTime = video.currentTime;
  }, [active, video.currentTime]);
  const dockable = surface === "detail" && !video.floating;
  useEffect(() => {
    const slot = slotRef.current;
    if (!dockable || !slot) {
      setDocked(false);
      if (slot) slot.style.height = "";
      return;
    }
    let frame = 0;
    const sync = () => {
      frame = 0;
      const shell = shellRef.current;
      if (!shell) return;
      const slotWidth = slot.clientWidth;
      // 只在还留在顶部展示位时量高度；收进右下角或最小化后 shell 已脱离文档流，
      // 量到的会是浮窗甚至胶囊的高度，必须沿用上一次在展示位量到的值。
      if (!slot.style.height && !video.minimized) {
        heroExtraHeight.current = shell.getBoundingClientRect().height - slotWidth * 9 / 16;
      }
      const heroHeight = slotWidth * 9 / 16 + heroExtraHeight.current;
      const next = shouldDockV04DetailPlayer(slot.getBoundingClientRect().top, heroHeight);
      // 占位高度保持不变，收起与展开都不会顶动正文，也就不会来回抖动。
      // 最小化同样让 shell 脱离文档流，所以它也要撑住占位，否则从顶部大屏
      // 直接最小化会把正文整体上提一个视频的高度。
      slot.style.height = next || video.minimized ? `${heroHeight}px` : "";
      setDocked(next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(sync); };
    sync();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
      slot.style.height = "";
    };
  }, [dockable, video.minimized]);
  const floating = surface === "workspace" || video.floating || docked;
  function toggleFloating() {
    if (docked) {
      updateVideo({ floating: false });
      slotRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    updateVideo({ floating: !floating });
  }
  // 浮窗定位：离开浮窗（回到顶部展示位）或进入最小化都清掉内联坐标，交回 CSS 的
  // right/bottom 锚点；从最小化恢复、或重新进入浮窗时，同步（而非用 rAF）套用
  // 记忆的拖动落点——读 offsetWidth 已经强制了一次 layout，rAF 在部分内嵌/后台
  // 场景里会被节流，静默丢掉这次还原。
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const applyPosition = () => {
      if (!floating || video.minimized) {
        shell.style.left = "";
        shell.style.top = "";
        shell.style.right = "";
        shell.style.bottom = "";
        return;
      }
      const remembered = dragPositionRef.current;
      if (!remembered) {
        shell.style.left = "";
        shell.style.top = "";
        shell.style.right = "";
        shell.style.bottom = "";
        return;
      }
      const size = { width: shell.offsetWidth, height: shell.offsetHeight };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const next = clampPlayerPosition(remembered, size, viewport);
      dragPositionRef.current = next;
      shell.style.left = `${next.x}px`;
      shell.style.top = `${next.y}px`;
      shell.style.right = "auto";
      shell.style.bottom = "auto";
    };
    applyPosition();
    window.addEventListener("resize", applyPosition);
    return () => window.removeEventListener("resize", applyPosition);
  }, [floating, video.minimized]);
  function handleShellPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!floating || video.minimized) return;
    const shell = shellRef.current;
    if (!shell) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = shell.getBoundingClientRect();
    // 底部原生播放控制条不触发拖动，否则用户按不到进度条/音量等控件。
    if (isVideoControlStrip(event.clientY, rect.bottom)) return;
    dragOffsetRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    shell.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function handleShellPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const offset = dragOffsetRef.current;
    const shell = shellRef.current;
    if (!offset || !shell) return;
    const size = { width: shell.offsetWidth, height: shell.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const next = clampPlayerPosition({ x: event.clientX - offset.dx, y: event.clientY - offset.dy }, size, viewport);
    dragPositionRef.current = next;
    shell.style.left = `${next.x}px`;
    shell.style.top = `${next.y}px`;
    shell.style.right = "auto";
    shell.style.bottom = "auto";
  }
  function handleShellPointerEnd(event: ReactPointerEvent<HTMLElement>) {
    if (!dragOffsetRef.current) return;
    dragOffsetRef.current = null;
    const shell = shellRef.current;
    if (shell?.hasPointerCapture(event.pointerId)) shell.releasePointerCapture(event.pointerId);
  }
  return (
    <div className={surface === "detail" ? styles.videoHeroSlot : undefined} ref={slotRef}>
      <aside
        ref={shellRef}
        className={`${styles.videoShell} ${floating || video.minimized ? styles.videoFloating : styles.videoHero} ${video.minimized ? styles.videoMinimized : ""}`}
        data-v04-video-single-instance
        data-v04-video-docked={docked ? "true" : undefined}
        onPointerDown={handleShellPointerDown}
        onPointerMove={handleShellPointerMove}
        onPointerUp={handleShellPointerEnd}
        onPointerCancel={handleShellPointerEnd}
      >
        {video.minimized ? (
          <div className={styles.videoBar}>
            <span className={styles.videoBarIcon} aria-hidden="true">▶</span>
            <span className={styles.videoBarTitle}>{title}</span>
            <button className={styles.videoMinButton} onClick={() => updateVideo({ minimized: false })}>恢复视频</button>
          </div>
        ) : (
          <>
            <div className={styles.videoStage}>
              <video ref={ref} controls preload="metadata" src={media?.streamPath} poster={media?.posterPath ?? undefined} aria-label={`${title} 视频播放器`} onLoadedMetadata={(event) => onDuration?.(event.currentTarget.duration)} onTimeUpdate={(event) => updateVideo({ currentTime: event.currentTarget.currentTime })} />
              {!media && <div className={styles.videoPlaceholder}><span>V0.4 VIDEO</span><strong>{title}</strong><small>媒体尚未就绪</small></div>}
            </div>
            <div className={styles.videoTools}>
              <button onClick={toggleFloating}>{floating ? "回到顶部" : "浮窗"}</button>
              <button onClick={() => updateVideo({ minimized: true })}>最小化</button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
