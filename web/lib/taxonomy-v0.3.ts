import taxonomyV02 from "./taxonomy-v0.2.json";
import type {
  CreativeGrade,
  CreativePath,
  CreativeStructureDraft,
  FormationMode,
  ShotGroupDraft,
} from "./types";

export const V03_TAXONOMY_VERSION = "V0.3-PILOT" as const;
export const V03_WORKFLOW_VERSION = "REVERSE-WORKFLOW-V0.3-PILOT" as const;
export const V03_RUBRIC_VERSION = "RUBRIC-V0.5-PILOT" as const;
export const V03_VOCABULARY_VERSION = "V0.3.2" as const;

export const bridgeRoleGroups = [
  {
    label: "建立",
    options: [
      "建立人物／关系",
      "建立场景／处境",
      "建立创意世界／规则",
      "建立原始预期",
      "建立重复动作／核心意象",
      "建立情绪底板",
    ],
  },
  {
    label: "推进",
    options: [
      "推进故事事件",
      "累积情感",
      "累积信息",
      "重复并改变意义",
      "升级视听规则",
      "加深冲突／缺口",
    ],
  },
  {
    label: "偏离／重释",
    options: [
      "制造偏离／异常",
      "形成对照／错位",
      "埋设伏笔",
      "延迟解释",
      "完成揭示／反转",
      "重新解释前文",
    ],
  },
  {
    label: "完成／收束",
    options: [
      "完成情感释放",
      "完成视听高潮／兑现",
      "完成品牌／产品进入",
      "收束创意母题",
      "意义升华",
      "留下余韵／开放留白",
    ],
  },
] as const;

export const bridgeRoles = bridgeRoleGroups.flatMap((group) => group.options);

export const legacyMechanismOptions = [
  ...((taxonomyV02 as Array<{ code: string; options: Array<{ value: string }> }>).find(
    (field) => field.code === "A2",
  )?.options.map((option) => option.value) ?? []),
  "现有词表不适用／待形成新机制",
] as string[];

export const mechanismDisplayMap: Record<string, string> = {
  "重复积累": "重复变义",
  "对比冲突": "对置生义",
  "规则设定": "非常规规则建构",
};

export function displayMechanismLabel(value: string) {
  return mechanismDisplayMap[value] ?? value;
}

export const mechanismOptions = Array.from(
  new Set(legacyMechanismOptions.map(displayMechanismLabel)),
);

export function mechanismChoicesFor(values: string[] = []) {
  const seen = new Set<string>();
  return [...values, ...mechanismOptions]
    .filter(Boolean)
    .flatMap((value) => {
      const label = displayMechanismLabel(value);
      if (seen.has(label)) return [];
      seen.add(label);
      return [{ value, label }];
    });
}

export const storyReferenceOptions =
  (taxonomyV02 as Array<{ code: string; options: Array<{ value: string }> }>).find(
    (field) => field.code === "B2",
  )?.options.map((option) => option.value) ?? [];

export const storyArchetypeOptions =
  (taxonomyV02 as Array<{ code: string; options: Array<{ value: string }> }>).find(
    (field) => field.code === "B3",
  )?.options.map((option) => option.value) ?? [];

export const formationOptions: Array<{
  value: FormationMode;
  label: string;
  hint: string;
}> = [
  { value: "HOLISTIC_EMERGENCE", label: "整体涌现", hint: "全片关系合在一起才形成创意。" },
  { value: "CROSS_GROUP_ACCUMULATION", label: "跨桥段渐进形成", hint: "多个桥段逐步累积并在后程成立。" },
  { value: "BEFORE_AFTER_CONTRAST", label: "前后关系对照形成", hint: "依靠前后变化或反差完成意义。" },
  { value: "RULE_THROUGHOUT", label: "规则全片贯穿", hint: "同一创意规则自始至终组织表达。" },
  { value: "LOCAL_TRIGGER", label: "关键局部触发", hint: "某个关键桥段使创意开始成立。" },
  { value: "COMPOSITE", label: "复合形成", hint: "两种以上形成方式分工协作。" },
  { value: "NOT_YET_DECOMPOSABLE", label: "暂时无法拆解", hint: "允许保留不确定，在说明中写清原因。" },
];

