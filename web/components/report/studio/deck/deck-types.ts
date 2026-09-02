// 报告拆解工作台第三部分（ReportDeck）对外契约。字段名与外壳 agent 约定一致，
// 改动需双方同步（见 docs/19_报告逆向工程_实施规格_V0.1.md §6.2）。

import type { ReportPageView } from "@/lib/report-model";
import type { ReportAnnotation } from "@/lib/report-structure";

export type DeckReviewComment = { body: string; authorName: string; updatedAt: string };

export type ReportDeckProps = {
  pages: ReportPageView[];
  annotation: ReportAnnotation;
  /** 看别人的版本：一切修改禁用，浮层/modal 以只读打开。 */
  readOnly: boolean;
  /** 每次变化给一个全新的不可变对象（外壳负责撤销/重做与保存）。 */
  onChange: (next: ReportAnnotation) => void;
  review: {
    /** 老孙为 true。 */
    canReview: boolean;
    /** 以 targetKey 索引。 */
    comments: Record<string, DeckReviewComment>;
    /** body 空串 = 删除。 */
    onComment: (targetKey: string, targetLabel: string, body: string) => Promise<void>;
  };
};

export type ReportMindMapButtonProps = {
  annotation: ReportAnnotation;
  pages: ReportPageView[];
};
