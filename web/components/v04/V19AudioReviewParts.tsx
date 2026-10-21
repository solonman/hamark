"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  formatAudioClock,
  type AudioReviewOpinionKind,
  type AudioReviewSegment,
  type AudioReviewSourceKind,
} from "@/lib/audio-review-model";
import {
  activeAudioReviewSegmentId,
  describeAudioReviewDocumentSummary,
  splitAudioReviewCorrections,
  type AudioReviewSegmentRef,
} from "@/lib/audio-review-ui";
import styles from "./V04Surface.module.css";

/**
 * 老孙点评改写的共用小件：图标、录音条（真实 <audio>，界面自己画）、文字稿、
 * 文档来源的「点评原文」、意见类型标签、原话前的引用。确认抽屉（V19AudioReviewDrawer）
 * 和点评版顶部的点评卡（V19AudioReviewCard）各用一套播放／跳段状态，互不牵连。
 * 见 docs/25 二之二、七、3-4。
 */

export type AudioReviewIconName = "mic" | "doc" | "note" | "upload" | "play" | "pause";

/** 来源对应的图标：录音是话筒，文档（含粘贴的文字）是一页纸。 */
export function audioReviewSourceIcon(sourceKind: AudioReviewSourceKind | null | undefined): AudioReviewIconName {
  return sourceKind === "DOCUMENT" ? "doc" : sourceKind === "AUDIO" ? "mic" : "note";
}

export function AudioReviewIcon({ name }: { name: AudioReviewIconName }): JSX.Element {
  if (name === "mic") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
        <path d="M3.1 7.6a4.9 4.9 0 0 0 9.8 0M8 12.5v1.9" />
      </svg>
    );
  }
  if (name === "doc") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 1.75h5.25L12.25 4.75v9.5H4z" />
        <path d="M9 1.75v3.25h3.25M6.25 8h3.75M6.25 10.75h3.75" />
      </svg>
    );
  }
  if (name === "note") {
    // 点评（来源未定）：一个对话气泡，里面两行字——录音、文档、粘贴的文字都算。
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.25 3.5A1.5 1.5 0 0 1 3.75 2h8.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h-.25a1.5 1.5 0 0 1-1.5-1.5z" />
        <path d="M5.25 5.5h5.5M5.25 7.75h3.5" />
      </svg>
    );
  }
  if (name === "upload") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
        <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
      </svg>
    );
  }
  if (name === "pause") {
    return <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" /></svg>;
  }
  return <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" fill="currentColor" /></svg>;
}

export function AudioReviewKindTag({ kind, long = false }: { kind: AudioReviewOpinionKind; long?: boolean }): JSX.Element {
  const label = kind === "GENERAL" ? "总体" : "具体";
  return (
    <span className={`${styles.reviewKind} ${kind === "GENERAL" ? styles.reviewKindGeneral : styles.reviewKindSpecific}`}>
      {long ? `${label}意见` : label}
    </span>
  );
}

/** 点评版标记：版本菜单、点评卡标题前都用这一枚，和「我的」「最新修改」同一套尺寸。录音、文字都是这一枚。 */
export function AudioReviewVersionTag(): JSX.Element {
  return <span className={styles.reviewTag}><AudioReviewIcon name="note" />点评版</span>;
}

/**
 * 原话、「没落到条目的话」前面那一枚引用（`audioReviewSegmentRef` 算好的）：
 * 录音是时间点，等宽字；文档是「第 N 段」，正文字体。点了做什么由调用方给。
 */
