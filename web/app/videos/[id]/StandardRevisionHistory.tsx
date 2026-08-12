"use client";

import { useState } from "react";
import type { AnalysisComment, AnalysisRevisionSuggestion } from "@/lib/types";
import { formatLongDate } from "@/lib/date-format";

function revisionValue(revision: AnalysisRevisionSuggestion, side: "before" | "after") {
  const structured = side === "before" ? revision.originalValue : revision.replacementValue;
  if (structured !== undefined) return Array.isArray(structured) ? structured.join(" · ") : structured;
  if (side === "before") return revision.selectedText || "（空）";
  return revision.editType === "DELETE" ? "（删除）" : revision.replacementText || "（空）";
}

export default function StandardRevisionHistory({ releaseId }: { releaseId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [revisions, setRevisions] = useState<AnalysisRevisionSuggestion[]>([]);
  const [comments, setComments] = useState<AnalysisComment[]>([]);
  const [round, setRound] = useState<{ roundNumber: number; reviewerName: string | null; decisionNote: string | null; decidedAt: string | null } | null>(null);

  async function load() {
    if (open) {
      setOpen(false);
      return;
    }
    if (revisions.length || comments.length) {
      setOpen(true);
      return;
    }
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch(`/api/approved-standards/${releaseId}/history`, { cache: "no-store" });
      const data = (await response.json()) as {
        revisions?: AnalysisRevisionSuggestion[];
        comments?: AnalysisComment[];
        reviewRound?: { roundNumber: number; reviewerName: string | null; decisionNote: string | null; decidedAt: string | null };
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "修订历史读取失败");
      setRevisions(data.revisions ?? []);
      setComments(data.comments ?? []);
      setRound(data.reviewRound ?? null);
      setOpen(true);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "修订历史读取失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="standard-revision-history">
      <button type="button" className="text-button" disabled={loading} onClick={() => void load()}>
        {loading ? "读取中…" : open ? "收起批注与修订历史" : "查看本标准版的批注与修订历史"}
      </button>
      {notice ? <p className="analysis-comment-notice">{notice}</p> : null}
      {open ? (
        <div className="standard-revision-history-list">
          {round ? <p className="standard-history-round">终审轮次 {round.roundNumber} · {round.reviewerName ?? "未记录终审者"}{round.decidedAt ? ` · ${formatLongDate(round.decidedAt)}` : ""}{round.decisionNote ? ` · ${round.decisionNote}` : ""}</p> : null}
          {!revisions.length && !comments.length ? <p>本轮没有保存批注或修订。</p> : null}
          {revisions.map((revision) => (
            <article key={revision.id}>
              <strong>{revision.targetLabel}</strong>
              <span>{revision.authorName} · {revision.actorRole === "FINAL_REVIEWER" ? "终审者" : "作者"} · {revision.editType ?? "UNIT_REPLACE"} · {formatLongDate(revision.createdAt)}{revision.changeSetId ? ` · 联合修订 ${revision.changeSetId.slice(-6)}` : ""}</span>
              <p><del>{revisionValue(revision, "before")}</del><b> → </b><ins>{revisionValue(revision, "after")}</ins></p>
              {revision.reason ? <small>原因：{revision.reason}</small> : null}
            </article>
          ))}
          {comments.filter((comment) => !comment.replies.length).map((comment) => (
            <article key={comment.id}>
              <strong>{comment.targetLabel}</strong>
              <span>{comment.authorName} · {comment.status}</span>
              <p>{comment.body}</p>
              {comment.replies.map((reply) => <p className="standard-history-reply" key={reply.id}><b>{reply.authorName} 回复：</b>{reply.body}</p>)}
              {comment.finalConclusion ? <small>终审结论：{comment.finalConclusion}</small> : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
