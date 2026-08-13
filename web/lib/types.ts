import type { AnnotationFieldCode } from "./annotation-fields";

export type TaxonomyVersion = "V0.2" | "V0.3-PILOT";
export type AnnotationWorkflowVersion =
  | "REVERSE-WORKFLOW-V0.2"
  | "REVERSE-WORKFLOW-V0.3-PILOT";
export type CreativePath = "LOVE" | "INTERESTING" | "SUBSTANCE";
export type FormationMode =
  | "HOLISTIC_EMERGENCE"
  | "CROSS_GROUP_ACCUMULATION"
  | "BEFORE_AFTER_CONTRAST"
  | "RULE_THROUGHOUT"
  | "LOCAL_TRIGGER"
  | "COMPOSITE"
  | "NOT_YET_DECOMPOSABLE";
export type CreativeGrade = "S" | "A" | "B" | "C" | "";
export type VocabularyVersion = "V0.3.1" | "V0.3.2";

export type VideoStatus = "UPLOADING" | "READY" | "FAILED";

export type VideoItem = {
  id: string;
  title: string;
  brand: string;
  description: string;
  tags: string[];
  originalName: string;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  contentType: string;
  fileSize: number;
  status: VideoStatus;
  createdByName: string;
  createdAt: string;
  annotationCount: number;
};

export type ShotDraft = {
  id: string;
  orderIndex: number;
  groupName: string;
  shotNumber: string;
  startTime: string;
  endTime: string;
  shotSize: string;
  cameraAngle: string;
  cameraMovement: string;
  visualContent: string;
  dialogue: string;
  voiceover: string;
  screenText: string;
  soundEffect: string;
  music: string;
  creativeComment: string;
  shotGroupId?: string | null;
};

export type ShotGroupDraft = {
  id: string;
  orderIndex: number;
  title: string;
  primaryRole: string;
  auxiliaryRoles: string[];
  customRole: string;
  note: string;
};

export type FieldAnswerDraft = {
  code: AnnotationFieldCode;
  answer: string;
  evidence: string;
  source?: "HUMAN_ORIGINAL" | "HUMAN_CONFIRMED_AI" | "AI_DERIVED" | "SYSTEM_MAPPED";
};

export type CreativeStructureDraft = {
  vocabularyVersion?: VocabularyVersion;
  creativeButton: string;
  mechanismStatement: string;
  mechanismPrimary: string;
  mechanismAuxiliary: string[];
  mechanismCustom: string;
  creativeRealizationPath?: string;
  /** @deprecated V0.3.1 keeps this compatibility key for existing pilot data. */
  realizationSkeleton: string;
  brandProductLanding: string;
  storyReferenceType: string;
  storyArchetype: string;
  primaryCreativePath: CreativePath | "";
  auxiliaryCreativePaths: CreativePath[];
  compositeStateReason: string;
  formationPrimary: FormationMode | "";
  formationAuxiliary: FormationMode[];
  formationStatement: string;
  formationRelatedGroupIds: string[];
  creativeCarriers: string;
  establishmentConditions: string;
  strengthSources: string;
  acceptanceContract: string;
  audiovisualMechanism: string;
  informationReleaseTurning: string;
  creativeGrade: CreativeGrade;
  creativeGradeReason: string;
  creativeGradeVersion: "CREATIVE-GRADE-V0.1";
  mainPathPayload: Record<string, string>;
  auxiliaryPathNotes: Partial<Record<CreativePath, string>>;
  conditionFlags: {
    unconventionalWorld: boolean;
    audiovisualCarriesIdea: boolean;
    interestingLoadBearing: boolean;
  };
};

export type AnnotationDraft = {
  id: string | null;
  videoId: string;
  authorName: string;
  taxonomyVersion: TaxonomyVersion;
  workflowVersion?: AnnotationWorkflowVersion;
  sourceSnapshotId?: string | null;
  status: "DRAFT" | "SUBMITTED";
  reviewStatus?: AnalysisWorkflowStatus;
  activeBaseSnapshotId?: string | null;
  baseReleaseId?: string | null;
  baseSnapshotId?: string | null;
  sourcePublicSnapshotId?: string | null;
  baseReleaseNumber?: number | null;
  revision: number;
  analysisTitle: string;
  commercialIntent: string;
  creativeTheme: string;
  synopsis: string;
  thinkingChain: string;
  shotCommentary: string;
  summary: string;
  shots: ShotDraft[];
  shotGroups?: ShotGroupDraft[];
  fields: FieldAnswerDraft[];
  creativeStructure?: CreativeStructureDraft;
  updatedAt: string | null;
};

export type AnalysisWorkflowStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "CHANGES_REQUESTED"
  | "PENDING_REREVIEW"
  | "APPROVED";

export type ReviewRoundStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED";

