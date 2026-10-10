// 录音点评改写的提示词（docs/25 4.5）。system 放规则；user 是一段 JSON：任务、字段说明、词表、
// 作业（被点评版本快照的可读结构，每个可改位置带稳定键）、文字稿、输出格式与一个完整的小例子。
//
// 字段说明由工程起草，**请老孙校订**（改这里的文字即可，改完把 AUDIO_REVIEW_PROMPT_VERSION 加一，
// 任务行会记下用的是哪一版提示词）。纯函数，不碰数据库与网络。

import { createHash } from "node:crypto";
import type { V04ChoiceValue, V04DraftPayloadV1, V04PerceptionType } from "@/lib/v04-contract";
import { V04_UI_PATHS } from "@/lib/v04-ui-fixture";
import {
  AUXILIARY_FIELDS,
  CARRIER_LABELS,
  FACT_FIELDS,
  GROUP_FIELDS,
  PRIMARY_DETAIL_KEYS,
  SHOT_TEXT_FIELDS,
  groupNumber,
  optionLabel,
  perceptionTypeLabel,
  primaryDetailLabel,
  vocabularyOptions,
} from "./fields";
import { transcriptClock, type AudioReviewTranscriptSegment } from "./transcript";

export const AUDIO_REVIEW_PROMPT_VERSION = "2026-10-10.1";

// ---------------------------------------------------------------------------
// system：规则
// ---------------------------------------------------------------------------

