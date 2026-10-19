"use client";

import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { activeAudioReviewSegmentId } from "@/lib/audio-review-ui";
import type { RetroTranscriptLine } from "@/lib/retro-ui";
import {
  V19AudioReviewAudioBar,
  V19AudioReviewTranscript,
  useAudioReviewPlayback,
} from "../v04/V19AudioReviewParts";
import styles from "./Retro.module.css";

/**
 * 「去听原声」「?t=秒数」要求的跳转：parent 每发一次就换一个 nonce，面板收到就从 ms 处开始并高亮当前句。
 * ownerId 是录音段（或附件）的 id：面板只认发给自己的那一条。
 */
export type RetroAudioSeekRequest = { ownerId: string; ms: number; nonce: number };

/**
 * 录音条 + 文字稿，案例页的点评录音、整场总结、附件里的客户录音三处共用。
 * 条和文字稿都是 V19AudioReview* 的原件（播放状态用 useAudioReviewPlayback，真实 <audio>）；
 * 这里只负责把一份「可能由多段拼成」的文字稿接到当前这一段的播放上：
 * 点别的段落里的时间点，交给 onSeekOther 去切段，再由新段的面板收到跳转请求。
 */
export default function RetroAudioPanel({
  ownerId,
  src,
  fileName,
  durationMs,
  lines,
  dividers,
  summary,
  seekRequest,
  onSeekOther,
  extra,
}: {
  ownerId: string;
  src: string;
  fileName: string;
  durationMs: number | null;
  lines: readonly RetroTranscriptLine[];
  dividers?: ReadonlyMap<number, string>;
  summary: string;
  seekRequest: RetroAudioSeekRequest | null;
  /** 点了别的录音段里的时间点。 */
  onSeekOther?: (ownerId: string, ms: number) => void;
  /** 条上方一行的右侧（比如「收起」）。 */
  extra?: JSX.Element | null;
}): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const playback = useAudioReviewPlayback(audioRef, durationMs);
  const [userSeeked, setUserSeeked] = useState(false);
  const handledNonce = useRef(0);

  const ownLines = useMemo(() => lines.filter((line) => line.ownerId === ownerId), [lines, ownerId]);
  const lineById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);
  const jumpedHere = seekRequest?.ownerId === ownerId;
  // 高亮：正在播、或者刚按「去听原声」跳过来、或者用户点过文字稿的时间点（暂停时也留着，demo 的 hl）。
  const activeId = (playback.playing || userSeeked || jumpedHere)
    ? activeAudioReviewSegmentId(ownLines, playback.currentMs)
    : null;

  const { seek } = playback;
  useEffect(() => {
    if (!seekRequest || seekRequest.ownerId !== ownerId || handledNonce.current === seekRequest.nonce) return;
    handledNonce.current = seekRequest.nonce;
    // 先定位，再尝试播放：浏览器不让没点过的页面自动出声时，静默放弃，由用户自己按播放。
    seek(seekRequest.ms, false);
    void audioRef.current?.play().catch(() => { /* 自动播放被拦下：不报错 */ });
    const target = activeAudioReviewSegmentId(ownLines, seekRequest.ms);
    // 用 setTimeout 而不是 requestAnimationFrame：后台标签页里 rAF 不触发，打开链接后不会跳到原话。
    const frame = window.setTimeout(() => {
      const row = wrapRef.current?.querySelector<HTMLElement>(`[data-segment-id="${target}"]`);
      const box = row?.parentElement;
      if (row && box) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 40;
    });
    return () => window.clearTimeout(frame);
  }, [seekRequest, ownerId, ownLines, seek]);

  return (
    <div className={styles.assetAudioPanel} ref={wrapRef}>
      {extra}
      <V19AudioReviewAudioBar audioRef={audioRef} src={src} fileName={fileName} playback={playback} />
      {lines.length ? (
        <V19AudioReviewTranscript
          segments={lines}
          playback={playback}
          summary={summary}
          defaultOpen
          activeId={activeId}
          dividers={dividers}
          onSeek={(segment) => {
            const line = lineById.get(segment.id);
            if (!line) return;
            setUserSeeked(true);
            if (line.ownerId === ownerId) playback.seek(line.startMs);
            else onSeekOther?.(line.ownerId, line.startMs);
          }}
        />
      ) : null}
    </div>
  );
}
