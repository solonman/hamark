export type V04VocabularyFieldKey =
  | "bridgeCreativeRole"
  | "generalMechanism"
  | "storyReferenceType";

export type V04VocabularyOption = {
  fieldKey: V04VocabularyFieldKey;
  orderIndex: number;
  optionId: string;
  labelZhCn: string;
  groupKey: string;
};

export const V04_VOCABULARY_APPROVED_HASHES = {
  bridgeCreativeRole: "ff2ab8d53f738c3fbcc48287e76541a86b143d7e477938ea665f93c80f922b24",
  generalMechanism: "d3248ebb22178222a4d8943f826da3b86c7ac6c6184d385be88a07e575d7c1dd",
  storyReferenceType: "506c8c1c7e0088d2735d7ebc343c500f2eeddb0db09aa0a57bc6639426623c1b",
  combined: "8fe7c3b01517d8a0fca6c2dbd79d4b12e16eecbe53ea9f907d2562568373c8c6",
} as const;

export const V04_VOCABULARY_FIELD_ORDER = [
  "bridgeCreativeRole",
  "generalMechanism",
  "storyReferenceType",
] as const satisfies readonly V04VocabularyFieldKey[];

export const V04_VOCABULARY_OPTIONS = [
  { fieldKey: "bridgeCreativeRole", orderIndex: 1, optionId: "ESTABLISH_CHARACTER_RELATIONSHIP", labelZhCn: "建立人物／关系", groupKey: "ESTABLISH" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 2, optionId: "ESTABLISH_SCENE_SITUATION", labelZhCn: "建立场景／处境", groupKey: "ESTABLISH" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 3, optionId: "ESTABLISH_CREATIVE_WORLD_RULE", labelZhCn: "建立创意世界／规则", groupKey: "ESTABLISH" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 4, optionId: "ESTABLISH_ORIGINAL_EXPECTATION", labelZhCn: "建立原始预期", groupKey: "ESTABLISH" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 5, optionId: "ESTABLISH_REPEATED_ACTION_CORE_MOTIF", labelZhCn: "建立重复动作／核心意象", groupKey: "ESTABLISH" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 6, optionId: "ESTABLISH_EMOTIONAL_BASE", labelZhCn: "建立情绪底板", groupKey: "ESTABLISH" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 7, optionId: "ADVANCE_STORY_EVENT", labelZhCn: "推进故事事件", groupKey: "ADVANCE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 8, optionId: "ACCUMULATE_EMOTION", labelZhCn: "累积情感", groupKey: "ADVANCE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 9, optionId: "ACCUMULATE_INFORMATION", labelZhCn: "累积信息", groupKey: "ADVANCE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 10, optionId: "REPEAT_AND_SHIFT_MEANING", labelZhCn: "重复并改变意义", groupKey: "ADVANCE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 11, optionId: "ESCALATE_AUDIOVISUAL_RULE", labelZhCn: "升级视听规则", groupKey: "ADVANCE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 12, optionId: "DEEPEN_CONFLICT_GAP", labelZhCn: "加深冲突／缺口", groupKey: "ADVANCE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 13, optionId: "CREATE_DEVIATION_ANOMALY", labelZhCn: "制造偏离／异常", groupKey: "DEVIATE_REINTERPRET" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 14, optionId: "CREATE_CONTRAST_MISALIGNMENT", labelZhCn: "形成对照／错位", groupKey: "DEVIATE_REINTERPRET" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 15, optionId: "PLANT_FORESHADOWING", labelZhCn: "埋设伏笔", groupKey: "DEVIATE_REINTERPRET" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 16, optionId: "DELAY_EXPLANATION", labelZhCn: "延迟解释", groupKey: "DEVIATE_REINTERPRET" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 17, optionId: "DELIVER_REVEAL_REVERSAL", labelZhCn: "完成揭示／反转", groupKey: "DEVIATE_REINTERPRET" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 18, optionId: "REINTERPRET_EARLIER_CONTENT", labelZhCn: "重新解释前文", groupKey: "DEVIATE_REINTERPRET" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 19, optionId: "COMPLETE_EMOTIONAL_RELEASE", labelZhCn: "完成情感释放", groupKey: "COMPLETE_CLOSE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 20, optionId: "DELIVER_AUDIOVISUAL_CLIMAX", labelZhCn: "完成视听高潮／兑现", groupKey: "COMPLETE_CLOSE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 21, optionId: "BRING_IN_BRAND_PRODUCT", labelZhCn: "完成品牌／产品进入", groupKey: "COMPLETE_CLOSE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 22, optionId: "CLOSE_CREATIVE_MOTIF", labelZhCn: "收束创意母题", groupKey: "COMPLETE_CLOSE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 23, optionId: "ELEVATE_MEANING", labelZhCn: "意义升华", groupKey: "COMPLETE_CLOSE" },
  { fieldKey: "bridgeCreativeRole", orderIndex: 24, optionId: "LEAVE_AFTERTASTE_OPEN_ENDING", labelZhCn: "留下余韵／开放留白", groupKey: "COMPLETE_CLOSE" },
  { fieldKey: "generalMechanism", orderIndex: 1, optionId: "INSIGHT_RESONANCE", labelZhCn: "洞察共鸣", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 2, optionId: "METAPHOR_TRANSLATION", labelZhCn: "隐喻转译", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 3, optionId: "REVERSAL_REINTERPRETATION", labelZhCn: "反转重释", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 4, optionId: "MISPLACEMENT_GRAFTING", labelZhCn: "错位嫁接", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 5, optionId: "EXAGGERATION_AMPLIFICATION", labelZhCn: "夸张放大", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 6, optionId: "MINIATURIZATION_COMPRESSION", labelZhCn: "缩小压缩", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 7, optionId: "DEFAMILIARIZATION", labelZhCn: "陌生化", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 8, optionId: "PERSONIFICATION", labelZhCn: "拟人化", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 9, optionId: "JUXTAPOSITION_CREATES_MEANING", labelZhCn: "对置生义", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 10, optionId: "REPETITION_CHANGES_MEANING", labelZhCn: "重复变义", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 11, optionId: "UNCONVENTIONAL_RULE_BUILDING", labelZhCn: "非常规规则建构", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 12, optionId: "FORMAL_PLAY", labelZhCn: "形式游戏", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 13, optionId: "SPECTACLE_CREATION", labelZhCn: "奇观制造", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 14, optionId: "PRODUCT_MECHANISM_ENACTMENT", labelZhCn: "产品机制演绎", groupKey: "UNGROUPED" },
  { fieldKey: "generalMechanism", orderIndex: 15, optionId: "PENDING_NEW_MECHANISM", labelZhCn: "现有词表不适用／待形成新机制", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 1, optionId: "YOUTH_NOSTALGIA", labelZhCn: "青春怀旧片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 2, optionId: "FAMILY_AFFECTION", labelZhCn: "家庭亲情片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 3, optionId: "GROWTH_COMPANIONSHIP", labelZhCn: "成长陪伴片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 4, optionId: "ROMANTIC_ENCOUNTER", labelZhCn: "爱情相遇片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 5, optionId: "ROMANTIC_MISSED_CONNECTION", labelZhCn: "爱情错过片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 6, optionId: "FAREWELL_REUNION", labelZhCn: "离别重逢片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 7, optionId: "FAMILY_RECONCILIATION", labelZhCn: "家庭和解片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 8, optionId: "ROAD_JOURNEY", labelZhCn: "公路旅程片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 9, optionId: "WORKPLACE_STRIVING", labelZhCn: "职场奋斗片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 10, optionId: "PASSIONATE_COMPETITION", labelZhCn: "热血竞技片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 11, optionId: "UNDERDOG_COMEBACK", labelZhCn: "小人物逆袭片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 12, optionId: "EVERYDAY_LIFE_COMEDY", labelZhCn: "日常生活喜剧片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 13, optionId: "ABSURD_COMEDY", labelZhCn: "荒诞喜剧片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 14, optionId: "MYSTERY_REVEAL", labelZhCn: "悬疑揭秘片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 15, optionId: "SOCIAL_DOCUMENTARY", labelZhCn: "社会纪实片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 16, optionId: "LIFE_RETROSPECTIVE", labelZhCn: "人生回望片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 17, optionId: "FAIRYTALE_FABLE", labelZhCn: "童话寓言片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 18, optionId: "TECH_SCI_FANTASY", labelZhCn: "科技奇幻片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 19, optionId: "HISTORICAL_EPIC", labelZhCn: "历史史诗片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 20, optionId: "HEROIC_ADVENTURE", labelZhCn: "英雄冒险片", groupKey: "UNGROUPED" },
  { fieldKey: "storyReferenceType", orderIndex: 21, optionId: "ENSEMBLE_LIFE", labelZhCn: "群像人生片", groupKey: "UNGROUPED" },
] as const satisfies readonly V04VocabularyOption[];

export function serializeV04VocabularyTsv(
  options: readonly V04VocabularyOption[] = V04_VOCABULARY_OPTIONS,
) {
  return V04_VOCABULARY_FIELD_ORDER.flatMap((fieldKey) =>
    options
      .filter((option) => option.fieldKey === fieldKey)
      .toSorted((left, right) => left.orderIndex - right.orderIndex),
  )
    .map((option) => [
      option.fieldKey,
      option.orderIndex,
      option.optionId,
      option.labelZhCn,
      option.groupKey,
    ].join("\t"))
    .join("\n") + "\n";
}