export const AUDIO_REVIEW_SYSTEM_PROMPT = `你是「视频广告创意逆向工程」工作台里的点评落实助手。

【场景】
学员各自对一支广告片做「逆向拆解作业」：第一模块写全片事实与核心判断，第二模块按桥段和镜头反写脚本，第三模块判断主导感知类型的发生路径并给整体评价。老孙（老师）在线下分享会上逐个点评作业，并现场录了音。你会在用户消息的 JSON 里拿到：字段说明、词表、被点评的这一版作业（每个可改的位置都带稳定的「键」）、这段录音的转写文字稿、输出格式和一个完整的小例子。你的任务是把老孙的点评落实到这份作业上，拟出一份「点评版」改动，交给老孙逐条确认。你看不到视频，只能读文字。

【工作步骤】
1. 认人。文字稿按说话人分成 S0、S1……（机器自动区分，可能有少量错分）。录音者是老孙：他通常说得最多，是在评价别人的作业；被点评人会解释自己当时的想法；现场其他人可能插话提问。先判断哪个编号是老孙，写进 speakers.reviewer；其他说话人能认出是谁就写名字（被点评人的名字在「任务」里），认不出写「其他同事」，写进 speakers.labels。

2. 只认老孙的话。老孙的话是改动的唯一依据。被点评人的解释、别人的提问只用来理解上下文，不能单独成为改动的依据；老孙在回答提问时给出的判断，以老孙的回答为准。

3. 归纳意见。把老孙的话归纳成若干条意见。每条写一句 summary：用书面语转述老孙的判断，必要时带上他的关键原话；segmentIds 列出这条意见依据的全部片段编号（含相关的提问片段）。kind 只有两种：
   - GENERAL（总体意见）：否定或修正了对全片的判断，或指出了贯穿多处的通病，影响面不止一个条目。例如「母题看浅了」「关键创意描述都在复述画面」「这片子的主导感受判断错了」。
   - SPECIFIC（具体意见）：点名到某一处或某几处。例如「井盖里钻出来的是警察」「第二段的作用不是升级视听规则」「评价给高了」。

4. 落实总体意见——这是最重要的一步。总体意见绝不能只改老孙点名提到的那几处。对每一条总体意见，都要把「作业」里的全部条目从头到尾逐个检查一遍：凡是建立在被否定的判断上、或者犯了同一个通病的条目，都要跟着改。
   - 例：老孙说母题看浅了、真正的母题是 X，那么创意母题、张力按钮、创意思维链、创意成立契约、承重载体说明、相关桥段的关键创意描述、主导路径细项、评价理由……凡是还沿用旧判断的，都要按 X 重写。
   - 例：老孙说「关键创意描述都在复述画面」，就要把每一个桥段的关键创意描述都检查一遍，凡是在复述画面的，都改写成「这一段为什么成立、在机制上做了什么」；同样犯这个毛病的其他条目（如承重载体说明）也一并改。
   - 在 rationale 里写清落实说明：这条意见改了哪几处、各自为什么改；检查过但不需要改的关键条目也简要说明理由。

5. 落实具体意见。改点名的位置，以及因为这个事实改变而必须同步的地方（例如镜头里的人物身份变了，引用这个人物的桥段描述、路径细项也要一致）。rationale 写明改了哪里。

6. 改写要求：
   - 保留作者原有的、没有被老孙否定的信息和写法，只改被否定的或缺失的部分；不要整段推倒、换成另一种风格。
   - 语气用作业本身的书面体，写成拆解结论；不要写「老孙认为」「老师指出」「应改为」之类的转述口吻。
   - 每个条目按「字段说明」里的含义和写法要求来写。创意思维链必须是 Markdown 嵌套列表格式（见字段说明）。
   - 你看不到视频：不要编造文字稿和作业里都没有的画面、台词、人物、数字。老孙口头说出的画面信息（如「钻出来的是个警察」）可以补写进对应条目。
   - 一条意见可以改多处；同一处可以同时依据多条意见（opinionIds 写多个）；同一个键只输出一次，把多条意见对它的要求合在一个新值里。
   - 老孙肯定的、没提到的、检查后确实不受影响的条目不要动。没有任何改动的意见也要保留（表示听到了但不需要改），rationale 说明为什么不改。

7. 硬性约束（违反的改动会被系统直接丢弃）：
   - key 只能用「作业」里列出的键，以及字段说明里讲明拼法的镜头字段键、主导路径细项键；不能自造键。
   - 不增删桥段和镜头，不调桥段和镜头的顺序，不改时间码（镜头的开始时间、结束时间只读）。老孙要求补镜头、删镜头、拆分或合并桥段的话，不要硬改别的条目去凑，记进 unaddressed，reason 写「需要人工补／删镜头：……」。
   - 选项字段只能用「词表」里的标签原文，个数不超过上限；主导机制与辅助机制不能选同一项；同一桥段的主创意作用与辅助创意作用不能选同一项。
   - 整体创意评价只能是 S、A、B、C 之一。创意承重载体只能从「故事」「文案」「视听规则」里选 1–3 项。
   - 改主导路径时，必须同时给出新路径的全部五个细项（键用新路径的细项键），而且新的主导路径不能和现有辅助路径相同。不能新增或删除辅助路径，只能改现有辅助路径的两项文字。
   - value 是改后的完整新值（形状见字段说明），不是补丁，也不是修改建议。

8. 同音错字。文字稿是机器听写，常有同音、近音错字（例如把「对置生义」听成「对质生意」，把「张力按钮」听成「张力暗扭」，把人名听错）。按词表、字段名和上下文理解老孙的原意；你校正过的词写进 corrections：segmentId 是片段编号，from 是文字稿原文里的错写（必须能在该片段原文里找到），to 是校正后的写法。

9. 不遗漏。老孙的每一段实质性发言，要么被某条意见的 segmentIds 引用，要么写进 unaddressed 并写明原因。原因从下面几类里选，并具体说明：
   - 肯定的部分，不需要改；
   - 闲聊或背景信息，不对应作业条目；
   - 做法建议，不对应作业条目；
   - 被点评人的解释，只用来理解上下文；
   - 别人的提问，只用来理解上下文；
   - 需要人工补／删镜头：……；
   - 听不清，无法判断。
   开场、过渡、点名这类没有内容的话可以不列。

10. 输出。只输出一个 JSON 对象，不要输出解释文字，不要用 Markdown 围栏。结构严格照「输出格式」：speakers、opinions、changes、unaddressed、corrections 五项都要有（没有内容就给空数组）。opinions 的 id 用 o1、o2……，changes 的 opinionIds 引用这些 id。「输出示例」里的键和内容只用来说明格式，不能出现在你的输出里。`;

// ---------------------------------------------------------------------------
// user：字段说明（请老孙校订）
// ---------------------------------------------------------------------------

export type FieldGuideEntry = { 键: string; 名称: string; 含义: string; 写法: string; 取值: string };

const DETAIL_MEANINGS: Record<string, string> = {
  emotionalBase: "片子依托的情感关系和情感底色。",
  accumulation: "情感靠什么一步步累积、加重。",
  gapPressure: "是什么让这份情感有失去的风险或没被满足，形成缺口和压力。",
  releaseMethod: "情感在哪里、以什么方式释放。",
  originalExpectation: "观众原本以为会怎样、默认的常理是什么。",
  deviation: "从哪里开始不对劲、偏离了预期，偏离是怎样递进的。",
  reveal: "揭开的真相或反转是什么——是让人重新理解前文的那个信息，不是结尾画面本身。",
  reinterpretation: "反转之后，观众怎样重新理解整件事、前文的意义变成了什么。",
  perceptionRule: "片子建立了什么感知规则或装置。",
  repetitionVariation: "规则如何重复、在重复中怎样变化和升级。",
  audiovisualRelation: "画面与声音、文字与画面之间是什么关系。",
  payoff: "高潮在哪里、规则以什么方式兑现。",
  mainCarrier: "承载这条路径的关键元素（人物、道具、动作、声音等），写具体。",
};

