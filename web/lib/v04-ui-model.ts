import type { V04ChoiceValue, V04ShotFieldKey } from "@/lib/v04-contract";

export type V04UiWorkState =
  | "NOT_STARTED"
  | "INCOMPLETE"
  | "SUBMITTED"
  | "MODIFIED_UNSUBMITTED"
  | "MODIFICATION_SUBMITTED";

export type V04UiShot = Record<V04ShotFieldKey, string> & { id: string };

export type V04UiShotGroup = {
  id: string;
  title: string;
  primaryRole: V04ChoiceValue;
  auxiliaryRole: V04ChoiceValue;
  creativeDescription: string;
  shots: V04UiShot[];
};

export type V04UiDraft = {
  shotGroups: V04UiShotGroup[];
  commercialIntent: string;
  storySummary: string;
  creativeMotif: string;
  tensionButton: string;
  primaryMechanism: V04ChoiceValue;
  auxiliaryMechanism: V04ChoiceValue;
  creativeThinkingChain: string;
  storyReference: V04ChoiceValue;
  carriers: string[];
  carrierExplanation: string;
  creativeContract: string;
  overallGrade: "" | "S" | "A" | "B" | "C";
  gradeReason: string;
  primaryPath: "LOVE" | "FUN" | "PERCEPTION";
  primaryPathAnswers: Record<"LOVE" | "FUN" | "PERCEPTION", string[]>;
  auxiliaryPaths: Array<"LOVE" | "FUN" | "PERCEPTION">;
  auxiliaryPathDetails: Partial<Record<"LOVE" | "FUN" | "PERCEPTION", { description: string; role: string }>>;
};

export type V04UiSubmission = {
  id: string;
  versionNumber: number;
  submittedAt: string;
  submittedBy: string;
  draft: V04UiDraft;
};

export type V04UiCase = {
  id: string;
  title: string;
  brand: string;
  duration: string;
  description: string;
  tags: string[];
  workState: V04UiWorkState;
  expertGrade: "" | "S" | "A" | "B" | "C";
  draft: V04UiDraft;
  submissions: V04UiSubmission[];
  activeEditor: string | null;
  lastSavedAt: string;
};

export const V04_UI_MODULES = [
  "第一模块｜脚本反写",
  "第二模块｜全片事实与核心判断",
  "第三模块｜主导感知类型发生路径",
  "第四模块｜提交",
] as const;

export const V04_UI_SHOT_FIELDS: ReadonlyArray<{ key: V04ShotFieldKey; label: string }> = [
  { key: "startTime", label: "开始时间" },
  { key: "endTime", label: "结束时间" },
  { key: "shotScale", label: "景别" },
  { key: "cameraAngle", label: "机位／角度" },
  { key: "cameraMovement", label: "镜头运动" },
  { key: "visualContent", label: "画面内容" },
  { key: "screenCopy", label: "字幕／屏幕文案" },
  { key: "subtitleEffect", label: "字幕特效" },
  { key: "dialogue", label: "对白" },
  { key: "voiceOver", label: "旁白" },
  { key: "soundEffect", label: "声效" },
  { key: "music", label: "音乐" },
];

export const V04_UI_STATE_LABELS: Record<V04UiWorkState, string> = {
  NOT_STARTED: "尚未开始",
  INCOMPLETE: "尚未完成",
  SUBMITTED: "已提交",
  MODIFIED_UNSUBMITTED: "有修改未提交",
  MODIFICATION_SUBMITTED: "修改已提交",
};

export function cloneV04UiDraft(draft: V04UiDraft): V04UiDraft {
  return structuredClone(draft);
}
