import { V04_UI_MODULES, V04_UI_SHOT_FIELDS, type V04UiCase, type V04UiDraft, type V04UiShot, type V04UiShotGroup, type V04UiWorkState } from "@/lib/v04-ui-model";

export function normalizeV04LibraryQuery(value = "") {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function matchesV04LibraryQuery(item: V04UiCase, query: string) {
  const normalized = normalizeV04LibraryQuery(query);
  if (!normalized) return true;
  return normalizeV04LibraryQuery([item.title, item.brand, item.description, ...item.tags].join(" ")).includes(normalized);
}

export function deriveV04UiWorkState(input: {
  hasAnyDraftData: boolean;
  successfulSubmissionCount: number;
  hasUnsubmittedChanges: boolean;
}): V04UiWorkState {
  if (input.successfulSubmissionCount === 0) {
    return input.hasAnyDraftData ? "INCOMPLETE" : "NOT_STARTED";
  }
  if (input.hasUnsubmittedChanges) return "MODIFIED_UNSUBMITTED";
  return input.successfulSubmissionCount === 1 ? "SUBMITTED" : "MODIFICATION_SUBMITTED";
}

export function numberedV04Shots(groups: V04UiShotGroup[]) {
  let number = 0;
  return groups.flatMap((group, groupIndex) =>
    group.shots.map((shot, shotIndex) => ({
      stableId: shot.id,
      displayNumber: ++number,
      groupIndex,
      shotIndex,
    })),
  );
}

export function nextV04Timecode(value: string) {
  const match = value.trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!match || Number(match[2]) > 59) return "";
  const next = Number(match[1]) * 60 + Number(match[2]) + 1;
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

export const V04_REPEATABLE_SHOT_FIELDS = [
  "shotScale",
  "cameraAngle",
  "cameraMovement",
  "soundEffect",
  "music",
] as const;

export function moveV04Shot(
  groups: V04UiShotGroup[],
  shotId: string,
  targetGroupId: string,
  targetIndex: number,
) {
  const next = structuredClone(groups);
  let moving = null;
  for (const group of next) {
    const index = group.shots.findIndex((shot) => shot.id === shotId);
    if (index >= 0) moving = group.shots.splice(index, 1)[0];
  }
  const target = next.find((group) => group.id === targetGroupId);
  if (!moving || !target) return groups;
  target.shots.splice(Math.max(0, Math.min(targetIndex, target.shots.length)), 0, moving);
  return next;
}

export type V04MissingItem = { id: string; module: string; scope: string; label: string };

export function evaluateV04FixturePublication(draft: V04UiDraft) {
  const missing: V04MissingItem[] = [];
  const requireText = (value: string, id: string, module: string, scope: string, label: string) => {
    if (!value.trim()) missing.push({ id, module, scope, label });
  };
  draft.shotGroups.forEach((group, index) => {
    const scope = `桥段${String(index + 1).padStart(2, "0")}`;
    requireText(group.title, `group-${group.id}-title`, V04_UI_MODULES[0], scope, "桥段名称");
    if (!group.primaryRole.selectedOptionIds.length && !group.primaryRole.customText.trim())
      missing.push({ id: `group-${group.id}-primary`, module: V04_UI_MODULES[0], scope, label: "桥段主创意作用" });
    if (!group.shots.some((shot) => shot.visualContent.trim()))
      missing.push({ id: `shot-${group.shots[0]?.id ?? group.id}-visualContent`, module: V04_UI_MODULES[0], scope, label: "至少一个镜头的画面内容" });
  });
  const core: Array<[keyof V04UiDraft, string]> = [
    ["commercialIntent", "商业意图"], ["storySummary", "故事梗概"], ["creativeMotif", "创意母题"],
    ["tensionButton", "张力按钮"], ["creativeThinkingChain", "创意思维链"],
    ["carrierExplanation", "创意承重载体具体说明"], ["creativeContract", "创意成立契约"], ["gradeReason", "评价理由"],
  ];
  core.forEach(([key, label]) => requireText(String(draft[key]), `field-${String(key)}`, V04_UI_MODULES[1], "全片", label));
  if (!draft.primaryMechanism.selectedOptionIds.length && !draft.primaryMechanism.customText.trim())
    missing.push({ id: "field-primaryMechanism", module: V04_UI_MODULES[1], scope: "全片", label: "创意主导手法及机制" });
  if (draft.primaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM") && !draft.primaryMechanism.advancedText?.trim())
    missing.push({ id: "field-primaryMechanism-advanced", module: V04_UI_MODULES[1], scope: "全片", label: "待形成新机制｜进阶机制层" });
  if (!draft.storyReference.selectedOptionIds.length && !draft.storyReference.customText.trim())
    missing.push({ id: "field-storyReference", module: V04_UI_MODULES[1], scope: "全片", label: "故事参照类型" });
  if (!draft.carriers.length) missing.push({ id: "field-carriers", module: V04_UI_MODULES[1], scope: "全片", label: "创意承重载体" });
  if (!draft.overallGrade) missing.push({ id: "field-overallGrade", module: V04_UI_MODULES[1], scope: "整体评价", label: "整体创意评价" });
  draft.primaryPathAnswers[draft.primaryPath].forEach((value, index) => requireText(value, `field-path-${index}`, V04_UI_MODULES[2], "主导路径", `条件判断 ${index + 1}`));
  return { ready: missing.length === 0, missing };
}

export function blankV04Shot(id: string) {
  return Object.fromEntries([["id", id], ...V04_UI_SHOT_FIELDS.map(({ key }) => [key, ""])]) as V04UiShot;
}