function detailGuide(type: V04PerceptionType): FieldGuideEntry[] {
  return PRIMARY_DETAIL_KEYS[type].map((subKey) => ({
    键: `path.primaryDetails.${subKey}`,
    名称: `主导路径细项（${perceptionTypeLabel(type)}）· ${primaryDetailLabel(type, subKey)}`,
    含义: DETAIL_MEANINGS[subKey] ?? "",
    写法: "一两句，和创意母题、张力按钮的判断保持一致。只有主导路径是这一条时才可用；mainCarrier 三条路径共用。",
    取值: "文字",
  }));
}

const MECHANISM_VALUE =
  "对象 {\"options\": [机制标签], \"custom\": \"手法\", \"advanced\": \"进阶机制层\"}。options 用「通用机制」词表的标签；custom 写手法；advanced 只在选了「现有词表不适用／待形成新机制」时必填，其余情况沿用原值。";

const CHOICE_VALUE = (vocabulary: string, max: number) =>
  `对象 {"options": [标签], "custom": "自定义补充"}。options 只能用「${vocabulary}」词表的标签，最多 ${max} 项；custom 是词表不贴切时的一句补充，可为空串。`;

export const AUDIO_REVIEW_FIELD_GUIDE: FieldGuideEntry[] = [
  {
    键: "facts.commercialIntent", 名称: "商业意图",
    含义: "这支片子替品牌完成什么商业任务：面向谁、传递什么、希望带来什么认知或行为上的改变。",
    写法: "一两句书面语，写品牌要达成的目的，不复述剧情。", 取值: "文字",
  },
  {
    键: "facts.storySynopsis", 名称: "故事梗概",
    含义: "片子讲了一个什么事：按时间顺序概括人物、事件、转折与结局。",
    写法: "客观复述，约 100–200 字，不加评价；关键转折和结尾要写到，人物身份要写准。", 取值: "文字",
  },
  {
    键: "facts.creativeMotif", 名称: "创意母题",
    含义: "整支片子真正在说的那个核心命题，是创意的根；不是画面现象，也不是品牌口号。",
    写法: "一句话，具体到只属于这支片子。「换十条片子都能这么写」的空话（如「让生活绽放活力美好」）不合格。", 取值: "文字",
  },
  {
    键: "facts.tensionButton", 名称: "张力按钮",
    含义: "片子里制造张力、让观众心里一动的那个关键对置或矛盾：把什么和什么放在一起、哪里不合常理。",
    写法: "一两句，点出构成张力的两端和具体落点（人物、身份、动作、处境），不写成效果评价。", 取值: "文字",
  },
  {
    键: "facts.mainMechanism", 名称: "创意主导手法及机制",
    含义: "创意主要靠哪一种通用机制发生（机制），以及在这支片子里具体是怎么做的（手法）。",
    写法: "机制选 1 项；手法用动词短语写本片具体做了什么，要能看出机制落在哪里。", 取值: MECHANISM_VALUE + "最多 1 项。",
  },
  {
    键: "facts.auxiliaryMechanism", 名称: "创意辅助手法及机制",
    含义: "在主导机制之外，起辅助作用的通用机制和手法。",
    写法: "机制最多 2 项，不能与主导机制相同；手法写清它怎样配合主导机制。", 取值: MECHANISM_VALUE + "最多 2 项。",
  },
  {
    键: "facts.creativeThinkingChain", 名称: "创意思维链",
    含义: "从商业问题或洞察出发，一步步推导出这支片子的创意的思考路径；评的是推导顺序是否成立。",
    写法: [
      "必须写成 Markdown 嵌套列表：每条思维链的「中心」顶格写、不加记号；",
      "中心下的第一层是有先后顺序的步骤，每行以两个空格加「- 」开头；",
      "某一步下面的并列分叉（无先后）再多缩进两个空格（四个空格加「- 」）；可以有多条思维链，每条一个中心，上下排开。",
      "节点可写成「短标题：说明」。不要用「→」把整条链串在一行里，也不要每行写一个箭头。",
      "格式示例：\n商业问题与洞察\n  - 问题：……\n  - 洞察：……\n    - 依据：……\n创意推导\n  - 第一步：……\n  - 第二步：……",
    ].join(""),
    取值: "文字（换行用 \\n）",
  },
  {
    键: "facts.storyReference", 名称: "故事参照类型",
    含义: "这支片子借用了观众熟悉的哪一类故事经验（类型片模板）。",
    写法: "选最贴切的 1 项；不贴切时在 custom 里补一句。", 取值: CHOICE_VALUE("故事参照类型", 1),
  },
  {
    键: "facts.creativeCarriers", 名称: "创意承重载体",
    含义: "创意主要压在哪些载体上：故事（情节与人物）、文案（台词、旁白、字幕）、视听规则（画面、声音、剪辑形成的规则）。",
    写法: "选真正承重的 1–3 项。", 取值: "标签数组，只能是「故事」「文案」「视听规则」，如 [\"故事\", \"视听规则\"]",
  },
  {
    键: "facts.carrierExplanation", 名称: "创意承重载体具体说明",
    含义: "所选的每个载体具体靠什么承重：哪个元素、怎样起作用。",
    写法: "逐个载体写清具体元素和作用机制，不写「营造欢乐氛围」这类泛泛的效果描述。", 取值: "文字",
  },
  {
    键: "facts.acceptanceContract", 名称: "创意成立契约（隐含情理）",
    含义: "观众要默认接受什么前提或情理，这个创意才成立（例如非常规的世界规则、人物动机、身份默契）。",
    写法: "一句话写出这个隐含前提；现实题材没有特殊前提时，写明按现实情理即可成立，并点出关键情理。", 取值: "文字",
  },
  {
    键: "shotGroup:<桥段id>.bridgeName", 名称: "桥段名称",
    含义: "这一段在全片里的叫法。",
    写法: "4–12 字，概括这一段在创意上做了什么，而不只是描述画面。", 取值: "文字",
  },
  {
    键: "shotGroup:<桥段id>.primaryCreativeRole", 名称: "桥段主创意作用",
    含义: "这一段在创意结构里最主要的作用。",
    写法: "选 1 项。", 取值: CHOICE_VALUE("桥段创意作用", 1),
  },
  {
    键: "shotGroup:<桥段id>.auxiliaryCreativeRole", 名称: "桥段辅助创意作用",
    含义: "这一段同时承担的次要作用。",
    写法: "最多 3 项，不能与本桥段的主创意作用相同。", 取值: CHOICE_VALUE("桥段创意作用", 3),
  },
  {
    键: "shotGroup:<桥段id>.keyCreativeDescription", 名称: "本桥段关键创意描述",
    含义: "这一段为什么成立、在创意机制上做了什么。",
    写法: "写机制和作用：这一段建立／推进／反转了什么，靠什么让观众产生什么理解或情绪。不复述画面（画面已经记在镜头里）。1–3 句。", 取值: "文字",
  },
  {
    键: "shot:<镜头id>.<字段键>", 名称: "镜头字段",
    含义: `镜头的客观记录。可改的字段键：${SHOT_TEXT_FIELDS.map((field) => `${field.key}（${field.label}）`).join("、")}。startTime、endTime（时间码）只读，不能改。`,
    写法: "如实记录，不加评价；画面内容写清谁在做什么，人物身份、关键道具要写准。你看不到视频，只能补写老孙口头说出的信息。「作业」里只列出了已填写的镜头字段，空着的字段照「shot:<镜头id>.<字段键>」拼键。",
    取值: "文字",
  },
  {
    键: "path.primaryType", 名称: "主导路径",
    含义: "这支片子最终主要让观众获得的感受：有爱／情感（情感触动：温暖、感动、心痛、治愈、共情）；有趣／预期（愉悦、好笑、意外、机智感或游戏感）；有料／感知（超出日常经验的震撼：认知、观念、视觉、技术或规模）。",
    写法: "三选一。改主导路径时必须同时给出新路径的全部五个细项，且不能与现有辅助路径相同。",
    取值: "文字，只能是「有爱／情感」「有趣／预期」「有料／感知」之一",
  },
  ...(["LOVE", "FUN", "PERCEPTION"] as const).flatMap((type) => detailGuide(type)),
  {
    键: "path.auxiliaryTypes.<路径代码>.description", 名称: "辅助路径说明",
    含义: "这条辅助路径在片中是怎样发生的。路径代码：LOVE＝有爱／情感，FUN＝有趣／预期，PERCEPTION＝有料／感知。",
    写法: "一两句，写具体发生在哪里、靠什么。只能改作业里已有的辅助路径。", 取值: "文字",
  },
  {
    键: "path.auxiliaryTypes.<路径代码>.creativeRole", 名称: "辅助类型的创意作用",
    含义: "这条辅助路径对主导路径起什么作用；拿掉它会损失什么。",
    写法: "一两句。", 取值: "文字",
  },
  {
    键: "facts.overallCreativeRating", 名称: "整体创意评价",
    含义: "对这支片子创意水平的整体判断。",
    写法: "只写一个字母。", 取值: "文字，只能是 S、A、B、C 之一",
  },
  {
    键: "facts.ratingReason", 名称: "评价理由",
    含义: "为什么给这个评价：成立在哪里、扣分在哪里。",
    写法: "先写成立的地方，再写扣分点，具体到桥段或机制；与整体创意评价一致。", 取值: "文字",
  },
];

