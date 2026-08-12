import type { AnalysisReviewContext, AnalysisWorkflowStatus } from "./types";

export type ReviewEntryState =
  | "V02_READ_ONLY"
  | "ENTER_REVIEW"
  | "AUTHOR_EDIT"
  | "AUTHOR_NEW_ROUND"
  | "APPROVED_READ_ONLY"
  | "WAITING_AUTHOR"
  | "WAITING_REVIEW"
  | "PUBLIC_READ_ONLY";

export function resolveReviewEntry(input: {
  taxonomyVersion: string;
  workflowStatus?: AnalysisWorkflowStatus;
  review?: AnalysisReviewContext;
}): ReviewEntryState {
  if (input.taxonomyVersion === "V0.2") return "V02_READ_ONLY";
  if (input.review?.canReview) return "ENTER_REVIEW";
  if (
    input.review?.isAuthor &&
    (input.workflowStatus === "CHANGES_REQUESTED" ||
      input.review.round?.status === "CHANGES_REQUESTED")
  ) {
    return "AUTHOR_EDIT";
  }
  if (
    input.workflowStatus === "APPROVED" ||
    input.review?.round?.status === "APPROVED"
  ) {
    return input.review?.isAuthor ? "AUTHOR_NEW_ROUND" : "APPROVED_READ_ONLY";
  }
  if (input.review?.round?.status === "CHANGES_REQUESTED") return "WAITING_AUTHOR";
  if (
    input.workflowStatus === "PENDING_REVIEW" ||
    input.workflowStatus === "PENDING_REREVIEW" ||
    input.review?.round?.status === "PENDING" ||
    input.review?.round?.status === "IN_REVIEW"
  ) {
    return "WAITING_REVIEW";
  }
  return "PUBLIC_READ_ONLY";
}
