export const WELCOME_HOME_MAPPING_VIDEO_ID =
  "video_e2d5dbab-fc35-4e81-9d8e-0ab1a0a90435";

export const WELCOME_HOME_MAPPING_OPERATION_KEY =
  "WELCOME_HOME_V02_TO_V03_V0_2";

export const WELCOME_HOME_MAPPING_CONFIRMATION =
  "确认将《欢迎回家》V0.2公开版本V2映射为老孙V0.3新草稿";

export const WELCOME_HOME_MAPPING_PATH =
  "/admin/welcome-home-v02-v03-mapping";

export type WelcomeHomeMappingPreview = {
  ready: boolean;
  applied: boolean;
  reasons: string[];
  previewToken: string | null;
  operation: {
    key: string;
    ledgerAvailable: boolean;
    status: "NOT_RUN" | "COMPLETED";
    completedAt: string | null;
  };
  case: {
    title: string;
    videoId: string;
    dataScope: string;
  };
  source: {
    authorName: string;
    taxonomyVersion: string;
    status: string;
    reviewStatus: string;
    workingRevision: number;
    submittedSnapshotRevision: number | null;
    submittedSnapshotVersionNumber: number | null;
  };
  target: {
    authorName: string;
    taxonomyVersion: string;
    mode: "CREATE";
    exists: boolean;
    status: string;
    reviewStatus: string;
    currentRevision: number;
    nextRevision: number;
  };
  mapping: {
    shots: number;
    groups: number;
    legacyFields: number;
    primaryCreativePath: "LOVE";
    storyReferenceTypePresent: boolean;
    storyArchetypePresent: boolean;
    explanatoryFieldsRemainBlank: true;
  };
  preserved: {
    snapshots: number;
    reviewRounds: number;
    comments: number;
    revisionEvents: number;
    releases: number;
  };
};

export type WelcomeHomeMappingResult = {
  alreadyApplied: boolean;
  operationKey: string;
  completedAt: string;
  target: {
    annotationId: string;
    status: "DRAFT";
    reviewStatus: "DRAFT";
    revision: number;
  };
  mapped: {
    shots: 23;
    groups: 7;
    legacyFields: 19;
  };
  createdNewTargetDraft: true;
  preservedExistingReleases: true;
  nonTargetBusinessDataUnchanged: true;
};