const MECHANISM_MEANINGS: Record<string, string> = {
  INSIGHT_RESONANCE: "把被忽略但普遍存在的经验显现出来，引起共鸣。",
  METAPHOR_TRANSLATION: "用另一种人、事、物或关系来表达商业内容。",
  REVERSAL_REINTERPRETATION: "改变观众对前面信息的理解。",
  MISPLACEMENT_GRAFTING: "把原本不属于同一系统的事物连接起来。",
  EXAGGERATION_AMPLIFICATION: "把某种特征、利益或问题推向极端。",
  MINIATURIZATION_COMPRESSION: "把宏大、漫长或复杂的事物压缩呈现。",
  DEFAMILIARIZATION: "把熟悉的事物变成陌生的经验。",
  PERSONIFICATION: "让产品、物件、技术或品牌具有人的行为。",
  JUXTAPOSITION_CREATES_MEANING: "把两个对象、状态、身份或世界放在一起，靠对照与冲突生出意义。",
  REPETITION_CHANGES_MEANING: "同一行为、意象或结构反复出现，并在重复中改变意义。",
  UNCONVENTIONAL_RULE_BUILDING: "建立一个不同于现实的特殊世界规则。",
  FORMAL_PLAY: "依靠语言、镜头、媒介或结构形式本身形成创意。",
  SPECTACLE_CREATION: "通过罕见画面、规模或技术呈现形成吸引力。",
  PRODUCT_MECHANISM_ENACTMENT: "直接从产品功能、结构或使用机制中生长出创意。",
  PENDING_NEW_MECHANISM: "现有标签都不贴切；必须在 advanced（进阶机制层）写清新的动词性机制，以及它在本片中具体做了什么。",
};

