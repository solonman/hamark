"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { V04UiDraft } from "@/lib/v04-ui-model";
import { locateV04Target, v04StableTargetToDomId } from "@/lib/v04-ui-client-state";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import styles from "./V04Surface.module.css";

type CommentItem = {
  id: string;
  moduleLabel: string;
  targetKey: string;
  targetLabel: string;
  originalExcerpt: string;
  body: string;
  authorName: string;
  status: string;
};

export type V04CommentComposeTarget = {
  targetKey: string;
  targetLabel: string;
  moduleLabel: string;
  originalExcerpt?: string;
};

export default function V04CommentDrawer({ videoId, open, onClose, onLocate, readOnly = false, draft, composeTarget }: { videoId: string; open: boolean; onClose: () => void; onLocate?: (id: string) => void; readOnly?: boolean; draft?: V04UiDraft; composeTarget?: V04CommentComposeTarget | null }) {
  const tabToken = useRef(`v04-comments-${crypto.randomUUID()}`);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const reload = useCallback(() => v04UiApi.comments<{ comments: CommentItem[] }>(videoId, tabToken.current)
    .then((value) => { setComments(value.comments); setError(""); })
    .catch((reason: unknown) => setError(reason instanceof V04UiApiError ? reason.message : "批注暂时无法读取。")), [videoId]);
  useEffect(() => { if (open) void reload(); }, [open, reload]);
  if (!open) return null;
  return <aside className={styles.drawer} aria-label="全部批注任务"><header><h2>全部批注任务</h2><button onClick={onClose}>关闭</button></header>{error && <p role="alert">{error}</p>}{comments.map((comment) => <article key={comment.id}><b>{comment.moduleLabel}</b><strong>{comment.targetLabel}</strong><span>原文：{comment.originalExcerpt || "（空）"}</span><p>{comment.body}</p><small>{comment.authorName} · {comment.status}</small><button type="button" onClick={() => { const id = v04StableTargetToDomId(comment.targetKey, draft); if (onLocate) onLocate(id); else void locateV04Target(id); }}>定位科目</button>{!readOnly && comment.status !== "AUTHOR_MARKED_HANDLED" && <button type="button" onClick={() => { void v04UiApi.updateComment(videoId, comment.id, { status: "AUTHOR_MARKED_HANDLED" }, `comment-status-${crypto.randomUUID()}`).then(reload); }}>标记已处理</button>}</article>)}{!comments.length && !error && <p>尚无批注。</p>}{!readOnly && composeTarget && <section className={styles.commentComposer}><small>{composeTarget.moduleLabel}</small><strong>{composeTarget.targetLabel}</strong><p>原文：{composeTarget.originalExcerpt?.trim() || "（空）"}</p><label>添加字段批注<textarea value={body} onChange={(event) => setBody(event.target.value)} /></label><button type="button" disabled={!body.trim() || saving} onClick={() => { setSaving(true); void v04UiApi.createComment(videoId, { targetKey: composeTarget.targetKey, targetLabel: composeTarget.targetLabel, body }, `comment-create-${crypto.randomUUID()}`).then(() => { setBody(""); return reload(); }).finally(() => setSaving(false)); }}>{saving ? "正在添加…" : "添加批注"}</button></section>}{!readOnly && !composeTarget && <p>请从具体科目旁的“批注”进入，批注会精确绑定当前字段。</p>}</aside>;
}
