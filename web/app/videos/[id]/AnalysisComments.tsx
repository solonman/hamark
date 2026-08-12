"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { formatLongDate } from "@/lib/date-format";
import type {
  AnalysisComment,
  AnalysisCommentKind,
  AnalysisRevisionSuggestion,
} from "@/lib/types";

type TextAnchor = {
  targetKey: string;
  targetLabel: string;
  targetValue: string;
  selectedText: string;
  anchorStart: number;
  anchorEnd: number;
  x: number;
  y: number;
  placement: "above" | "below";
};

type ComposerState = TextAnchor & {
  mode: "COMMENT" | "REVISION";
  parentId?: string;
};

type AnnotationRecord =
  | { type: "comment"; id: string; comment: AnalysisComment }
  | {
      type: "suggestion";
      id: string;
      suggestion: AnalysisRevisionSuggestion;
    };

type HoverCardState = {
  records: AnnotationRecord[];
  x: number;
  y: number;
  placement: "above" | "below";
};

type InlineAnnotationContextValue = {
  canCreate: boolean;
  recordsFor: (targetKey: string) => AnnotationRecord[];
  openCellComposer: (
    mode: "COMMENT" | "REVISION",
    input: Omit<TextAnchor, "selectedText" | "anchorStart" | "anchorEnd">,
  ) => void;
  openSelection: (anchor: TextAnchor) => void;
  showHoverCard: (records: AnnotationRecord[], rect: DOMRect) => void;
  scheduleHoverCardClose: () => void;
};