export function buildVocabularyGuide() {
  return {
    通用机制: vocabularyOptions("generalMechanism").map((option) => ({
      标签: option.labelZhCn,
      说明: MECHANISM_MEANINGS[option.optionId] ?? "",
    })),
    桥段创意作用: Object.entries(Object.groupBy(vocabularyOptions("bridgeCreativeRole"), (option) => option.groupKey))
      .map(([group, options]) => ({
        分组: { ESTABLISH: "建立", ADVANCE: "推进", DEVIATE_REINTERPRET: "偏离与重释", COMPLETE_CLOSE: "完成与收束" }[group] ?? group,
        标签: (options ?? []).map((option) => option.labelZhCn),
      })),
    故事参照类型: vocabularyOptions("storyReferenceType").map((option) => option.labelZhCn),
    主导路径: V04_UI_PATHS.map((path) => path.label),
    创意承重载体: Object.values(CARRIER_LABELS),
    整体创意评价: ["S", "A", "B", "C"],
  };
}

// ---------------------------------------------------------------------------
// user：作业（可读结构，带稳定键）
// ---------------------------------------------------------------------------

type HomeworkItem = { 键: string; 名称: string; 当前内容: unknown };

function choiceForPrompt(value: V04ChoiceValue | undefined, mechanism: boolean) {
  const result: Record<string, unknown> = {
    options: (value?.selectedOptionIds ?? []).map(optionLabel),
    custom: value?.customText ?? "",
  };
  if (mechanism) result.advanced = value?.advancedText ?? "";
  return result;
}