export type ReviewCommentWorkflowStatus =
  | "OPEN"
  | "AUTHOR_MARKED_HANDLED"
  | "RESOLVED"
  | "REOPENED";

export type SubmittedAnalysis = {
  id: string;
  authorName: string;
  taxonomyVersion: string;
  revision: number;
  versionNumber: number;
  createdAt: string;
  contentHash: string;
  payload: AnnotationDraft;
  versions: SubmissionVersionSummary[];
  reviewContext?: AnalysisReviewContext;
  versionIdentity?: AnalysisVersionIdentity;
};

export type AnalysisVersionIdentity =
  | "ACTIVE_STANDARD"
  | "HISTORICAL_STANDARD"
  | "PUBLIC_SUBMISSION";

export type SubmissionVersionSummary = {
  id: string;
  revision: number;
  versionNumber: number;
  createdAt: string;
  contentHash: string;
};

export type AnalysisCommentStatus = ReviewCommentWorkflowStatus;
export type AnalysisCommentKind = "COMMENT" | "EXPERT_NOTE";

export type AnalysisCommentReply = {
  id: string;
  authorName: string;
  body: string;
  kind: AnalysisCommentKind;
  createdAt: string;
};

export type AnalysisComment = {
  id: string;
  submissionId: string;
  targetKey: string;
  targetLabel: string;
  selectedText: string;
  anchorStart: number;
  anchorEnd: number;
  body: string;
  authorName: string;
  kind: AnalysisCommentKind;
  status: AnalysisCommentStatus;
  isExcellent: boolean;
  markedByName: string | null;
  resolvedByName?: string | null;
  finalConclusion?: string | null;
  linkedRevisionEventId?: string | null;
  handledInSnapshotId?: string | null;
  createdAt: string;
  updatedAt: string;
  canResolve: boolean;
  canMarkHandled?: boolean;
  replies: AnalysisCommentReply[];
};

export type AnalysisRevisionSuggestionStatus =
  | "DRAFT"
  | "APPLIED"
  | "SUPERSEDED"
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED";

export type RevisionEditType =
  | "RANGE_REPLACE"
  | "UNIT_REPLACE"
  | "INSERT"
  | "DELETE";

export type RevisionValueType = "TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";

export type AnalysisRevisionSuggestion = {
  id: string;
  submissionId: string;
  targetKey: string;
  targetLabel: string;
  selectedText: string;
  anchorStart: number;
  anchorEnd: number;
  replacementText: string;
  reason: string;
  authorName: string;
  actorRole?: "AUTHOR" | "FINAL_REVIEWER" | "COLLABORATOR";
  editType?: RevisionEditType;
  valueType?: RevisionValueType;
  originalValue?: string | string[];
  replacementValue?: string | string[];
  vocabularyVersion?: VocabularyVersion;
  changeSetId?: string | null;
  originalTextHash?: string;
  linkedCommentId?: string | null;
  status: AnalysisRevisionSuggestionStatus;
  decidedByName: string | null;
  appliedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  canDecide: boolean;
};

export type AnalysisReviewRound = {
  id: string;
  submissionId: string;
  roundNumber: number;
  status: ReviewRoundStatus;
  reviewerName: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type AnalysisReviewContext = {
  round: AnalysisReviewRound | null;
  isAuthor: boolean;
  isFinalReviewer: boolean;
  canReview: boolean;
  canReturn: boolean;
  canApprove: boolean;
  canWithdraw: boolean;
  activeReleaseNumber: number | null;
};

export type ApprovedAnalysisRelease = {
  id: string;
  releaseNumber: number;
  approvedSnapshotId: string;
  sourceSnapshotId: string;
  approvedByName: string;
  approvedAt: string;
  expertCreativeGrade: Exclude<CreativeGrade, "">;
  assignmentQualityGrade: string | null;
  contentHash: string;
  status?: "ACTIVE" | "SUPERSEDED" | "WITHDRAWN";
  versionIdentity?: "ACTIVE_STANDARD" | "HISTORICAL_STANDARD";
  sourceAuthorName?: string;
  sourceSubmittedAt?: string;
  payload?: AnnotationDraft;
};

export type MyAnalysisStatus = {
  id: string;
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  updatedAt: string;
  taxonomyVersion?: TaxonomyVersion;
  reviewStatus?: AnalysisWorkflowStatus;
  baseReleaseId?: string | null;
  baseReleaseNumber?: number | null;
  baseSnapshotId?: string | null;
  sourcePublicSnapshotId?: string | null;
};

export type AssignmentReviewDraft = {
  id: string | null;
  submissionId: string;
  rubricVersion: "RUBRIC-V0.4";
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  scores: Record<string, number | null>;
  totalScore: number;
  generalComment: string;
  discussionNomination: boolean;
  isValidForAggregate: boolean;
  updatedAt: string | null;
};

export type AssignmentReviewAggregate = {
  validReviewCount: number;
  averageScore: number | null;
};
