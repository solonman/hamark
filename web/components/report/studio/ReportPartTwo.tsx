"use client";

import { REPORT_MODELS, type ReportAnnotation } from "@/lib/report-structure";
import type { CaseReviewComment } from "@/lib/case-review";
import ReportFieldItem, { type ReportFinalFieldExtras } from "./ReportFieldItem";
import { ReportSelect } from "./ReportSelect";
import { ReportFinalTraceFootnote } from "./ReportFinalTrace";
import type { ReportFinalFieldTrace } from "@/lib/report-final-trace";
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
  /** 集成版专属，见 `ReportPartOne` 同名 prop 的注释。 */
  finalExtras?: (targetKey: string) => ReportFinalFieldExtras;
  /**
   * "报告模型"是固定候选下拉（`ReportSelect`），没有 `after` 插槽可以直接挂
   * 溯源来源链，所以额外单独要一份原始 trace 数据，自己在下拉旁边渲染
   * `ReportFinalTraceFootnote`；`canAdoptFinal`/`onAdoptFinal` 是它渲染
   * "未纳入·采纳这一版"要用的权限与回调。三者都不传时（普通版本、没有集成版
   * 这回事）什么额外的东西都不渲染，行为跟以前一样。
   */
  modelFinalTrace?: ReportFinalFieldTrace;
  canAdoptFinal?: boolean;
  onAdoptFinal?: (intakeId: string) => void;
};

export default function ReportPartTwo({
  annotation, readOnly, onChange, review, finalExtras, modelFinalTrace, canAdoptFinal = false, onAdoptFinal,
}: ReportPartTwoProps) {
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
        {...(finalExtras?.("strategy.narrative") ?? {})}
      />
      {(() => {
        const modelExtras = finalExtras?.("strategy.model") ?? {};
        return (
          <div className={styles.item}>
            <small>报告模型</small>
            <ReportSelect
              value={annotation.strategy.model}
              onChange={(next) => patchStrategy({ model: next })}
              options={REPORT_MODELS}
              disabled={readOnly}
              locked={modelExtras.locked}
              title={modelExtras.sourceHint ? `${modelExtras.locked ? "集成版只有老孙可以编辑" : "点击编辑"} · 来自 ${modelExtras.sourceHint}` : undefined}
              ariaLabel="报告模型"
            />
            {modelFinalTrace ? (
              <ReportFinalTraceFootnote
                trace={modelFinalTrace}
                canAdopt={canAdoptFinal}
                onAdopt={(intakeId) => onAdoptFinal?.(intakeId)}
              />
            ) : null}
          </div>
        );
      })()}
    </div>
  );
}