function factValue(payload: V04DraftPayloadV1, key: (typeof FACT_FIELDS)[number]) {
  const value = payload.factsAndCoreJudgement[key.key];
  if (key.kind === "MECHANISM") return choiceForPrompt(value as V04ChoiceValue, true);
  if (key.kind === "CHOICE") return choiceForPrompt(value as V04ChoiceValue, false);
  if (key.kind === "CARRIERS") {
    return (value as string[]).map((code) => CARRIER_LABELS[code as keyof typeof CARRIER_LABELS] ?? code);
  }
  return value ?? "";
}

export function buildHomeworkForPrompt(payload: V04DraftPayloadV1) {
  const module1: HomeworkItem[] = FACT_FIELDS.filter((field) => field.module === 1).map((field) => ({
    键: `facts.${field.key}`, 名称: field.name, 当前内容: factValue(payload, field),
  }));
  const module2 = payload.script.shotGroups.map((group, groupIndex) => ({
    桥段: `桥段 ${groupNumber(groupIndex)}`,
    桥段id: group.id,
    条目: GROUP_FIELDS.map((field) => ({
      键: `shotGroup:${group.id}.${field.key}`,
      名称: field.name,
      当前内容: field.kind === "CHOICE"
        ? choiceForPrompt(group[field.key] as V04ChoiceValue, false)
        : group[field.key] ?? "",
    })),
    镜头: group.shots.map((shot, shotIndex) => ({
      镜号: `${groupIndex + 1}-${shotIndex + 1}`,
      镜头id: shot.id,
      "时间码（只读）": `${shot.startTime || "?"}–${shot.endTime || "?"}`,
      已填写: Object.fromEntries(SHOT_TEXT_FIELDS
        .filter((field) => (shot[field.key] ?? "").trim())
        .map((field) => [`shot:${shot.id}.${field.key}`, `${field.label}：${shot[field.key]}`])),
    })),
  }));
  const path = payload.perceptionPath;
  const module3: HomeworkItem[] = [
    { 键: "path.primaryType", 名称: "主导路径", 当前内容: path.primaryType ? perceptionTypeLabel(path.primaryType) : "" },
  ];
  if (path.primaryType) {
    for (const subKey of PRIMARY_DETAIL_KEYS[path.primaryType]) {
      module3.push({
        键: `path.primaryDetails.${subKey}`,
        名称: `主导路径细项 · ${primaryDetailLabel(path.primaryType, subKey)}`,
        当前内容: path.primaryDetails[subKey] ?? "",
      });
    }
  }
  for (const auxiliary of path.auxiliaryTypes) {
    for (const field of AUXILIARY_FIELDS) {
      module3.push({
        键: `path.auxiliaryTypes.${auxiliary.type}.${field.key}`,
        名称: `辅助路径（${perceptionTypeLabel(auxiliary.type)}）· ${field.name}`,
        当前内容: auxiliary[field.key] ?? "",
      });
    }
  }
  for (const field of FACT_FIELDS.filter((item) => item.module === 3)) {
    module3.push({ 键: `facts.${field.key}`, 名称: field.name, 当前内容: factValue(payload, field) });
  }
  return {
    说明: "每个条目给出键和当前内容（空着的条目也列出来了，老孙说到时可以补写）。选项字段的当前内容用的就是输出时 value 的形状。镜头只列出已填写的字段，值的冒号前是字段名；改镜头字段时 value 只写内容，不带字段名。",
    "第一模块｜全片事实与核心判断": module1,
    "第二模块｜脚本反写": module2,
    "第三模块｜主导感知类型发生路径与整体评价": module3,
  };
}

// ---------------------------------------------------------------------------
// user：输出格式与示例
// ---------------------------------------------------------------------------

export const AUDIO_REVIEW_OUTPUT_FORMAT = {
  speakers: { reviewer: "老孙的说话人编号，如 \"S0\"", labels: { "其他说话人编号": "姓名，或「其他同事」" } },
  opinions: [{
    id: "o1",
    kind: "GENERAL 或 SPECIFIC",
    summary: "一句话转述老孙的判断",
    segmentIds: ["这条意见依据的片段编号（数字）"],
    rationale: "落实说明：改了哪几处、为什么；检查过但没改的关键条目也说明",
  }],
  changes: [{ key: "作业里的键", value: "改后的完整新值，形状见字段说明", opinionIds: ["o1"] }],
  unaddressed: [{ segmentIds: ["片段编号（数字）"], reason: "原因（见规则第 9 条）" }],
  corrections: [{ segmentId: "片段编号（数字）", from: "文字稿原文里的错写", to: "校正后的写法" }],
};

