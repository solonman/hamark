import { annotationFields } from "./annotation-fields";

export const REVIEW_RUBRIC_VERSION = "RUBRIC-V0.4" as const;

export type ReviewScoreItem = {
  code: string;
  section: string;
  label: string;
  maxScore: number;
  guide: string;
  targetId: string;
};

const fivePointGuide =
  "5分：准确具体，可作为高质量学习数据；4分：整体正确，仅有少量缺失；3分：基本可用但洞察不足；1–2分：内容零散或偏差明显；0分：未填写或无法使用。";

const taxonomyGuide =
  "1分：符合V0.2定义与选择规则；0.5分：已完成但存在部分偏差；0分：未填写、违反选择规则或明显错误。标注依据不计分。";

export const reviewScoreItems: ReviewScoreItem[] = [
  {
    code: "shot_segmentation",
    section: "逐镜脚本还原 · 35分",
    label: "镜头组分段与顺序",
    maxScore: 10,
    guide:
      "10分：段落切分、镜头组、镜头序号和时间段准确完整；8分：整体正确，仅有少量边界偏差；6分：主要段落可辨但存在漏镜或顺序问题；1–5分：切分混乱；0分：未完成。",
    targetId: "shots",
  },
  {
    code: "shot_language",
    section: "逐镜脚本还原 · 35分",
    label: "景别、机位与运动",
    maxScore: 10,
    guide:
      "10分：景别、机位、角度和运动识别准确完整；8分：整体准确，少数镜头有偏差；6分：基础识别可用但遗漏明显；1–5分：大量错误；0分：未完成。",
    targetId: "shots",
  },
  {
    code: "shot_visual",
    section: "逐镜脚本还原 · 35分",
    label: "画面内容／镜头故事",
    maxScore: 10,
    guide:
      "10分：画面事实、人物动作和镜头内故事准确完整；8分：主要叙事准确，细节略有遗漏；6分：能理解主线但描述不充分；1–5分：叙事理解偏差明显；0分：未完成。",
    targetId: "shots",
  },
  {
    code: "shot_speech",
    section: "逐镜脚本还原 · 35分",
    label: "对白与旁白",
    maxScore: 1,
    guide: "1分：对白与旁白基本逐字准确、角色归属清楚；0.5分：有少量遗漏或错字；0分：未完成或明显错误。",
    targetId: "shots",
  },
  {
    code: "shot_text",
    section: "逐镜脚本还原 · 35分",
    label: "字幕与屏幕文案",
    maxScore: 1,
    guide: "1分：字幕、屏幕文案和品牌落款准确完整；0.5分：有少量遗漏或错字；0分：未完成或明显错误。",
    targetId: "shots",
  },
  {
    code: "shot_sound",
    section: "逐镜脚本还原 · 35分",
    label: "声效",
    maxScore: 1.5,
    guide: "1.5分：关键环境音、动作音和特殊声效识别完整；1分：主要声效已记录；0.5分：记录零散；0分：未完成。",
    targetId: "shots",
  },
  {
    code: "shot_music",
    section: "逐镜脚本还原 · 35分",
    label: "音乐",
    maxScore: 1.5,
    guide: "1.5分：音乐进入、变化、退出及其作用记录完整；1分：主要音乐段落已记录；0.5分：记录零散；0分：未完成。",
    targetId: "shots",
  },
  {
    code: "commentary_function",
    section: "镜头创意点评 · 20分",
    label: "事实与创意功能区分",
    maxScore: 5,
    guide: `关注是否从“画面发生什么”推进到“为什么这样拍”。${fivePointGuide}`,
    targetId: "shots",
  },
  {
    code: "commentary_narrative",
    section: "镜头创意点评 · 20分",
    label: "叙事与情绪作用",
    maxScore: 5,
    guide: `关注是否指出铺垫、推进、转折与情绪作用。${fivePointGuide}`,
    targetId: "shots",
  },
  {
    code: "commentary_brand",
    section: "镜头创意点评 · 20分",
    label: "商业与品牌连接",
    maxScore: 5,
    guide: `关注是否解释镜头怎样服务商业意图和品牌进入。${fivePointGuide}`,
    targetId: "shots",
  },
  {
    code: "commentary_audiovisual",
    section: "镜头创意点评 · 20分",
    label: "视听洞察与表达",
    maxScore: 5,
    guide: `关注是否识别关键视听机制，表达是否具体、清楚且不重复。${fivePointGuide}`,
    targetId: "shots",
  },
  {
    code: "commercial_intent",
    section: "整体判断 · 22分",
    label: "商业意图",
    maxScore: 3,
    guide:
      "3分：商业目标明确完整并与作品一致；2分：方向基本正确但不够具体；1分：判断模糊或连接较弱；0分：未填写或明显错误。",
    targetId: "core",
  },
  {
    code: "creative_theme",
    section: "整体判断 · 22分",
    label: "创意母题",
    maxScore: 5,
    guide:
      "5分：准确概括并能统领整片；4分：判断正确但略宽或略窄；2–3分：抓到局部但更像情节复述；1分：模糊或偏离；0分：未填写。",
    targetId: "core",
  },
  {
    code: "story_synopsis",
    section: "整体判断 · 22分",
    label: "故事梗概",
    maxScore: 4,
    guide:
      "4分：人物、事件、变化和结局清楚完整；3分：主线完整但有少量遗漏；2分：能理解大意但结构或因果不清；1分：片段化复述；0分：未填写。",
    targetId: "core",
  },
  {
    code: "thinking_chain",
    section: "整体判断 · 22分",
    label: "创意思维链",
    maxScore: 10,
    guide:
      "9–10分：商业问题、洞察、机制、叙事与品牌落点推导完整；7–8分：逻辑完整但深度或证据略弱；5–6分：有基本思路但推导不足；1–4分：零散或跳跃；0分：未填写。",
    targetId: "core",
  },
  ...annotationFields.slice(0, 9).map((field) => ({
    code: `field_${field.code}`,
    section: "创意构成 A1–A9 · 9分",
    label: `${field.code} ${field.name}`,
    maxScore: 1,
    guide: taxonomyGuide,
    targetId: "creative",
  })),
  ...annotationFields.slice(9).map((field) => ({
    code: `field_${field.code}`,
    section: "故事组织 B1–B10 · 10分",
    label: `${field.code} ${field.name}`,
    maxScore: 1,
    guide: taxonomyGuide,
    targetId: "story",
  })),
  {
    code: "full_summary",
    section: "全篇创意总结 · 4分",
    label: "全篇创意总结",
    maxScore: 4,
    guide:
      "4分：完整概括创意、故事、文案、视听和商业目标之间的关系；3分：总体正确但少量关系未说明；2分：有主要内容但缺综合判断；1分：零散复述；0分：未填写。",
    targetId: "core",
  },
];

export const REVIEW_MAX_SCORE = reviewScoreItems.reduce(
  (total, item) => total + item.maxScore,
  0,
);

export function emptyReviewScores() {
  return Object.fromEntries(reviewScoreItems.map((item) => [item.code, null])) as Record<
    string,
    number | null
  >;
}

export function calculateReviewTotal(scores: Record<string, number | null>) {
  return reviewScoreItems.reduce((total, item) => {
    const value = scores[item.code];
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

export function validateReviewScores(scores: Record<string, number | null>) {
  return reviewScoreItems.flatMap((item) => {
    const value = scores[item.code];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return [`${item.label}尚未评分`];
    }
    if (value < 0 || value > item.maxScore) {
      return [`${item.label}必须在0–${item.maxScore}分之间`];
    }
    return [];
  });
}
