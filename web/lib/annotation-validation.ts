import { annotationFields } from "./annotation-fields";
import {
  bridgeRoles,
  creativePathOptions,
  formationOptions,
  legacyMechanismOptions,
  mainPathFields,
  mechanismOptions,
  V03_TAXONOMY_VERSION,
} from "./taxonomy-v0.3";
import type { AnnotationDraft, CreativePath, FormationMode } from "./types";

const validBridgeRoles = new Set<string>(bridgeRoles);

export type ApprovalValidationIssue = {
  targetKey: string;
  message: string;
};

function unique(values: string[]) {
  return new Set(values).size === values.length;
}

function structureIssues(payload: AnnotationDraft): ApprovalValidationIssue[] {
  if (payload.taxonomyVersion !== V03_TAXONOMY_VERSION) return [];
  const structure = payload.creativeStructure;
  if (!structure) {
    return [{ targetKey: "structure", message: "缺少 V0.3 创意结构。" }];
  }
  const issues: ApprovalValidationIssue[] = [];
  const paths = new Set(creativePathOptions.map((option) => option.value));
  const formations = new Set(formationOptions.map((option) => option.value));
  const mechanisms = new Set([...legacyMechanismOptions, ...mechanismOptions]);
  const groupIds = new Set<string>();
  const shotIds = new Set<string>();

  for (const [index, group] of (payload.shotGroups ?? []).entries()) {
    const groupTarget = `group:${group.id || index}`;
    if (!group.id || groupIds.has(group.id)) {
      issues.push({ targetKey: groupTarget, message: `桥段 ${index + 1} 的稳定 ID 缺失或重复。` });
    } else {
      groupIds.add(group.id);
    }
    if (group.primaryRole !== "__CUSTOM__" && !validBridgeRoles.has(group.primaryRole)) {
      issues.push({ targetKey: `${groupTarget}:primary-role`, message: `桥段 ${index + 1} 的主要作用不在当前词表中。` });
    }
    if (group.primaryRole === "__CUSTOM__" && !group.customRole.trim()) {
      issues.push({ targetKey: `${groupTarget}:custom-role`, message: `桥段 ${index + 1} 选择“其他”后必须填写自定义作用。` });
    }
    if (group.auxiliaryRoles.length > 2 || !unique(group.auxiliaryRoles)) {
      issues.push({ targetKey: `${groupTarget}:auxiliary-roles`, message: `桥段 ${index + 1} 的辅助作用最多两项且不能重复。` });
    }
    if (group.auxiliaryRoles.includes(group.primaryRole)) {
      issues.push({ targetKey: `${groupTarget}:auxiliary-roles`, message: `桥段 ${index + 1} 的主要作用不能同时作为辅助作用。` });
    }
    if (group.auxiliaryRoles.some((role) => !validBridgeRoles.has(role))) {
      issues.push({ targetKey: `${groupTarget}:auxiliary-roles`, message: `桥段 ${index + 1} 含有无效的辅助作用。` });
    }
  }

  for (const [index, shot] of payload.shots.entries()) {
    if (!shot.id || shotIds.has(shot.id)) {
      issues.push({ targetKey: `shot:${shot.id || index}:row`, message: `镜头 ${index + 1} 的稳定 ID 缺失或重复。` });
    } else {
      shotIds.add(shot.id);
    }
    if (!shot.shotGroupId || !groupIds.has(shot.shotGroupId)) {
      issues.push({ targetKey: `shot:${shot.id || index}:row`, message: `镜头 ${index + 1} 没有绑定到真实桥段。` });
    }
  }

  if (!paths.has(structure.primaryCreativePath as CreativePath)) {
    issues.push({ targetKey: "structure:primary-creative-path", message: "主导创意路径无效。" });
  }
  if (structure.auxiliaryCreativePaths.length > 2 || !unique(structure.auxiliaryCreativePaths)) {
    issues.push({ targetKey: "structure:auxiliary-creative-paths", message: "辅助创意路径最多两项且不能重复。" });
  }
  if (structure.auxiliaryCreativePaths.includes(structure.primaryCreativePath as CreativePath)) {
    issues.push({ targetKey: "structure:auxiliary-creative-paths", message: "主导创意路径不能同时作为辅助路径。" });
  }
  if (structure.auxiliaryCreativePaths.some((path) => !paths.has(path))) {
    issues.push({ targetKey: "structure:auxiliary-creative-paths", message: "辅助创意路径含有无效枚举值。" });
  }
  if (structure.primaryCreativePath && paths.has(structure.primaryCreativePath)) {
    for (const field of mainPathFields[structure.primaryCreativePath]) {
      if (!structure.mainPathPayload[field.key]?.trim()) {
        issues.push({ targetKey: `structure:main-path:${field.key}`, message: `主导路径缺少“${field.label}”。` });
      }
    }
  }
  for (const path of structure.auxiliaryCreativePaths) {
    if (!structure.auxiliaryPathNotes[path]?.trim()) {
      issues.push({ targetKey: `structure:aux-path:${path}`, message: `辅助路径 ${path} 缺少增强作用说明。` });
    }
  }

  if (!mechanisms.has(structure.mechanismPrimary)) {
    issues.push({ targetKey: "structure:mechanism-primary", message: "主机制不在当前或兼容词表中。" });
  }
  if (structure.mechanismAuxiliary.length > 2 || !unique(structure.mechanismAuxiliary)) {
    issues.push({ targetKey: "structure:mechanism-auxiliary", message: "辅助机制最多两项且不能重复。" });
  }
  if (structure.mechanismAuxiliary.includes(structure.mechanismPrimary)) {
    issues.push({ targetKey: "structure:mechanism-auxiliary", message: "主机制不能同时作为辅助机制。" });
  }
  if (structure.mechanismAuxiliary.some((item) => !mechanisms.has(item))) {
    issues.push({ targetKey: "structure:mechanism-auxiliary", message: "辅助机制含有无效枚举值。" });
  }
  if (
    [structure.mechanismPrimary, ...structure.mechanismAuxiliary].some(
      (value) => value.includes("其他") || value.includes("待形成新机制"),
    ) && !structure.mechanismCustom.trim()
  ) {
    issues.push({ targetKey: "structure:mechanism-custom", message: "选择自定义机制后必须填写说明。" });
  }

  if (!formations.has(structure.formationPrimary as FormationMode)) {
    issues.push({ targetKey: "structure:formation-primary", message: "全片主要形成方式无效。" });
  }
  if (structure.formationAuxiliary.length > 2 || !unique(structure.formationAuxiliary)) {
    issues.push({ targetKey: "structure:formation-auxiliary", message: "辅助形成方式最多两项且不能重复。" });
  }
  if (structure.formationAuxiliary.includes(structure.formationPrimary as FormationMode)) {
    issues.push({ targetKey: "structure:formation-auxiliary", message: "主要形成方式不能同时作为辅助方式。" });
  }
  if (structure.formationAuxiliary.some((item) => !formations.has(item))) {
    issues.push({ targetKey: "structure:formation-auxiliary", message: "辅助形成方式含有无效枚举值。" });
  }
  const usesLocalTrigger = [structure.formationPrimary, ...structure.formationAuxiliary]
    .includes("LOCAL_TRIGGER");
  if (usesLocalTrigger && !structure.formationRelatedGroupIds.length) {
    issues.push({ targetKey: "structure:formation-related-groups", message: "关键局部触发必须关联至少一个真实桥段。" });
  }
  if (!usesLocalTrigger && structure.formationRelatedGroupIds.length) {
    issues.push({ targetKey: "structure:formation-related-groups", message: "未选择关键局部触发时不能保留关联桥段。" });
  }
  if (
    !unique(structure.formationRelatedGroupIds) ||
    structure.formationRelatedGroupIds.some((id) => !groupIds.has(id))
  ) {
    issues.push({ targetKey: "structure:formation-related-groups", message: "关联桥段包含重复或不存在的 ID。" });
  }
  return issues;
}

