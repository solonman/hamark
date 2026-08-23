import {
  V04_VERSION_CONTRACT,
  V04_VOCABULARY_VERSION,
  type V04ChoiceValue,
  type V04DraftPayloadV1,
} from "./v04-contract";
import { V04_VOCABULARY_OPTIONS, type V04VocabularyFieldKey } from "./v04-vocabulary";

// Browser-safe: this module must stay free of node: imports because the
// workspace client checks a draft against the frozen contract before sending.

const OPTION_IDS = Object.fromEntries(
  (["bridgeCreativeRole", "generalMechanism", "storyReferenceType"] as const).map((fieldKey) => [
    fieldKey,
    new Set(V04_VOCABULARY_OPTIONS
      .filter((option) => option.fieldKey === fieldKey)
      .map((option) => option.optionId)),
  ]),
) as Record<V04VocabularyFieldKey, Set<string>>;

export type V04ContractViolation = {
  targetKey: string;
  targetLabel: string;
  message: string;
};

/**
 * Every rule of the frozen payload contract, reported per stable target
 * instead of as one opaque throw. A violation blocks the save for good —
 * retrying the same draft can never succeed — so the editor has to be told
 * exactly which field to fix. Same rules as assertV04PayloadContract.
 */
export function listV04ContractViolations(payload: V04DraftPayloadV1): V04ContractViolation[] {
  const violations: V04ContractViolation[] = [];
  const add = (targetKey: string, targetLabel: string, message: string) =>
    violations.push({ targetKey, targetLabel, message });
  const checkChoice = (
    value: V04ChoiceValue | undefined,
    fieldKey: V04VocabularyFieldKey,
    maxFixed: number,
    targetKey: string,
    targetLabel: string,
  ) => {
    if (!value || !Array.isArray(value.selectedOptionIds)) {
      add(targetKey, targetLabel, "选项结构不完整");
      return;
    }
    const ids = value.selectedOptionIds;
    if (value.vocabularyVersion !== V04_VOCABULARY_VERSION) {
      add(targetKey, targetLabel, "词表版本与当前合同不一致，请重新选择");
    }
    if (ids.length > maxFixed) add(targetKey, targetLabel, `固定选项最多选 ${maxFixed} 项`);
    if (new Set(ids).size !== ids.length) add(targetKey, targetLabel, "同一选项被重复选择");
    if (ids.some((id) => !OPTION_IDS[fieldKey].has(id))) {
      add(targetKey, targetLabel, "包含当前词表中不存在的选项");
    }
  };
  const overlap = (left: readonly string[], right: readonly string[]) =>
    left.filter((id) => right.includes(id));

  const contract = payload?.contract;
  if (
    contract?.productVersion !== V04_VERSION_CONTRACT.productVersion ||
    contract?.taxonomyVersion !== V04_VERSION_CONTRACT.taxonomyVersion ||
    contract?.workflowVersion !== V04_VERSION_CONTRACT.workflowVersion ||
    contract?.vocabularyVersion !== V04_VERSION_CONTRACT.vocabularyVersion ||
    contract?.payloadSchemaVersion !== V04_VERSION_CONTRACT.payloadSchemaVersion
  ) {
    add("contract", "工作稿版本合同", "工作稿的版本合同与当前系统不一致，请刷新页面");
  }

  const groupIds = new Set<string>();
  const shotIds = new Set<string>();
  let previousShotOrder = -1;
  for (const [groupIndex, group] of (payload?.script?.shotGroups ?? []).entries()) {
    const groupLabel = `桥段 ${groupIndex + 1}${group.bridgeName?.trim() ? `｜${group.bridgeName.trim()}` : ""}`;
    if (!group.id || groupIds.has(group.id)) {
      add(`shotGroup:${group.id}`, groupLabel, "桥段标识缺失或重复");
    }
    if (group.orderIndex !== groupIndex) add(`shotGroup:${group.id}`, groupLabel, "桥段顺序编号不连续");
    groupIds.add(group.id);
    checkChoice(group.primaryCreativeRole, "bridgeCreativeRole", 1,
      `shotGroup:${group.id}.primaryCreativeRole`, `${groupLabel} · 主创意作用`);
    checkChoice(group.auxiliaryCreativeRole, "bridgeCreativeRole", 3,
      `shotGroup:${group.id}.auxiliaryCreativeRole`, `${groupLabel} · 辅助创意作用`);
    const roleOverlap = overlap(
      group.primaryCreativeRole?.selectedOptionIds ?? [],
      group.auxiliaryCreativeRole?.selectedOptionIds ?? [],
    );
    if (roleOverlap.length) {
      add(`shotGroup:${group.id}.auxiliaryCreativeRole`, `${groupLabel} · 辅助创意作用`,
        "与主创意作用选了同一项；主辅作用必须互斥");
    }
    for (const shot of group.shots ?? []) {
      if (!shot.id || shotIds.has(shot.id)) {
        add(`shot:${shot.id}`, `${groupLabel} · 镜头`, "镜头标识缺失或重复");
      }
      if (shot.orderIndex <= previousShotOrder) {
        add(`shot:${shot.id}`, `${groupLabel} · 镜头`, "镜头顺序编号不递增");
      }
      shotIds.add(shot.id);
      previousShotOrder = shot.orderIndex;
    }
  }

  const facts = payload?.factsAndCoreJudgement;
  checkChoice(facts?.mainMechanism, "generalMechanism", 1, "facts.mainMechanism", "创意主导手法及机制");
  checkChoice(facts?.auxiliaryMechanism, "generalMechanism", 2, "facts.auxiliaryMechanism", "创意辅助手法及机制");
  checkChoice(facts?.storyReference, "storyReferenceType", 1, "facts.storyReference", "故事参照类型");
  if (overlap(
    facts?.mainMechanism?.selectedOptionIds ?? [],
    facts?.auxiliaryMechanism?.selectedOptionIds ?? [],
  ).length) {
    add("facts.auxiliaryMechanism", "创意辅助手法及机制", "与主导机制选了同一项；主辅机制必须互斥");
  }
  const carriers = facts?.creativeCarriers ?? [];
  if (carriers.length > 3) add("facts.creativeCarriers", "创意承重载体", "最多选 3 项");
  if (new Set(carriers).size !== carriers.length) add("facts.creativeCarriers", "创意承重载体", "同一载体被重复选择");

  const path = payload?.perceptionPath;
  const auxiliaries = path?.auxiliaryTypes ?? [];
  if (auxiliaries.length > 2) add("path.auxiliaryTypes", "辅助路径", "最多选 2 条");
  if (new Set(auxiliaries.map((item) => item.type)).size !== auxiliaries.length) {
    add("path.auxiliaryTypes", "辅助路径", "同一路径被重复选择");
  }
  if (auxiliaries.some((item) => item.type === path?.primaryType)) {
    add("path.auxiliaryTypes", "辅助路径", "与主导路径相同；辅助路径必须与主导互斥");
  }
  return violations;
}
