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
  checkChoice(facts?.mainMechanism, "generalMechanism", 1, "facts.mainMechanism", "主导机制");
  checkChoice(facts?.auxiliaryMechanism, "generalMechanism", 2, "facts.auxiliaryMechanism", "辅助机制");
  checkChoice(facts?.storyReference, "storyReferenceType", 1, "facts.storyReference", "故事参照类型");
  if (overlap(
    facts?.mainMechanism?.selectedOptionIds ?? [],
    facts?.auxiliaryMechanism?.selectedOptionIds ?? [],
  ).length) {
    add("facts.auxiliaryMechanism", "辅助机制", "与主导机制选了同一项；主辅机制必须互斥");
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

export type V04ExclusiveAdjustment = {
  targetKey: string;
  targetLabel: string;
  valueType: "CHOICE_WITH_CUSTOM" | "STRUCTURE";
  beforeValue: unknown;
  afterValue: unknown;
};

/**
 * 主辅互斥的三对字段（主导/辅助机制、桥段主/辅创意作用、主导/辅助路径）在服务端
 * 「按处最后写入」合并时可能撞上：本页面看到的辅助是旧的，另一个标签页、另一台设备
 * 或别人汇入集成版的写法已经把同一项放进了另一侧。合并结果一旦违规，整份工作稿被拒，
 * 而这一处冲突在本页面上根本看不到、也就改不掉，之后每次自动保存都失败。
 *
 * 这里按界面同一条口径化解：主导优先，从辅助一侧去掉重复项（界面上辅助本来就不列出
 * 主导已选的项）。返回被调整的辅助字段，调用方把它记进修订事件并回传给页面。
 */
export function resolveV04ExclusiveOverlaps(payload: V04DraftPayloadV1): {
  payload: V04DraftPayloadV1;
  adjustments: V04ExclusiveAdjustment[];
} {
  const adjustments: V04ExclusiveAdjustment[] = [];
  const next = structuredClone(payload);
  const trimChoice = (
    primary: V04ChoiceValue | undefined,
    auxiliary: V04ChoiceValue | undefined,
    targetKey: string,
    targetLabel: string,
  ): V04ChoiceValue | undefined => {
    if (!primary || !auxiliary || !Array.isArray(primary.selectedOptionIds) || !Array.isArray(auxiliary.selectedOptionIds)) {
      return auxiliary;
    }
    const kept = auxiliary.selectedOptionIds.filter((id) => !primary.selectedOptionIds.includes(id));
    if (kept.length === auxiliary.selectedOptionIds.length) return auxiliary;
    const trimmed = { ...auxiliary, selectedOptionIds: kept };
    adjustments.push({ targetKey, targetLabel, valueType: "CHOICE_WITH_CUSTOM", beforeValue: auxiliary, afterValue: trimmed });
    return trimmed;
  };

  for (const group of next.script?.shotGroups ?? []) {
    const trimmed = trimChoice(group.primaryCreativeRole, group.auxiliaryCreativeRole,
      `shotGroup:${group.id}.auxiliaryCreativeRole`, "桥段辅助创意作用");
    if (trimmed) group.auxiliaryCreativeRole = trimmed;
  }
  const facts = next.factsAndCoreJudgement;
  if (facts) {
    const trimmed = trimChoice(facts.mainMechanism, facts.auxiliaryMechanism,
      "facts.auxiliaryMechanism", "auxiliaryMechanism");
    if (trimmed) facts.auxiliaryMechanism = trimmed;
  }
  const path = next.perceptionPath;
  if (path && Array.isArray(path.auxiliaryTypes) &&
    path.auxiliaryTypes.some((item) => item.type === path.primaryType)) {
    const before = path.auxiliaryTypes;
    path.auxiliaryTypes = before.filter((item) => item.type !== path.primaryType);
    adjustments.push({
      targetKey: "path.auxiliaryTypes", targetLabel: "辅助路径", valueType: "STRUCTURE",
      beforeValue: before, afterValue: path.auxiliaryTypes,
    });
  }
  return { payload: adjustments.length ? next : payload, adjustments };
}