export function AudioReviewRefButton({ sourceKind, reference, onClick }: {
  sourceKind: AudioReviewSourceKind;
  reference: AudioReviewSegmentRef;
  onClick: () => void;
}): JSX.Element {
  if (sourceKind === "DOCUMENT" && reference.segmentId === null) {
    return <span className={styles.reviewParaRefMissing} title={reference.title}>{reference.label}</span>;
  }
  return (
    <button
      type="button"
      className={sourceKind === "DOCUMENT" ? styles.reviewParaRef : styles.reviewTime}
      onClick={onClick}
      title={reference.title}
    >
      {reference.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 播放状态
// ---------------------------------------------------------------------------

export type AudioReviewPlayback = {
  currentMs: number;
  playing: boolean;
  durationMs: number | null;
  error: string;
  /** 跳到某一时刻；`play` 为 true 时顺手播放（点原话、点文字稿时间点）。 */
  seek: (ms: number, play?: boolean) => void;
  toggle: () => void;
  pause: () => void;
  handlers: {
    onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => void;
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onLoadedMetadata: (event: SyntheticEvent<HTMLAudioElement>) => void;
    onError: () => void;
  };
};

const PLAY_FAILED = "录音暂时播放不了，请稍后再试。";

/**
 * `audioRef` 由调用方建好、同时交给录音条的 <audio>（ref 单独传，不放进返回的对象里：
 * 一个装着 ref 的对象在渲染时读任何字段都会被 react-hooks/refs 当成读 ref）。
 */
export function useAudioReviewPlayback(
  audioRef: RefObject<HTMLAudioElement | null>,
  durationHintMs: number | null,
): AudioReviewPlayback {
  // 元数据还没到时设 currentTime 可能被浏览器丢掉，先记下来，loadedmetadata 时补上。
  const pendingSeekRef = useRef<number | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadedDurationMs, setLoadedDurationMs] = useState<number | null>(null);
  const [error, setError] = useState("");

  const play = useCallback((audio: HTMLAudioElement) => {
    setError("");
    audio.play().catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(PLAY_FAILED);
    });
  }, []);

  const seek = useCallback((ms: number, shouldPlay = true) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.max(0, ms);
    if (audio.readyState < 1) pendingSeekRef.current = target;
    audio.currentTime = target / 1000;
    setCurrentMs(target);
    if (shouldPlay) play(audio);
  }, [audioRef, play]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play(audio); else audio.pause();
  }, [audioRef, play]);

  const pause = useCallback(() => { audioRef.current?.pause(); }, [audioRef]);

  const handlers = {
    onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1000)),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onLoadedMetadata: (event: SyntheticEvent<HTMLAudioElement>) => {
      const audio = event.currentTarget;
      if (Number.isFinite(audio.duration) && audio.duration > 0) setLoadedDurationMs(Math.round(audio.duration * 1000));
      if (pendingSeekRef.current !== null) {
        audio.currentTime = pendingSeekRef.current / 1000;
        pendingSeekRef.current = null;
      }
    },
    onError: () => { setPlaying(false); setError(PLAY_FAILED); },
  };

  return {
    currentMs,
    playing,
    durationMs: loadedDurationMs ?? durationHintMs,
    error,
    seek,
    toggle,
    pause,
    handlers,
  };
}

// ---------------------------------------------------------------------------
// 录音条
// ---------------------------------------------------------------------------

const SEEK_STEP_MS = 5000;

