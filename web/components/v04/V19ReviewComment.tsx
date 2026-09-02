"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CASE_REVIEW_COMMENT_MAX_LENGTH, type CaseReviewComment } from "@/lib/case-review";
import styles from "./V04Surface.module.css";

/**
 * 条目上的评论按钮。平时藏起来，鼠标划过条目才浮现；有评论就一直亮着，
 * 本版有评论时描边实色——因为「这里有话」本身就是作者要看见的信息，
 * 而「本版有话」是他自己写的这一版被说过什么。
 *
 * 气泡汇总这个条目在**所有版本**上的评论（`docs/20_..._V0.1.md` 一之 A）：
 * 每条前缀写在哪一版，属于当前版本的那条高亮「本版」。只有老孙能写，
 * 写下去锚定当前正在看的版本；他在本版没写过时看到输入区，本版已经写过
 * 则那条有「编辑」（清空即删除）；别版的条目对他是「切到该版可改」，
 * 对其他人一律「只读」。没有任何版本评论过、又不是老孙 → 不渲染。
 */
export type V19ReviewCommentProps = {
  targetKey: string;
  targetLabel: string;
  /** 该条目在所有版本上的评论，按写入时间升序。 */
  comments: readonly CaseReviewComment[];
  /** 当前正在看的版本 id（含最终版）；决定哪一条是「本版」。 */
  currentVersionId: string | null;
  canReview: boolean;
  /** 版本还没落库时无处可锚定。 */
  disabled?: boolean;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

type PanelMode = "CLOSED" | "READING" | "EDITING";

export default function V19ReviewComment({
  targetKey,
  targetLabel,
  comments,
  currentVersionId,
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

  if (!comments.length && !canReview) return null;

  // 老孙在本版写过的那一条——本版有就编辑它，没有就新写一条。
  const mine = canReview ? comments.find((item) => item.versionId === currentVersionId) : undefined;
  const hereHasComment = comments.some((item) => item.versionId === currentVersionId);

  const startEditing = () => {
    setText(mine?.body ?? "");
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

  const openReading = () => {
    // 本版没写过时气泡里带一份空白输入区；本版写过就带上它的正文,
    // 免得上一次没提交的草稿糊在这次打开的框里。
    setText(mine?.body ?? "");
    setMode("READING");
  };

  const handleClick = () => {
    if (mode !== "CLOSED") {
      close();
      return;
    }
    if (comments.length) {
      setPinned(true);
      openReading();
      return;
    }
    startEditing();
  };

  const showWritePanel = canReview && (mode === "EDITING" || !hereHasComment);

  return (
    <span
      ref={anchorRef}
      className={styles.commentAnchor}
      onMouseEnter={() => { if (comments.length && mode === "CLOSED") openReading(); }}
      onMouseLeave={() => { if (mode === "READING" && !pinned) setMode("CLOSED"); }}
    >
      <button
        type="button"
        className={styles.commentMarker}
        data-has-comment={comments.length ? "true" : undefined}
        data-here={hereHasComment ? "true" : undefined}
        data-open={mode === "CLOSED" ? undefined : "true"}
        aria-expanded={mode !== "CLOSED"}
        aria-label={comments.length ? `查看「${targetLabel}」的评论` : `给「${targetLabel}」写评论`}
        title={comments.length ? `${comments.length} 条评论${hereHasComment ? "（含本版）" : ""}` : "写评论"}
        onClick={handleClick}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M2.4 3.4h11.2v7.4H7.2L4.3 13.2v-2.4H2.4z"
            fill={comments.length ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        {comments.length ? <span>{comments.length}</span> : null}
      </button>

      {mode !== "CLOSED" ? (
        <span className={styles.commentPopover} role="dialog">
          <b>{targetLabel}｜{comments.length} 条 · 各版本汇总</b>
          <span className={styles.commentList}>
            {comments.map((item) => {
              const here = item.versionId === currentVersionId;
              const isMine = canReview && here;
              return (
                <span key={`${item.versionId}:${item.updatedAt}`} className={styles.commentItem} data-here={here ? "true" : undefined}>
                  <span className={styles.commentItemHead}>
                    <span className={styles.commentVersionTag} data-here={here ? "true" : undefined}>
                      {item.versionLabel}{here ? "·本版" : ""}
                    </span>
                    <b>{item.authorName}</b>
                    <span className={styles.commentItemTime}>{item.updatedAt}</span>
                    {isMine ? (
                      <button type="button" onClick={startEditing}>编辑</button>
                    ) : (
                      <span className={styles.commentReadonly}>{here ? "只读" : (canReview ? "切到该版可改" : "只读")}</span>
                    )}
                  </span>
                  <span className={styles.commentBody}>{item.body}</span>
                </span>
              );
            })}
            {!comments.length ? <span className={styles.commentNone}>「{targetLabel}」在各版本上都还没有评论。</span> : null}
          </span>

          {showWritePanel ? (
            disabled ? (
              <span className={styles.commentBody}>这一版还没有保存过内容，保存后才能评论。</span>
            ) : (
              <span className={styles.commentWrite}>
                <textarea
                  ref={textareaRef}
                  value={text}
                  maxLength={CASE_REVIEW_COMMENT_MAX_LENGTH}
                  placeholder={`写给本版的「${targetLabel}」…`}
                  aria-label={`${targetLabel} 的评论`}
                  onChange={(event) => setText(event.target.value)}
                  onFocus={() => { if (mode !== "EDITING") { setPinned(true); setMode("EDITING"); } }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(text);
                  }}
                />
                {error ? <em role="alert">{error}</em> : null}
                <span className={styles.commentActions}>
                  <span className={styles.commentWriteHint}>{mine ? "修改本版评论；清空即删除" : "锚定本版，一个条目一条"}</span>
                  <button type="button" className={styles.commentSubmit} disabled={busy || (!text.trim() && !mine)} onClick={() => void submit(text)}>
                    {busy ? "保存中…" : (mine ? "保存" : "发布")}
                  </button>
                </span>
              </span>
            )
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
