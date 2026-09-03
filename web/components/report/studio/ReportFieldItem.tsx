"use client";

import type { ReactNode } from "react";
import V19EditableValue, { type V19EditableKind } from "@/components/v04/V19EditableValue";
import V19ReviewComment from "@/components/v04/V19ReviewComment";
import type { CaseReviewComment } from "@/lib/case-review";
import styles from "./ReportStudio.module.css";

/**
 * 第一、二部分共用的一格：标签（可选带评论入口）＋ 原位编辑的值。
 * 直接复用 `V19EditableValue`（点击进入编辑，失焦提交）与 `V19ReviewComment`
 * （只有自由填写的条目才传 `review`——固定选项字段不传，天然没有评论入口，
 * 对应规格 2.4「固定选项条目无评论入口」）。
 *
 * `V19ReviewComment` 的新契约（`docs/20_..._V0.1.md` 一）把评论从「一个条目一条」
 * 改成「一个条目在所有版本上各写的一条，汇总展示」——报告侧口径照抄：`comments`
 * 是这个条目在报告所有版本上的评论列表，`currentVersionId` 决定哪一条高亮「本版」。
 */
export type ReportFieldItemReview = {
  targetKey: string;
  targetLabel?: string;
  canReview: boolean;
  comments: readonly CaseReviewComment[];
  currentVersionId: string | null;
  disabled?: boolean;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

export type ReportFieldItemProps = {
  label: string;
  kind?: V19EditableKind;
  value: string;
  placeholder?: string;
  wide?: boolean;
  readOnly: boolean;
  onCommit: (next: string) => void;
  review?: ReportFieldItemReview;
  /**
   * 集成版专属，直接透传给 `V19EditableValue`（规格五、16/18/19，见
   * `docs/21_报告集成版_实施规格_V0.1.md`）：`locked` 是"看得见、点了也不会
   * 进编辑态"的锁定视觉（非老孙看集成版）；`sourceHint` 是默认视图 hover
   * 标题追加的"来自 vN·谁 时间"；`after` 是溯源视图挂在正文下方的来源链。
   * 不传时字段行为与之前完全一样（普通版本，没有集成版这回事）。
   */
  locked?: boolean;
  sourceHint?: string;
  after?: ReactNode;
};

/** `locked`/`sourceHint`/`after` bundled together — what `ReportStudioClient`'s per-field lookup returns and `ReportPartOne`/`ReportPartTwo` spread straight into each `ReportFieldItem`. */
export type ReportFinalFieldExtras = { locked?: boolean; sourceHint?: string; after?: ReactNode };

export default function ReportFieldItem({
  label,
  kind = "text",
  value,
  placeholder = "待填写",
  wide = false,
  readOnly,
  onCommit,
  review,
  locked,
  sourceHint,
  after,
}: ReportFieldItemProps) {
  return (
    <div className={[styles.item, wide ? styles.wide : ""].filter(Boolean).join(" ")}>
      <small>
        {label}
        {review ? (
          <V19ReviewComment
            targetKey={review.targetKey}
            targetLabel={review.targetLabel ?? label}
            comments={review.comments}
            currentVersionId={review.currentVersionId}
            canReview={review.canReview}
            disabled={review.disabled}
            onSave={review.onSave}
          />
        ) : null}
      </small>
      <V19EditableValue
        value={value}
        kind={kind}
        block={kind === "textarea"}
        placeholder={placeholder}
        readOnly={readOnly}
        locked={locked}
        sourceHint={sourceHint}
        after={after}
        ariaLabel={label}
        onCommit={onCommit}
      />
    </div>
  );
}
