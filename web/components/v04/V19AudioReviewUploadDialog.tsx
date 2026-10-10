"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type JSX } from "react";
import { createPortal } from "react-dom";
import {
  AUDIO_REVIEW_EXTENSIONS,
  AUDIO_REVIEW_MAX_BYTES,
  audioReviewApi,
  audioReviewContentType,
  type AudioReviewView,
} from "@/lib/audio-review-model";
import { V04UiApiError } from "@/lib/v04-ui-api-client";
import { AudioReviewIcon } from "./V19AudioReviewParts";
import dialogStyles from "@/components/shared/DeleteConfirmDialog.module.css";
import styles from "./V04Surface.module.css";

/**
 * 上传点评录音（docs/25 七、2）：选文件（或拖进来）→ 按扩展名补齐 Content-Type
 * 并校验 → 建任务 → 浏览器直传对象存储（XHR，显示进度）→ 通知服务端「传完了」
 * → 关闭弹层，由外壳弹 toast。弹层的壳复用站内删除确认对话框那一套
 * （components/shared/DeleteConfirmDialog.module.css），portal 到 body，外面套一层
 * display:contents 的 .surface 把 --v04-* 带过去——理由同那个组件：页头带
 * backdrop-filter，不 portal 出去遮罩会被关在页头里。
 */

export type V19AudioReviewUploadPhase = "IDLE" | "CREATING" | "UPLOADING" | "FINISHING";

const ACCEPT = ["audio/*", ...AUDIO_REVIEW_EXTENSIONS.map((ext) => `.${ext}`)].join(",");

/** 浏览器直传对象存储。Content-Type 必须与建任务时报给服务端的一致，否则预签名对不上。 */
export function putAudioReviewFile(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (percent: number) => void,
  register: (request: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    register(request);
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`录音没有上传完成（存储返回 HTTP ${request.status}）。`));
    });
    request.addEventListener("error", () => reject(new Error("网络中断，录音没有上传完成。")));
    request.addEventListener("abort", () => reject(new DOMException("已取消上传", "AbortError")));
    request.send(file);
  });
}

/** 选中的文件能不能传：返回给人看的原因，或 null 表示可以。 */
export function validateAudioReviewFile(file: { name: string; type: string; size: number }): { contentType: string } | { error: string } {
  const contentType = audioReviewContentType(file.name, file.type);
  if (!contentType) {
    return { error: `「${file.name}」不是能识别的录音格式。支持 ${AUDIO_REVIEW_EXTENSIONS.join(" / ")}。` };
  }
  if (file.size <= 0) return { error: `「${file.name}」是空文件，请换一个。` };
  if (file.size > AUDIO_REVIEW_MAX_BYTES) return { error: `「${file.name}」超过 500MB，请压缩或截短后再传。` };
  return { contentType };
}