/** 一个完整的小例子：示例作业片段 + 示例文字稿 → 示例输出。键都是假的，只说明格式与落实方式。 */
export const AUDIO_REVIEW_EXAMPLE = {
  说明: "示例案例是虚构的《夜归》（便利店品牌，有爱／情感路径），只截取了几个条目。注意意见 1 是总体意见，落实到了五处；释放方式那一处同时依据意见 1 和意见 3；提问片段 3 归入了意见 2 的 segmentIds；要求补镜头的片段 6 进了 unaddressed。",
  示例作业片段: [
    { 键: "facts.creativeMotif", 名称: "创意母题", 当前内容: "城市夜晚的温暖" },
    { 键: "facts.tensionButton", 名称: "张力按钮", 当前内容: "冷清的深夜街道和亮着灯的便利店形成对比。" },
    { 键: "facts.creativeThinkingChain", 名称: "创意思维链", 当前内容: "夜归人很孤独\n→ 便利店亮着灯\n→ 城市很温暖" },
    { 键: "facts.auxiliaryMechanism", 名称: "创意辅助手法及机制", 当前内容: { options: ["洞察共鸣"], custom: "夜归人的孤独", advanced: "" } },
    { 键: "shotGroup:例桥段2.keyCreativeDescription", 名称: "本桥段关键创意描述", 当前内容: "店员把关东煮递给加班的人。" },
    { 键: "shot:例镜头2-1.visualContent", 名称: "画面内容（镜头故事）", 当前内容: "一个人推门进店。" },
    { 键: "path.primaryDetails.releaseMethod", 名称: "主导路径细项 · 情感释放方式", 当前内容: "店员递上热的关东煮。" },
    { 键: "facts.overallCreativeRating", 名称: "整体创意评价", 当前内容: "S" },
    { 键: "facts.ratingReason", 名称: "评价理由", 当前内容: "画面温暖，很感人。" },
  ],
  示例文字稿: [
    { id: 1, t: "00:12", speaker: "S0", text: "这条的母题写成城市夜晚的温暖，太泛了。它真正说的是，深夜还在外面的人，其实都在被一个陌生人默默等着。" },
    { id: 2, t: "00:40", speaker: "S0", text: "所以张力不在冷和暖的对比，在陌生人和等你这两件事放在一起。" },
    { id: 3, t: "01:05", speaker: "S1", text: "孙老师，那主导机制要改吗？" },
    { id: 4, t: "01:09", speaker: "S0", text: "主导不用动。辅助机制不是洞察共鸣，是对质生意，陌生人干的是家人干的事。" },
    { id: 5, t: "01:40", speaker: "S0", text: "推门进店那个镜头，进来的是个外卖骑手，头盔还没摘，这个要写出来。" },
    { id: 6, t: "02:02", speaker: "S0", text: "店员递关东煮之前，你漏拆了一个她抬头看钟的镜头，回去补上。" },
    { id: 7, t: "02:20", speaker: "S0", text: "镜头节奏拆得很准，这个是好的。" },
    { id: 8, t: "02:41", speaker: "S0", text: "评价我给 A，结尾直接递关东煮，太直白了。" },
  ],
  示例输出: {
    speakers: { reviewer: "S0", labels: { S1: "其他同事" } },
    opinions: [
      {
        id: "o1", kind: "GENERAL",
        summary: "母题看浅了：片子说的不是「城市夜晚的温暖」，而是「深夜在外的人都被一个陌生人默默等着」",
        segmentIds: [1, 2],
        rationale: "总体意见，改变了全片的核心判断。逐条检查后改了创意母题、张力按钮、创意思维链、桥段 02 的关键创意描述、情感释放方式；镜头记录不受影响；评价理由随意见 4 一并改写。",
      },
      {
        id: "o2", kind: "SPECIFIC",
        summary: "辅助机制应为「对置生义」：陌生人做着家人才做的事",
        segmentIds: [3, 4],
        rationale: "具体意见，来自问答：问题是同事提的，以老孙的回答为准；主导机制不动，只改辅助机制。",
      },
      {
        id: "o3", kind: "SPECIFIC",
        summary: "推门进店的是外卖骑手，头盔还没摘",
        segmentIds: [5],
        rationale: "具体意见：改镜头 2-1 的画面内容；情感释放方式里的人物同步写成骑手。",
      },
      {
        id: "o4", kind: "SPECIFIC",
        summary: "整体评价给 S 偏高，应为 A：结尾直接递关东煮太直白",
        segmentIds: [8],
        rationale: "具体意见：改整体创意评价和评价理由。",
      },
    ],
    changes: [
      { key: "facts.creativeMotif", value: "深夜还在外面的人，都在被一个陌生人默默等着", opinionIds: ["o1"] },
      { key: "facts.tensionButton", value: "把「陌生人」和「等你回来」放在一起：店员不认识这些夜归人，却像家人一样为他们留着灯和热食。", opinionIds: ["o1"] },
      {
        key: "facts.creativeThinkingChain",
        value: "夜归人的处境\n  - 深夜还在外面：加班的人、骑手、司机\n  - 没有人在等：回家前最后一站往往是便利店\n创意推导\n  - 把店员写成「在等你的人」\n    - 陌生人做家人才做的事：留灯、留热食\n  - 每个夜归人都被接住\n  - 品牌＝深夜里等你的那盏灯",
        opinionIds: ["o1"],
      },
      { key: "facts.auxiliaryMechanism", value: { options: ["对置生义"], custom: "陌生人与家人对置：店员不认识他们，却做着家人才会做的事", advanced: "" }, opinionIds: ["o2"] },
      { key: "shotGroup:例桥段2.keyCreativeDescription", value: "用一个陌生人的照顾兑现「有人在等你」：热食递出的那一刻，夜归人的孤独被接住，母题在动作上落地。", opinionIds: ["o1"] },
      { key: "shot:例镜头2-1.visualContent", value: "一名外卖骑手推门进店，头盔还没摘。", opinionIds: ["o3"] },
      { key: "path.primaryDetails.releaseMethod", value: "店员把留好的热关东煮递给刚进门的外卖骑手——陌生人的等待落到一个具体动作上。", opinionIds: ["o1", "o3"] },
      { key: "facts.overallCreativeRating", value: "A", opinionIds: ["o4"] },
      { key: "facts.ratingReason", value: "「陌生人在等你」的母题成立，桥段推进清楚；但结尾直接递上关东煮，情感释放过于直白、没有留出余味，因此给 A。", opinionIds: ["o4", "o1"] },
    ],
    unaddressed: [
      { segmentIds: [6], reason: "需要人工补／删镜头：老孙指出桥段 02 漏拆了店员抬头看钟的镜头，需人工补一个镜头。" },
      { segmentIds: [7], reason: "肯定的部分，不需要改。" },
    ],
    corrections: [{ segmentId: 4, from: "对质生意", to: "对置生义" }],
  },
};

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export type AudioReviewPromptContext = {
  snapshot: V04DraftPayloadV1;
  segments: readonly AudioReviewTranscriptSegment[];
  reviewerName: string;
  revieweeName: string;
  baseVersionNumber: number;
  caseTitle?: string | null;
};

