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

export const V04_WORKSPACE_TARGETS = {
  commercialIntent: "field-commercialIntent",
  storySummary: "field-storySummary",
  creativeMotif: "field-creativeMotif",
  tensionButton: "field-tensionButton",
  primaryMechanism: "field-primaryMechanism",
  primaryMechanismAdvanced: "field-primaryMechanism-advanced",
  auxiliaryMechanism: "field-auxiliaryMechanism",
  auxiliaryMechanismAdvanced: "field-auxiliaryMechanism-advanced",
  creativeThinkingChain: "field-creativeThinkingChain",
  storyReference: "field-storyReference",
  carriers: "field-carriers",
  carrierExplanation: "field-carrierExplanation",
  creativeContract: "field-creativeContract",
  overallGrade: "field-overallGrade",
  gradeReason: "field-gradeReason",
} as const;

export function v04GroupTitleTargetId(groupId: string) {
  return `group-${groupId}-title`;
}

export function v04GroupPrimaryRoleTargetId(groupId: string) {
  return `group-${groupId}-primary`;
}

export function v04ShotFieldTargetId(shotId: string, field: string) {
  return `shot-${shotId}-${field}`;
}

const V04_FACT_TARGET_IDS: Record<string, string> = {
  commercialIntent: V04_WORKSPACE_TARGETS.commercialIntent,
  storySynopsis: V04_WORKSPACE_TARGETS.storySummary,
  creativeMotif: V04_WORKSPACE_TARGETS.creativeMotif,
  tensionButton: V04_WORKSPACE_TARGETS.tensionButton,
  mainMechanism: V04_WORKSPACE_TARGETS.primaryMechanism,
  auxiliaryMechanism: V04_WORKSPACE_TARGETS.auxiliaryMechanism,
  creativeThinkingChain: V04_WORKSPACE_TARGETS.creativeThinkingChain,
  storyReference: V04_WORKSPACE_TARGETS.storyReference,
  creativeCarriers: V04_WORKSPACE_TARGETS.carriers,
  carrierExplanation: V04_WORKSPACE_TARGETS.carrierExplanation,
  acceptanceContract: V04_WORKSPACE_TARGETS.creativeContract,
  overallCreativeRating: V04_WORKSPACE_TARGETS.overallGrade,
  ratingReason: V04_WORKSPACE_TARGETS.gradeReason,
};

export function v04StableTargetToDomId(targetKey: string, draft?: V04UiDraft) {
  const shot = targetKey.match(/^shot:([^.]+)\.([a-zA-Z][a-zA-Z0-9]*)$/);
  if (shot) return v04ShotFieldTargetId(shot[1], shot[2]);
  const group = targetKey.match(/^shotGroup:([^.]+)\.(bridgeName|primaryCreativeRole|auxiliaryCreativeRole|keyCreativeDescription|shots)$/);
  if (group) {
    if (group[2] === "bridgeName") return v04GroupTitleTargetId(group[1]);
    if (group[2] === "primaryCreativeRole") return v04GroupPrimaryRoleTargetId(group[1]);
    if (group[2] === "keyCreativeDescription") return `field-${group[1]}-description`;
    return `group-${group[1]}`;
  }
  const fact = targetKey.match(/^facts\.([a-zA-Z][a-zA-Z0-9]*)(?:\.([a-zA-Z][a-zA-Z0-9]*))?$/);
  if (fact) {
    if (fact[2] === "advancedText" && fact[1] === "mainMechanism") {
      return V04_WORKSPACE_TARGETS.primaryMechanismAdvanced;
    }
    if (fact[2] === "advancedText" && fact[1] === "auxiliaryMechanism") {
      return V04_WORKSPACE_TARGETS.auxiliaryMechanismAdvanced;
    }
    return V04_FACT_TARGET_IDS[fact[1]] ?? "module-2";
  }
  if (targetKey === "path.primaryType") return "module-3";
  const detail = targetKey.match(/^path\.primaryDetails\.([a-zA-Z][a-zA-Z0-9]*)$/);
  if (detail && draft) {
    const keys = {
      LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
      FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
      PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
    }[draft.primaryPath];
    const index = keys.indexOf(detail[1]);
    if (index >= 0) return `field-path-${index}`;
  }
  if (targetKey.startsWith("path.auxiliary:")) return "module-3";
  return "module-1";
}

export function listV04WorkspaceTargetIds(draft: V04UiDraft) {
  return new Set([
    "module-1", "module-2", "module-3", "module-4",
    ...Object.values(V04_WORKSPACE_TARGETS),
    ...draft.shotGroups.flatMap((group) => [
      `group-${group.id}`,
      v04GroupTitleTargetId(group.id),
      v04GroupPrimaryRoleTargetId(group.id),
      ...group.shots.flatMap((shot) => [
        `shot-${shot.id}`,
        ...V04_UI_SHOT_FIELDS.map(({ key }) => v04ShotFieldTargetId(shot.id, key)),
      ]),
    ]),
    ...draft.primaryPathAnswers[draft.primaryPath].map((_, index) => `field-path-${index}`),
    ...draft.auxiliaryPaths.flatMap((path) => [`field-aux-${path}-description`, `field-aux-${path}-role`]),
  ]);
}

let locateSequence = 0;

function afterV04Layout() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function v04VisibleBounds() {
  const header = document.querySelector<HTMLElement>("[data-v04-fixed-header]");
  return {
    top: Math.max(12, (header?.getBoundingClientRect().bottom ?? 0) + 16),
    bottom: window.innerHeight - 24,
  };
}

