"use client";

import { useEffect, useRef, useState } from "react";
import { shouldDockV04DetailPlayer } from "@/lib/v04-media-loading";
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
      // 只在还留在顶部展示位时量高度；收进右下角后 shell 已脱离文档流。
      if (!slot.style.height) heroExtraHeight.current = shell.getBoundingClientRect().height - slotWidth * 9 / 16;
      const heroHeight = slotWidth * 9 / 16 + heroExtraHeight.current;
      const next = shouldDockV04DetailPlayer(slot.getBoundingClientRect().top, heroHeight);
      // 占位高度保持不变，收起与展开都不会顶动正文，也就不会来回抖动。
      slot.style.height = next ? `${heroHeight}px` : "";
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
  }, [dockable]);
  const floating = surface === "workspace" || video.floating || docked;
  function toggleFloating() {
    if (docked) {
      updateVideo({ floating: false });
      slotRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    updateVideo({ floating: !floating });
  }
  return (
    <div className={surface === "detail" ? styles.videoHeroSlot : undefined} ref={slotRef}>
      <aside ref={shellRef} className={`${styles.videoShell} ${floating ? styles.videoFloating : styles.videoHero} ${video.minimized ? styles.videoMinimized : ""}`} data-v04-video-single-instance data-v04-video-docked={docked ? "true" : undefined}>
        {video.minimized ? (
          <button className={styles.videoRestore} onClick={() => updateVideo({ minimized: false })}>恢复视频</button>
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
