import { createHash } from "node:crypto";
import type {
  AnnotationDraft,
  CreativePath,
  CreativeStructureDraft,
  ShotDraft,
  ShotGroupDraft,
} from "./types";
import {
  V04_VOCABULARY_VERSION,
  type V04ChoiceValue,
  type V04DraftPayloadV1,
  type V04PerceptionPath,
  type V04PerceptionType,
  type V04ShotGroupPayload,
  type V04ShotPayload,
} from "./v04-contract";
import {
  emptyV04DraftPayload,
  hashV04Payload,
} from "./v04-domain";
import {
  V04_VOCABULARY_OPTIONS,
  type V04VocabularyFieldKey,
} from "./v04-vocabulary";

export type V04LegacyAdapterIssueType =
  | "UNKNOWN_LEGACY_CHOICE"
  | "AMBIGUOUS_LEGACY_ALIAS"
  | "CUSTOM_MARKER_WITHOUT_TEXT"
  | "UNASSIGNED_LEGACY_SHOT"
  | "UNMAPPED_LEGACY_VALUE";

export type V04LegacyAdapterIssue = {
  type: V04LegacyAdapterIssueType;
  sourceObjectId: string;
  sourceWorkflowVersion: string;
  fieldKey: string;
  stableTargetId: string;
  legacyValueHash: string;
};

export type V04LegacyAdapterResult = {
  sourceObjectId: string;
  sourceWorkflowVersion: string;
  payload: V04DraftPayloadV1;
  payloadHash: string;
  issues: V04LegacyAdapterIssue[];
};

const CUSTOM_MARKERS = new Set([
  "__CUSTOM__",
  "其他",
  "其他（自定义）",
  "其他（自定义类型）",
  "其他（自定义机制）",
  "其他（自定义参照类型）",
]);

const LEGACY_MECHANISM_ALIASES: Record<string, string> = {
  "重复积累": "REPETITION_CHANGES_MEANING",
  "对比冲突": "JUXTAPOSITION_CREATES_MEANING",
  "规则设定": "UNCONVENTIONAL_RULE_BUILDING",
};

const LEGACY_STORY_REFERENCE_ALIASES = [
  "青春怀旧", "家庭亲情", "成长陪伴", "爱情相遇", "爱情错过", "离别重逢", "家庭和解",
  "公路旅程", "职场奋斗", "热血竞技", "小人物逆袭", "日常生活喜剧", "荒诞喜剧",
  "悬疑揭秘", "社会纪实", "人生回望", "童话寓言", "科技奇幻", "历史史诗", "英雄冒险",
  "群像人生",
] as const;

const sha256 = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(value), "utf8")
  .digest("hex");

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

function buildApprovedAliasIndex() {
  const index = new Map<V04VocabularyFieldKey, Map<string, string[]>>();
  for (const fieldKey of ["bridgeCreativeRole", "generalMechanism", "storyReferenceType"] as const) {
    index.set(fieldKey, new Map());
  }
  const add = (fieldKey: V04VocabularyFieldKey, alias: string, optionId: string) => {
    const normalized = text(alias);
    if (!normalized) return;
    const byAlias = index.get(fieldKey)!;
    byAlias.set(normalized, [...(byAlias.get(normalized) ?? []), optionId]);
  };
  for (const option of V04_VOCABULARY_OPTIONS) {
    add(option.fieldKey, option.labelZhCn, option.optionId);
  }
  for (const [alias, optionId] of Object.entries(LEGACY_MECHANISM_ALIASES)) {
    add("generalMechanism", alias, optionId);
  }
  const storyOptions = V04_VOCABULARY_OPTIONS.filter(
    (option) => option.fieldKey === "storyReferenceType",
  );
  if (storyOptions.length !== LEGACY_STORY_REFERENCE_ALIASES.length) {
    throw new Error("V0.4 legacy story alias contract drift");
  }
  LEGACY_STORY_REFERENCE_ALIASES.forEach((alias, indexValue) => {
    add("storyReferenceType", alias, storyOptions[indexValue].optionId);
  });
  return index;
}

const APPROVED_ALIAS_INDEX = buildApprovedAliasIndex();

function issue(
  issues: V04LegacyAdapterIssue[],
  type: V04LegacyAdapterIssueType,
  sourceObjectId: string,
  sourceWorkflowVersion: string,
  fieldKey: string,
  stableTargetId: string,
  raw: unknown,
) {
  issues.push({
    type,
    sourceObjectId,
    sourceWorkflowVersion,
    fieldKey,
    stableTargetId,
    legacyValueHash: sha256(raw),
  });
}

