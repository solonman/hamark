import { createHash } from "node:crypto";
import {
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_PRODUCT_VERSION,
  V04_TAXONOMY_VERSION,
  V04_VERSION_CONTRACT,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
  type V04Change,
  type V04ChoiceValue,
  type V04DraftPayloadV1,
  type V04PerceptionType,
} from "./v04-contract";
import { V04_VOCABULARY_OPTIONS, type V04VocabularyFieldKey } from "./v04-vocabulary";

export type V04WorkflowState =
  | "NOT_STARTED"
  | "INCOMPLETE"
  | "SUBMITTED"
  | "MODIFIED_UNSUBMITTED"
  | "MODIFICATION_SUBMITTED";

export type V04WorkflowFacts = {
  hasAnyDraftData: boolean;
  currentDraftRevision: number;
  currentDraftContentHash: string;
  successfulSubmissionCount: number;
  latestSubmissionSourceRevision: number | null;
  latestSubmissionContentHash: string | null;
};

export type V04MissingItem = {
  moduleKey: "SCRIPT" | "FACTS" | "PERCEPTION";
  scopeId: string;
  scopeLabel: string;
  fieldKey: string;
  targetKey: string;
  message: string;
};

const PRIMARY_DETAIL_KEYS: Record<V04PerceptionType, readonly string[]> = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
};

const trim = (value: unknown) => typeof value === "string" ? value.trim() : "";
const hasChoice = (value: V04ChoiceValue) =>
  value.selectedOptionIds.length > 0 || Boolean(trim(value.customText));

const OPTION_IDS = Object.fromEntries(
  (["bridgeCreativeRole", "generalMechanism", "storyReferenceType"] as const).map((fieldKey) => [
    fieldKey,
    new Set(V04_VOCABULARY_OPTIONS
      .filter((option) => option.fieldKey === fieldKey)
      .map((option) => option.optionId)),
  ]),
) as Record<V04VocabularyFieldKey, Set<string>>;

function assertChoice(
  value: V04ChoiceValue,
  fieldKey: V04VocabularyFieldKey,
  maxFixed: number,
) {
  const ids = value.selectedOptionIds;
  if (
    value.vocabularyVersion !== V04_VOCABULARY_VERSION ||
    ids.length > maxFixed ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !OPTION_IDS[fieldKey].has(id))
  ) {
    throw new Error("CHOICE_RULE_VIOLATION");
  }
}

export function emptyV04ChoiceValue(): V04ChoiceValue {
  return {
    selectedOptionIds: [],
    customText: "",
    advancedText: "",
    vocabularyVersion: V04_VOCABULARY_VERSION,
  };
}

