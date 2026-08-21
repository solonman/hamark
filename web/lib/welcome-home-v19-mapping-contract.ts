import type {
  WelcomeHomeV19PayloadComparison,
} from "./welcome-home-v19-conflict-audit";

export const WELCOME_HOME_V19_MAPPING_CONFIRMATION = "确认仅填充《欢迎回家》V1.9空白项";

export type WelcomeHomeV19MappingPreview = {
  mode: "FIXED_SINGLE_CASE_V1_1";
  ready: boolean;
  alreadyApplied: boolean;
  generatedAt: string;
  expiresAt: string;
  targetCodeSha: string;
  contract: {
    version: "WELCOME_HOME_V19_DIRECT_MAPPING_V1_1";
    hash: string;
    fieldTypeCount: 19;
    instanceCount: 196;
  };
  source: {
    roundNumber: number;
    revision: number;
    storedHashDigest: string;
    canonicalFingerprint: string;
    sourceDigest: string;
  };
  target: {
    revision: number;
    contentHash: string;
    workspaceStatus: string;
    submissionCount: number;
    expertReleaseCount: number;
    activeLeaseCount: number;
  };
  structure: WelcomeHomeV19PayloadComparison["structure"];
  totals: WelcomeHomeV19PayloadComparison["totals"];
  fieldTypes: WelcomeHomeV19PayloadComparison["fieldTypes"];
  postApplyTotals: WelcomeHomeV19PayloadComparison["totals"];
  previewHash: string;
  previewToken: string;
  previewTokenDigest: string;
  zeroWrite: { beforeHash: string; afterHash: string; unchanged: boolean };
  stopReasons: string[];
};

export type WelcomeHomeV19MappingApplyInput = {
  action: "APPLY_WELCOME_HOME_V19_MAPPING";
  confirmation: string;
  previewToken: string;
  targetCodeSha: string;
  idempotencyKey: string;
  approvalReference: string;
};

export type WelcomeHomeV19MappingApplyResult = {
  outcome: "APPLIED" | "ALREADY_APPLIED";
  operationKey: string;
  revision: number;
  contentHash: string;
  structure: { shotGroupCount: 7; shotCount: 23 };
  totals: WelcomeHomeV19PayloadComparison["totals"];
  submissionCount: number;
  expertReleaseCount: number;
  sourceDigest: string;
  previewTokenDigest: string;
  completedAt: string;
};