function mapChoice(args: {
  sourceObjectId: string;
  sourceWorkflowVersion: string;
  stableTargetId: string;
  fieldKey: V04VocabularyFieldKey;
  rawValues: unknown[];
  customText?: unknown;
  advancedText?: unknown;
  issues: V04LegacyAdapterIssue[];
}): V04ChoiceValue {
  const selectedOptionIds: string[] = [];
  const unknownValues: string[] = [];
  let sawCustomMarker = false;
  const byAlias = APPROVED_ALIAS_INDEX.get(args.fieldKey)!;

  for (const raw of args.rawValues) {
    const value = text(raw);
    if (!value) continue;
    if (CUSTOM_MARKERS.has(value)) {
      sawCustomMarker = true;
      continue;
    }
    const matches = [...new Set(byAlias.get(value) ?? [])];
    if (matches.length === 1) {
      if (!selectedOptionIds.includes(matches[0])) selectedOptionIds.push(matches[0]);
      continue;
    }
    if (matches.length > 1) {
      issue(args.issues, "AMBIGUOUS_LEGACY_ALIAS", args.sourceObjectId,
        args.sourceWorkflowVersion,
        args.fieldKey, args.stableTargetId, value);
    } else {
      issue(args.issues, "UNKNOWN_LEGACY_CHOICE", args.sourceObjectId,
        args.sourceWorkflowVersion,
        args.fieldKey, args.stableTargetId, value);
    }
    unknownValues.push(value);
  }

  const suppliedCustom = text(args.customText);
  const customText = suppliedCustom || unknownValues.join("；");
  if (sawCustomMarker && !customText) {
    issue(args.issues, "CUSTOM_MARKER_WITHOUT_TEXT", args.sourceObjectId,
      args.sourceWorkflowVersion,
      args.fieldKey, args.stableTargetId, args.rawValues);
  }
  const advancedText = text(args.advancedText);
  const legacyRawValue = {
    rawValues: args.rawValues,
    customText: suppliedCustom,
    advancedText,
  };
  return {
    selectedOptionIds,
    customText,
    advancedText,
    vocabularyVersion: V04_VOCABULARY_VERSION,
    legacyRawValue,
  };
}

function mapShot(shot: ShotDraft, orderIndex: number): V04ShotPayload {
  return {
    id: shot.id || `legacy-shot-${orderIndex + 1}`,
    orderIndex,
    startTime: text(shot.startTime),
    endTime: text(shot.endTime),
    shotScale: text(shot.shotSize),
    cameraAngle: text(shot.cameraAngle),
    cameraMovement: text(shot.cameraMovement),
    visualContent: text(shot.visualContent),
    screenCopy: text(shot.screenText),
    subtitleEffect: "",
    dialogue: text(shot.dialogue),
    voiceOver: text(shot.voiceover),
    soundEffect: text(shot.soundEffect),
    music: text(shot.music),
  };
}

function roleChoice(
  annotationId: string,
  sourceWorkflowVersion: string,
  group: ShotGroupDraft | undefined,
  slot: "primary" | "auxiliary",
  issues: V04LegacyAdapterIssue[],
) {
  const rawValues = slot === "primary"
    ? [group?.primaryRole]
    : group?.auxiliaryRoles ?? [];
  return mapChoice({
    sourceObjectId: annotationId,
    sourceWorkflowVersion,
    stableTargetId: group?.id ?? annotationId,
    fieldKey: "bridgeCreativeRole",
    rawValues,
    customText: group?.customRole,
    issues,
  });
}

