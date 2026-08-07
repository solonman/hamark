"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { formatLongDate } from "@/lib/date-format";
import type {
  AnalysisComment,
  AnalysisCommentKind,
} from "@/lib/types";

type ComposerState = {
  targetKey: string;
  targetLabel: string;
  selectedText: string;
  x: number;
  y: number;
};

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(
      `/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
    return true;
  }
  return false;
}

function targetElementFromNode(node: Node | null) {
  const element =
    node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest<HTMLElement>("[data-annotation-target]") ?? null;
}

export default function AnalysisComments({
  snapshotId,
  children,
}: {
  snapshotId: string;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [comments, setComments] = useState<AnalysisComment[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentKind, setCommentKind] =
    useState<AnalysisCommentKind>("COMMENT");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const loadComments = useCallback(async () => {
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/comments`, {
        cache: "no-store",
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        comments?: AnalysisComment[];
        isAdmin?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "批注读取失败");
      setComments(data.comments ?? []);
      setIsAdmin(Boolean(data.isAdmin));
      setNotice("");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批注读取失败");
    }
  }, [snapshotId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/analyses/${snapshotId}/comments`, { cache: "no-store" })
      .then(async (response) => {
        if (redirectOnUnauthorized(response)) return;
        const data = (await response.json()) as {
          comments?: AnalysisComment[];
          isAdmin?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "批注读取失败");
        if (active) {
          setComments(data.comments ?? []);
          setIsAdmin(Boolean(data.isAdmin));
          setNotice("");
        }
      })
      .catch((reason) => {
        if (active) {
          setNotice(reason instanceof Error ? reason.message : "批注读取失败");
        }
      });
    return () => {
      active = false;
    };
  }, [snapshotId]);

  function openComposer(target: HTMLElement, selectedText = "", rect?: DOMRect) {
    const box = rect ?? target.getBoundingClientRect();
    setComposer({
      targetKey: target.dataset.annotationTarget ?? "",
      targetLabel: target.dataset.annotationLabel ?? "所选内容",
      selectedText: selectedText.trim().slice(0, 600),
      x: Math.min(window.innerWidth - 24, Math.max(24, box.left + box.width / 2)),
      y: Math.min(window.innerHeight - 24, Math.max(24, box.bottom + 8)),
    });
    setCommentBody("");
    setCommentKind("COMMENT");
    setDrawerOpen(true);
  }

  function handleContentMouseUp() {
    if (!annotationMode) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!selection || !text || selection.rangeCount === 0) return;
    const target = targetElementFromNode(selection.anchorNode);
    if (!target || !contentRef.current?.contains(target)) return;
    openComposer(target, text, selection.getRangeAt(0).getBoundingClientRect());
  }

  function handleContentClick(event: MouseEvent<HTMLDivElement>) {
    if (!annotationMode || window.getSelection()?.toString().trim()) return;
    const clicked = event.target as HTMLElement;
    if (clicked.closest("button, a, input, textarea, select, summary")) return;
    const target = clicked.closest<HTMLElement>("[data-annotation-target]");
    if (target) openComposer(target);
  }

  async function createComment(parentId?: string) {
    const body = parentId ? replyDrafts[parentId] ?? "" : commentBody;
    if (!body.trim()) {
      setNotice(parentId ? "请填写回复内容。" : "请填写批注内容。");
      return;
    }
    if (!parentId && !composer) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          parentId
            ? { parentId, body, kind: isAdmin ? commentKind : "COMMENT" }
            : {
                targetKey: composer?.targetKey,
                targetLabel: composer?.targetLabel,
                selectedText: composer?.selectedText,
                body,
                kind: commentKind,
              },
        ),
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "批注保存失败");
      if (parentId) {
        setReplyDrafts((current) => ({ ...current, [parentId]: "" }));
      } else {
        setComposer(null);
        setCommentBody("");
        window.getSelection()?.removeAllRanges();
      }
      await loadComments();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批注保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function updateComment(
    commentId: string,
    update: { status?: "OPEN" | "RESOLVED"; isExcellent?: boolean },
  ) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(
        `/api/analyses/${snapshotId}/comments/${commentId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        },
      );
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "批注更新失败");
      await loadComments();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批注更新失败");
    } finally {
      setBusy(false);
    }
  }

  function focusTarget(targetKey: string) {
    const targets = contentRef.current?.querySelectorAll<HTMLElement>(
      "[data-annotation-target]",
    );
    const target = [...(targets ?? [])].find(
      (candidate) => candidate.dataset.annotationTarget === targetKey,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-annotation-highlight");
    window.setTimeout(() => target.classList.remove("is-annotation-highlight"), 1800);
  }

  const openCount = comments.filter((comment) => comment.status === "OPEN").length;

  return (
    <section
      className={`analysis-comment-workspace ${drawerOpen ? "is-open" : ""} ${annotationMode ? "is-annotating" : ""}`}
    >
      <div className="analysis-comment-toolbar">
        <div>
          <strong>修订与批注</strong>
          <span>选中文字或点击内容块，批注会绑定当前公开版本。</span>
        </div>
        <button
          type="button"
          className={annotationMode ? "is-active" : ""}
          onClick={() => {
            setAnnotationMode((current) => !current);
            setDrawerOpen(true);
          }}
        >
          {annotationMode ? "退出批注模式" : "开启批注模式"}
        </button>
        <button
          type="button"
          onClick={() => setDrawerOpen((current) => !current)}
        >
          批注 {comments.length}{openCount ? ` · 待处理 ${openCount}` : ""}
        </button>
      </div>

      <div className="analysis-comment-layout">
        <div
          ref={contentRef}
          className="analysis-comment-content"
          onMouseUp={handleContentMouseUp}
          onClick={handleContentClick}
        >
          {children}
        </div>

        {drawerOpen ? (
          <aside className="analysis-comment-drawer" aria-label="作业原位批注">
            <header>
              <div>
                <span>当前公开版本</span>
                <strong>{comments.length} 条批注</strong>
              </div>
              <button
                type="button"
                aria-label="关闭批注栏"
                onClick={() => setDrawerOpen(false)}
              >
                ×
              </button>
            </header>
            {notice ? <p className="analysis-comment-notice">{notice}</p> : null}
            {comments.length ? (
              <div className="analysis-comment-list">
                {comments.map((comment) => (
                  <article
                    key={comment.id}
                    className={`${comment.status === "RESOLVED" ? "is-resolved" : ""} ${comment.isExcellent ? "is-excellent" : ""}`}
                  >
                    <button
                      type="button"
                      className="analysis-comment-target"
                      onClick={() => focusTarget(comment.targetKey)}
                    >
                      {comment.isExcellent ? "★ 优秀片段 · " : ""}
                      {comment.targetLabel}
                    </button>
                    {comment.selectedText ? (
                      <blockquote>“{comment.selectedText}”</blockquote>
                    ) : null}
                    <p>{comment.body}</p>
                    <div className="analysis-comment-meta">
                      <span>
                        {comment.kind === "EXPERT_NOTE" ? "专家精修 · " : ""}
                        {comment.authorName} · {formatLongDate(comment.createdAt)}
                      </span>
                    </div>
                    {comment.replies.map((reply) => (
                      <div className="analysis-comment-reply" key={reply.id}>
                        <strong>{reply.authorName}</strong>
                        <p>{reply.body}</p>
                      </div>
                    ))}
                    <label className="analysis-comment-reply-box">
                      <span>回复</span>
                      <textarea
                        rows={2}
                        value={replyDrafts[comment.id] ?? ""}
                        onChange={(event) =>
                          setReplyDrafts((current) => ({
                            ...current,
                            [comment.id]: event.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void createComment(comment.id)}
                      >
                        发送回复
                      </button>
                    </label>
                    <div className="analysis-comment-actions">
                      {comment.canResolve ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void updateComment(comment.id, {
                              status:
                                comment.status === "OPEN" ? "RESOLVED" : "OPEN",
                            })
                          }
                        >
                          {comment.status === "OPEN" ? "标为已解决" : "重新打开"}
                        </button>
                      ) : null}
                      {isAdmin ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void updateComment(comment.id, {
                              isExcellent: !comment.isExcellent,
                            })
                          }
                        >
                          {comment.isExcellent ? "取消优秀标记" : "标记优秀片段"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="analysis-comment-empty">
                <strong>还没有批注</strong>
                <p>开启批注模式，选中文字或点击一个镜头组／字段即可开始。</p>
              </div>
            )}
          </aside>
        ) : null}
      </div>

      {composer ? (
        <div
          className="analysis-comment-composer"
          style={{ left: composer.x, top: composer.y }}
          role="dialog"
          aria-label="添加原位批注"
        >
          <header>
            <div>
              <span>{composer.targetLabel}</span>
              {composer.selectedText ? <small>“{composer.selectedText}”</small> : null}
            </div>
            <button type="button" onClick={() => setComposer(null)} aria-label="关闭">
              ×
            </button>
          </header>
          {isAdmin ? (
            <label className="analysis-comment-kind">
              <span>批注类型</span>
              <select
                value={commentKind}
                onChange={(event) =>
                  setCommentKind(event.target.value as AnalysisCommentKind)
                }
              >
                <option value="COMMENT">普通批注</option>
                <option value="EXPERT_NOTE">专家精修意见</option>
              </select>
            </label>
          ) : null}
          <textarea
            autoFocus
            rows={4}
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
            placeholder="写下判断、修订建议或值得保留的原因…"
          />
          <button
            type="button"
            className="button button-accent compact"
            disabled={busy}
            onClick={() => void createComment()}
          >
            保存批注
          </button>
        </div>
      ) : null}
    </section>
  );
}
