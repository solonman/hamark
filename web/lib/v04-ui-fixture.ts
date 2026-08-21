import { V04_VOCABULARY_OPTIONS } from "@/lib/v04-vocabulary";
import { V04_VOCABULARY_VERSION, type V04ChoiceValue } from "@/lib/v04-contract";
import { cloneV04UiDraft, type V04UiCase, type V04UiDraft, type V04UiShot } from "@/lib/v04-ui-model";

const choice = (selectedOptionIds: string[] = [], customText = "", advancedText = ""): V04ChoiceValue => ({ selectedOptionIds, customText, advancedText, vocabularyVersion: V04_VOCABULARY_VERSION });

function shot(id: string, values: Partial<V04UiShot>): V04UiShot {
  return {
    id, startTime: "", endTime: "", shotScale: "", cameraAngle: "", cameraMovement: "",
    visualContent: "", screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "", soundEffect: "", music: "",
    ...values,
  };
}

export const V04_UI_BRIDGE_OPTIONS = V04_VOCABULARY_OPTIONS.filter((item) => item.fieldKey === "bridgeCreativeRole");
export const V04_UI_MECHANISM_OPTIONS = V04_VOCABULARY_OPTIONS.filter((item) => item.fieldKey === "generalMechanism");
export const V04_UI_STORY_OPTIONS = V04_VOCABULARY_OPTIONS.filter((item) => item.fieldKey === "storyReferenceType");

export const V04_UI_PATHS = [
  { id: "LOVE" as const, label: "有爱／情感", fields: ["情感底板", "情感如何累积", "情感缺口／压力", "情感释放方式", "主要承重元素"] },
  { id: "FUN" as const, label: "有趣／预期", fields: ["原始预期", "偏离／异常", "揭示／反转", "重新理解", "主要承重元素"] },
  { id: "PERCEPTION" as const, label: "有料／感知", fields: ["感知规则／装置", "重复与变化", "音画／文画关系", "高潮／兑现方式", "主要承重元素"] },
];

export const V04_UI_PROTOTYPE_HASHES = Object.freeze({
  "index.html": "ab9825773350334bc4675f372a3cf9a6aee53679afbde9cb77b73cc241367b01",
  "app.js": "521fff1fe3bfb6a6585502b2cb80f170c488270e4c4230c10c9611229abe8205",
  "styles.css": "ea02fcf0ee9e48b206df90f16752e081cecff346ffcb12b6e107f9b380109b5c",
  "workflow-state.mjs": "c25f1458f42d5c552148fa1321ed0db6ba2969f511c616de4244c83e79b5cc05",
  "draft-save-state.mjs": "9195794db850af78572ba7f42ae1ec4f1373d92fbf0474aee54dcec65449a452",
  "interaction-rules.mjs": "6449795bfae8ab9f66d5bf87c5b6026d54437542ba859399747e1882289b13a6",
  "publication-rules.mjs": "e00e546b53ee9e72687acb5d77c2fd82c354e1b65c4e15526d527e15ae4e8a17",
  "shot-data.mjs": "7852b9ed8828bdfce509b455c6e68143a446396df2e608704f9bd90e277cb8dd",
  "library-search.mjs": "6583f695aa5759c6b1ada198207d9139bf92c9153b758899a6e62b7beecd1424",
  "verify.mjs": "bf5d5346c242d33281b20e95211f5b721f909ad1ec6960b4b88da06efc9d0f54",
  "workflow-state.test.mjs": "9c9a363f13a8fe4f60a6d799c313567aa214eb297daafef31dcdc37472bca45e",
  "autosave-behavior.test.mjs": "e757066077cbfbd58f9cb06717ddb35b6747ac57ab68aaaa822b1b1e91ffbba0",
  "v16-data.test.mjs": "6db7e35888690c509dbfd18f9695210b13d70b7b2f25e7e6b4429416bd34191b",
});