function mapScript(
  sourceObjectId: string,
  sourceWorkflowVersion: string,
  annotation: AnnotationDraft,
  issues: V04LegacyAdapterIssue[],
): V04ShotGroupPayload[] {
  const sourceShots = [...annotation.shots].sort((left, right) => left.orderIndex - right.orderIndex);
  const sourceGroups = [...(annotation.shotGroups ?? [])]
    .sort((left, right) => left.orderIndex - right.orderIndex);
  const mappedShotIds = new Set<string>();
  const groups: Array<{
    stableId: string;
    title: string;
    group?: ShotGroupDraft;
    shots: ShotDraft[];
    fallbackNote: string;
  }> = [];

  for (const group of sourceGroups) {
    const shots = sourceShots.filter((shot) => shot.shotGroupId === group.id);
    shots.forEach((shot) => mappedShotIds.add(shot.id));
    groups.push({
      stableId: group.id,
      title: text(group.title),
      group,
      shots,
      fallbackNote: text(shots.find((shot) => text(shot.creativeComment))?.creativeComment),
    });
  }

  let fallbackGroup: typeof groups[number] | null = null;
  for (const shot of sourceShots.filter((item) => !mappedShotIds.has(item.id))) {
    const title = text(shot.groupName) || `桥段 ${groups.length + 1}`;
    if (!fallbackGroup || fallbackGroup.title !== title) {
      fallbackGroup = {
        stableId: `legacy-group:${sourceObjectId}:${groups.length + 1}`,
        title,
        shots: [],
        fallbackNote: "",
      };
      groups.push(fallbackGroup);
    }
    fallbackGroup.shots.push(shot);
    if (!fallbackGroup.fallbackNote && text(shot.creativeComment)) {
      fallbackGroup.fallbackNote = text(shot.creativeComment);
    }
    if (sourceGroups.length > 0) {
      issue(issues, "UNASSIGNED_LEGACY_SHOT", sourceObjectId, sourceWorkflowVersion,
        "shotGroupId", shot.id, shot.shotGroupId);
    }
  }

  let globalShotOrder = 0;
  return groups.map((entry, groupIndex) => ({
    id: entry.stableId,
    orderIndex: groupIndex,
    bridgeName: entry.title,
    primaryCreativeRole: roleChoice(sourceObjectId, sourceWorkflowVersion,
      entry.group, "primary", issues),
    auxiliaryCreativeRole: roleChoice(sourceObjectId, sourceWorkflowVersion,
      entry.group, "auxiliary", issues),
    keyCreativeDescription: text(entry.group?.note) || entry.fallbackNote,
    shots: entry.shots.map((shot) => mapShot(shot, globalShotOrder++)),
  }));
}

const PATH_MAP: Record<CreativePath, V04PerceptionType> = {
  LOVE: "LOVE",
  INTERESTING: "FUN",
  SUBSTANCE: "PERCEPTION",
};

const PATH_DETAIL_MAP: Record<V04PerceptionType, Record<string, string>> = {
  LOVE: {
    emotionalBase: "emotionalBase",
    emotionalAccumulation: "accumulation",
    emotionalGap: "gapPressure",
    emotionalRelease: "releaseMethod",
    loveMainCarrier: "mainCarrier",
  },
  FUN: {
    originalExpectation: "originalExpectation",
    deviation: "deviation",
    reveal: "reveal",
    reinterpretation: "reinterpretation",
    interestingMainCarrier: "mainCarrier",
  },
  PERCEPTION: {
    perceptualRule: "perceptionRule",
    repetitionVariation: "repetitionVariation",
    mediaRelation: "audiovisualRelation",
    climaxPayoff: "payoff",
    substanceMainCarrier: "mainCarrier",
  },
};

function mapPerception(structure: CreativeStructureDraft | undefined): V04PerceptionPath {
  const primaryType = structure?.primaryCreativePath
    ? PATH_MAP[structure.primaryCreativePath]
    : "";
  const primaryDetails: Record<string, string> = {};
  if (primaryType) {
    for (const [legacyKey, targetKey] of Object.entries(PATH_DETAIL_MAP[primaryType])) {
      primaryDetails[targetKey] = text(structure?.mainPathPayload?.[legacyKey]);
    }
  }
  const auxiliaryTypes = (structure?.auxiliaryCreativePaths ?? []).flatMap((legacyType) => {
    const type = PATH_MAP[legacyType];
    if (!type || type === primaryType) return [];
    return [{
      type,
      description: text(structure?.auxiliaryPathNotes?.[legacyType]),
      creativeRole: "",
    }];
  }).slice(0, 2);
  return { primaryType, primaryDetails, auxiliaryTypes };
}

function exactCarrier(value: string) {
  const aliases: Record<string, "STORY" | "COPY" | "AUDIOVISUAL_RULE"> = {
    "故事": "STORY",
    "文案": "COPY",
    "视听规则": "AUDIOVISUAL_RULE",
  };
  return aliases[value];
}

