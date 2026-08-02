"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  REVIEW_MAX_SCORE,
  REVIEW_RUBRIC_VERSION,
  calculateReviewTotal,
  reviewScoreItems,
} from "@/lib/review-rubric";
import type {
  AssignmentReviewAggregate,
  AssignmentReviewDraft,
} from "@/lib/types";

type ReviewResponse = {
  review?: AssignmentReviewDraft;
  aggregate?: AssignmentReviewAggregate;
  isSelf?: boolean;
  error?: string;
};

type ReviewContextValue = {
  review: AssignmentReviewDraft;
  updateScore: (code: string, value: number | null) => void;
};

const ReviewContext = createContext<ReviewContextValue | null>(null);

function ScoreGuide({ label, guide }: { label: string; guide: string }) {
  return (
    <span
      className="score-guide-wrap"
      aria-label={`${label}评分指南`}
    >
      <span className="score-guide-trigger">评分指南</span>
      <span className="score-guide" role="tooltip">
        <strong>{REVIEW_RUBRIC_VERSION}</strong>
        {guide}
      </span>
    </span>
  );
}

export function InlineReviewScore({
  code,
  hideLabel = false,
}: {
  code: string;
  hideLabel?: boolean;
}) {
  const context = useContext(ReviewContext);
  const item = reviewScoreItems.find((candidate) => candidate.code === code);
  if (!context || !item) return null;
  const value = context.review.scores[item.code];
  const invalid =
    typeof value === "number" && (value < 0 || value > item.maxScore);

  return (
    <div className={`inline-review-score ${invalid ? "invalid" : ""}`}>
      <div className="inline-review-score-copy">
        {hideLabel ? null : <strong>{item.label}</strong>}
        <ScoreGuide label={item.label} guide={item.guide} />
      </div>
      <label>
        <input
          type="number"
          min="0"
          max={item.maxScore}
          step="0.5"
          value={value ?? ""}
          onChange={(event) =>
            context.updateScore(
              item.code,
              event.target.value === "" ? null : Number(event.target.value),
            )
          }
          aria-label={`${item.label}得分`}
        />
        <span>/ {item.maxScore}</span>
      </label>
    </div>
  );
}

export function InlineReviewScoreGroup({
  title,
  codes,
}: {
  title: string;
  codes: string[];
}) {
  const context = useContext(ReviewContext);
  if (!context) return null;
  return (
    <section className="inline-review-group" aria-label={title}>
      <div className="inline-review-group-head">
        <span>原位评分</span>
        <strong>{title}</strong>
      </div>
      <div className="inline-review-group-grid">
        {codes.map((code) => (
          <InlineReviewScore code={code} key={code} />
        ))}
      </div>
    </section>
  );
}

