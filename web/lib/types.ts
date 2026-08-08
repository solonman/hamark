import type { AnnotationFieldCode } from "./annotation-fields";

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
};

export type FieldAnswerDraft = {
  code: AnnotationFieldCode;
  answer: string;
  evidence: string;
};

export type AnnotationDraft = {
  id: string | null;
  videoId: string;
  authorName: string;
  taxonomyVersion: "V0.2";
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  analysisTitle: string;
  commercialIntent: string;
  creativeTheme: string;
  synopsis: string;
  thinkingChain: string;
  shotCommentary: string;
  summary: string;
  shots: ShotDraft[];
  fields: FieldAnswerDraft[];
  updatedAt: string | null;
};

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
};

export type SubmissionVersionSummary = {
  id: string;
  revision: number;
  versionNumber: number;
  createdAt: string;
  contentHash: string;
};

export type AnalysisCommentStatus = "OPEN" | "RESOLVED";
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
  createdAt: string;
  updatedAt: string;
  canResolve: boolean;
  replies: AnalysisCommentReply[];
};

export type AnalysisRevisionSuggestionStatus =
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED";

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
  status: AnalysisRevisionSuggestionStatus;
  decidedByName: string | null;
  appliedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  canDecide: boolean;
};

export type MyAnalysisStatus = {
  id: string;
  status: "DRAFT" | "SUBMITTED";
  revision: number;
  updatedAt: string;
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