export function buildTranscriptForPrompt(segments: readonly AudioReviewTranscriptSegment[]) {
  return segments.map((segment) => ({
    id: segment.id,
    t: transcriptClock(segment.startMs),
    speaker: segment.speakerId,
    text: segment.text,
  }));
}

export function buildAudioReviewUserPayload(context: AudioReviewPromptContext) {
  return {
    任务: {
      案例: context.caseTitle?.trim() || "（未提供标题）",
      被点评版本: `v${context.baseVersionNumber}`,
      被点评人: context.revieweeName,
      录音者: context.reviewerName,
      说明: `这段录音是${context.reviewerName}在分享会上点评${context.revieweeName}这一版作业时录的。现场可能还有被点评人的解释和其他同事的提问。请按 system 里的步骤，把${context.reviewerName}的点评落实成对这份作业的改动。`,
    },
    字段说明: AUDIO_REVIEW_FIELD_GUIDE,
    词表: buildVocabularyGuide(),
    作业: buildHomeworkForPrompt(context.snapshot),
    文字稿: buildTranscriptForPrompt(context.segments),
    输出格式: AUDIO_REVIEW_OUTPUT_FORMAT,
    输出示例: AUDIO_REVIEW_EXAMPLE,
  };
}

export function buildAudioReviewMessages(context: AudioReviewPromptContext) {
  return {
    system: AUDIO_REVIEW_SYSTEM_PROMPT,
    user: JSON.stringify(buildAudioReviewUserPayload(context), null, 1),
  };
}

/** 送进模型的输入的哈希（docs/03 3.3）：模型、提示词版本、两条消息一起算。 */
export function hashAudioReviewInput(model: string, messages: { system: string; user: string }) {
  return createHash("sha256")
    .update(JSON.stringify({ model, promptVersion: AUDIO_REVIEW_PROMPT_VERSION, system: messages.system, user: messages.user }), "utf8")
    .digest("hex");
}
