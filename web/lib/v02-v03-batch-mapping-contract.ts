export const V02_V03_BATCH_MAPPING_PATH = "/admin/v02-v03-batch-mapping";

export const V02_V03_BATCH_MAPPING_CONFIRMATION =
  "确认将全部可映射V0.2最新公开版本写入原作者V0.3新草稿";

export type V02V03BatchCandidateStatus =
  | "READY"
  | "BLOCKED"
  | "SKIP_EXISTING"
  | "COMPLETED";

export type V02V03BatchCandidate = {
  candidateKey: string;
  candidateToken: string | null;
  status: V02V03BatchCandidateStatus;
  reasons: string[];
  video: {
    id: string;
    title: string;
  };
  author: {
    sourceName: string;
    currentName: string | null;
    activeUserExists: boolean;
  };
  source: {
    snapshotVersionNumber: number;
    snapshotRevision: number;
    shots: number;
    groups: number;
    legacyFields: number;
  };
  target: {
    exists: boolean;
    status: string | null;
    reviewStatus: string | null;
    revision: number | null;
  };
};

export type V02V03BatchPreview = {
  generatedAt: string;
  summary: {
    sourcePairs: number;
    ready: number;
    blocked: number;
    skippedExisting: number;
    completed: number;
  };
  candidates: V02V03BatchCandidate[];
};

export type V02V03BatchMappingResult = {
  alreadyApplied: boolean;
  operationKey: string;
  candidateKey: string;
  completedAt: string;
  videoId: string;
  videoTitle: string;
  authorName: string;
  targetAnnotationId: string;
  targetRevision: 1;
  mapped: {
    shots: number;
    groups: number;
    legacyFields: 19;
  };
  existingBusinessDataUnchanged: true;
};