function ensureV04Visible(element: HTMLElement) {
  const bounds = v04VisibleBounds();
  const rect = element.getBoundingClientRect();
  const available = bounds.bottom - bounds.top;
  if (rect.height > available || rect.top < bounds.top) {
    window.scrollBy({ top: rect.top - bounds.top, behavior: "auto" });
  } else if (rect.bottom > bounds.bottom) {
    window.scrollBy({ top: rect.bottom - bounds.bottom, behavior: "auto" });
  }
}

export async function locateV04Target(id: string) {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const sequence = ++locateSequence;
  await afterV04Layout();
  if (sequence !== locateSequence) return false;
  const target = document.getElementById(id);
  if (!target) return false;
  const focusTarget = target.matches("input,textarea,select,button,[tabindex]:not([tabindex='-1'])")
    ? target
    : target.querySelector<HTMLElement>("[data-v04-primary-focus]")
      ?? target.querySelector<HTMLElement>("input,textarea,select,button,[tabindex]:not([tabindex='-1'])");
  const anchor = focusTarget ?? target;
  anchor.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
  await afterV04Layout();
  if (sequence !== locateSequence) return false;
  ensureV04Visible(anchor);
  await afterV04Layout();
  if (sequence !== locateSequence) return false;
  focusTarget?.focus({ preventScroll: true });
  target.setAttribute("data-v04-located", "true");
  ensureV04Visible(anchor);
  window.setTimeout(() => {
    if (target.isConnected) target.removeAttribute("data-v04-located");
  }, 1800);
  return true;
}

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
  if (!draft.shotGroups.length) {
    missing.push({ id: "module-1", module: V04_UI_MODULES[0], scope: "脚本反写", label: "至少添加一个桥段并填写镜头画面内容" });
  }
  draft.shotGroups.forEach((group, index) => {
    const scope = `桥段${String(index + 1).padStart(2, "0")}`;
    requireText(group.title, v04GroupTitleTargetId(group.id), V04_UI_MODULES[0], scope, "桥段名称");
    if (!group.primaryRole.selectedOptionIds.length && !group.primaryRole.customText.trim())
      missing.push({ id: v04GroupPrimaryRoleTargetId(group.id), module: V04_UI_MODULES[0], scope, label: "桥段主创意作用" });
    if (!group.shots.some((shot) => shot.visualContent.trim()))
      missing.push({ id: v04ShotFieldTargetId(group.shots[0]?.id ?? group.id, "visualContent"), module: V04_UI_MODULES[0], scope, label: "至少一个镜头的画面内容" });
  });
  const core: Array<[keyof V04UiDraft, string]> = [
    ["commercialIntent", "商业意图"], ["storySummary", "故事梗概"], ["creativeMotif", "创意母题"],
    ["tensionButton", "张力按钮"], ["creativeThinkingChain", "创意思维链"],
    ["carrierExplanation", "创意承重载体具体说明"], ["creativeContract", "创意成立契约"], ["gradeReason", "评价理由"],
  ];
  core.forEach(([key, label]) => requireText(String(draft[key]), `field-${String(key)}`, V04_UI_MODULES[1], "全片", label));
  if (!draft.primaryMechanism.selectedOptionIds.length && !draft.primaryMechanism.customText.trim() && !draft.primaryMechanism.advancedText?.trim())
    missing.push({ id: V04_WORKSPACE_TARGETS.primaryMechanism, module: V04_UI_MODULES[1], scope: "全片", label: "创意主导手法及机制" });
  if (draft.primaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM") && !draft.primaryMechanism.advancedText?.trim())
    missing.push({ id: V04_WORKSPACE_TARGETS.primaryMechanismAdvanced, module: V04_UI_MODULES[1], scope: "全片", label: "待形成新机制｜进阶机制层" });
  if (draft.auxiliaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM") && !draft.auxiliaryMechanism.advancedText?.trim())
    missing.push({ id: "field-auxiliaryMechanism-advanced", module: V04_UI_MODULES[1], scope: "全片", label: "辅助待形成新机制｜进阶机制层" });
  if (!draft.storyReference.selectedOptionIds.length && !draft.storyReference.customText.trim())
    missing.push({ id: "field-storyReference", module: V04_UI_MODULES[1], scope: "全片", label: "故事参照类型" });
  if (!draft.carriers.length) missing.push({ id: "field-carriers", module: V04_UI_MODULES[1], scope: "全片", label: "创意承重载体" });
  if (!draft.overallGrade) missing.push({ id: "field-overallGrade", module: V04_UI_MODULES[1], scope: "整体评价", label: "整体创意评价" });
  const pathLabels = {
    LOVE: ["情感底板", "情感如何累积", "情感缺口／压力", "情感释放方式", "主要承重元素"],
    FUN: ["原始预期", "偏离／异常", "揭示／反转", "重新理解", "主要承重元素"],
    PERCEPTION: ["感知规则／装置", "重复与变化", "音画／文画关系", "高潮／兑现方式", "主要承重元素"],
  }[draft.primaryPath];
  draft.primaryPathAnswers[draft.primaryPath].forEach((value, index) => requireText(value, `field-path-${index}`, V04_UI_MODULES[2], "主导路径", pathLabels[index]));
  draft.auxiliaryPaths.forEach((path) => {
    requireText(draft.auxiliaryPathDetails[path]?.description ?? "", `field-aux-${path}-description`, V04_UI_MODULES[2], `辅助路径｜${path}`, "辅助路径说明");
    requireText(draft.auxiliaryPathDetails[path]?.role ?? "", `field-aux-${path}-role`, V04_UI_MODULES[2], `辅助路径｜${path}`, "辅助类型的创意作用");
  });
  return { ready: missing.length === 0, missing };
}

export function blankV04Shot(id: string) {
  return Object.fromEntries([["id", id], ...V04_UI_SHOT_FIELDS.map(({ key }) => [key, ""])]) as V04UiShot;
}