function fieldValue(annotation: AnnotationDraft, code: string) {
  return text(annotation.fields.find((field) => field.code === code)?.answer);
}

export function adaptLegacyAnnotationToV04(args: {
  sourceObjectId: string;
  sourceWorkflowVersion: string;
  annotation: AnnotationDraft;
}): V04LegacyAdapterResult {
  const issues: V04LegacyAdapterIssue[] = [];
  const annotation = args.annotation;
  const structure = annotation.creativeStructure;
  const payload = emptyV04DraftPayload();
  payload.metadata = {
    source: "SYSTEM_MIGRATION",
    legacySource: {
      workflowVersion: args.sourceWorkflowVersion,
      objectId: args.sourceObjectId,
    },
  };
  payload.script.shotGroups = mapScript(
    args.sourceObjectId,
    args.sourceWorkflowVersion,
    annotation,
    issues,
  );

  const primaryMechanism = structure?.mechanismPrimary || fieldValue(annotation, "A2");
  const auxiliaryMechanisms = structure?.mechanismAuxiliary ?? [];
  const storyReference = structure?.storyReferenceType || fieldValue(annotation, "B2");
  const mainMechanism = mapChoice({
    sourceObjectId: args.sourceObjectId,
    sourceWorkflowVersion: args.sourceWorkflowVersion,
    stableTargetId: annotation.id ?? args.sourceObjectId,
    fieldKey: "generalMechanism",
    rawValues: [primaryMechanism],
    customText: structure?.mechanismCustom,
    advancedText: primaryMechanism === "现有词表不适用／待形成新机制"
      ? structure?.mechanismCustom
      : "",
    issues,
  });
  const auxiliaryMechanism = mapChoice({
    sourceObjectId: args.sourceObjectId,
    sourceWorkflowVersion: args.sourceWorkflowVersion,
    stableTargetId: annotation.id ?? args.sourceObjectId,
    fieldKey: "generalMechanism",
    rawValues: auxiliaryMechanisms,
    customText: structure?.mechanismCustom,
    advancedText: auxiliaryMechanisms.includes("现有词表不适用／待形成新机制")
      ? structure?.mechanismCustom
      : "",
    issues,
  });
  const storyReferenceChoice = mapChoice({
    sourceObjectId: args.sourceObjectId,
    sourceWorkflowVersion: args.sourceWorkflowVersion,
    stableTargetId: annotation.id ?? args.sourceObjectId,
    fieldKey: "storyReferenceType",
    rawValues: [storyReference],
    issues,
  });

  const carrierRaw = text(structure?.creativeCarriers);
  const carrier = exactCarrier(carrierRaw);
  if (carrierRaw && !carrier) {
    issue(issues, "UNMAPPED_LEGACY_VALUE", args.sourceObjectId,
      args.sourceWorkflowVersion,
      "creativeCarriers", annotation.id ?? args.sourceObjectId, carrierRaw);
  }
  payload.factsAndCoreJudgement = {
    commercialIntent: text(annotation.commercialIntent),
    storySynopsis: text(annotation.synopsis),
    creativeMotif: text(annotation.creativeTheme),
    tensionButton: text(structure?.creativeButton),
    mainMechanism,
    auxiliaryMechanism,
    creativeThinkingChain: text(annotation.thinkingChain),
    storyReference: storyReferenceChoice,
    creativeCarriers: carrier ? [carrier] : [],
    carrierExplanation: text(structure?.strengthSources) || carrierRaw,
    acceptanceContract: text(structure?.acceptanceContract),
    overallCreativeRating: structure?.creativeGrade ?? "",
    ratingReason: text(structure?.creativeGradeReason),
  };
  payload.perceptionPath = mapPerception(structure);

  return {
    sourceObjectId: args.sourceObjectId,
    sourceWorkflowVersion: args.sourceWorkflowVersion,
    payload,
    payloadHash: hashV04Payload(payload),
    issues,
  };
}

export function legacyAdapterIssueSummary(results: readonly V04LegacyAdapterResult[]) {
  const byType: Record<string, number> = {};
  const stableIds: Record<string, string[]> = {};
  for (const result of results) {
    for (const current of result.issues) {
      byType[current.type] = (byType[current.type] ?? 0) + 1;
      stableIds[current.type] = [...new Set([
        ...(stableIds[current.type] ?? []),
        current.sourceObjectId,
      ])].sort();
    }
  }
  return { byType, stableIds };
}
