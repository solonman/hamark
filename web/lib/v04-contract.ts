export const V04_PRODUCT_VERSION = "AD_VIDEO_PRODUCT_V0_4" as const;
export const V04_TAXONOMY_VERSION = "AD_VIDEO_TAXONOMY_V1" as const;
export const V04_WORKFLOW_VERSION = "AD_VIDEO_WORKFLOW_V1" as const;
export const V04_VOCABULARY_VERSION = "AD_VIDEO_VOCAB_V1" as const;
export const V04_PAYLOAD_SCHEMA_VERSION = "AD_VIDEO_PAYLOAD_V1" as const;

export const V04_CONTRACT_STATUS = "DRAFT" as const;

export const V04_EXPLICIT_ROLE_KEYS = ["EXPERT", "SYSTEM_ADMIN"] as const;
export type V04ExplicitRoleKey = (typeof V04_EXPLICIT_ROLE_KEYS)[number];

export const V04_DERIVED_CAPABILITY_KEYS = ["MEMBER", "UPLOADER"] as const;
export type V04DerivedCapabilityKey = (typeof V04_DERIVED_CAPABILITY_KEYS)[number];

export const V04_SHOT_FIELD_KEYS = [
  "startTime",
  "endTime",
  "shotScale",
  "cameraAngle",
  "cameraMovement",
  "visualContent",
  "screenCopy",
  "subtitleEffect",
  "dialogue",
  "voiceOver",
  "soundEffect",
  "music",
] as const;
export type V04ShotFieldKey = (typeof V04_SHOT_FIELD_KEYS)[number];

export const V04_WORKSPACE_STATUSES = ["ACTIVE", "ARCHIVED", "TRASHED"] as const;
export const V04_ROUND_STATUSES = ["ACTIVE", "CLOSED", "SUPERSEDED", "TRASHED"] as const;
export const V04_LEASE_STATUSES = ["ACTIVE", "RELEASED", "EXPIRED"] as const;
export const V04_EXPERT_RELEASE_STATUSES = ["ACTIVE", "WITHDRAWN", "SUPERSEDED"] as const;
export const V04_DELETION_STATES = [
  "ACTIVE",
  "TRASHED",
  "PURGE_PENDING",
  "ASSET_PURGED",
  "PURGE_FAILED",
] as const;

export type V04ChoiceValue = {
  selectedOptionIds: string[];
  customText: string;
  advancedText?: string;
  vocabularyVersion: typeof V04_VOCABULARY_VERSION;
  legacyRawValue?: unknown;
};

export type V04ShotPayload = Record<V04ShotFieldKey, string> & {
  id: string;
  orderIndex: number;
};

export type V04PerceptionType = "LOVE" | "FUN" | "PERCEPTION";
export type V04CreativeGrade = "S" | "A" | "B" | "C";

export type V04ShotGroupPayload = {
  id: string;
  orderIndex: number;
  bridgeName: string;
  primaryCreativeRole: V04ChoiceValue;
  auxiliaryCreativeRole: V04ChoiceValue;
  keyCreativeDescription: string;
  shots: V04ShotPayload[];
};

export type V04FactsAndCoreJudgement = {
  commercialIntent: string;
  storySynopsis: string;
  creativeMotif: string;
  tensionButton: string;
  mainMechanism: V04ChoiceValue;
  auxiliaryMechanism: V04ChoiceValue;
  creativeThinkingChain: string;
  storyReference: V04ChoiceValue;
  creativeCarriers: Array<"STORY" | "COPY" | "AUDIOVISUAL_RULE">;
  carrierExplanation: string;
  acceptanceContract: string;
  overallCreativeRating: V04CreativeGrade | "";
  ratingReason: string;
};

export type V04AuxiliaryPerceptionPath = {
  type: V04PerceptionType;
  description: string;
  creativeRole: string;
};

export type V04PerceptionPath = {
  primaryType: V04PerceptionType | "";
  primaryDetails: Record<string, string>;
  auxiliaryTypes: V04AuxiliaryPerceptionPath[];
};

export type V04DraftPayloadV1 = {
  contract: Omit<typeof V04_VERSION_CONTRACT, "status">;
  script: { shotGroups: V04ShotGroupPayload[] };
  factsAndCoreJudgement: V04FactsAndCoreJudgement;
  perceptionPath: V04PerceptionPath;
  metadata: {
    source: "HUMAN" | "SYSTEM_MIGRATION" | "HISTORY_RESTORE";
    legacySource?: { workflowVersion: string; objectId: string };
    restoredFrom?: { objectType: string; objectId: string };
  };
};

export type V04RevisionValueType =
  | "TEXT"
  | "SINGLE_SELECT"
  | "MULTI_SELECT"
  | "CHOICE_WITH_CUSTOM"
  | "STRUCTURE";

export type V04Change = {
  targetKey: string;
  targetLabel: string;
  valueType: V04RevisionValueType;
  beforeValue: unknown;
  afterValue: unknown;
  reason?: string;
};

export const V04_VERSION_CONTRACT = {
  productVersion: V04_PRODUCT_VERSION,
  taxonomyVersion: V04_TAXONOMY_VERSION,
  workflowVersion: V04_WORKFLOW_VERSION,
  vocabularyVersion: V04_VOCABULARY_VERSION,
  payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
  status: V04_CONTRACT_STATUS,
} as const;