const auroraDraft: V04UiDraft = {
  shotGroups: [
    {
      id: "bridge-aurora-01", title: "深夜归来", primaryRole: choice(["ESTABLISH_CHARACTER_RELATIONSHIP"]), auxiliaryRole: choice(["ESTABLISH_EMOTIONAL_BASE"]),
      creativeDescription: "用反复亮起的门灯，把一次回家逐步变成跨越时间的守候。",
      shots: [
        shot("shot-aurora-01", { startTime: "00:00", endTime: "00:04", shotScale: "远景", cameraAngle: "平视", cameraMovement: "固定", visualContent: "雨夜，一辆车驶入安静的住宅区，门灯在远处亮起。", screenCopy: "WELCOME HOME", subtitleEffect: "字样随门灯由暗到亮", soundEffect: "雨声、轮胎压过积水", music: "低缓钢琴进入" }),
        shot("shot-aurora-02", { startTime: "00:05", endTime: "00:09", shotScale: "中景", cameraAngle: "侧面", cameraMovement: "缓慢跟拍", visualContent: "父亲推门下车，孩子隔着窗向他挥手。", dialogue: "爸爸！", voiceOver: "每一次归来，都有人为你留一盏灯。", soundEffect: "车门声", music: "钢琴延续" }),
      ],
    },
    {
      id: "bridge-aurora-02", title: "时间流转", primaryRole: choice(["REPEAT_AND_SHIFT_MEANING"]), auxiliaryRole: choice(),
      creativeDescription: "同一动作在不同年龄重复，意义从被等待转向主动守候。",
      shots: [shot("shot-aurora-03", { startTime: "00:10", endTime: "00:16", shotScale: "近景", cameraAngle: "低机位", cameraMovement: "横移", visualContent: "多年后，长大的孩子驾车回家，为年迈父亲打开车门。", screenCopy: "一路安心，始终如一", subtitleEffect: "长字幕在车身反光中缓慢显现并自然换行", voiceOver: "长大，是把曾经得到的守候，再交还给爱的人。", soundEffect: "钥匙轻响", music: "弦乐抬升" })],
    },
  ],
  commercialIntent: "将可靠的出行体验转译为家庭关系中的长期陪伴。",
  storySummary: "父亲深夜归家，孩子为他留灯；多年后孩子驾车归来，换自己守候年迈父亲。",
  creativeMotif: "欢迎回家",
  tensionButton: "守候关系的身份换位",
  primaryMechanism: choice(["REPETITION_CHANGES_MEANING"], "", "同一回家动作因人物年龄和照顾方向改变而获得新意义"),
  auxiliaryMechanism: choice(["INSIGHT_RESONANCE"]),
  creativeThinkingChain: "提取回家这一高频生活动作，再用时间跨越完成关系换位，让产品可靠性成为情感可靠性的证据。",
  storyReference: choice(["GROWTH_COMPANIONSHIP"]),
  carriers: ["故事", "视听规则"],
  carrierExplanation: "用门灯与车灯的亮灭做贯穿全片的视觉承重。",
  creativeContract: "观众接受同一空间跨越多年，并把灯光重复识别为家庭守候。",
  overallGrade: "A",
  gradeReason: "母题、重复机制与品牌价值同向，结尾仍可进一步压缩。",
  primaryPath: "LOVE",
  primaryPathAnswers: {
    LOVE: ["父女等待关系", "深夜归家", "时间流逝", "照顾方向换位", "彼此守候"],
    FUN: ["", "", "", "", ""], PERCEPTION: ["", "", "", "", ""],
  },
  auxiliaryPaths: ["PERCEPTION"],
  auxiliaryPathDetails: { PERCEPTION: { description: "灯光和车灯形成重复视听规则", role: "强化时间切换并完成品牌进入" } },
};

const blankDraft: V04UiDraft = {
  shotGroups: [{ id: "bridge-court-01", title: "", primaryRole: choice(), auxiliaryRole: choice(), creativeDescription: "", shots: [shot("shot-court-01", {})] }],
  commercialIntent: "", storySummary: "", creativeMotif: "", tensionButton: "", primaryMechanism: choice(), auxiliaryMechanism: choice(), creativeThinkingChain: "", storyReference: choice(), carriers: [], carrierExplanation: "", creativeContract: "", overallGrade: "", gradeReason: "", primaryPath: "LOVE", primaryPathAnswers: { LOVE: ["", "", "", "", ""], FUN: ["", "", "", "", ""], PERCEPTION: ["", "", "", "", ""] }, auxiliaryPaths: [], auxiliaryPathDetails: {},
};

export const V04_UI_FIXTURE_VERSION = "V04_UI_FIXTURE_V1_9_P1";

export const V04_UI_CASES: V04UiCase[] = [
  {
    id: "aurora", title: "欢迎回家", brand: "MITSUBISHI MOTORS", duration: "01:34", description: "一支关于回家、成长与守候关系换位的品牌短片。", tags: ["品牌叙事", "家庭／成长"], workState: "SUBMITTED", expertGrade: "A", draft: cloneV04UiDraft(auroraDraft),
    submissions: [{ id: "submission-aurora-v1", versionNumber: 1, submittedAt: "2026-08-18 18:40", submittedBy: "周屿", draft: cloneV04UiDraft(auroraDraft) }], activeEditor: null, lastSavedAt: "18:42",
  },
  {
    id: "court", title: "凌晨四点的球场", brand: "NIKE", duration: "00:58", description: "尚无已提交成果，可进入公共工作稿开始反写。", tags: ["体育", "成长"], workState: "NOT_STARTED", expertGrade: "", draft: cloneV04UiDraft(blankDraft), submissions: [], activeEditor: null, lastSavedAt: "",
  },
  {
    id: "rain", title: "雨停之前", brand: "MUJI", duration: "01:12", description: "团队正在共同维护的感知型案例。", tags: ["生活方式", "视听规则"], workState: "INCOMPLETE", expertGrade: "", draft: cloneV04UiDraft({ ...auroraDraft, overallGrade: "", gradeReason: "" }), submissions: [], activeEditor: "林岚", lastSavedAt: "17:03",
  },
];

export function getV04UiCase(id: string) {
  return V04_UI_CASES.find((item) => item.id === id) ?? null;
}
