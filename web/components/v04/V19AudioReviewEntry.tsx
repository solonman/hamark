"use client";

import { useEffect, useRef, useState, type JSX } from "react";
import { AUDIO_REVIEW_STEP_LABELS, formatAudioClock, type AudioReviewView } from "@/lib/audio-review-model";
import { describeAudioReviewFailure, type V19AudioReviewEntryState } from "@/lib/audio-review-ui";
import { AudioReviewIcon } from "./V19AudioReviewParts";
import styles from "./V04Surface.module.css";

/**
 * 页头右侧、版本胶囊之前的点评录音入口（docs/25 七、1），五种形态：
 * 上传按钮／处理中胶囊（转圈＋当前步骤，点开是进度气泡）／失败胶囊（点开看原因、
 * 重试或重新上传）／待确认胶囊（主色底，点开确认抽屉）／「查看点评版 vN」。
 * 只管渲染和把点击交出去；接口调用、确认弹窗都在外壳里。
 */
export default function V19AudioReviewEntry({
  state,
  view,
  baseLabel,
  uploadingLocally,
  busy,
  onUpload,
  onOpenDrawer,
  onView,
  onRetry,
  onReupload,
  onAbandon,
}: {
  state: V19AudioReviewEntryState;
  /** 轮询拿到的完整任务：进度气泡里显示文件名与时长。没有就只显示步骤。 */
  view: AudioReviewView | null;
  /** 「v1 刘梦娜」：气泡里说明点评对象。 */
  baseLabel: string;
  /** 这一页正在往存储里传这段录音（上传弹层开着且在传）。 */
  uploadingLocally: boolean;
  busy: boolean;
  onUpload: () => void;
  onOpenDrawer: () => void;
  onView: (reviewVersionId: string) => void;
  onRetry: () => void;
  onReupload: () => void;
  onAbandon: () => void;
}): JSX.Element | null {
  const [popOpen, setPopOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const showPop = popOpen && (state.kind === "PROCESSING" || state.kind === "FAILED");

  useEffect(() => {
    if (!showPop) return;
    const onPointer = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setPopOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPopOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showPop]);

  if (state.kind === "HIDDEN") return null;

  if (state.kind === "UPLOAD") {
    return (
      <div className={styles.reviewEntry}>
        <button type="button" className={styles.reviewEntryButton} onClick={onUpload} data-v19-audio-review-entry="upload"
          title={`上传分享会上对 ${baseLabel} 的点评录音`}>
          <AudioReviewIcon name="mic" /><span className={styles.reviewEntryLabel}>上传点评录音</span>
        </button>
      </div>
    );
  }

  if (state.kind === "VIEW") {
    const reviewVersionId = state.review.reviewVersionId as string;
    return (
      <div className={styles.reviewEntry}>
        <button type="button" className={styles.reviewEntryButton} onClick={() => onView(reviewVersionId)}
          data-v19-audio-review-entry="view" title="打开点评版，比较默认开启">
          <AudioReviewIcon name="mic" />
          <span className={styles.reviewEntryLabel}>查看点评版</span> <b>v{state.review.reviewVersionNumber ?? "?"}</b>
        </button>
      </div>
    );
  }

  if (state.kind === "PENDING") {
    return (
      <div className={styles.reviewEntry}>
        <button type="button" className={`${styles.reviewEntryChip} ${styles.reviewEntryPending}`} onClick={onOpenDrawer}
          data-v19-audio-review-entry="pending" title="核对拟定的改动，确认后生成点评版">
          <AudioReviewIcon name="mic" />
          <span className={styles.reviewEntryLabel}>点评改动待确认 ·</span> <b>{state.review.changeCount}</b>
          <span className={styles.reviewEntryLabel}>处</span>
        </button>
      </div>
    );
  }

  const failed = state.kind === "FAILED";
  const step = state.review.step;
  // 上传那一步卡住而这一页并没有在传：多半是上次传到一半关了页面或断了网，
  // 只能放弃重来，别让人对着一个永远不动的转圈干等。
  const stalledUpload = !failed && state.review.status === "UPLOADING" && !uploadingLocally;
  const fileNote = view ? `${view.audio.fileName}${view.audio.durationMs ? ` · ${formatAudioClock(view.audio.durationMs)}` : ""}` : "";

  return (
    <div className={styles.reviewEntry} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.reviewEntryChip} ${failed ? styles.reviewEntryFailed : ""}`.trim()}
        aria-expanded={showPop}
        aria-haspopup="dialog"
        data-v19-audio-review-entry={failed ? "failed" : "processing"}
        title={failed ? `点评录音处理失败：${state.review.failReason ?? "原因未知"}` : "点评录音处理中，点开看进度"}
        onClick={() => setPopOpen((current) => !current)}
      >
        {failed ? <AudioReviewIcon name="mic" /> : <span className={styles.reviewSpin} aria-hidden="true" />}
        {failed ? (
          <span className={styles.reviewEntryLabel}>点评录音处理失败</span>
        ) : (
          <>
            <span className={styles.reviewEntryLabel}>点评录音处理中 · {AUDIO_REVIEW_STEP_LABELS[step]}</span>
            <b>{step + 1}/{AUDIO_REVIEW_STEP_LABELS.length}</b>
          </>
        )}
      </button>
      {showPop && (
        <div className={styles.reviewPop} role="dialog" aria-label="点评录音处理进度">
          <h4>
            {failed
              ? describeAudioReviewFailure(view?.failedStep ?? (step === 0 ? "UPLOAD" : step === 1 ? "TRANSCRIBE" : "UNDERSTAND"))
              : stalledUpload ? "录音没有传完" : "正在处理点评录音"}
          </h4>
          <p>
            {failed
              ? `${state.review.failReason || "处理没有完成，原因未知"}。可以直接重试；如果传错了文件，重新上传。`
              : stalledUpload
                ? "上次上传在中途断了（页面被关闭或网络中断）。放弃这次上传，再重新传一次即可。"
                : `点评对象：${baseLabel}。可以离开页面，好了会在这里提示，回来也接得上。`}
          </p>
          <ol className={styles.reviewSteps}>
            {AUDIO_REVIEW_STEP_LABELS.map((label, index) => {
              const done = index < step;
              const current = index === step;
              const className = done
                ? styles.reviewStepDone
                : current ? (failed || stalledUpload ? styles.reviewStepFail : styles.reviewStepDoing) : undefined;
              return (
                <li key={label} className={className}>
                  <i aria-hidden="true">{done ? "✓" : current && (failed || stalledUpload) ? "!" : ""}</i>
                  {label}
                  {index === 0 && done && fileNote && <small title={fileNote}>{fileNote}</small>}
                </li>
              );
            })}
          </ol>
          <div className={styles.reviewPopActions}>
            {failed ? (
              <>
                <button type="button" className={styles.reviewGhostButton} disabled={busy}
                  onClick={() => { setPopOpen(false); onReupload(); }}>重新上传</button>
                <button type="button" className={styles.reviewPrimaryButton} disabled={busy}
                  onClick={() => { setPopOpen(false); onRetry(); }}>重试</button>
              </>
            ) : stalledUpload ? (
              <button type="button" className={styles.reviewPrimaryButton} disabled={busy}
                onClick={() => { setPopOpen(false); onReupload(); }}>放弃并重新上传</button>
            ) : (
              <button type="button" className={`${styles.reviewGhostButton} ${styles.reviewDangerButton}`} disabled={busy}
                onClick={() => { setPopOpen(false); onAbandon(); }}>放弃这次上传</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
