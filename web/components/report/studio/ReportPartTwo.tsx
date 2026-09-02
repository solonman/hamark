"use client";

import { REPORT_MODELS, type ReportAnnotation } from "@/lib/report-structure";
import type { CaseReviewComment } from "@/lib/case-review";
import ReportFieldItem from "./ReportFieldItem";
import { ReportSelect } from "./ReportSelect";
import styles from "./ReportStudio.module.css";

/**
 * 第二部分｜竞争与提报策略。字段清单见规格 2.2：竞争与提报策略（多行、自由填写，
 * 有评论入口）、报告模型（下拉，四选一固定候选，没有评论入口）。
 */

export type ReportPartTwoReview = {
  canReview: boolean;
  disabled: boolean;
  /** 每个条目在报告所有版本上的评论列表，见 `ReportFieldItem.tsx` 顶部注释。 */
  comments: ReadonlyMap<string, CaseReviewComment[]>;
  /** 当前正在看的版本 id，用来判定 `comments` 里哪一条是「本版」。 */
  currentVersionId: string | null;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

export type ReportPartTwoProps = {
  annotation: ReportAnnotation;
  readOnly: boolean;
  onChange: (next: ReportAnnotation) => void;
  review: ReportPartTwoReview;
};

export default function ReportPartTwo({ annotation, readOnly, onChange, review }: ReportPartTwoProps) {
  const patchStrategy = (patch: Partial<ReportAnnotation["strategy"]>) => {
    onChange({ ...annotation, strategy: { ...annotation.strategy, ...patch } });
  };

  return (
    <div className={styles.form2}>
      <ReportFieldItem
        label="竞争与提报策略"
        kind="textarea"
        wide
        placeholder="填写竞争判断、提报路径与关键取舍"
        value={annotation.strategy.narrative}
        readOnly={readOnly}
        onCommit={(next) => patchStrategy({ narrative: next })}
        review={{
          targetKey: "strategy.narrative",
          targetLabel: "竞争与提报策略",
          canReview: review.canReview,
          comments: review.comments.get("strategy.narrative") ?? [],
          currentVersionId: review.currentVersionId,
          disabled: review.disabled,
          onSave: review.onSave,
        }}
      />
      <div className={styles.item}>
        <small>报告模型</small>
        <ReportSelect
          value={annotation.strategy.model}
          onChange={(next) => patchStrategy({ model: next })}
          options={REPORT_MODELS}
          disabled={readOnly}
          ariaLabel="报告模型"
        />
      </div>
    </div>
  );
}