export const creativePathOptions: Array<{ value: CreativePath; label: string }> = [
  { value: "LOVE", label: "有爱／情感" },
  { value: "INTERESTING", label: "有趣／预期" },
  { value: "SUBSTANCE", label: "有料／感知" },
];

export const mainPathFields: Record<
  CreativePath,
  Array<{ key: string; label: string; hint: string }>
> = {
  LOVE: [
    { key: "emotionalBase", label: "情感底板", hint: "调动的基础关系或情感是什么？" },
    { key: "emotionalAccumulation", label: "情感如何累积", hint: "力量如何一步步增加？" },
    { key: "emotionalGap", label: "情感缺口／压力", hint: "什么缺失、冲突或压力使它成立？" },
    { key: "emotionalRelease", label: "情感释放方式", hint: "情感在哪种关系中被释放？" },
    { key: "loveMainCarrier", label: "主要承重元素", hint: "哪个元素拿掉后情感路径会坍塌？" },
  ],
  INTERESTING: [
    { key: "originalExpectation", label: "原始预期", hint: "观众起初会如何理解？" },
    { key: "deviation", label: "偏离／异常", hint: "什么打破或扭曲了原预期？" },
    { key: "reveal", label: "揭示／反转", hint: "关键信息如何出现？" },
    { key: "reinterpretation", label: "重新理解", hint: "揭示后前文如何被改写？" },
    { key: "interestingMainCarrier", label: "主要承重元素", hint: "哪个元素拿掉后预期路径会坍塌？" },
  ],
  SUBSTANCE: [
    { key: "perceptualRule", label: "感知规则／装置", hint: "视听、文字或形式上的核心规则是什么？" },
    { key: "repetitionVariation", label: "重复与变化", hint: "规则如何反复、变形或升级？" },
    { key: "mediaRelation", label: "音画／文画关系", hint: "不同表达通道如何配合或冲突？" },
    { key: "climaxPayoff", label: "高潮／兑现方式", hint: "感知规则如何到达最强点？" },
    { key: "substanceMainCarrier", label: "主要承重元素", hint: "哪个元素拿掉后感知路径会坍塌？" },
  ],
};

export const creativeGradeOptions: Array<{
  value: Exclude<CreativeGrade, "">;
  description: string;
}> = [
  { value: "S", description: "极少见的强创意；母题、按钮、机制、品牌落点与表达高度统一。" },
  { value: "A", description: "明确且有力量的优秀创意；至少一个环节突出，品牌连接自然。" },
  { value: "B", description: "创意成立且完成度合格；结构可识别，但机制或品牌拥有权一般。" },
  { value: "C", description: "主要依赖常规表达或执行包装；按钮不清或品牌连接牵强。" },
];

export function emptyCreativeStructure(): CreativeStructureDraft {
  return {
    vocabularyVersion: V03_VOCABULARY_VERSION,
    creativeButton: "",
    mechanismStatement: "",
    mechanismPrimary: "",
    mechanismAuxiliary: [],
    mechanismCustom: "",
    creativeRealizationPath: "",
    realizationSkeleton: "",
    brandProductLanding: "",
    storyReferenceType: "",
    storyArchetype: "",
    primaryCreativePath: "",
    auxiliaryCreativePaths: [],
    compositeStateReason: "",
    formationPrimary: "",
    formationAuxiliary: [],
    formationStatement: "",
    formationRelatedGroupIds: [],
    creativeCarriers: "",
    establishmentConditions: "",
    strengthSources: "",
    acceptanceContract: "",
    audiovisualMechanism: "",
    informationReleaseTurning: "",
    creativeGrade: "",
    creativeGradeReason: "",
    creativeGradeVersion: "CREATIVE-GRADE-V0.1",
    mainPathPayload: {},
    auxiliaryPathNotes: {},
    conditionFlags: {
      unconventionalWorld: false,
      audiovisualCarriesIdea: false,
      interestingLoadBearing: false,
    },
  };
}

export function newV03ShotGroup(orderIndex: number): ShotGroupDraft {
  return {
    id: crypto.randomUUID(),
    orderIndex,
    title: `桥段 ${orderIndex + 1}`,
    primaryRole: "",
    auxiliaryRoles: [],
    customRole: "",
    note: "",
  };
}