const InlineAnnotationContext =
  createContext<InlineAnnotationContextValue | null>(null);

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(
      `/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
    return true;
  }
  return false;
}

function floatingPosition(rect: DOMRect) {
  const width = Math.min(420, window.innerWidth - 24);
  const placement: "above" | "below" =
    rect.bottom + 280 > window.innerHeight && rect.top > 280
      ? "above"
      : "below";
  return {
    x: Math.min(window.innerWidth - width / 2 - 12, Math.max(width / 2 + 12, rect.left + rect.width / 2)),
    y: placement === "above" ? Math.max(12, rect.top - 10) : rect.bottom + 10,
    placement,
  };
}

function selectionAnchor(
  targetKey: string,
  targetLabel: string,
  targetValue: string,
  copy: HTMLElement,
  selection: Selection,
): TextAnchor | null {
  if (!selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!copy.contains(range.startContainer) || !copy.contains(range.endContainer)) {
    return null;
  }
  const rawText = range.toString();
  const leadingWhitespace = rawText.length - rawText.trimStart().length;
  const selectedText = rawText.trim().slice(0, 600);
  if (!selectedText) return null;
  const before = range.cloneRange();
  before.selectNodeContents(copy);
  before.setEnd(range.startContainer, range.startOffset);
  const anchorStart = before.toString().length + leadingWhitespace;
  const anchorEnd = anchorStart + selectedText.length;
  if (targetValue.slice(anchorStart, anchorEnd) !== selectedText) return null;
  const position = floatingPosition(range.getBoundingClientRect());
  return {
    targetKey,
    targetLabel,
    targetValue,
    selectedText,
    anchorStart,
    anchorEnd,
    ...position,
  };
}

function recordRange(record: AnnotationRecord, value: string) {
  const item = record.type === "comment" ? record.comment : record.suggestion;
  if (
    !item.selectedText ||
    item.anchorStart < 0 ||
    item.anchorEnd <= item.anchorStart ||
    value.slice(item.anchorStart, item.anchorEnd) !== item.selectedText
  ) {
    return null;
  }
  return { start: item.anchorStart, end: item.anchorEnd };
}

function decoratedSegments(value: string, records: AnnotationRecord[]) {
  const ranges = records.flatMap((record) => {
    const range = recordRange(record, value);
    return range ? [{ record, ...range }] : [];
  });
  if (!ranges.length || !value) {
    return [{ start: 0, end: value.length, records: [] as AnnotationRecord[] }];
  }
  const boundaries = Array.from(
    new Set([0, value.length, ...ranges.flatMap((range) => [range.start, range.end])]),
  ).sort((a, b) => a - b);
  const segments = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return {
      start,
      end,
      records: ranges
        .filter((range) => range.start <= start && range.end >= end)
        .map((range) => range.record),
    };
  });
  return segments.filter((segment) => segment.end > segment.start);
}

function recordIds(records: AnnotationRecord[]) {
  return records.map((record) => record.id).sort().join(":");
}

export function InlineAnnotationText({
  targetKey,
  targetLabel,
  value,
  emptyText = "—",
  className = "",
}: {
  targetKey: string;
  targetLabel: string;
  value: string;
  emptyText?: string;
  className?: string;
}) {
  const context = useContext(InlineAnnotationContext);
  const copyRef = useRef<HTMLSpanElement | null>(null);
  if (!context) {
    return <span className={className}>{value || emptyText}</span>;
  }

  const records = context.recordsFor(targetKey);
  const segments = decoratedSegments(value, records);
  const rangedIds = new Set(
    segments.flatMap((segment) => segment.records.map((record) => record.id)),
  );
  const cellRecords = records.filter((record) => !rangedIds.has(record.id));

  function handleMouseUp() {
    const selection = window.getSelection();
    const copy = copyRef.current;
    if (!selection || !copy) return;
    const anchor = selectionAnchor(
      targetKey,
      targetLabel,
      value,
      copy,
      selection,
    );
    if (anchor) context?.openSelection(anchor);
  }

  function openCell(mode: "COMMENT" | "REVISION", event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget.closest<HTMLElement>(
      "[data-inline-annotation-target]",
    );
    const rect = target?.getBoundingClientRect() ??
      event.currentTarget.getBoundingClientRect();
    const position = floatingPosition(rect);
    context?.openCellComposer(mode, {
      targetKey,
      targetLabel,
      targetValue: value,
      ...position,
    });
  }

  return (
    <span
      className={`inline-annotation-target ${records.length ? "has-inline-annotations" : ""} ${className}`.trim()}
      data-inline-annotation-target={targetKey}
    >
      <span
        ref={copyRef}
        className="inline-annotation-copy"
        onMouseUp={handleMouseUp}
      >
        {value
          ? segments.map((segment) => {
              const text = value.slice(segment.start, segment.end);
              if (!segment.records.length) return text;
              const hasSuggestion = segment.records.some(
                (record) => record.type === "suggestion",
              );
              return (
                <mark
                  className={`inline-text-mark ${hasSuggestion ? "is-revision" : "is-comment"}`}
                  key={`${segment.start}-${segment.end}-${recordIds(segment.records)}`}
                  tabIndex={0}
                  onMouseEnter={(event) =>
                    context.showHoverCard(
                      segment.records,
                      event.currentTarget.getBoundingClientRect(),
                    )
                  }
                  onFocus={(event) =>
                    context.showHoverCard(
                      segment.records,
                      event.currentTarget.getBoundingClientRect(),
                    )
                  }
                  onBlur={context.scheduleHoverCardClose}
                  onMouseLeave={context.scheduleHoverCardClose}
                >
                  {text}
                </mark>
              );
            })
          : emptyText}
      </span>
      {context.canCreate ? <span className="inline-annotation-entry-actions" aria-label={`${targetLabel}操作`}>
        <button type="button" onClick={(event) => openCell("COMMENT", event)}>
          批注
        </button>
        <button type="button" onClick={(event) => openCell("REVISION", event)}>
          修订
        </button>
        {cellRecords.length ? (
          <button
            type="button"
            className="inline-annotation-count"
            aria-label={`${cellRecords.length} 条整项批注或修订`}
            onMouseEnter={(event) =>
              context.showHoverCard(
                cellRecords,
                event.currentTarget.getBoundingClientRect(),
              )
            }
            onFocus={(event) =>
              context.showHoverCard(
                cellRecords,
                event.currentTarget.getBoundingClientRect(),
              )
            }
            onBlur={context.scheduleHoverCardClose}
            onMouseLeave={context.scheduleHoverCardClose}
          >
            {cellRecords.length}
          </button>
        ) : null}
      </span> : null}
      {records
        .filter((record) => record.type === "suggestion")
        .map((record) => {
          const revision = record.type === "suggestion" ? record.suggestion : null;
          if (!revision) return null;
          const verb = revision.editType === "DELETE"
            ? "删除"
            : revision.editType === "INSERT"
              ? "补充"
              : "修订为";
          const display = revision.editType === "DELETE"
            ? revision.selectedText
            : revision.replacementText;
          return (
            <span className="inline-revision-trace" key={`trace-${record.id}`}>
              [{revision.authorName}{revision.actorRole === "FINAL_REVIEWER" ? "｜终审" : ""}{verb}：{display}
              {revision.reason ? `（原因：${revision.reason}）` : ""}]
            </span>
          );
        })}
    </span>
  );
}

export default function AnalysisComments({
  snapshotId,
  taxonomyVersion,
  children,
}: {
  snapshotId: string;
  taxonomyVersion: string;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  const [comments, setComments] = useState<AnalysisComment[]>([]);
  const [suggestions, setSuggestions] = useState<AnalysisRevisionSuggestion[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [canDecide, setCanDecide] = useState(false);
  const [canReviewV03, setCanReviewV03] = useState(false);
  const [selection, setSelection] = useState<TextAnchor | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [commentKind, setCommentKind] =
    useState<AnalysisCommentKind>("COMMENT");
  const [replacementText, setReplacementText] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const loadAnnotations = useCallback(async () => {
    try {
      const [commentResponse, suggestionResponse, reviewResponse] = await Promise.all([
        fetch(`/api/analyses/${snapshotId}/comments`, { cache: "no-store" }),
        fetch(`/api/analyses/${snapshotId}/suggestions`, { cache: "no-store" }),
        taxonomyVersion === "V0.3-PILOT"
          ? fetch(`/api/analyses/${snapshotId}/review`, { cache: "no-store" })
          : Promise.resolve(null),
      ]);
      if (
        redirectOnUnauthorized(commentResponse) ||
        redirectOnUnauthorized(suggestionResponse) ||
        (reviewResponse ? redirectOnUnauthorized(reviewResponse) : false)
      ) {
        return;
      }
      const commentData = (await commentResponse.json()) as {
        comments?: AnalysisComment[];
        isAdmin?: boolean;
        error?: string;
      };
      const suggestionData = (await suggestionResponse.json()) as {
        suggestions?: AnalysisRevisionSuggestion[];
        canDecide?: boolean;
        error?: string;
      };
      const reviewData = reviewResponse
        ? (await reviewResponse.json()) as {
            review?: { canReview?: boolean };
            error?: string;
          }
        : null;
      if (!commentResponse.ok) {
        throw new Error(commentData.error || "批注读取失败");
      }
      if (!suggestionResponse.ok) {
        throw new Error(suggestionData.error || "修订建议读取失败");
      }
      if (reviewResponse && !reviewResponse.ok) {
        throw new Error(reviewData?.error || "审核状态读取失败");
      }
      setComments(commentData.comments ?? []);
      setSuggestions(suggestionData.suggestions ?? []);
      setIsAdmin(Boolean(commentData.isAdmin));
      setCanDecide(Boolean(suggestionData.canDecide));
      setCanReviewV03(Boolean(reviewData?.review?.canReview));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批注读取失败");
    }
  }, [snapshotId, taxonomyVersion]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadAnnotations(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadAnnotations]);

  const recordsByTarget = useMemo(() => {
    const result = new Map<string, AnnotationRecord[]>();
    for (const comment of comments) {
      const current = result.get(comment.targetKey) ?? [];
      current.push({ type: "comment", id: comment.id, comment });
      result.set(comment.targetKey, current);
    }
    for (const suggestion of suggestions) {
      const current = result.get(suggestion.targetKey) ?? [];
      current.push({
        type: "suggestion",
        id: suggestion.id,
        suggestion,
      });
      result.set(suggestion.targetKey, current);
    }
    return result;
  }, [comments, suggestions]);

  function openComposer(mode: "COMMENT" | "REVISION", anchor: TextAnchor) {
    setSelection(null);
    setComposer({ ...anchor, mode });
    setCommentBody("");
    setCommentKind("COMMENT");
    setReplacementText(
      mode === "REVISION" ? anchor.selectedText || anchor.targetValue : "",
    );
    setRevisionReason("");
  }

  const contextValue: InlineAnnotationContextValue = {
    canCreate: taxonomyVersion === "V0.3-PILOT" && canReviewV03,
    recordsFor: (targetKey) => recordsByTarget.get(targetKey) ?? [],
    openCellComposer: (mode, input) =>
      openComposer(mode, {
        ...input,
        selectedText: mode === "REVISION" ? input.targetValue : "",
        anchorStart: mode === "REVISION" ? 0 : -1,
        anchorEnd: mode === "REVISION" ? input.targetValue.length : -1,
      }),
    openSelection: (anchor) => {
      if (taxonomyVersion === "V0.3-PILOT" && !isAdmin) return;
      setComposer(null);
      setSelection(anchor);
    },
    showHoverCard: (records, rect) => {
      if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
      const position = floatingPosition(rect);
      setHoverCard({ records, ...position });
    },
    scheduleHoverCardClose: () => {
      if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = window.setTimeout(() => setHoverCard(null), 220);
    },
  };

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
            ? { parentId, body, kind: "COMMENT" }
            : {
                targetKey: composer?.targetKey,
                targetLabel: composer?.targetLabel,
                selectedText: composer?.selectedText,
                anchorStart: composer?.anchorStart,
                anchorEnd: composer?.anchorEnd,
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
      await loadAnnotations();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批注保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function createSuggestion() {
    if (!composer || composer.mode !== "REVISION") return;
    if (!replacementText.trim()) {
      setNotice("请填写修订后的内容。");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetKey: composer.targetKey,
          targetLabel: composer.targetLabel,
          selectedText: composer.selectedText,
          anchorStart: composer.anchorStart,
          anchorEnd: composer.anchorEnd,
          replacementText,
          reason: revisionReason,
        }),
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        suggestionId?: string;
        canDecide?: boolean;
        error?: string;
      };
      if (!response.ok || !data.suggestionId) {
        throw new Error(data.error || "修订建议保存失败");
      }
      if (taxonomyVersion !== "V0.3-PILOT" && data.canDecide) {
        await decideSuggestion(data.suggestionId, "ACCEPTED", false);
        setNotice("修订已写入个人草稿，发布作业后将生成新的公开版本。");
      } else {
        setNotice(
          taxonomyVersion === "V0.3-PILOT"
            ? "修订已保存到当前终审工作层；退回或批准时才会物化为干净版本。"
            : "修订建议已送达作业作者。",
        );
      }
      setComposer(null);
      window.getSelection()?.removeAllRanges();
      await loadAnnotations();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "修订建议保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function updateComment(
    commentId: string,
    update: {
      status?: "OPEN" | "AUTHOR_MARKED_HANDLED" | "RESOLVED" | "REOPENED";
      isExcellent?: boolean;
    },
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
      await loadAnnotations();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批注更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function decideSuggestion(
    suggestionId: string,
    status: "ACCEPTED" | "REJECTED",
    manageBusy = true,
  ) {
    if (manageBusy) {
      setBusy(true);
      setNotice("");
    }
    try {
      const response = await fetch(
        `/api/analyses/${snapshotId}/suggestions/${suggestionId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "修订建议处理失败");
      if (manageBusy) {
        setNotice(
          status === "ACCEPTED"
            ? "修订已写入个人草稿，待作者发布新版本。"
            : "已保留原文并驳回该修订建议。",
        );
        setHoverCard(null);
        await loadAnnotations();
      }
    } catch (reason) {
      if (!manageBusy) throw reason;
      setNotice(
        reason instanceof Error ? reason.message : "修订建议处理失败",
      );
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  function focusTarget(targetKey: string) {
    const target = contentRef.current?.querySelector<HTMLElement>(
      `[data-inline-annotation-target="${CSS.escape(targetKey)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-annotation-highlight");
    window.setTimeout(() => target.classList.remove("is-annotation-highlight"), 1800);
  }

  const totalRecords = comments.length + suggestions.length;
  const pendingCount = suggestions.filter(
    (suggestion) => suggestion.status === "PENDING" || suggestion.status === "DRAFT",
  ).length;

  return (
    <InlineAnnotationContext.Provider value={contextValue}>
      <section className="analysis-comment-workspace inline-mode">
        {notice ? <p className="analysis-comment-notice">{notice}</p> : null}
        <div ref={contentRef} className="analysis-comment-content">
          {children}
        </div>
        {totalRecords ? (
          <details className="inline-annotation-overview">
            <summary>
              全部批注与修订 · {totalRecords}
              {pendingCount ? ` · 待处理 ${pendingCount}` : ""}
            </summary>
            <div>
              {[...comments, ...suggestions].map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => focusTarget(item.targetKey)}
                >
                  <strong>{item.targetLabel}</strong>
                  <span>
                    {"body" in item ? item.body : `修订为：${item.replacementText}`}
                  </span>
                </button>
              ))}
            </div>
          </details>
        ) : null}

        {selection && contextValue.canCreate ? (
          <div
            className={`inline-selection-toolbar is-${selection.placement}`}
            style={{ left: selection.x, top: selection.y }}
            role="toolbar"
            aria-label="所选文字操作"
            onMouseDown={(event) => event.preventDefault()}
          >
            <button type="button" onClick={() => openComposer("COMMENT", selection)}>
              批注
            </button>
            <button type="button" onClick={() => openComposer("REVISION", selection)}>
              修订
            </button>
            <button type="button" aria-label="取消" onClick={() => setSelection(null)}>
              ×
            </button>
          </div>
        ) : null}

        {composer ? (
          <div
            className={`analysis-comment-composer inline-composer is-${composer.placement}`}
            style={{ left: composer.x, top: composer.y }}
            role="dialog"
            aria-label={composer.mode === "COMMENT" ? "添加批注" : "添加修订"}
          >
            <header>
              <div>
                <span>{composer.targetLabel}</span>
                {composer.selectedText ? (
                  <small>“{composer.selectedText}”</small>
                ) : (
                  <small>整项内容</small>
                )}
              </div>
              <button type="button" onClick={() => setComposer(null)} aria-label="关闭">
                ×
              </button>
            </header>
            {composer.mode === "COMMENT" ? (
              <>
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
                  placeholder="写下对这段内容的判断…"
                />
                <button
                  type="button"
                  className="button button-accent compact"
                  disabled={busy}
                  onClick={() => void createComment()}
                >
                  保存批注
                </button>
              </>
            ) : (
              <>
                <label className="inline-revision-field">
                  <span>修订为</span>
                  <textarea
                    autoFocus
                    rows={4}
                    value={replacementText}
                    onChange={(event) => setReplacementText(event.target.value)}
                  />
                </label>
                <label className="inline-revision-field">
                  <span>原因（选填）</span>
                  <textarea
                    rows={2}
                    value={revisionReason}
                    onChange={(event) => setRevisionReason(event.target.value)}
                    placeholder="如有必要，说明为什么这样改…"
                  />
                </label>
                <button
                  type="button"
                  className="button button-accent compact"
                  disabled={busy}
                  onClick={() => void createSuggestion()}
                >
                  {taxonomyVersion === "V0.3-PILOT"
                    ? "保存到终审工作层"
                    : canDecide
                      ? "保存并写入修订草稿"
                      : "提交修订建议"}
                </button>
              </>
            )}
          </div>
        ) : null}

        {hoverCard ? (
          <div
            className={`inline-annotation-popover is-${hoverCard.placement}`}
            style={{ left: hoverCard.x, top: hoverCard.y }}
            onMouseEnter={() => {
              if (hoverCloseTimer.current) {
                window.clearTimeout(hoverCloseTimer.current);
              }
            }}
            onMouseLeave={contextValue.scheduleHoverCardClose}
          >
            {hoverCard.records.map((record) =>
              record.type === "comment" ? (
                <article key={record.id}>
                  <header>
                    <strong>
                      {record.comment.kind === "EXPERT_NOTE" ? "专家精修" : "批注"}
                    </strong>
                    <span>{record.comment.authorName}</span>
                  </header>
                  <p>{record.comment.body}</p>
                  {record.comment.replies.map((reply) => (
                    <small key={reply.id}>
                      {reply.authorName}：{reply.body}
                    </small>
                  ))}
                  <time>{formatLongDate(record.comment.createdAt)}</time>
                  <label className="inline-popover-reply">
                    <input
                      value={replyDrafts[record.id] ?? ""}
                      onChange={(event) =>
                        setReplyDrafts((current) => ({
                          ...current,
                          [record.id]: event.target.value,
                        }))
                      }
                      placeholder="回复这条批注"
                    />
                    <button type="button" onClick={() => void createComment(record.id)}>
                      回复
                    </button>
                  </label>
                  <div className="inline-popover-actions">
                    {record.comment.canResolve ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void updateComment(record.id, {
                            status: record.comment.status === "RESOLVED" ? "REOPENED" : "RESOLVED",
                          })
                        }
                      >
                        {record.comment.status === "RESOLVED" ? "重新打开" : "终审解决"}
                      </button>
                    ) : null}
                    {record.comment.canMarkHandled && record.comment.status !== "AUTHOR_MARKED_HANDLED" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void updateComment(record.id, { status: "AUTHOR_MARKED_HANDLED" })}
                      >
                        作者标记已处理
                      </button>
                    ) : null}
                    {isAdmin ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void updateComment(record.id, {
                            isExcellent: !record.comment.isExcellent,
                          })
                        }
                      >
                        {record.comment.isExcellent ? "取消优秀" : "标记优秀"}
                      </button>
                    ) : null}
                  </div>
                </article>
              ) : (
                <article className="is-revision" key={record.id}>
                  <header>
                    <strong>{taxonomyVersion === "V0.3-PILOT" ? "终审修订" : "修订建议"}</strong>
                    <span>{record.suggestion.authorName}</span>
                  </header>
                  <div className="inline-revision-diff">
                    <del>{record.suggestion.selectedText || "（空白）"}</del>
                    <ins>{record.suggestion.replacementText || "（删除）"}</ins>
                  </div>
                  {record.suggestion.reason ? <p>原因：{record.suggestion.reason}</p> : null}
                  <time>
                    {record.suggestion.status === "DRAFT"
                      ? "终审工作层 · 尚未批准"
                      : record.suggestion.status === "APPLIED"
                        ? "已物化到干净版本"
                        : record.suggestion.status === "PENDING"
                      ? "待处理"
                      : record.suggestion.status === "ACCEPTED"
                        ? `已接受 · 草稿修订 ${record.suggestion.appliedRevision ?? ""}`
                        : "已驳回"}
                  </time>
                  {record.suggestion.canDecide &&
                  record.suggestion.status === "PENDING" ? (
                    <div className="inline-popover-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decideSuggestion(record.id, "ACCEPTED")}
                      >
                        接受并写入草稿
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decideSuggestion(record.id, "REJECTED")}
                      >
                        驳回
                      </button>
                    </div>
                  ) : null}
                </article>
              ),
            )}
          </div>
        ) : null}
      </section>
    </InlineAnnotationContext.Provider>
  );
}
