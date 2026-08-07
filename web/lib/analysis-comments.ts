export const COMMENT_BODY_MAX_LENGTH = 4000;
export const COMMENT_QUOTE_MAX_LENGTH = 600;
export const COMMENT_TARGET_MAX_LENGTH = 180;

export function normalizeCommentText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function normalizeCommentTarget(value: unknown) {
  const target = normalizeCommentText(value, COMMENT_TARGET_MAX_LENGTH);
  if (!target || !/^[a-z0-9:_-]+$/i.test(target)) return "";
  return target;
}

export function validateCommentBody(value: unknown) {
  const body = normalizeCommentText(value, COMMENT_BODY_MAX_LENGTH);
  return body ? { body, error: null } : { body: "", error: "请填写批注内容。" };
}
