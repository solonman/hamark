"use client";

import { useEffect, useRef } from "react";
import type { V04UiMediaReference } from "@/lib/v04-ui-model";
import { useV04VideoSession } from "./V04VideoSessionProvider";
import styles from "./V04Surface.module.css";

export default function V04VideoPlayer({ caseId, title, surface, media, onDuration }: { caseId: string; title: string; surface: "detail" | "workspace"; media?: V04UiMediaReference | null; onDuration?: (seconds: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const { video, updateVideo } = useV04VideoSession();
  const active = video.caseId === caseId;
  useEffect(() => {
    if (!active) updateVideo({ caseId, currentTime: 0, floating: surface === "workspace" });
  }, [active, caseId, surface, updateVideo]);
  useEffect(() => {
    if (ref.current && active && Math.abs(ref.current.currentTime - video.currentTime) > 0.5) ref.current.currentTime = video.currentTime;
  }, [active, video.currentTime]);
  const floating = surface === "workspace" || video.floating;
  return (
    <aside className={`${styles.videoShell} ${floating ? styles.videoFloating : styles.videoHero} ${video.minimized ? styles.videoMinimized : ""}`} data-v04-video-single-instance>
      {video.minimized ? (
        <button className={styles.videoRestore} onClick={() => updateVideo({ minimized: false })}>恢复视频</button>
      ) : (
        <>
          <div className={styles.videoStage}>
            <video ref={ref} controls preload="metadata" src={media?.streamPath} aria-label={`${title} 视频播放器`} onLoadedMetadata={(event) => onDuration?.(event.currentTarget.duration)} onTimeUpdate={(event) => updateVideo({ currentTime: event.currentTarget.currentTime })} />
            {!media && <div className={styles.videoPlaceholder}><span>V0.4 VIDEO</span><strong>{title}</strong><small>媒体尚未就绪</small></div>}
          </div>
          <div className={styles.videoTools}>
            <button onClick={() => updateVideo({ floating: !floating })}>{floating ? "回到顶部" : "浮窗"}</button>
            <button onClick={() => updateVideo({ minimized: true })}>最小化</button>
          </div>
        </>
      )}
    </aside>
  );
}
