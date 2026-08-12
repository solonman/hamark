import { annotationFields } from "./annotation-fields";
import { mainPathFields, V03_TAXONOMY_VERSION } from "./taxonomy-v0.3";
import type { AnnotationDraft } from "./types";

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
