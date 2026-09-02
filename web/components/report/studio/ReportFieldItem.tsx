"use client";

import V19EditableValue, { type V19EditableKind } from "@/components/v04/V19EditableValue";
import V19ReviewComment from "@/components/v04/V19ReviewComment";
import type { CaseReviewComment } from "@/lib/case-review";
import styles from "./ReportStudio.module.css";

/**
 * 第一、二部分共用的一格：标签（可选带评论入口）＋ 原位编辑的值。
 * 直接复用 `V19EditableValue`（点击进入编辑，失焦提交）与 `V19ReviewComment`
 * （只有自由填写的条目才传 `review`——固定选项字段不传，天然没有评论入口，
 * 对应规格 2.4「固定选项条目无评论入口」）。
 */
export type ReportFieldItemReview = {
  targetKey: string;
  targetLabel?: string;
  canReview: boolean;
  comment?: CaseReviewComment;
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
};

export default function ReportFieldItem({
  label,
  kind = "text",
  value,
  placeholder = "待填写",
  wide = false,
  readOnly,
  onCommit,
  review,
}: ReportFieldItemProps) {
  return (
    <div className={[styles.item, wide ? styles.wide : ""].filter(Boolean).join(" ")}>
      <small>
        {label}
        {review ? (
          <V19ReviewComment
            targetKey={review.targetKey}
            targetLabel={review.targetLabel ?? label}
            comment={review.comment}
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
        ariaLabel={label}
        onCommit={onCommit}
      />
    </div>
  );
}