export default function V19AudioReviewUploadDialog({
  open,
  videoId,
  baseVersionId,
  baseLabel,
  caseTitle,
  onClose,
  onCreated,
  onUploaded,
  onDiscarded,
  onUploadingChange,
}: {
  open: boolean;
  videoId: string;
  /** null = 被点评的是还没落库的虚拟 v1，服务端会在建任务时先物化它。 */
  baseVersionId: string | null;
  /** 「v1 刘梦娜」 */
  baseLabel: string;
  caseTitle: string;
  onClose: () => void;
  /** 任务建好（UPLOADING）——外壳先把它放进 audioReviews，虚拟 v1 也在这时拿到真实 id。 */
  onCreated: (review: AudioReviewView) => void;
  /** 传完并通知了服务端（TRANSCRIBING）。外壳关弹层、弹 toast、开始轮询。 */
  onUploaded: (review: AudioReviewView, fileName: string) => void;
  /** 上传失败或取消后已经放弃了那个任务，外壳把它从 audioReviews 里拿掉。 */
  onDiscarded: (reviewId: string) => void;
  onUploadingChange: (uploading: boolean) => void;
}): JSX.Element | null {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<V19AudioReviewUploadPhase>("IDLE");
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const busy = phase !== "IDLE";

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记已在浏览器挂载，SSR 时没有 document（同 DeleteConfirmDialog）
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const start = async (file: File) => {
    if (busy) return;
    setError("");
    const checked = validateAudioReviewFile(file);
    if ("error" in checked) { setError(checked.error); return; }
    setFileName(file.name);
    setProgress(0);
    setPhase("CREATING");
    let reviewId: string | null = null;
    try {
      const created = await audioReviewApi.create(videoId, {
        baseVersionId,
        fileName: file.name,
        contentType: checked.contentType,
        sizeBytes: file.size,
      });
      reviewId = created.review.id;
      onCreated(created.review);
      setPhase("UPLOADING");
      onUploadingChange(true);
      await putAudioReviewFile(created.uploadUrl, file, checked.contentType, setProgress, (request) => { requestRef.current = request; });
      requestRef.current = null;
      setPhase("FINISHING");
      const uploaded = await audioReviewApi.action(videoId, created.review.id, { action: "UPLOADED" });
      onUploadingChange(false);
      setPhase("IDLE");
      setFileName("");
      onUploaded(uploaded.review, file.name);
    } catch (reason) {
      requestRef.current = null;
      onUploadingChange(false);
      const cancelled = reason instanceof DOMException && reason.name === "AbortError";
      // 建好了任务却没传完：放弃它，入口回到「上传」，免得留下一个永远卡在「上传录音」的任务。
      if (reviewId) {
        const id = reviewId;
        try { await audioReviewApi.action(videoId, id, { action: "ABANDON" }); } catch { /* 留给页头的「放弃并重新上传」 */ }
        onDiscarded(id);
      }
      setPhase("IDLE");
      if (cancelled) { setFileName(""); return; }
      setError(reason instanceof V04UiApiError || reason instanceof Error
        ? `${reason.message}${reviewId ? " 可以重新选择文件再试。" : ""}`
        : "录音没有上传完成，请重试。");
    }
  };

  const onPick = (files: FileList | null) => {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) void start(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) onPick(event.dataTransfer.files);
  };

  if (!open || !mounted) return null;

  return createPortal(
    <div className={styles.surface} style={{ display: "contents" }}>
      <div
        className={dialogStyles.uploadBackdrop}
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      >
        <section className={dialogStyles.uploadDialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
          data-v19-audio-review-upload>
          <div className={dialogStyles.uploadHead}>
            <div><small>点评对象：{baseLabel} · {caseTitle}</small><b id={titleId}>上传点评录音</b></div>
            {!busy && <button type="button" className={dialogStyles.uploadClose} onClick={onClose} aria-label="关闭上传窗口">×</button>}
          </div>
          <div className={dialogStyles.uploadBody}>
            {busy ? (
              <div className={styles.reviewUploadProgress} aria-live="polite">
                <div>
                  <span title={fileName}>{fileName}</span>
                  <b>{phase === "CREATING" ? "准备中" : phase === "FINISHING" ? "收尾中" : `${progress}%`}</b>
                </div>
                <div className={styles.reviewProgressRail}><i style={{ width: `${phase === "FINISHING" ? 100 : progress}%` }} /></div>
                <small>
                  {phase === "FINISHING"
                    ? "录音已传完，正在交给转写……"
                    : "正在上传录音。传完会自动开始处理，这个窗口随后关闭；上传期间请不要关闭页面。"}
                </small>
              </div>
            ) : (
              <div
                className={`${styles.reviewDrop} ${dragging ? styles.reviewDropActive : ""}`.trim()}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <AudioReviewIcon name="upload" />
                <b>把录音拖到这里，或</b>
                <button type="button" className={styles.reviewPrimaryButton} onClick={() => inputRef.current?.click()}>
                  选择录音文件
                </button>
                <p>m4a / mp3 / wav / aac 等常见格式，不超过 500MB</p>
                <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(event) => onPick(event.target.files)} />
              </div>
            )}
            {error && <p className={styles.reviewDialogError} role="alert">{error}</p>}
            <ul className={styles.reviewDialogNotes}>
              <li>一段录音对应这一份作业。录音里有别人的提问也没关系，系统会区分说话人，以老孙的意见为准。</li>
              <li>处理完先给你确认，再生成点评版；生成前可以重新上传或放弃，<b>生成后这一版不能再传</b>。</li>
              <li>生成后，点评版、录音和文字稿全站可见。</li>
            </ul>
          </div>
          <div className={dialogStyles.uploadFooter}>
            {phase === "UPLOADING" ? (
              <button type="button" onClick={() => requestRef.current?.abort()}>取消上传</button>
            ) : (
              <button type="button" disabled={busy} onClick={onClose}>{busy ? "请稍候…" : "取消"}</button>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
