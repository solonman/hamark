// 录音点评改写里「哪些条目可以改、叫什么、取值是什么形状」的唯一口径。
// 提示词（prompt.ts）用它列字段说明与作业；校验（proposal.ts）用它做白名单、位置说明与排序；
// 热词（tencent-asr.ts）用它取字段名。纯数据 + 纯函数，不碰数据库。
//
// 细粒度键（模型看到、写回的键）与落库键（V04 变更集的 targetKey）的关系见 docs/25 4.5 / 4.6：
//   facts.<key>                                   → facts.<key>
//   shotGroup:<id>.<field> / shot:<id>.<field>    → 原样
//   path.primaryType                              → path.primaryType（切换时连同细项，见 proposal.ts）
//   path.primaryDetails.<subKey>                  → path.primaryDetails
//   path.auxiliaryTypes.<TYPE>.description|creativeRole → path.auxiliaryTypes

import type { AudioReviewValueType } from "@/lib/audio-review-model";
import type {
  V04DraftPayloadV1,
  V04FactsAndCoreJudgement,
  V04PerceptionType,
  V04ShotFieldKey,
} from "@/lib/v04-contract";
import { V04_UI_PATHS } from "@/lib/v04-ui-fixture";
import { V04_UI_SHOT_FIELDS } from "@/lib/v04-ui-model";
import { V04_VOCABULARY_OPTIONS, type V04VocabularyFieldKey } from "@/lib/v04-vocabulary";

export type AudioReviewFieldKind = AudioReviewValueType;

export type FactFieldSpec = {
  key: keyof V04FactsAndCoreJudgement;
  name: string;
  module: 1 | 3;
  kind: Extract<AudioReviewFieldKind, "TEXT" | "RATING" | "CHOICE" | "MECHANISM" | "CARRIERS">;
  vocabulary?: V04VocabularyFieldKey;
  maxOptions?: number;
};

export const FACT_FIELDS: readonly FactFieldSpec[] = [
  { key: "commercialIntent", name: "商业意图", module: 1, kind: "TEXT" },
  { key: "storySynopsis", name: "故事梗概", module: 1, kind: "TEXT" },
  { key: "creativeMotif", name: "创意母题", module: 1, kind: "TEXT" },
  { key: "tensionButton", name: "张力按钮", module: 1, kind: "TEXT" },
  { key: "mainMechanism", name: "创意主导手法及机制", module: 1, kind: "MECHANISM", vocabulary: "generalMechanism", maxOptions: 1 },
  { key: "auxiliaryMechanism", name: "创意辅助手法及机制", module: 1, kind: "MECHANISM", vocabulary: "generalMechanism", maxOptions: 2 },
  { key: "creativeThinkingChain", name: "创意思维链", module: 1, kind: "TEXT" },
  { key: "storyReference", name: "故事参照类型", module: 1, kind: "CHOICE", vocabulary: "storyReferenceType", maxOptions: 1 },
  { key: "creativeCarriers", name: "创意承重载体", module: 1, kind: "CARRIERS" },
  { key: "carrierExplanation", name: "创意承重载体具体说明", module: 1, kind: "TEXT" },
  { key: "acceptanceContract", name: "创意成立契约（隐含情理）", module: 1, kind: "TEXT" },
  { key: "overallCreativeRating", name: "整体创意评价", module: 3, kind: "RATING" },
  { key: "ratingReason", name: "评价理由", module: 3, kind: "TEXT" },
];

export type GroupFieldKey = "bridgeName" | "primaryCreativeRole" | "auxiliaryCreativeRole" | "keyCreativeDescription";

export const GROUP_FIELDS: readonly {
  key: GroupFieldKey;
  name: string;
  kind: "TEXT" | "CHOICE";
  maxOptions?: number;
}[] = [
  { key: "bridgeName", name: "桥段名称", kind: "TEXT" },
  { key: "primaryCreativeRole", name: "桥段主创意作用", kind: "CHOICE", maxOptions: 1 },
  { key: "auxiliaryCreativeRole", name: "桥段辅助创意作用", kind: "CHOICE", maxOptions: 3 },
  { key: "keyCreativeDescription", name: "本桥段关键创意描述", kind: "TEXT" },
];

/** 时间码只读：AI 看不到视频，不碰镜头的起止时间（docs/25 二、11）。 */
export const READ_ONLY_SHOT_FIELDS: readonly V04ShotFieldKey[] = ["startTime", "endTime"];

export const SHOT_TEXT_FIELDS = V04_UI_SHOT_FIELDS.filter((field) => !READ_ONLY_SHOT_FIELDS.includes(field.key));

export const PRIMARY_DETAIL_KEYS: Record<V04PerceptionType, readonly string[]> = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
};

export const PERCEPTION_TYPES = ["LOVE", "FUN", "PERCEPTION"] as const satisfies readonly V04PerceptionType[];

export function perceptionTypeLabel(type: string) {
  return V04_UI_PATHS.find((path) => path.id === type)?.label ?? type;
}

/** 接受 `LOVE` 或「有爱／情感」（也容忍半角斜杠、只写「有爱」）。 */
export function perceptionTypeFromLabel(value: unknown): V04PerceptionType | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if ((PERCEPTION_TYPES as readonly string[]).includes(upper)) return upper as V04PerceptionType;
  const normalized = raw.replace(/\s+/g, "").replace(/\//g, "／");
  for (const path of V04_UI_PATHS) {
    if (path.label === normalized || path.label.split("／")[0] === normalized) return path.id;
  }
  return null;
}

export function primaryDetailLabel(type: V04PerceptionType, subKey: string) {
  const index = PRIMARY_DETAIL_KEYS[type].indexOf(subKey);
  const path = V04_UI_PATHS.find((item) => item.id === type);
  return index >= 0 && path ? path.fields[index] : subKey;
}

