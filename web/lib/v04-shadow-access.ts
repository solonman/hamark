export type V04ShadowAccessDecision =
  | { allowed: true; reason: "STABLE_USER_ALLOWLIST" }
  | { allowed: false; reason: "SHADOW_DISABLED" | "STABLE_USER_NOT_ALLOWED" };

export function isV04ShadowEnabled(value = process.env.V04_UI_SHADOW_ENABLED) {
  return value === "true";
}

export function parseV04ShadowReviewerUserIds(
  value = process.env.V04_UI_SHADOW_REVIEWER_USER_IDS,
) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function decideV04ShadowAccess(input: {
  enabled?: string;
  reviewerUserIds?: string;
  stableUserId: string;
}): V04ShadowAccessDecision {
  if (!isV04ShadowEnabled(input.enabled)) {
    return { allowed: false, reason: "SHADOW_DISABLED" };
  }
  const reviewers = parseV04ShadowReviewerUserIds(input.reviewerUserIds);
  if (!reviewers.has(input.stableUserId)) {
    return { allowed: false, reason: "STABLE_USER_NOT_ALLOWED" };
  }
  return { allowed: true, reason: "STABLE_USER_ALLOWLIST" };
}
