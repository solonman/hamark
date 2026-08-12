"use client";

import { useEffect, useState } from "react";
import type { AnalysisReviewContext, CreativeGrade } from "@/lib/types";

export default function V03ReviewDecisionBar({ snapshotId }: { snapshotId: string }) {
  const [review, setReview] = useState<AnalysisReviewContext | null>(null);
  const [grade, setGrade] = useState<CreativeGrade>("");
  const [qualityGrade, setQualityGrade] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

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
      const data = (await response.json()) as { error?: string; releaseNumber?: number };
      if (!response.ok) throw new Error(data.error || "审核操作失败");
      setNotice(
        action === "APPROVE"
          ? `已批准为活动标准版 R${data.releaseNumber}。`
          : action === "RETURN"
            ? "已退回作者修改；终审直接修订已进入作者的新草稿。"
            : "已撤回提交，可以继续修改。",
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
    <section className="v031-review-bar" aria-label="V0.3.1 审核工作台">
      <div className="v031-review-status">
        <strong>{round ? `终审轮次 ${round.roundNumber}` : "尚未建立审核轮次"}</strong>
        <span>{round?.status ?? "—"}</span>
        {review?.activeReleaseNumber ? <span>当前标准版 R{review.activeReleaseNumber}</span> : null}
      </div>
      {review?.isFinalReviewer && active ? (
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
            <span>终审结论（选填）</span>
            <input value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="退回重点或批准说明" />
          </label>
          <button className="button button-ghost" disabled={busy} onClick={() => void decide("RETURN")}>退回修改</button>
          <button className="button button-accent" disabled={busy} onClick={() => void decide("APPROVE")}>批准入库</button>
        </div>
      ) : null}
      {review?.isAuthor && round?.status === "PENDING" ? (
        <button className="button button-ghost compact" disabled={busy} onClick={() => void decide("WITHDRAW")}>撤回并继续修订</button>
      ) : null}
      {notice ? <p className="analysis-comment-notice">{notice}</p> : null}
    </section>
  );
}
