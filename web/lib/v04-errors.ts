export type V04ErrorCode =
  | "UNSUPPORTED_WORKFLOW"
  | "INVALID_PAYLOAD_SCHEMA"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "EXPERT_REQUIRED"
  | "ADMIN_REQUIRED"
  | "CASE_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "NO_CHANGES_TO_SUBMIT"
  | "PUBLICATION_INCOMPLETE"
  | "CHOICE_RULE_VIOLATION"
  | "CASE_IN_TRASH"
  | "ASSET_PURGED"
  | "LEASE_REQUIRED"
  | "LEASE_HELD_BY_OTHER"
  | "LEASE_EXPIRED"
  | "RATE_LIMITED"
  | "TRANSACTION_ROLLED_BACK"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<V04ErrorCode, number> = {
  UNSUPPORTED_WORKFLOW: 400,
  INVALID_PAYLOAD_SCHEMA: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  EXPERT_REQUIRED: 403,
  ADMIN_REQUIRED: 403,
  CASE_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  NO_CHANGES_TO_SUBMIT: 409,
  PUBLICATION_INCOMPLETE: 422,
  CHOICE_RULE_VIOLATION: 422,
  CASE_IN_TRASH: 410,
  ASSET_PURGED: 410,
  LEASE_REQUIRED: 423,
  LEASE_HELD_BY_OTHER: 423,
  LEASE_EXPIRED: 423,
  RATE_LIMITED: 429,
  TRANSACTION_ROLLED_BACK: 500,
  INTERNAL_ERROR: 500,
};

export class V04ServiceError extends Error {
  readonly status: number;

  constructor(
    readonly code: V04ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId = "",
  ) {
    super(message);
    this.name = "V04ServiceError";
    this.status = STATUS_BY_CODE[code];
  }
}

export function toV04ServiceError(error: unknown, requestId = "") {
  if (error instanceof V04ServiceError) return error;
  if (error instanceof Error && error.message === "INVALID_PAYLOAD_SCHEMA") {
    return new V04ServiceError(
      "INVALID_PAYLOAD_SCHEMA",
      "工作稿的版本或结构不受支持。",
      {},
      requestId,
    );
  }
  if (error instanceof Error && error.message === "CHOICE_RULE_VIOLATION") {
    return new V04ServiceError(
      "CHOICE_RULE_VIOLATION",
      "固定选项、自定义值或互斥条件不符合当前词表合同。",
      {},
      requestId,
    );
  }
  return new V04ServiceError(
    "INTERNAL_ERROR",
    "操作未完成，请稍后重试。",
    {},
    requestId,
  );
}

export function v04ErrorResponse(error: unknown, requestId: string) {
  const serviceError = toV04ServiceError(error, requestId);
  return Response.json({
    error: {
      code: serviceError.code,
      message: serviceError.message,
      requestId: serviceError.requestId || requestId,
      details: serviceError.details,
    },
  }, { status: serviceError.status });
}
