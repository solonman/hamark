"use client";

import { useState } from "react";
import { CASE_RATING_MAX_STARS } from "@/lib/case-review";
import styles from "./V04Surface.module.css";

/**
 * 作业评分，摆在正文末尾：读完整份作业才谈得上打分。
 * 分数锚定当前正在看的版本——换版本看到的就是那一版的分数，
 * 案例卡片上显示的也是同一个分数。
 */
export type V19AssignmentRatingProps = {
  stars: number | null;
  canReview: boolean;
  versionLabel: string;
  /** 版本尚未落库（还没保存过任何内容）时无处可锚定。 */
  disabled?: boolean;
  onRate: (stars: number) => Promise<void>;
};

export default function V19AssignmentRating({
  stars,
  canReview,
  versionLabel,
  disabled = false,
  onRate,
}: V19AssignmentRatingProps) {
  const [hovered, setHovered] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slots = Array.from({ length: CASE_RATING_MAX_STARS }, (_, index) => index + 1);
  const shown = hovered || stars || 0;

  const rate = async (value: number) => {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      // 再点一次当前分数就是撤销：打错分要能收回，而不是只能改成另一个错分。
      await onRate(value === stars ? 0 : value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "评分保存失败，请重试。");
    } finally {
      setBusy(false);
      setHovered(0);
    }
  };

  return (
    <section className={styles.assignmentRating} aria-label="作业评分">
      <div className={styles.assignmentRatingMeta}>
        <small>作业评分</small>
        <span>
          {canReview ? "评分锚定" : "本版评分"} {versionLabel}
          {stars ? ` · 已评 ${stars} 星` : canReview ? " · 尚未评分" : " · 尚未评分"}
        </span>
        {error ? <em role="alert">{error}</em> : null}
      </div>
      {canReview ? (
        <div className={styles.ratingStrip} onMouseLeave={() => setHovered(0)}>
          {slots.map((value) => (
            <button
              key={value}
              type="button"
              className={value <= shown ? styles.ratingStarOn : undefined}
              disabled={busy || disabled}
              aria-pressed={stars != null && value <= stars}
              aria-label={value === stars ? `撤销评分（当前 ${stars} 星）` : `评 ${value} 星`}
              title={disabled ? "这一版还没有保存过内容，保存后才能评分" : value === stars ? "再点一次撤销评分" : `评 ${value} 星`}
              onMouseEnter={() => setHovered(value)}
              onFocus={() => setHovered(value)}
              onClick={() => void rate(value)}
            >
              {value <= shown ? "★" : "☆"}
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.ratingStrip} data-readonly="true" aria-label={stars ? `${stars} 星` : "尚未评分"}>
          {slots.map((value) => (
            <span key={value} className={value <= (stars ?? 0) ? styles.ratingStarOn : undefined} aria-hidden>
              {value <= (stars ?? 0) ? "★" : "☆"}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