export function V19AudioReviewAudioBar({
  audioRef,
  src,
  fileName,
  playback,
  marks = [],
}: {
  /** 与 useAudioReviewPlayback 同一个 ref。 */
  audioRef: RefObject<HTMLAudioElement | null>;
  src: string;
  fileName: string;
  playback: AudioReviewPlayback;
  /** 意见原话所在的时刻：在进度条上画一道小竖线。 */
  marks?: ReadonlyArray<{ ms: number; title: string }>;
}): JSX.Element {
  const { currentMs, durationMs, playing } = playback;
  const total = durationMs && durationMs > 0 ? durationMs : null;
  const ratio = total ? Math.min(1, currentMs / total) : 0;

  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!total) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const next = Math.round(((event.clientX - rect.left) / rect.width) * total);
    playback.seek(Math.min(total, Math.max(0, next)), playing);
  };
  const seekFromKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!total) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? SEEK_STEP_MS : -SEEK_STEP_MS;
      playback.seek(Math.min(total, Math.max(0, currentMs + delta)), playing);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      playback.toggle();
    }
  };

  return (
    <>
      <div className={styles.reviewAudio}>
        {/* 不显示原生控件：界面照 demo 自己画，事件全接到 playback 上。 */}
        <audio ref={audioRef} src={src} preload="metadata" {...playback.handlers} />
        <button type="button" className={styles.reviewAudioPlay} onClick={playback.toggle} aria-label={playing ? "暂停录音" : "播放录音"}>
          <AudioReviewIcon name={playing ? "pause" : "play"} />
        </button>
        <span className={styles.reviewAudioName} title={fileName}>{fileName}</span>
        <div
          className={styles.reviewAudioTrack}
          role="slider"
          tabIndex={0}
          aria-label="录音进度"
          aria-valuemin={0}
          aria-valuemax={total ? Math.round(total / 1000) : 0}
          aria-valuenow={Math.round(currentMs / 1000)}
          aria-valuetext={formatAudioClock(currentMs)}
          onPointerDown={seekFromPointer}
          onKeyDown={seekFromKey}
        >
          <div className={styles.reviewAudioRail}>
            <i className={styles.reviewAudioFill} style={{ width: `${ratio * 100}%` }} />
            {total && marks.map((mark, index) => (
              <b key={`${mark.ms}-${index}`} className={styles.reviewAudioMark}
                style={{ left: `${Math.min(100, (mark.ms / total) * 100)}%` }} title={mark.title} />
            ))}
          </div>
        </div>
        <span className={styles.reviewAudioClock}>
          {formatAudioClock(currentMs)} / {total ? formatAudioClock(total) : "--:--"}
        </span>
      </div>
      {playback.error && <p className={styles.reviewAudioError} role="alert">{playback.error}</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// 文字稿
// ---------------------------------------------------------------------------

/**
 * 一句话里校正过的词：虚线下划线，悬停看原文。录音是「按词表校正过的听写」；
 * 文档是打出来的字，只校正明显的错别字（docs/25 二之二、6）。
 */
export function AudioReviewCorrectedText({ text, corrections, sourceKind = "AUDIO" }: {
  text: string;
  corrections: ReadonlyArray<{ from: string; to: string }>;
  sourceKind?: AudioReviewSourceKind;
}): JSX.Element {
  const parts = splitAudioReviewCorrections(text, corrections);
  return (
    <>
      {parts.map((part, index) => part.correction ? (
        <span key={index} className={styles.reviewFix}
          title={sourceKind === "DOCUMENT"
            ? `原文写作“${part.correction.from}”，按错别字校正为“${part.correction.to}”`
            : `转写原文为“${part.correction.from}”，按词表校正为“${part.correction.to}”`}>
          {part.text}
        </span>
      ) : <span key={index}>{part.text}</span>)}
    </>
  );
}

export function V19AudioReviewTranscript({
  segments,
  playback,
  summary,
  defaultOpen = false,
  activeId,
  dividers,
  onSeek,
}: {
  segments: readonly AudioReviewSegment[];
  playback: AudioReviewPlayback;
  /** 复用方（客户需求复盘库）自己的标题；不传就是点评改写那一句。 */
  summary?: string;
  /** 默认展开。 */
  defaultOpen?: boolean;
  /** 高亮哪一句。不传＝播放时按进度算；传了（含 null）就以它为准，供「去听原声」跳转后暂停也能高亮。 */
  activeId?: number | null;
  /** 某句之前插一条分段标题（多段录音拼成一份文字稿时：「第 2 段 · 文件名」）。键是 segment.id。 */
  dividers?: ReadonlyMap<number, string>;
  /** 点时间点要做什么；不传就是在当前这段录音里跳转。 */
  onSeek?: (segment: AudioReviewSegment) => void;
}): JSX.Element {
  const resolvedActiveId = activeId !== undefined
    ? activeId
    : playback.playing ? activeAudioReviewSegmentId(segments, playback.currentMs) : null;
  return (
    <details className={styles.reviewTranscript} open={defaultOpen || undefined}>
      <summary>{summary ?? `完整文字稿（${segments.length} 段 · 说话人自动区分 · 虚线下划线＝按词表校正过的听写）`}</summary>
      <div className={styles.reviewTranscriptLines}>
        {segments.map((segment) => (
          <Fragment key={segment.id}>
            {dividers?.has(segment.id) ? <p className={styles.reviewPartDivider}>{dividers.get(segment.id)}</p> : null}
            <div
              data-segment-id={segment.id}
              className={[
                styles.reviewLine,
                segment.isReviewer ? styles.reviewLineReviewer : "",
                resolvedActiveId === segment.id ? styles.reviewLinePlaying : "",
              ].filter(Boolean).join(" ")}
            >
              <button type="button" className={styles.reviewTime} onClick={() => (onSeek ? onSeek(segment) : playback.seek(segment.startMs))}
                title="从这里开始播放">
                {formatAudioClock(segment.startMs)}
              </button>
              <span className={styles.reviewLineWho} title={segment.speaker}>{segment.speaker}</span>
              <span className={styles.reviewLineText}>
                <AudioReviewCorrectedText text={segment.text} corrections={segment.corrections} />
              </span>
            </div>
          </Fragment>
        ))}
        {segments.length === 0 && <p className={styles.reviewHint}>这段录音没有转写出文字。</p>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// 文档来源：点评原文（docs/25 二之二、7）。没有录音条、没有时间点；片段就是段落，
// 按 segments 的顺序编「第 N 段」。点意见原话前的「第 N 段」时展开原文、滚到那一段、
// 短暂高亮。
// ---------------------------------------------------------------------------

const PARAGRAPH_FLASH_MS = 1800;

export type AudioReviewParagraphJump = {
  /** 原文区展开没有（默认折叠）。 */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** 正在短暂高亮的那一段。 */
  flashId: number | null;
  /** 点「第 N 段」：展开原文、滚到那一段、短暂高亮。 */
  jump: (segmentId: number) => void;
};

/**
 * `rootRef` 由调用方建好、同时交给 V19AudioReviewDocumentText 的 <details>（理由同
 * useAudioReviewPlayback：装着 ref 的对象在渲染时读字段会被 react-hooks/refs 当成读 ref）。
 */
export function useAudioReviewParagraphJump(rootRef: RefObject<HTMLElement | null>): AudioReviewParagraphJump {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<{ id: number; token: number } | null>(null);
  const tokenRef = useRef(0);

  const jump = useCallback((segmentId: number) => {
    tokenRef.current += 1;
    setOpen(true);
    setFlash({ id: segmentId, token: tokenRef.current });
  }, []);

  useEffect(() => {
    if (!flash) return;
    // 刚展开时原文这一帧才渲染出来，等一帧再滚。
    const frame = window.requestAnimationFrame(() => {
      const node = rootRef.current?.querySelector<HTMLElement>(`[data-review-paragraph="${flash.id}"]`);
      if (!node) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      node.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    });
    const timer = window.setTimeout(() => {
      setFlash((current) => (current && current.token === flash.token ? null : current));
    }, PARAGRAPH_FLASH_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [flash, rootRef]);

  return { open, setOpen, flashId: flash?.id ?? null, jump };
}

export function V19AudioReviewDocumentText({
  segments,
  rootRef,
  open,
  onToggle,
  flashId = null,
}: {
  segments: readonly AudioReviewSegment[];
  /** 与 useAudioReviewParagraphJump 同一个 ref：跳段时在这里面找段落。 */
  rootRef?: RefObject<HTMLDetailsElement | null>;
  open: boolean;
  onToggle: (open: boolean) => void;
  flashId?: number | null;
}): JSX.Element {
  return (
    <details
      ref={rootRef}
      className={styles.reviewTranscript}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      data-v19-audio-review-document
    >
      <summary>{describeAudioReviewDocumentSummary(segments)}</summary>
      <div className={styles.reviewTranscriptLines}>
        {segments.map((segment, index) => (
          <div
            key={segment.id}
            data-review-paragraph={segment.id}
            className={[
              styles.reviewPara,
              segment.isReviewer ? "" : styles.reviewParaOther,
              flashId === segment.id ? styles.reviewParaFlash : "",
            ].filter(Boolean).join(" ")}
          >
            <span className={styles.reviewParaNo}>第 {index + 1} 段</span>
            <span className={styles.reviewLineText}>
              {/* 写明是别人说的那几段（如「王一凡问：」）不算老孙的意见：弱化，并标出是谁。 */}
              {!segment.isReviewer && segment.speaker && (
                <span className={styles.reviewParaWho} title={`这一段是${segment.speaker}说的，不算点评意见`}>{segment.speaker}</span>
              )}
              <AudioReviewCorrectedText text={segment.text} corrections={segment.corrections} sourceKind="DOCUMENT" />
            </span>
          </div>
        ))}
        {segments.length === 0 && <p className={styles.reviewHint}>这份文档没有读出文字。</p>}
      </div>
    </details>
  );
}
