"use client";

import { useCallback, useEffect, useState } from "react";
import type { AnalysisComment } from "@/lib/types";

export default function AuthorRevisionTasks({ snapshotId }: { snapshotId: string }) {
  const [comments, setComments] = useState<AnalysisComment[]>([]);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/analyses/${snapshotId}/comments`, { cache: "no-store" });
    const data = (await response.json()) as { comments?: AnalysisComment[]; error?: string };
    if (!response.ok) throw new Error(data.error || "待处理批注读取失败");
    setComments((data.comments ?? []).filter((comment) => comment.status !== "RESOLVED"));
  }, [snapshotId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load().catch((error) => setNotice(error instanceof Error ? error.message : "待处理批注读取失败"));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  function focusTarget(targetKey: string) {
    const target = document.querySelector<HTMLElement>(
      `[data-edit-target="${CSS.escape(targetKey)}"]`,
    );
    if (!target) {
      setNotice("对应字段当前未显示，请先打开相关条件项后再定位。");
      return;
    }
    setNotice("");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-author-comment-target");
    target.querySelector<HTMLElement>("textarea, input, select, button")?.focus({ preventScroll: true });
    window.setTimeout(() => target.classList.remove("is-author-comment-target"), 2200);
  }

  async function markHandled(commentId: string) {
    setBusyId(commentId);
    setNotice("");
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "AUTHOR_MARKED_HANDLED" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "批注状态更新失败");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "批注状态更新失败");
    } finally {
      setBusyId(null);
    }
  }

  if (!comments.length && !notice) return null;
  return (
    <section className="author-revision-tasks" aria-labelledby="author-revision-title">
      <header>
        <div>
          <p className="eyebrow">RETURNED FOR REVISION</p>
          <h2 id="author-revision-title">本轮待处理批注</h2>
        </div>
        <span>{comments.length} 条未由终审解决</span>
      </header>
      {notice ? <p className="notice error">{notice}</p> : null}
      <div>
        {comments.map((comment) => (
          <article key={comment.id}>
            <button type="button" className="author-comment-location" onClick={() => focusTarget(comment.targetKey)}>
              <strong>{comment.targetLabel}</strong>
              <span>定位到内容项 ↘</span>
            </button>
            <p>{comment.body}</p>
            {comment.selectedText ? <blockquote>“{comment.selectedText}”</blockquote> : null}
            <footer>
              <span>{comment.authorName} · {comment.status === "AUTHOR_MARKED_HANDLED" ? "作者已处理，等待终审" : "待处理"}</span>
              {comment.status !== "AUTHOR_MARKED_HANDLED" ? (
                <button type="button" disabled={busyId === comment.id} onClick={() => void markHandled(comment.id)}>
                  标记为已处理
                </button>
              ) : null}
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
