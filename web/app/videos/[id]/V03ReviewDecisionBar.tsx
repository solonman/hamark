"use client";

import { useEffect, useState } from "react";
import type { AnalysisReviewContext, CreativeGrade } from "@/lib/types";

export default function V03ReviewDecisionBar({
  snapshotId,
  initialReview = null,
  mode = "review",
}: {
  snapshotId: string;
  initialReview?: AnalysisReviewContext | null;
  mode?: "review" | "author";
}) {
  const [review, setReview] = useState<AnalysisReviewContext | null>(initialReview);
  const [grade, setGrade] = useState<CreativeGrade>("");
  const [qualityGrade, setQualityGrade] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [validationIssues, setValidationIssues] = useState<Array<{ targetKey: string; message: string }>>([]);

  useEffect(() => {
    let active = true;
    fetch(`/api/analyses/${snapshotId}/review`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { review?: AnalysisReviewContext; error?: string };
        if (!response.ok || !data.review) throw new Error(data.error || "审核状态读取失败");
        if (active) setReview(data.review);
      })
      .catch((error) => active && setNotice(error instanceof Error ? error.message : "审核状态读取失败"));
    return () => { active = false; };
  }, [snapshotId]);

  async function decide(action: "RETURN" | "APPROVE" | "WITHDRAW") {
    if (action === "APPROVE" && !grade) {
      setNotice("批准入库前请选择专家作品创意等级。");
      return;
    }
    setBusy(true);
    setNotice("");
    setValidationIssues([]);
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          decisionNote,
          expertCreativeGrade: grade,
          assignmentQualityGrade: qualityGrade,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        releaseNumber?: number;
        issues?: Array<{ targetKey: string; message: string }>;
      };
      if (data.issues?.length) setValidationIssues(data.issues);
      if (!response.ok) throw new Error(data.error || "审核操作失败");
      setNotice(
        action === "APPROVE"
          ? `已批准为活动标准版 R${data.releaseNumber}。`
          : action === "RETURN"
            ? "候选已退回共享协作轮；所有成员都可以继续修订。"
            : "已撤回候选，可以继续共享修订。",
      );
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "审核操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (!review && !notice) return <div className="v031-review-bar">正在读取审核状态…</div>;
  const round = review?.round;
  const active = Boolean(round && ["PENDING", "IN_REVIEW"].includes(round.status));
  return (
    <section className={`v031-review-bar is-${mode}`} aria-label={mode === "review" ? "专家定稿" : "候选状态"}>
      <div className="v031-review-status">
        <strong>{round ? `专家定稿候选 ${round.roundNumber}` : "尚未建立定稿候选"}</strong>
        <span>{round?.status ?? "—"}</span>
        {review?.activeReleaseNumber ? <span>当前标准版 R{review.activeReleaseNumber}</span> : null}
      </div>
      {mode === "review" && review?.isFinalReviewer && active ? (
        <div className="v031-review-controls">
          <label>
            <span>专家作品创意等级</span>
            <select value={grade} onChange={(event) => setGrade(event.target.value as CreativeGrade)}>
              <option value="">批准时选择</option>
              {(["S", "A", "B", "C"] as const).map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            <span>作业质量评级（选填）</span>
            <input value={qualityGrade} onChange={(event) => setQualityGrade(event.target.value)} placeholder="待量表冻结后规范" />
          </label>
          <label className="wide">
            <span>定稿结论（选填）</span>
            <input value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="退回重点或批准说明" />
          </label>
          <button className="button button-ghost" disabled={busy} onClick={() => void decide("RETURN")}>退回共享修订</button>
          <button className="button button-accent" disabled={busy} onClick={() => void decide("APPROVE")}>专家定稿</button>
        </div>
      ) : null}
      {mode === "author" && review?.canWithdraw ? (
        <button className="button button-ghost compact" disabled={busy} onClick={() => void decide("WITHDRAW")}>撤回并继续修订</button>
      ) : null}
      {notice ? <p className="analysis-comment-notice">{notice}</p> : null}
      {validationIssues.length ? (
        <div className="approval-validation-issues" role="alert">
          <strong>批准前需修正 {validationIssues.length} 个结构问题</strong>
          <ul>{validationIssues.map((issue) => <li key={`${issue.targetKey}:${issue.message}`}><code>{issue.targetKey}</code><span>{issue.message}</span></li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}
