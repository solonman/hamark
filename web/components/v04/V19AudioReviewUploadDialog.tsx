"use client";

import { useEffect, useId, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AUDIO_REVIEW_CRITIC_NAME } from "@/lib/audio-review/access";
import {
  AUDIO_REVIEW_DOCUMENT_CONTENT_TYPES,
  AUDIO_REVIEW_DOCUMENT_EXTENSIONS,
  AUDIO_REVIEW_EXTENSIONS,
  audioReviewApi,
  type AudioReviewSourceKind,
  type AudioReviewView,
} from "@/lib/audio-review-model";
import {
  AUDIO_REVIEW_PASTED_MIN_CHARS,
  audioReviewTextLength,
  checkAudioReviewPastedText,
  checkAudioReviewRecording,
  classifyAudioReviewUpload,
  pastedAudioReviewFile,
} from "@/lib/audio-review-ui";
import { V04UiApiError } from "@/lib/v04-ui-api-client";
import { AudioReviewIcon } from "./V19AudioReviewParts";
import dialogStyles from "@/components/shared/DeleteConfirmDialog.module.css";
import styles from "./V04Surface.module.css";

/**
 * 上传老孙点评（docs/25 七、2，二之二）：录音、文档（.docx / .txt / .md），或直接粘贴文字。
 * 选文件（或拖进来）→ 按扩展名分出录音还是文档、补齐 Content-Type 并校验 → 建任务 →
 * 浏览器直传对象存储（XHR，显示进度）→ 通知服务端「传完了」→ 关闭弹层，由外壳弹 toast。
 * 粘贴的文字在浏览器里存成「粘贴的点评文字.txt」，走完全相同的流程。
 * 弹层的壳复用站内删除确认对话框那一套（components/shared/DeleteConfirmDialog.module.css），
 * portal 到 body，外面套一层 display:contents 的 .surface 把 --v04-* 带过去——理由同那个
 * 组件：页头带 backdrop-filter，不 portal 出去遮罩会被关在页头里。
 */

export type V19AudioReviewUploadPhase = "IDLE" | "CREATING" | "UPLOADING" | "FINISHING";

/** 弹层里说传的是什么：录音、文档，或粘贴的文字。 */
type UploadNoun = "录音" | "文档" | "文字";

