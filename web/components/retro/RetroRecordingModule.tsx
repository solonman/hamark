"use client";

import { useMemo, useState, type JSX } from "react";
import { RETRO_LIMITS, formatRetroClock, type RetroRecordingView } from "@/lib/retro-model";
import { buildRetroTranscript, isRetroRecordingBusy } from "@/lib/retro-ui";
import { AudioReviewIcon } from "../v04/V19AudioReviewParts";
import RetroAudioPanel, { type RetroAudioSeekRequest } from "./RetroAudioPanel";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

/** 父组件发来的「去听原声」：段号、毫秒、nonce（每发一次换一个）。 */
export type RetroRecordingJump = { partNo: number; ms: number; nonce: number };

/**
 * 点评录音的正文（案例页的「点评录音」模块、月份页的「整场总结」共用）：多段切换、录音条、拼起来的文字稿、
 * 上传中／转写中／失败的胶囊。只管渲染和把点击交出去，接口调用、对话框都在父组件里。
 * 样式复用 V19AudioReviewEntry 的处理中／失败形态与 V19AudioReview* 的条和文字稿。
 */
export default function RetroRecordingModule({
  recordings,
  emptyTitle,
  emptySub,
  jump,
  busyAction,
  onUpload,
  onRetry,
  onRemove,
}: {
  recordings: readonly RetroRecordingView[];
  emptyTitle: string;
  emptySub: string;
  jump: RetroRecordingJump | null;
  /** 正在对哪一段发请求（重试／移除），按钮灰掉。 */
  busyAction: string | null;
  onUpload: () => void;
  onRetry: (recording: RetroRecordingView) => void;
  onRemove: (recording: RetroRecordingView) => void;
}): JSX.Element {
  const list = useMemo(
    () => recordings.filter((recording) => recording.status !== "REMOVED").sort((a, b) => a.partNo - b.partNo),
    [recordings],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seekRequest, setSeekRequest] = useState<RetroAudioSeekRequest | null>(null);
  const [seenJump, setSeenJump] = useState(0);

  // 「去听原声」：选中对应段并发出跳转请求。放在渲染期里调整 state（官方推荐写法），省掉一次 effect 里的 setState。
  if (jump && jump.nonce !== seenJump) {
    const target = list.find((recording) => recording.partNo === jump.partNo) ?? list[0];
    setSeenJump(jump.nonce);
    if (target) {
      setSelectedId(target.id);
      setSeekRequest({ ownerId: target.id, ms: jump.ms, nonce: jump.nonce });
    }
  }

  if (!list.length) {
    return (
      <button type="button" className={styles.recEmpty} onClick={onUpload}>
        <AudioReviewIcon name="upload" />
        <b>{emptyTitle}</b>
        <span>{emptySub}</span>
        <small>任何人都能传 · 最多 {RETRO_LIMITS.recordingPartsMax} 段 · m4a／mp3／wav 等，单段不超过 500MB</small>
      </button>
    );
  }

  const current = list.find((recording) => recording.id === selectedId) ?? list[0];
  const transcript = buildRetroTranscript(list);
  const multi = list.length > 1;
  const statusSuffix = (recording: RetroRecordingView) => (
    recording.status === "READY" ? "" : isRetroRecordingBusy(recording.status) ? " · 处理中" : " · 失败"
  );
  const acting = busyAction === current.id;

  let main: JSX.Element;
  if (current.status === "UPLOADING") {
    main = (
      <div className={styles.procRow}>
        <span className={styles.procChip}><span className={v04.reviewSpin} aria-hidden="true" /><b>上传中</b></span>
        <p>直传到对象存储，不经服务器中转。如果上传中途断了，移除这一段再重传就行。</p>
      </div>
    );
  } else if (current.status === "TRANSCRIBING") {
    main = (
      <div className={styles.procRow}>
        <span className={styles.procChip}><span className={v04.reviewSpin} aria-hidden="true" />转写中</span>
        <p>转写完成后录音条和文字稿自动出现，全员可见。可以先去做别的，回来也接得上。</p>
      </div>
    );
  } else if (current.status === "FAILED") {
    main = (
      <div className={styles.procRow}>
        <span className={`${styles.procChip} ${styles.failed}`}><AudioReviewIcon name="mic" />转写失败</span>
        <p>{current.failReason || "转写没有完成，原因未知。"}可以直接重试；传错了文件就移除后重传。</p>
        <button type="button" className={v04.reviewPrimaryButton} disabled={acting} onClick={() => onRetry(current)}>重试</button>
        {current.canRemove ? <button type="button" className={v04.reviewGhostButton} disabled={acting} onClick={() => onRemove(current)}>移除后重传</button> : null}
      </div>
    );
  } else {
    main = (
      <RetroAudioPanel
        key={current.id}
        ownerId={current.id}
        src={current.audioUrl}
        fileName={current.fileName}
        durationMs={current.durationMs}
        lines={transcript.lines}
        dividers={transcript.dividers}
        summary={`完整文字稿（${multi ? `${list.filter((recording) => recording.status === "READY").length} 段按段号拼接 · ` : ""}${transcript.lines.length} 句 · ${transcript.labelled ? "说话人已由 AI 认定" : "说话人自动区分，当月纪要发布后换成称呼"}）`}
        seekRequest={seekRequest}
        onSeekOther={(ownerId, ms) => {
          setSelectedId(ownerId);
          setSeekRequest({ ownerId, ms, nonce: Date.now() });
        }}
      />
    );
  }

  return (
    <>
      <div className={styles.recParts}>
        {multi ? list.map((recording) => (
          <button
            key={recording.id}
            type="button"
            className={styles.partPill}
            aria-pressed={recording.id === current.id}
            onClick={() => setSelectedId(recording.id)}
          >
            第 {recording.partNo} 段{statusSuffix(recording)}
          </button>
        )) : null}
        <span className={styles.recMeta}>
          {multi ? "" : `第 ${current.partNo} 段 · `}{current.fileName}
          {current.status === "READY" && current.durationMs ? ` · ${formatRetroClock(current.durationMs)}` : ""} · {current.uploadedByName} 上传
        </span>
        <span className={styles.grow} />
        {list.length < RETRO_LIMITS.recordingPartsMax ? (
          <button type="button" className={v04.reviewGhostButton} onClick={onUpload}>＋ 再传一段</button>
        ) : null}
        {current.canRemove ? (
          <button type="button" className={`${v04.reviewGhostButton} ${v04.reviewDangerButton}`} disabled={acting} onClick={() => onRemove(current)}>移除这一段</button>
        ) : null}
      </div>
      {main}
      <p className={styles.recNote}>
        {multi ? "多段按段号顺序拼成一份文字稿；点时间可以从那一句开始听。" : "点文字稿里的时间可以从那一句开始听。"}
        录音和文字稿没有 AI 解读，转写完就全员可见。
      </p>
    </>
  );
}