export function emptyV04DraftPayload(): V04DraftPayloadV1 {
  return {
    contract: {
      productVersion: V04_PRODUCT_VERSION,
      taxonomyVersion: V04_TAXONOMY_VERSION,
      workflowVersion: V04_WORKFLOW_VERSION,
      vocabularyVersion: V04_VOCABULARY_VERSION,
      payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
    },
    script: { shotGroups: [] },
    factsAndCoreJudgement: {
      commercialIntent: "",
      storySynopsis: "",
      creativeMotif: "",
      tensionButton: "",
      mainMechanism: emptyV04ChoiceValue(),
      auxiliaryMechanism: emptyV04ChoiceValue(),
      creativeThinkingChain: "",
      storyReference: emptyV04ChoiceValue(),
      creativeCarriers: [],
      carrierExplanation: "",
      acceptanceContract: "",
      overallCreativeRating: "",
      ratingReason: "",
    },
    perceptionPath: { primaryType: "", primaryDetails: {}, auxiliaryTypes: [] },
    metadata: { source: "HUMAN" },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function canonicalV04Payload(payload: V04DraftPayloadV1) {
  return JSON.stringify(stableValue(payload));
}

export function hashV04Payload(payload: V04DraftPayloadV1) {
  return createHash("sha256").update(canonicalV04Payload(payload), "utf8").digest("hex");
}

export function assertV04PayloadContract(payload: V04DraftPayloadV1) {
  const contract = payload?.contract;
  if (
    contract?.productVersion !== V04_VERSION_CONTRACT.productVersion ||
    contract?.taxonomyVersion !== V04_VERSION_CONTRACT.taxonomyVersion ||
    contract?.workflowVersion !== V04_VERSION_CONTRACT.workflowVersion ||
    contract?.vocabularyVersion !== V04_VERSION_CONTRACT.vocabularyVersion ||
    contract?.payloadSchemaVersion !== V04_VERSION_CONTRACT.payloadSchemaVersion
  ) {
    throw new Error("INVALID_PAYLOAD_SCHEMA");
  }
  const groupIds = new Set<string>();
  const shotIds = new Set<string>();
  let previousShotOrder = -1;
  for (const [groupIndex, group] of payload.script.shotGroups.entries()) {
    if (!group.id || groupIds.has(group.id) || group.orderIndex !== groupIndex) {
      throw new Error("INVALID_PAYLOAD_SCHEMA");
    }
    groupIds.add(group.id);
    assertChoice(group.primaryCreativeRole, "bridgeCreativeRole", 1);
    assertChoice(group.auxiliaryCreativeRole, "bridgeCreativeRole", 3);
    if (group.primaryCreativeRole.selectedOptionIds.some(
      (id) => group.auxiliaryCreativeRole.selectedOptionIds.includes(id),
    )) {
      throw new Error("CHOICE_RULE_VIOLATION");
    }
    for (const shot of group.shots) {
      if (!shot.id || shotIds.has(shot.id) || shot.orderIndex <= previousShotOrder) {
        throw new Error("INVALID_PAYLOAD_SCHEMA");
      }
      shotIds.add(shot.id);
      previousShotOrder = shot.orderIndex;
    }
  }
  const facts = payload.factsAndCoreJudgement;
  assertChoice(facts.mainMechanism, "generalMechanism", 1);
  assertChoice(facts.auxiliaryMechanism, "generalMechanism", 2);
  assertChoice(facts.storyReference, "storyReferenceType", 1);
  if (facts.mainMechanism.selectedOptionIds.some(
    (id) => facts.auxiliaryMechanism.selectedOptionIds.includes(id),
  )) {
    throw new Error("CHOICE_RULE_VIOLATION");
  }
  if (facts.creativeCarriers.length > 3 ||
      new Set(facts.creativeCarriers).size !== facts.creativeCarriers.length) {
    throw new Error("CHOICE_RULE_VIOLATION");
  }
  const auxiliaries = payload.perceptionPath.auxiliaryTypes;
  if (auxiliaries.length > 2 || new Set(auxiliaries.map((item) => item.type)).size !== auxiliaries.length ||
      auxiliaries.some((item) => item.type === payload.perceptionPath.primaryType)) {
    throw new Error("CHOICE_RULE_VIOLATION");
  }
}

export function hasAnyV04DraftData(payload: V04DraftPayloadV1) {
  const withoutContract = {
    ...payload,
    contract: emptyV04DraftPayload().contract,
    metadata: emptyV04DraftPayload().metadata,
  };
  return canonicalV04Payload(withoutContract) !== canonicalV04Payload(emptyV04DraftPayload());
}

export function deriveV04WorkflowState(facts: V04WorkflowFacts): V04WorkflowState {
  const count = Math.max(0, Math.trunc(facts.successfulSubmissionCount));
  if (count === 0) return facts.hasAnyDraftData ? "INCOMPLETE" : "NOT_STARTED";
  if (facts.currentDraftContentHash !== facts.latestSubmissionContentHash) {
    return "MODIFIED_UNSUBMITTED";
  }
  return count === 1 ? "SUBMITTED" : "MODIFICATION_SUBMITTED";
}

function missing(
  list: V04MissingItem[],
  item: Omit<V04MissingItem, "message"> & { message?: string },
) {
  list.push({ ...item, message: item.message ?? `请填写${item.scopeLabel}的${item.fieldKey}` });
}

export function validateV04Publication(payload: V04DraftPayloadV1) {
  assertV04PayloadContract(payload);
  const items: V04MissingItem[] = [];
  if (payload.script.shotGroups.length === 0) missing(items, {
    moduleKey: "SCRIPT", scopeId: "script", scopeLabel: "脚本反写",
    fieldKey: "shotGroups", targetKey: "script.shotGroups",
    message: "请至少添加一个桥段并填写镜头画面内容",
  });
  for (const group of payload.script.shotGroups) {
    const groupLabel = group.bridgeName.trim() || `桥段 ${group.orderIndex + 1}`;
    if (!trim(group.bridgeName)) missing(items, {
      moduleKey: "SCRIPT", scopeId: group.id, scopeLabel: groupLabel,
      fieldKey: "bridgeName", targetKey: `shotGroup:${group.id}.bridgeName`,
    });
    if (!hasChoice(group.primaryCreativeRole)) missing(items, {
      moduleKey: "SCRIPT", scopeId: group.id, scopeLabel: groupLabel,
      fieldKey: "primaryCreativeRole", targetKey: `shotGroup:${group.id}.primaryCreativeRole`,
    });
    if (!group.shots.some((shot) => Boolean(trim(shot.visualContent)))) missing(items, {
      moduleKey: "SCRIPT", scopeId: group.id, scopeLabel: groupLabel,
      fieldKey: "visualContent", targetKey: `shotGroup:${group.id}.shots`,
      message: `${groupLabel}至少需要一个镜头填写画面内容`,
    });
  }
  const facts = payload.factsAndCoreJudgement;
  const requiredFacts: Array<[keyof typeof facts, string]> = [
    ["commercialIntent", "商业意图"], ["storySynopsis", "故事梗概"],
    ["creativeMotif", "创意母题"], ["tensionButton", "张力按钮"],
    ["creativeThinkingChain", "创意思维链"], ["carrierExplanation", "承重说明"],
    ["acceptanceContract", "成立契约"], ["ratingReason", "评价理由"],
  ];
  for (const [fieldKey, label] of requiredFacts) {
    if (!trim(facts[fieldKey])) missing(items, {
      moduleKey: "FACTS", scopeId: "facts", scopeLabel: label,
      fieldKey, targetKey: `facts.${fieldKey}`,
    });
  }
  const mainMechanism = facts.mainMechanism;
  if (!hasChoice(mainMechanism) && !trim(mainMechanism.advancedText)) missing(items, {
    moduleKey: "FACTS", scopeId: "facts", scopeLabel: "主导通用机制",
    fieldKey: "mainMechanism", targetKey: "facts.mainMechanism",
  });
  for (const [fieldKey, label, value] of [
    ["mainMechanism", "主导通用机制", mainMechanism],
    ["auxiliaryMechanism", "辅助通用机制", facts.auxiliaryMechanism],
  ] as const) {
    if (value.selectedOptionIds.includes("PENDING_NEW_MECHANISM") && !trim(value.advancedText)) {
      missing(items, {
        moduleKey: "FACTS", scopeId: "facts", scopeLabel: label,
        fieldKey: `${fieldKey}.advancedText`, targetKey: `facts.${fieldKey}.advancedText`,
      });
    }
  }
  if (!hasChoice(facts.storyReference)) missing(items, {
    moduleKey: "FACTS", scopeId: "facts", scopeLabel: "故事参照类型",
    fieldKey: "storyReference", targetKey: "facts.storyReference",
  });
  if (facts.creativeCarriers.length < 1) missing(items, {
    moduleKey: "FACTS", scopeId: "facts", scopeLabel: "创意承重载体",
    fieldKey: "creativeCarriers", targetKey: "facts.creativeCarriers",
  });
  if (!new Set(["S", "A", "B", "C"]).has(facts.overallCreativeRating)) missing(items, {
    moduleKey: "FACTS", scopeId: "facts", scopeLabel: "整体创意评价",
    fieldKey: "overallCreativeRating", targetKey: "facts.overallCreativeRating",
  });
  const path = payload.perceptionPath;
  if (!path.primaryType) missing(items, {
    moduleKey: "PERCEPTION", scopeId: "perception", scopeLabel: "主导路径",
    fieldKey: "primaryType", targetKey: "path.primaryType",
  });
  if (path.primaryType) {
    for (const key of PRIMARY_DETAIL_KEYS[path.primaryType]) {
      if (!trim(path.primaryDetails[key])) missing(items, {
        moduleKey: "PERCEPTION", scopeId: path.primaryType, scopeLabel: `${path.primaryType} 主导路径`,
        fieldKey: key, targetKey: `path.primaryDetails.${key}`,
      });
    }
  }
  for (const auxiliary of path.auxiliaryTypes) {
    for (const key of ["description", "creativeRole"] as const) {
      if (!trim(auxiliary[key])) missing(items, {
        moduleKey: "PERCEPTION", scopeId: auxiliary.type, scopeLabel: `${auxiliary.type} 辅助路径`,
        fieldKey: key, targetKey: `path.auxiliary:${auxiliary.type}.${key}`,
      });
    }
  }
  return { publicationReady: items.length === 0, missingItems: items };
}

export type V04ConflictDecision = {
  kind: "APPLY" | "REBASE" | "CONFLICT";
  conflictTargets: string[];
};

export function decideV04ChangeSet(
  expectedRevision: number,
  serverRevision: number,
  localChanges: readonly V04Change[],
  serverChangesSinceExpected: readonly Pick<V04Change, "targetKey" | "valueType">[],
): V04ConflictDecision {
  if (expectedRevision === serverRevision) return { kind: "APPLY", conflictTargets: [] };
  const localTargets = new Set(localChanges.map((change) => change.targetKey));
  const serverTargets = new Set(serverChangesSinceExpected.map((change) => change.targetKey));
  const structural = localChanges.some((change) => change.valueType === "STRUCTURE") ||
    serverChangesSinceExpected.some((change) => change.valueType === "STRUCTURE");
  const intersection = [...localTargets].filter((target) => serverTargets.has(target));
  if (structural || intersection.length > 0) {
    return {
      kind: "CONFLICT",
      conflictTargets: structural
        ? [...new Set([...intersection, ...localTargets, ...serverTargets])].sort()
        : intersection.sort(),
    };
  }
  return { kind: "REBASE", conflictTargets: [] };
}

function clonePayload(payload: V04DraftPayloadV1) {
  return structuredClone(payload);
}

function locateTarget(payload: V04DraftPayloadV1, targetKey: string) {
  const groupMatch = targetKey.match(/^shotGroup:([^.]+)\.(.+)$/);
  if (groupMatch) {
    const group = payload.script.shotGroups.find((item) => item.id === groupMatch[1]);
    return group ? { object: group as unknown as Record<string, unknown>, key: groupMatch[2] } : null;
  }
  const shotMatch = targetKey.match(/^shot:([^.]+)\.(.+)$/);
  if (shotMatch) {
    const shot = payload.script.shotGroups.flatMap((group) => group.shots)
      .find((item) => item.id === shotMatch[1]);
    return shot ? { object: shot as unknown as Record<string, unknown>, key: shotMatch[2] } : null;
  }
  const prefixes: Array<[string, Record<string, unknown>]> = [
    ["facts.", payload.factsAndCoreJudgement as unknown as Record<string, unknown>],
    ["path.", payload.perceptionPath as unknown as Record<string, unknown>],
  ];
  for (const [prefix, object] of prefixes) {
    if (targetKey.startsWith(prefix) && !targetKey.slice(prefix.length).includes(".")) {
      return { object, key: targetKey.slice(prefix.length) };
    }
  }
  if (targetKey === "script.structure") {
    return { object: payload.script as unknown as Record<string, unknown>, key: "shotGroups" };
  }
  return null;
}

export function applyV04ChangeSet(payload: V04DraftPayloadV1, changes: readonly V04Change[]) {
  const next = clonePayload(payload);
  for (const change of changes) {
    const target = locateTarget(next, change.targetKey);
    if (!target || !Object.is(target.object[target.key], change.beforeValue) &&
      canonicalJson(target.object[target.key]) !== canonicalJson(change.beforeValue)) {
      throw new Error("REVISION_CONFLICT");
    }
    target.object[target.key] = structuredClone(change.afterValue);
  }
  assertV04PayloadContract(next);
  return next;
}

const canonicalJson = (value: unknown) => JSON.stringify(stableValue(value));

export function canonicalV04ChangeSet(changes: readonly V04Change[]) {
  const targets = changes.map((change) => change.targetKey);
  if (new Set(targets).size !== targets.length) {
    throw new Error("DUPLICATE_CHANGE_TARGET");
  }
  return canonicalJson(changes.map((change) => ({
    targetKey: change.targetKey,
    targetLabel: change.targetLabel,
    valueType: change.valueType,
    beforeValue: change.beforeValue ?? null,
    afterValue: change.afterValue ?? null,
    reason: change.reason ?? null,
  })).toSorted((left, right) => left.targetKey.localeCompare(right.targetKey, "en")));
}