const ACCEPT = [
  "audio/*",
  ...AUDIO_REVIEW_EXTENSIONS.map((ext) => `.${ext}`),
  ...AUDIO_REVIEW_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`),
  ...AUDIO_REVIEW_DOCUMENT_CONTENT_TYPES,
].join(",");

/**
 * 浏览器直传对象存储。Content-Type 必须与建任务时报给服务端的一致，否则预签名对不上。
 * 客户需求复盘库的录音上传也用这一个；`noun` 只影响出错时的说法。
 */
export function putAudioReviewFile(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (percent: number) => void,
  register: (request: XMLHttpRequest) => void,
  noun: string = "录音",
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
      else reject(new Error(`${noun}没有上传完成（存储返回 HTTP ${request.status}）。`));
    });
    request.addEventListener("error", () => reject(new Error(`网络中断，${noun}没有上传完成。`)));
    request.addEventListener("abort", () => reject(new DOMException("已取消上传", "AbortError")));
    request.send(file);
  });
}

/**
 * 选中的录音能不能传：返回给人看的原因，或建任务要报的 Content-Type。
 * 只认录音——客户需求复盘库的录音上传沿用这个名字；点评上传用 `classifyAudioReviewUpload`。
 */
export function validateAudioReviewFile(file: { name: string; type: string; size: number }): { contentType: string } | { error: string } {
  return checkAudioReviewRecording(file);
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
  /** 传完并通知了服务端（TRANSCRIBING）。外壳关弹层、按来源弹 toast、开始轮询。 */
  onUploaded: (review: AudioReviewView, fileName: string, sourceKind: AudioReviewSourceKind) => void;
  /** 上传失败或取消后已经放弃了那个任务，外壳把它从 audioReviews 里拿掉。 */
  onDiscarded: (reviewId: string) => void;
  onUploadingChange: (uploading: boolean) => void;
}): JSX.Element | null {
  const titleId = useId();
  const pasteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<V19AudioReviewUploadPhase>("IDLE");
  const [mode, setMode] = useState<"FILE" | "PASTE">("FILE");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [noun, setNoun] = useState<UploadNoun>("录音");
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
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setError(""); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  /** 录音、文档、粘贴的文字都走这一条：建任务 → 直传 → 通知服务端「传完了」。 */
  const start = async (file: File, checked: { sourceKind: AudioReviewSourceKind; contentType: string }, uploadNoun: UploadNoun) => {
    if (busy) return;
    setError("");
    setFileName(file.name);
    setNoun(uploadNoun);
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
      await putAudioReviewFile(created.uploadUrl, file, checked.contentType, setProgress, (request) => { requestRef.current = request; }, uploadNoun);
      requestRef.current = null;
      setPhase("FINISHING");
      const uploaded = await audioReviewApi.action(videoId, created.review.id, { action: "UPLOADED" });
      onUploadingChange(false);
      setPhase("IDLE");
      setFileName("");
      if (uploadNoun === "文字") { setText(""); setMode("FILE"); }
      onUploaded(uploaded.review, file.name, checked.sourceKind);
    } catch (reason) {
      requestRef.current = null;
      onUploadingChange(false);
      const cancelled = reason instanceof DOMException && reason.name === "AbortError";
      // 建好了任务却没传完：放弃它，入口回到「上传」，免得留下一个永远卡在「上传」那一步的任务。
      if (reviewId) {
        const id = reviewId;
        try { await audioReviewApi.action(videoId, id, { action: "ABANDON" }); } catch { /* 留给页头的「放弃并重新上传」 */ }
        onDiscarded(id);
      }
      setPhase("IDLE");
      if (cancelled) { setFileName(""); return; }
      setError(reason instanceof V04UiApiError || reason instanceof Error
        ? `${reason.message}${reviewId ? (uploadNoun === "文字" ? " 文字还在，可以直接再提交一次。" : " 可以重新选择文件再试。") : ""}`
        : `${uploadNoun}没有上传完成，请重试。`);
    }
  };

  const onPick = (files: FileList | null) => {
    const file = files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!file || busy) return;
    const checked = classifyAudioReviewUpload(file);
    if (!checked.ok) { setError(checked.error); return; }
    void start(file, checked, checked.sourceKind === "DOCUMENT" ? "文档" : "录音");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) onPick(event.dataTransfer.files);
  };

  const submitText = () => {
    if (busy) return;
    const checked = checkAudioReviewPastedText(text);
    if (!checked.ok) { setError(checked.error); return; }
    void start(pastedAudioReviewFile(checked.text), { sourceKind: "DOCUMENT", contentType: "text/plain" }, "文字");
  };

  const switchMode = (next: "FILE" | "PASTE") => {
    setError("");
    setMode(next);
    if (next === "PASTE") window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl + 回车直接提交；单按回车照常换行（点评文字按段落切，换行有意义）。
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitText();
    }
  };

  if (!open || !mounted) return null;

  const textLength = audioReviewTextLength(text);

  return createPortal(
    <div className={styles.surface} style={{ display: "contents" }}>
      <div
        className={dialogStyles.uploadBackdrop}
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setError(""); onClose(); } }}
      >
        <section className={dialogStyles.uploadDialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
          data-v19-audio-review-upload>
          <div className={dialogStyles.uploadHead}>
            <div><small>点评对象：{baseLabel} · {caseTitle}</small><b id={titleId}>上传点评</b></div>
            {!busy && <button type="button" className={dialogStyles.uploadClose} onClick={() => { setError(""); onClose(); }} aria-label="关闭上传窗口">×</button>}
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
                    ? (noun === "录音" ? "录音已传完，正在交给转写……" : `${noun}已传完，正在交给系统读取……`)
                    : `正在上传${noun}。传完会自动开始处理，这个窗口随后关闭；上传期间请不要关闭页面。`}
                </small>
              </div>
            ) : mode === "PASTE" ? (
              <div className={styles.reviewPaste} data-v19-audio-review-paste>
                <label htmlFor={pasteId}>
                  <b>直接粘贴文字</b>
                  <small>按段落理解，每段一条意见更好认；写明是别人说的话（如「王一凡问：」）不算{AUDIO_REVIEW_CRITIC_NAME}的意见。</small>
                </label>
                <textarea
                  id={pasteId}
                  ref={textareaRef}
                  className={styles.reviewPasteInput}
                  value={text}
                  placeholder={`把${AUDIO_REVIEW_CRITIC_NAME}的点评文字粘贴在这里`}
                  onChange={(event) => { setText(event.target.value); if (error) setError(""); }}
                  onKeyDown={onTextKey}
                />
                <div className={styles.reviewPasteBar}>
                  <span className={styles.reviewPasteCount} aria-live="polite">
                    {textLength} 字{textLength < AUDIO_REVIEW_PASTED_MIN_CHARS ? ` · 至少 ${AUDIO_REVIEW_PASTED_MIN_CHARS} 个字` : ""}
                  </span>
                  <button type="button" className={styles.reviewGhostButton} onClick={() => switchMode("FILE")}>改为上传文件</button>
                  <button type="button" className={styles.reviewPrimaryButton} onClick={submitText}
                    disabled={textLength === 0}>提交文字</button>
                </div>
              </div>
            ) : (
              <div
                className={`${styles.reviewDrop} ${dragging ? styles.reviewDropActive : ""}`.trim()}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <AudioReviewIcon name="upload" />
                <b>把录音或文档拖到这里，或</b>
                <div className={styles.reviewDropActions}>
                  <button type="button" className={styles.reviewPrimaryButton} onClick={() => inputRef.current?.click()}>
                    选择文件
                  </button>
                  <button type="button" className={styles.reviewGhostButton} onClick={() => switchMode("PASTE")}
                    data-v19-audio-review-paste-entry>
                    直接粘贴文字
                  </button>
                </div>
                <p>录音（m4a / mp3 / wav / aac 等）或文档（Word .docx / .txt / .md）</p>
                <small>录音不超过 500MB，文档不超过 20MB；暂不支持 PDF 和老格式 .doc</small>
                <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(event) => onPick(event.target.files)} />
              </div>
            )}
            {error && <p className={styles.reviewDialogError} role="alert">{error}</p>}
            <ul className={styles.reviewDialogNotes}>
              <li>
                {`一份点评只对应这一份作业，录音和文字二选一。录音里有别人的提问、文字里写明是别人说的话都没关系，系统会区分开，以${AUDIO_REVIEW_CRITIC_NAME}的意见为准。`}
              </li>
              <li>处理完先给你确认，再生成点评版；生成前可以重新上传或放弃，<b>生成后这一版不能再传</b>。</li>
              <li>生成后，点评版和点评原文（录音、文字稿或文档）全站可见。</li>
            </ul>
          </div>
          <div className={dialogStyles.uploadFooter}>
            {phase === "UPLOADING" ? (
              <button type="button" onClick={() => requestRef.current?.abort()}>取消上传</button>
            ) : (
              <button type="button" disabled={busy} onClick={() => { setError(""); onClose(); }}>{busy ? "请稍候…" : "取消"}</button>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
