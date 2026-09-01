"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CASE_REVIEW_COMMENT_MAX_LENGTH, type CaseReviewComment } from "@/lib/case-review";
import styles from "./V04Surface.module.css";

/**
 * 条目上的评论按钮。平时藏起来，鼠标划过条目才浮现；已经有评论就一直亮着，
 * 因为「这里有话」本身就是作者要看见的信息。
 *
 * 没有评论、也没有评审权限的人看不到任何痕迹——对他们来说这个条目就是干净的。
 */
export type V19ReviewCommentProps = {
  targetKey: string;
  targetLabel: string;
  comment?: CaseReviewComment;
  canReview: boolean;
  /** 版本还没落库时无处可锚定，按钮出现但说明原因。 */
  disabled?: boolean;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

type PanelMode = "CLOSED" | "READING" | "EDITING";

export default function V19ReviewComment({
  targetKey,
  targetLabel,
  comment,
  canReview,
  disabled = false,
  onSave,
}: V19ReviewCommentProps) {
  const [mode, setMode] = useState<PanelMode>("CLOSED");
  // 悬停打开的气泡移开就收；点开的要留住，否则读长评论时鼠标一动就没了。
  const [pinned, setPinned] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const anchorRef = useRef<HTMLSpanElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const close = useCallback(() => {
    setMode("CLOSED");
    setPinned(false);
    setError("");
  }, []);

  useEffect(() => {
    if (mode === "CLOSED") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, mode]);

  useEffect(() => {
    if (mode === "EDITING") textareaRef.current?.focus();
  }, [mode]);

  if (!comment && !canReview) return null;

  const startEditing = () => {
    setText(comment?.body ?? "");
    setError("");
    setPinned(true);
    setMode("EDITING");
  };

  const submit = async (body: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({ targetKey, targetLabel, body });
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "评论保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleClick = () => {
    if (mode !== "CLOSED") {
      close();
      return;
    }
    if (comment) {
      setPinned(true);
      setMode("READING");
      return;
    }
    startEditing();
  };

  return (
    <span
      ref={anchorRef}
      className={styles.commentAnchor}
      onMouseEnter={() => { if (comment && mode === "CLOSED") setMode("READING"); }}
      onMouseLeave={() => { if (mode === "READING" && !pinned) setMode("CLOSED"); }}
    >
      <button
        type="button"
        className={styles.commentMarker}
        data-has-comment={comment ? "true" : undefined}
        data-open={mode === "CLOSED" ? undefined : "true"}
        aria-expanded={mode !== "CLOSED"}
        aria-label={comment ? `查看「${targetLabel}」的评论` : `给「${targetLabel}」写评论`}
        title={comment ? "有评论" : "写评论"}
        onClick={handleClick}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M2.4 3.4h11.2v7.4H7.2L4.3 13.2v-2.4H2.4z"
            fill={comment ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {mode === "READING" && comment ? (
        <span className={styles.commentPopover} role="note">
          <b>{comment.authorName}的评论</b>
          <span className={styles.commentBody}>{comment.body}</span>
          {canReview ? (
            <span className={styles.commentActions}>
              <button type="button" onClick={startEditing}>编辑</button>
            </span>
          ) : null}
        </span>
      ) : null}

      {mode === "EDITING" ? (
        <span className={styles.commentPopover} data-editing="true">
          <b>{comment ? "修改评论" : "写评论"}｜{targetLabel}</b>
          {disabled ? (
            <span className={styles.commentBody}>这一版还没有保存过内容，保存后才能评论。</span>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={text}
                maxLength={CASE_REVIEW_COMMENT_MAX_LENGTH}
                placeholder="写给作者看的评语"
                aria-label={`${targetLabel} 的评论`}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(text);
                }}
              />
              {error ? <em role="alert">{error}</em> : null}
              <span className={styles.commentActions}>
                <button type="button" disabled={busy || !text.trim()} onClick={() => void submit(text)}>
                  {busy ? "保存中…" : "提交"}
                </button>
                <button type="button" onClick={close}>取消</button>
                {comment ? (
                  <button type="button" className={styles.commentDelete} disabled={busy}
                    onClick={() => void submit("")}>删除</button>
                ) : null}
              </span>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}
