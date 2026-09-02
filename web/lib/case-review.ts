// 作业评审的纯逻辑与类型：谁能评、评什么、评在哪个条目上。
// 不碰数据库，浏览器和服务端共用；写库的部分在 lib/case-review-server.ts。

import { CASE_RATING_MAX_STARS } from "@/lib/case-engagement";

export { CASE_RATING_MAX_STARS };

/**
 * 评审身份。评分与评论都只开放给这一个人，其他人只读。
 * 与 `app_admins` 的做法一致，用显示名判定——这套系统里的身份就是企微姓名。
 */
export const CASE_REVIEWER_NAME = "老孙";

export function isCaseReviewer(displayName: string | null | undefined): boolean {
  return (displayName ?? "").trim() === CASE_REVIEWER_NAME;
}

/** 一条评论最多写多少字。写不下的应该当面说，不该塞进一个悬浮框。 */
export const CASE_REVIEW_COMMENT_MAX_LENGTH = 800;

/**
 * 评论锚点。第一、三模块用与变更集相同的稳定字段键（facts.* / path.*），
 * 第二模块整段评在桥段和镜头上，所以另起两个前缀。
 */
export const CASE_REVIEW_TARGETS = {
  bridge: (bridgeId: string) => `bridge:${bridgeId}`,
  shot: (shotId: string) => `shot:${shotId}`,
  primaryPathDetail: (pathId: string, index: number) => `path.primaryDetails.${pathId}.${index}`,
  auxiliaryPath: (pathId: string) => `path.auxiliary.${pathId}`,
} as const;

export type CaseReviewComment = {
  targetKey: string;
  targetLabel: string;
  body: string;
  authorName: string;
  updatedAt: string;
  /** 这条评论锚定在哪一版上——普通版本或集成版。 */
  versionId: string;
  /** 给人看的版本标签：`v2` 或 `集成版`。 */
  versionLabel: string;
};

export type CaseReviewModel = {
  /** 当前访问者能不能写。为假时前端只渲染已有评论，不出现任何输入入口。 */
  canReview: boolean;
  versionId: string | null;
  stars: number | null;
  /** 当前 `versionId` 能不能评分——集成版不评分，星级只锚定个人版本。 */
  canRate: boolean;
  /** 该条目在所有版本上的评论，按写入时间升序。 */
  comments: CaseReviewComment[];
};

export function emptyCaseReview(canReview = false, versionId: string | null = null): CaseReviewModel {
  return { canReview, versionId, stars: null, canRate: true, comments: [] };
}

/**
 * 星级只接受 1–5；0 表示撤销评分，其余一律拒绝。
 * `null`／`undefined` 不当作 0——那多半是请求体写错了，不是有人想撤回评分。
 */
export function normalizeReviewStars(value: unknown): number {
  const stars = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(stars) || stars < 0 || stars > CASE_RATING_MAX_STARS) {
    throw new Error(`评分只能是 0（撤销）到 ${CASE_RATING_MAX_STARS} 之间的整数。`);
  }
  return stars;
}

/** 评论正文：去空白后为空表示删除这条评论。 */
export function normalizeReviewComment(value: unknown): string {
  const body = typeof value === "string" ? value.trim() : "";
  if (body.length > CASE_REVIEW_COMMENT_MAX_LENGTH) {
    throw new Error(`评论最多 ${CASE_REVIEW_COMMENT_MAX_LENGTH} 字。`);
  }
  return body;
}

/**
 * 按条目分组，组内按写入时间升序——一个条目现在可能挂着好几个版本各写的一条,
 * 不再是「一个条目一条」。分组顺序遵循传入顺序，组内显式再排一次序，
 * 不依赖调用方已经排好。
 */
export function commentsByTarget(
  comments: readonly CaseReviewComment[],
): Map<string, CaseReviewComment[]> {
  const grouped = new Map<string, CaseReviewComment[]>();
  for (const comment of comments) {
    const list = grouped.get(comment.targetKey);
    if (list) list.push(comment);
    else grouped.set(comment.targetKey, [comment]);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
  return grouped;
}