export function validateApprovalCandidate(payload: AnnotationDraft) {
  const required = validateAnnotation(payload).map((message) => ({
    targetKey: "required",
    message: `必填项未完成：${message}`,
  }));
  const structural = structureIssues(payload);
  const seen = new Set<string>();
  return [...required, ...structural].filter((issue) => {
    const key = `${issue.targetKey}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateV02(payload: AnnotationDraft) {
  const missing: string[] = [];
  if (!payload.analysisTitle.trim()) missing.push("分析标题");
  if (!payload.commercialIntent.trim()) missing.push("商业意图");
  if (!payload.creativeTheme.trim()) missing.push("创意母题");
  if (!payload.synopsis.trim()) missing.push("故事梗概");
  if (!payload.thinkingChain.trim()) missing.push("创意思维链");
  if (!payload.shots.some((shot) => shot.visualContent.trim())) {
    missing.push("至少一个有画面内容的镜头");
  }
  for (const field of annotationFields) {
    const answer = payload.fields.find((item) => item.code === field.code);
    if (!answer?.answer.trim()) missing.push(`${field.code} ${field.name}`);
  }
  return missing;
}

function validateV03(payload: AnnotationDraft) {
  const missing: string[] = [];
  const structure = payload.creativeStructure;
  const groups = payload.shotGroups ?? [];
  if (!payload.analysisTitle.trim()) missing.push("分析标题");
  if (!groups.length) missing.push("至少一个桥段");
  groups.forEach((group, index) => {
    const label = `桥段 ${index + 1}`;
    if (!group.title.trim()) missing.push(`${label} 标题`);
    if (!group.primaryRole.trim()) missing.push(`${label} 主创意作用`);
    if (group.primaryRole === "__CUSTOM__" && !group.customRole.trim()) {
      missing.push(`${label} 自定义作用说明`);
    }
    if (
      !payload.shots.some(
        (shot) => shot.shotGroupId === group.id && shot.visualContent.trim(),
      )
    ) {
      missing.push(`${label} 至少一个有画面内容的镜头`);
    }
  });
  if (!payload.commercialIntent.trim()) missing.push("商业意图");
  if (!payload.synopsis.trim()) missing.push("故事梗概");
  if (!payload.creativeTheme.trim()) missing.push("创意母题");
  if (!structure) return [...missing, "V0.3 创意结构"];
  if (!structure.creativeButton.trim()) missing.push("创意按钮");
  if (!structure.mechanismStatement.trim()) missing.push("创意机制具体句");
  if (!structure.mechanismPrimary.trim()) missing.push("创意机制二级归类");
  if (
    [structure.mechanismPrimary, ...structure.mechanismAuxiliary].some(
      (value) => value.includes("其他") || value.includes("待形成新机制"),
    ) &&
    !structure.mechanismCustom.trim()
  ) {
    missing.push("自定义／新机制说明");
  }
  if (!(structure.creativeRealizationPath || structure.realizationSkeleton).trim()) {
    missing.push("创意兑现路径");
  }
  if (!payload.thinkingChain.trim()) missing.push("创意思维链");
  if (!structure.brandProductLanding.trim()) missing.push("品牌／产品落点");
  if (!structure.storyReferenceType.trim()) missing.push("故事参照类型");
  if (!structure.storyArchetype.trim()) missing.push("故事原型");
  if (!structure.formationPrimary) missing.push("全片主形成方式");
  if (!structure.formationStatement.trim()) missing.push("全片形成说明");
  if (!structure.creativeCarriers.trim()) missing.push("创意承重载体");
  if (!structure.establishmentConditions.trim()) missing.push("创意成立条件");
  if (!structure.strengthSources.trim()) missing.push("成片强度来源");
  if (!payload.summary.trim()) missing.push("全篇创意总结");
  if (!structure.primaryCreativePath) missing.push("主导创意路径");
  if (!structure.compositeStateReason.trim()) missing.push("复合态判断");
  if (structure.primaryCreativePath) {
    mainPathFields[structure.primaryCreativePath].forEach((field) => {
      if (!structure.mainPathPayload[field.key]?.trim()) {
        missing.push(`主导路径·${field.label}`);
      }
    });
  }
  structure.auxiliaryCreativePaths.forEach((path) => {
    if (!structure.auxiliaryPathNotes[path]?.trim()) {
      missing.push(`辅助路径·${path} 增强作用`);
    }
  });
  if (structure.conditionFlags.unconventionalWorld && !structure.acceptanceContract.trim()) {
    missing.push("非常规世界的成立契约");
  }
  if (
    structure.conditionFlags.audiovisualCarriesIdea &&
    !structure.audiovisualMechanism.trim()
  ) {
    missing.push("视听机制具体操作");
  }
  if (
    (structure.primaryCreativePath === "INTERESTING" ||
      structure.conditionFlags.interestingLoadBearing) &&
    !structure.informationReleaseTurning.trim()
  ) {
    missing.push("信息释放／转折结构");
  }
  if (!structure.creativeGrade) missing.push("作品创意等级 S／A／B／C");
  if (!structure.creativeGradeReason.trim()) missing.push("创意等级理由");
  return missing;
}

// Shared by submit API and worksheet. Version dispatch prevents V0.3 from
// reinterpreting or weakening historical V0.2 validation.
export function validateAnnotation(payload: AnnotationDraft) {
  return payload.taxonomyVersion === V03_TAXONOMY_VERSION
    ? validateV03(payload)
    : validateV02(payload);
}