export default function ReviewPanel({
  snapshotId,
  onClose,
  children,
}: {
  snapshotId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [review, setReview] = useState<AssignmentReviewDraft | null>(null);
  const [aggregate, setAggregate] = useState<AssignmentReviewAggregate | null>(
    null,
  );
  const [isSelf, setIsSelf] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [notice, setNotice] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const reviewRef = useRef<AssignmentReviewDraft | null>(null);
  const editSequence = useRef(0);

  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  useEffect(() => {
    let active = true;
    fetch(`/api/analyses/${snapshotId}/score`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as ReviewResponse;
        if (!response.ok || !data.review || !data.aggregate) {
          throw new Error(data.error || "评分读取失败");
        }
        if (active) {
          setReview(data.review);
          setAggregate(data.aggregate);
          setIsSelf(Boolean(data.isSelf));
        }
      })
      .catch((reason) => {
        if (active) {
          setNotice(reason instanceof Error ? reason.message : "评分读取失败");
          setSaveState("error");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [snapshotId]);

  const markReviewChanged = useCallback((next: AssignmentReviewDraft) => {
    editSequence.current += 1;
    reviewRef.current = next;
    setReview(next);
    setDirty(true);
    setSaveState("idle");
    setNotice("");
    setMissing([]);
  }, []);

  const updateScore = useCallback(
    (code: string, value: number | null) => {
      const current = reviewRef.current;
      if (!current) return;
      const scores = { ...current.scores, [code]: value };
      markReviewChanged({
        ...current,
        status: "DRAFT",
        scores,
        totalScore: calculateReviewTotal(scores),
      });
    },
    [markReviewChanged],
  );

  const saveReview = useCallback(async () => {
    const current = reviewRef.current;
    if (!current) return null;
    const sequenceAtStart = editSequence.current;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/score`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });
      const data = (await response.json()) as {
        error?: string;
        reviewId?: string;
        revision?: number;
        totalScore?: number;
        isValidForAggregate?: boolean;
        updatedAt?: string;
      };
      if (!response.ok || !data.reviewId || data.revision === undefined) {
        throw new Error(data.error || "保存评分失败");
      }
      const saved: AssignmentReviewDraft = {
        ...current,
        id: data.reviewId,
        revision: data.revision,
        status: "DRAFT",
        totalScore: data.totalScore ?? current.totalScore,
        isValidForAggregate:
          data.isValidForAggregate ?? current.isValidForAggregate,
        updatedAt: data.updatedAt ?? new Date().toISOString(),
      };
      setReview((latest) =>
        latest
          ? {
              ...latest,
              id: saved.id,
              revision: saved.revision,
              updatedAt: saved.updatedAt,
            }
          : saved,
      );
      if (editSequence.current === sequenceAtStart) {
        setDirty(false);
        setSaveState("saved");
      } else {
        setSaveState("idle");
      }
      return saved;
    } catch (reason) {
      setSaveState("error");
      setNotice(reason instanceof Error ? reason.message : "保存评分失败");
      return null;
    }
  }, [snapshotId]);

  useEffect(() => {
    if (!dirty || saveState === "saving") return;
    const timer = window.setTimeout(() => {
      void saveReview();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [dirty, saveReview, saveState]);

  const scoredCount = review
    ? reviewScoreItems.filter(
        (item) => typeof review.scores[item.code] === "number",
      ).length
    : 0;
  const scoreErrors = review
    ? reviewScoreItems.filter((item) => {
        const value = review.scores[item.code];
        return typeof value === "number" && (value < 0 || value > item.maxScore);
      })
    : [];

  async function submitReview() {
    setMissing([]);
    const current = reviewRef.current;
    const saved = dirty || !current?.id ? await saveReview() : current;
    if (!saved) return;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/analyses/${snapshotId}/score`, {
        method: "POST",
      });
      const data = (await response.json()) as {
        error?: string;
        missing?: string[];
        totalScore?: number;
        isValidForAggregate?: boolean;
      };
      if (!response.ok) {
        setMissing(data.missing ?? []);
        throw new Error(data.error || "提交评分失败");
      }
      setReview({
        ...saved,
        status: "SUBMITTED",
        totalScore: data.totalScore ?? saved.totalScore,
        isValidForAggregate:
          data.isValidForAggregate ?? saved.isValidForAggregate,
      });
      setDirty(false);
      setSaveState("saved");
      setNotice(
        data.isValidForAggregate === false
          ? "自评分已保存为练习记录，不计入同行均分。"
          : "评分已正式提交，并进入同行评分统计。",
      );
    } catch (reason) {
      setSaveState("error");
      setNotice(reason instanceof Error ? reason.message : "提交评分失败");
    }
  }

  const context = review ? { review, updateScore } : null;

  return (
    <ReviewContext.Provider value={context}>
      <section className="inline-review-session" aria-label="原位百分制作业评分">
        <header className="inline-review-toolbar">
          <div className="inline-review-total">
            <span>原位批改</span>
            <strong>{review ? review.totalScore.toFixed(1) : "—"}</strong>
            <small>/ {REVIEW_MAX_SCORE}</small>
          </div>
          <p>
            {loading
              ? "正在载入评分…"
              : `已评 ${scoredCount}/${reviewScoreItems.length} · ${
                  dirty || saveState === "saving"
                    ? "自动保存中"
                    : saveState === "error"
                      ? "保存失败"
                      : "评分草稿已保存"
                }`}
            {aggregate?.validReviewCount
              ? ` · 同行均分 ${aggregate.averageScore?.toFixed(1)}`
              : ""}
            {isSelf ? " · 自评不计入均分" : ""}
          </p>
          <button type="button" className="text-button" onClick={onClose}>
            退出批改
          </button>
        </header>

        {notice ? (
          <div className={`review-notice ${saveState === "error" ? "error" : ""}`}>
            {notice}
          </div>
        ) : null}
        {missing.length ? (
          <div className="review-notice error">
            <strong>正式提交前还需完成：</strong>
            <p>{missing.join("、")}</p>
          </div>
        ) : null}

        {children}

        {review ? (
          <footer className="inline-review-finish">
            <div>
              <p className="eyebrow">FINAL COMMENT</p>
              <h4>完成这次批改</h4>
              <p>各项分数已随内容原位保存，最后补充整体意见即可提交。</p>
            </div>
            <label className="inline-review-comment">
              <span>总体批语</span>
              <textarea
                rows={4}
                value={review.generalComment}
                onChange={(event) =>
                  markReviewChanged({
                    ...review,
                    status: "DRAFT",
                    generalComment: event.target.value,
                  })
                }
                placeholder="指出最值得肯定的部分，以及下一步怎样改进。"
              />
            </label>
            <div className="inline-review-finish-actions">
              <label className="review-nomination">
                <input
                  type="checkbox"
                  checked={review.discussionNomination}
                  onChange={(event) =>
                    markReviewChanged({
                      ...review,
                      status: "DRAFT",
                      discussionNomination: event.target.checked,
                    })
                  }
                />
                推荐进入周／双周创意讨论
              </label>
              <span>
                {review.status === "SUBMITTED"
                  ? `已提交评分 · 修订 ${review.revision}`
                  : `评分自动保存 · 修订 ${review.revision}`}
              </span>
              <button
                type="button"
                className="button button-accent"
                onClick={() => void submitReview()}
                disabled={saveState === "saving" || scoreErrors.length > 0}
              >
                提交正式评分
              </button>
            </div>
          </footer>
        ) : null}
      </section>
    </ReviewContext.Provider>
  );
}
