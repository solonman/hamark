export const V03_SHARED_BACKFILL_CONFIRMATION =
  "确认将现有V0.3接入公司共享协作主线";
export const V03_SHARED_SCHEMA_CONFIRMATION =
  "确认安装V0.3共享协作数据结构";

export type V03SharedBackfillCandidate = {
  candidateKey: string;
  previewToken: string | null;
  videoId: string;
  videoTitle: string;
  canonicalAnnotationId: string;
  sourceAuthorName: string;
  currentRevision: number;
  status: "READY" | "COMPLETED" | "BLOCKED";
  sourceType: "V02_MAPPED" | "EXISTING_V03" | "APPROVED_RELEASE";
  mappedOrigin: boolean;
  activeReleaseNumber: number | null;
  counts: {
    annotations: number;
    shots: number;
    groups: number;
    fields: number;
    snapshots: number;
    comments: number;
    revisionEvents: number;
    reviewRounds: number;
    releases: number;
  };
  reasons: string[];
};

export type V03SharedBackfillPreview = {
  confirmation: string;
  summary: {
    videosWithV03: number;
    ready: number;
    completed: number;
    blocked: number;
    mapped: number;
    existingV03: number;
  };
  candidates: V03SharedBackfillCandidate[];
};

export type V03SharedBackfillResult = {
  alreadyApplied: boolean;
  operationKey: string;
  videoId: string;
  videoTitle: string;
  streamId: string;
  baselineId: string;
  roundId: string;
  canonicalAnnotationId: string;
  completedAt: string;
  preservedBusinessRows: boolean;
};
