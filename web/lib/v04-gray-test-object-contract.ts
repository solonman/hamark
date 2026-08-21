export const V04_GRAY_TEST_OBJECT_CONFIRMATION =
  "我确认仅创建一个隐藏的 V0.4 TEST_ONLY 灰度测试视频";

export const V04_GRAY_TEST_OBJECT_REASON_CLASSES = [
  "NOT_FOUND",
  "AUTHORIZATION",
  "SERVER",
  "NETWORK",
  "UNKNOWN",
] as const;
export type V04GrayTestObjectReasonClass =
  typeof V04_GRAY_TEST_OBJECT_REASON_CLASSES[number];

export function normalizeV04GrayTestObjectReasonClass(
  value: unknown,
): V04GrayTestObjectReasonClass | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string"
    && V04_GRAY_TEST_OBJECT_REASON_CLASSES.includes(value as V04GrayTestObjectReasonClass)
    ? value as V04GrayTestObjectReasonClass
    : "UNKNOWN";
}

export type V04GrayTestObjectPreview = {
  mode: "TEST_ONLY_GRAY_MEDIA";
  ready: boolean;
  alreadyApplied: boolean;
  stopReasons: string[];
  targetCodeSha: string;
  generatedAt: string;
  expiresAt: string;
  previewHash: string;
  previewToken: string;
  previewTokenDigest: string;
  actorDigest: string;
  plan: {
    videoId: string;
    objectKeyDigest: string;
    title: string;
    contentType: string;
    originalName: string;
    fileSize: number;
    mediaSha256: string;
    dataScope: "TEST_ONLY";
    testRunId: string;
  };
  facts: {
    actorActive: boolean;
    actorSystemAdmin: boolean;
    contractsActive: boolean;
    targetState: "ABSENT" | "EXACT" | "DRIFT";
    objectState: "ABSENT" | "EXACT" | "DRIFT";
    ledgerState: "ABSENT" | "EXACT" | "DRIFT";
    legalState: "CLEAN_CREATE" | "EXACT_APPLIED" | "INCONSISTENT";
    businessVideoCount: number;
    businessFingerprint: string;
    ledgerAppliedCount: number;
  };
  zeroWrite: { beforeHash: string; afterHash: string; unchanged: boolean };
};
export type V04GrayTestObjectApplyInput = {
  action: "CREATE_TEST_ONLY_GRAY_VIDEO";
  previewToken: string;
  idempotencyKey: string;
  confirmation: string;
  approvalReference: string;
  targetCodeSha: string;
};

export type V04GrayTestObjectApplyResult = {
  operationKey: string;
  status: "APPLIED" | "FAILED";
  outcome: "APPLIED" | "FAILED";
  alreadyApplied: boolean;
  videoId: string;
  dataScope: "TEST_ONLY";
  testRunId: string;
  fileSize: number;
  mediaSha256: string;
  objectKeyDigest: string;
  actorDigest: string;
  objectEtagDigest: string | null;
  creationMarkerDigest: string | null;
  targetCodeSha: string;
  previewTokenDigest: string;
  businessFingerprint: string;
  completedAt: string;
  compensation?: "NOT_NEEDED" | "OBJECT_DELETED" | "OBJECT_DELETE_REFUSED" | "OBJECT_DELETE_FAILED";
  failure?: { stage: string; code: string };
};
