"use client";

import { useEffect, useId, useRef, useState, type JSX } from "react";
import { AUDIO_REVIEW_EXTENSIONS } from "@/lib/audio-review-model";
import { retroApi, retroReasonText } from "@/lib/retro-client";
import { RETRO_LIMITS, formatRetroMonth, type RetroRecordingView } from "@/lib/retro-model";
import { putAudioReviewFile, validateAudioReviewFile } from "../v04/V19AudioReviewUploadDialog";
import report from "../report/library/ReportLibrary.module.css";
import styles from "./Retro.module.css";

const ACCEPT = ["audio/*", ...AUDIO_REVIEW_EXTENSIONS.map((ext) => `.${ext}`)].join(",");

type Phase = "IDLE" | "CREATING" | "UPLOADING" | "FINISHING";

/**
 * 给案例传点评录音／给月份传整场总结（规格 5.1）：选文件 → validateAudioReviewFile 校验 → 建录音行（段号服务端取，满 3 段回 409）
 * → putAudioReviewFile 直传对象存储（显示进度）→ 通知「传完了」→ 关闭，由外壳弹提示、开始轮询。
 * 直传与校验都是点评改写那套的原件（V19AudioReviewUploadDialog 导出）；对话框外壳复用报告上传框（ReportLibrary.module.css）。
 * 任何已登录的人都能传，不限上传者。
 */
export default function RetroRecordingUploadDialog({
  monthKey,
  caseId,
  caseTitle,
  nextPart,
  onClose,
  onUploaded,
  onUploadingChange,
}: {
  monthKey: string;
  /** null = 整场总结。 */
  caseId: string | null;
  caseTitle?: string;
  nextPart: number;
  onClose: () => void;
  onUploaded: (recording: RetroRecordingView, fileName: string) => void;
  onUploadingChange?: (uploading: boolean) => void;
}): JSX.Element {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const busy = phase !== "IDLE";
  const isSummary = caseId === null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function start(file: File) {
    if (busy) return;
    setError("");
    const checked = validateAudioReviewFile(file);
    if ("error" in checked) { setError(checked.error); return; }
    setFileName(file.name);
    setProgress(0);
    setPhase("CREATING");
    let recordingId: string | null = null;
    try {
      const created = await retroApi.createRecording({ monthKey, caseId, fileName: file.name, contentType: checked.contentType, sizeBytes: file.size });
      recordingId = created.recording.id;
      setPhase("UPLOADING");
      onUploadingChange?.(true);
      await putAudioReviewFile(created.uploadUrl, file, checked.contentType, setProgress, (request) => { requestRef.current = request; });
      requestRef.current = null;
      setPhase("FINISHING");
      const uploaded = await retroApi.recordingAction(recordingId, "UPLOADED");
      onUploadingChange?.(false);
      setPhase("IDLE");
      onUploaded(uploaded ?? { ...created.recording, status: "TRANSCRIBING" }, file.name);
    } catch (reason) {
      requestRef.current = null;
      onUploadingChange?.(false);
      const cancelled = reason instanceof DOMException && reason.name === "AbortError";
      // 建好了行却没传完：移除它，免得占着一个段号、永远卡在「上传中」。
      if (recordingId) {
        try { await retroApi.recordingAction(recordingId, "REMOVE"); } catch { /* 留给页面上的「移除这一段」 */ }
      }
      setPhase("IDLE");
      if (cancelled) { setFileName(""); return; }
      setError(`${retroReasonText(reason, "录音没有上传完成，请重试。")}${recordingId ? " 可以重新选择文件再试。" : ""}`);
    }
  }

  function onPick(files: FileList | null) {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) void start(file);
  }

  return (
    <div className={styles.root}>
      <div
        className={report.uploadBackdrop}
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      >
        <section className={`${report.uploadDialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-retro-recording-dialog>
          <div className={`${report.uploadHead} ${styles.dialogHead}`}>
            <div>
              <small>RECORDING</small>
              <b id={titleId}>{isSummary ? `传整场总结录音 · 第 ${nextPart} 段` : `传点评录音 · 第 ${nextPart} 段`}</b>
            </div>
            {busy ? null : <button type="button" className={report.uploadClose} onClick={onClose} aria-label="关闭上传窗口">×</button>}
          </div>
          <div className={report.uploadBody}>
            <p className={report.hint}>
              {isSummary ? `挂在${formatRetroMonth(monthKey)}上：老孙最后单独录的整场总结。` : `挂在案例《${caseTitle ?? ""}》上。`}
              会上每讲完一个案例停一次录音；中途断过、换过设备，可以分成最多 {RETRO_LIMITS.recordingPartsMax} 段传。
            </p>
            {busy ? (
              <div className={styles.uploadProgressRow} aria-live="polite">
                <div>
                  <span title={fileName}>{fileName}</span>
                  <b>{phase === "CREATING" ? "准备中" : phase === "FINISHING" ? "收尾中" : `${progress}%`}</b>
                </div>
                <div className={styles.progressRail}><i style={{ width: `${phase === "FINISHING" ? 100 : progress}%` }} /></div>
                <small>
                  {phase === "FINISHING" ? "录音已传完，正在交给转写……" : "正在上传录音，传完会自动开始转写；上传期间请不要关闭页面。"}
                </small>
              </div>
            ) : (
              <>
                <button type="button" className={styles.fileDropBtn} onClick={() => inputRef.current?.click()}>
                  <b>选择录音文件</b>
                  <span>m4a／mp3／wav／aac／flac／ogg／amr／wma／3gp／mp4，单段不超过 500MB</span>
                </button>
                <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(event) => onPick(event.target.files)} />
              </>
            )}
            <ul className={styles.recNotes}>
              <li><b>任何人都能传</b>，不限上传者。</li>
              <li>转写只出文字稿，不做 AI 解读，转写完全员可见。</li>
              <li>当月纪要发布后再有录音变动，老孙会看到「可以重新生成」的提示，不自动重算。</li>
            </ul>
            {error ? <p className={report.formError} role="alert">{error}</p> : null}
          </div>
          <div className={`${report.uploadFooter} ${styles.dialogFoot}`}>
            {phase === "UPLOADING" ? (
              <button type="button" onClick={() => requestRef.current?.abort()}>取消上传</button>
            ) : (
              <button type="button" disabled={busy} onClick={onClose}>{busy ? "请稍候…" : "取消"}</button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