export const AUXILIARY_FIELDS = [
  { key: "description", name: "辅助路径说明" },
  { key: "creativeRole", name: "辅助类型的创意作用" },
] as const;

export const CARRIER_LABELS: Record<"STORY" | "COPY" | "AUDIOVISUAL_RULE", string> = {
  STORY: "故事",
  COPY: "文案",
  AUDIOVISUAL_RULE: "视听规则",
};

export const RATING_VALUES = ["S", "A", "B", "C"] as const;

export function vocabularyOptions(field: V04VocabularyFieldKey) {
  return V04_VOCABULARY_OPTIONS.filter((option) => option.fieldKey === field)
    .toSorted((left, right) => left.orderIndex - right.orderIndex);
}

const OPTION_LABEL = new Map<string, string>(V04_VOCABULARY_OPTIONS.map((option) => [option.optionId, option.labelZhCn]));

export function optionLabel(optionId: string) {
  return OPTION_LABEL.get(optionId) ?? optionId;
}

export function groupNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// 可改条目清单：按工作台上从上到下的顺序列出快照里每个可改的位置（含空着的），
// 位置序号用于提案里改动的排序。镜头只列文字字段，时间码另给只读的镜号与时间。
// ---------------------------------------------------------------------------

export type EditableItem = {
  key: string;
  targetKey: string;
  subKey: string | null;
  /** 「第三模块 · 主导路径细项 · 揭示／反转」。 */
  label: string;
  /** 条目自身的名字，如「揭示／反转」「画面内容（镜头故事）」。 */
  name: string;
  valueType: AudioReviewValueType;
  position: number;
  vocabulary?: V04VocabularyFieldKey;
  maxOptions?: number;
};

export function shotNumbers(payload: V04DraftPayloadV1) {
  const numbers = new Map<string, { number: string; groupIndex: number }>();
  payload.script.shotGroups.forEach((group, groupIndex) => {
    group.shots.forEach((shot, shotIndex) => {
      numbers.set(shot.id, { number: `${groupIndex + 1}-${shotIndex + 1}`, groupIndex });
    });
  });
  return numbers;
}

export function listEditableItems(payload: V04DraftPayloadV1): EditableItem[] {
  const items: EditableItem[] = [];
  const push = (item: Omit<EditableItem, "position">) => items.push({ ...item, position: items.length * 10 });

  for (const field of FACT_FIELDS.filter((item) => item.module === 1)) {
    push({
      key: `facts.${field.key}`, targetKey: `facts.${field.key}`, subKey: null,
      label: `第一模块 · ${field.name}`, name: field.name, valueType: field.kind,
      vocabulary: field.vocabulary, maxOptions: field.maxOptions,
    });
  }
  payload.script.shotGroups.forEach((group, groupIndex) => {
    for (const field of GROUP_FIELDS) {
      const key = `shotGroup:${group.id}.${field.key}`;
      push({
        key, targetKey: key, subKey: null,
        label: `第二模块 · 桥段 ${groupNumber(groupIndex)} · ${field.name}`, name: field.name, valueType: field.kind,
        vocabulary: field.kind === "CHOICE" ? "bridgeCreativeRole" : undefined, maxOptions: field.maxOptions,
      });
    }
    group.shots.forEach((shot, shotIndex) => {
      for (const field of SHOT_TEXT_FIELDS) {
        const key = `shot:${shot.id}.${field.key}`;
        push({
          key, targetKey: key, subKey: null,
          label: `第二模块 · 镜头 ${groupIndex + 1}-${shotIndex + 1} · ${field.label}`, name: field.label, valueType: "TEXT",
        });
      }
    });
  });
  const path = payload.perceptionPath;
  push({
    key: "path.primaryType", targetKey: "path.primaryType", subKey: null,
    label: "第三模块 · 主导路径", name: "主导路径", valueType: "PATH_PRIMARY",
  });
  if (path.primaryType) {
    for (const subKey of PRIMARY_DETAIL_KEYS[path.primaryType]) {
      const name = primaryDetailLabel(path.primaryType, subKey);
      push({
        key: `path.primaryDetails.${subKey}`, targetKey: "path.primaryDetails", subKey,
        label: `第三模块 · 主导路径细项 · ${name}`, name, valueType: "PATH_DETAIL",
      });
    }
  }
  for (const auxiliary of path.auxiliaryTypes) {
    for (const field of AUXILIARY_FIELDS) {
      push({
        key: `path.auxiliaryTypes.${auxiliary.type}.${field.key}`, targetKey: "path.auxiliaryTypes",
        subKey: `${auxiliary.type}.${field.key}`,
        label: `第三模块 · 辅助路径 · ${perceptionTypeLabel(auxiliary.type)} · ${field.name}`, name: field.name,
        valueType: "PATH_AUXILIARY",
      });
    }
  }
  for (const field of FACT_FIELDS.filter((item) => item.module === 3)) {
    push({
      key: `facts.${field.key}`, targetKey: `facts.${field.key}`, subKey: null,
      label: `第三模块 · ${field.name}`, name: field.name, valueType: field.kind,
    });
  }
  return items;
}

/** 主导路径切换后新路径的细项（快照里还没有这些键），排在「主导路径」之后。 */
export function primaryDetailItem(type: V04PerceptionType, subKey: string, primaryPosition: number): EditableItem {
  const name = primaryDetailLabel(type, subKey);
  return {
    key: `path.primaryDetails.${subKey}`, targetKey: "path.primaryDetails", subKey,
    label: `第三模块 · 主导路径细项 · ${name}`, name, valueType: "PATH_DETAIL",
    position: primaryPosition + 1 + PRIMARY_DETAIL_KEYS[type].indexOf(subKey) / 10,
  };
}
