"use client";

import Link from "next/link";
import type { ScoreRankingItem } from "@/lib/score-ranking";

type ScoreRankingDialogProps = {
  startDate: string;
  endDate: string;
  items: ScoreRankingItem[];
  onClose: () => void;
};

export default function ScoreRankingDialog({ startDate, endDate, items, onClose }: ScoreRankingDialogProps) {
  return (
    <div className="dialog-backdrop score-ranking-backdrop">
      <section className="score-ranking-dialog" role="dialog" aria-modal="true" aria-labelledby="score-ranking-title">
        <div className="score-ranking-dialog-head">
          <div>
            <p className="eyebrow">ADMIN VIEW</p>
            <h2 id="score-ranking-title">作品评分排行</h2>
            <p>{startDate} — {endDate}</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭评分排行">×</button>
        </div>
        {items.length === 0 ? (
          <p className="score-ranking-empty">这个日期范围内还没有有效评分作业。</p>
        ) : (
          <div className="score-ranking-list">
            {items.map((item, index) => (
              <Link key={item.videoId} href={`/videos/${item.videoId}`} target="_blank" rel="noopener noreferrer" className="score-ranking-row">
                <span className="score-ranking-position">{String(index + 1).padStart(2, "0")}</span>
                <span className="score-ranking-work">
                  <strong>{item.title}</strong>
                  <small>{item.brand || "未标注品牌"} · {item.validReviewCount} 份有效评分</small>
                </span>
                <span className="score-ranking-score">{item.averageScore.toFixed(1)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
