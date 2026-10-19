// 客户需求复盘库·月度整理的三步提示词（docs/26 三、6.3–6.5、6.8）。
//
// **维度和类别的释义由工程起草，请老孙校订**（做法同 docs/25 的字段说明：改这里的文字即可，
// 改完把对应的 *_PROMPT_VERSION 加一，任务行会记下用的是哪一版提示词；逐案缓存也会随之失效）。
//
// system 写死规格第三节的八条硬约束、维度／类别／迁移性的中文释义和反例；user 是一段 JSON：
// 任务、输入（表单文字、文字稿）和输出格式。纯函数，不碰数据库与网络。

import { transcriptClock } from "@/lib/audio-review/transcript";
import {
  RETRO_DIMENSION_LABELS,
  RETRO_LIMITS,
  RETRO_KIND_LABELS,
  RETRO_LINK_KIND_LABELS,
  RETRO_TRANSFER_LABELS,
} from "@/lib/retro-model";
import type { RetroExtractionOutput, RetroSpeakers } from "./extraction";
import {
  caseSegmentIndex,
  recordingSegmentIndex,
  sha256,
  stableStringify,
  type RetroGenerateSnapshot,
  type RetroSnapshotCase,
} from "./month-snapshot";
import { buildSynthesisRefIndex, type RetroSynthesisContext } from "./synthesis";

export const RETRO_EXTRACT_PROMPT_VERSION = "2026-10-20.2";
export const RETRO_MINUTES_PROMPT_VERSION = "2026-10-20.2";
export const RETRO_METHODS_PROMPT_VERSION = "2026-10-20.2";

export const RETRO_PROMPT_VERSIONS = {
  extract: RETRO_EXTRACT_PROMPT_VERSION,
  minutes: RETRO_MINUTES_PROMPT_VERSION,
  methods: RETRO_METHODS_PROMPT_VERSION,
} as const;

export type RetroLlmMessages = { system: string; user: string };

// ---------------------------------------------------------------------------
// 共用：场景、八条硬约束、释义（请老孙校订）
// ---------------------------------------------------------------------------

const SCENE = `【场景】
博加是一家房地产广告公司，客户是房地产开发商，常见工作包括楼盘推广策略、案名与主形象、开盘与各节点营销、售楼处与现场包装、楼书和各类物料、线上传播；案例里的「客户」通常指开发商的营销团队（营销总、策划经理等）。博加每月开一次客户服务复盘会。各部门各讲一个真实的客户服务案例（客户最初要什么、我们交了几版、客户怎么反馈、我们怎么应对、结果如何），创始人老孙通过追问、分析和点评带教。每讲完一个案例停一次录音，最后老孙的整场总结单独录一段。会后系统把录音转写成文字，你的工作是把老孙的现场带教整理成两份东西：①面向中层的「教学纪要」，②面向公司长期积累的「方法提取记录」（内容全部是「方法候选」）。你看不到任何附件（图片、PDF、视频），只能读表单里的文字和录音的转写文字稿。`;

const HARD_RULES = `【硬约束——违反的内容会被系统直接丢弃】
1. 只提取录音里有依据的东西。每一条方法候选、核心认识、改进事项、老孙指出的问题、改进建议都必须引用至少一句录音原话（写片段编号）；引不出来的不要写。引文由系统按片段编号从文字稿里取出展示，你不要自己写引文，也不要在文字里假装引用。
2. 不替老孙发明理论。不得把分析套进任何现成框架或模型：尤其不得整理成黄金圈（Why／What／How），也不要套 SWOT、4P、AIDA、金字塔原理、用户旅程、第一性原理之类的现成结构。老孙原话里自己用了这类说法的，可以照实记录。
3. 区分三类东西，每条方法候选必须标出一类（释义见下）：METHOD 相对稳定的思维方法；INTUITION 基于经验的专业直觉——只记老孙的判断和他实际说出的理由，不替他补全逻辑；SITUATIONAL 针对特定情境的判断——必须在 situation 里写明是什么情境（客户性格、合作历史、现场气氛……）。
4. 只是候选。你产出的方法全部是「方法候选」，不要写「正式方法」「公司规范」「标准流程」之类的定性。
5. 出现次数不等于重要性。不按频次排序、不打重要度分、不写「老孙反复强调」来抬高某一条；只出现一次但有分量的判断照样保留。
6. 不机械凑数。不要求每个案例出三条，核心认识和改进事项按实际讨论来，可以很少，甚至没有。宁缺毋滥。
7. 改进事项只保留能执行的：写清在什么时候、由谁、做什么。说不清这三样的，不算改进事项。
8. 录音里汇报人和其他同事的话只用来理解上下文。方法候选、老孙指出的问题、改进建议只从老孙的话里提；纪要里的「关键争议」可以引用各方，也可以引用客户录音。`;

/** 维度、类别、迁移性的释义（工程起草，请老孙校订）。 */
export const RETRO_DIMENSION_GUIDE: Record<keyof typeof RETRO_DIMENSION_LABELS, string> = {
  ENTRY: "问题切入：面对客户的要求或一个棘手局面，老孙先从哪里下手、先问什么、先抓哪个点。",
  INFO: "信息判断：老孙怎么判断一条信息（客户的话、数据、渠道、处境）可信不可信、重要不重要、背后意味着什么。",
  PATH: "分析路径：老孙把一个问题一步步想清楚的顺序和角度，例如逐版回看、先拆目标再看方案。",
  VALUE: "价值判断：老孙判断方案好坏、取舍轻重的标准，例如什么是前提、什么只是加分。",
  SOLUTION: "解决思路：老孙给出的解决问题的路子，尤其是在约束下两头兼顾、换一个问题来解的办法。",
  INTERACTION: "互动方法：老孙怎么和客户、同事打交道：什么时候退、什么时候问、怎么说对方听得进去。",
};

export const RETRO_KIND_GUIDE: Record<keyof typeof RETRO_KIND_LABELS, string> = {
  METHOD: "方法：相对稳定、换一个案子也成立的思维方法；老孙说得出做法和道理。",
  INTUITION: "直觉：基于经验的专业判断，老孙自己也说不全理由（「说不太清楚，看多了就知道」）。只记他的判断和他实际说出的理由，不替他补全逻辑。",
  SITUATIONAL: "情境：只在特定情境下才这么做的判断；situation 必须写明情境，例如「开发商刚换了营销总」「客户当着上级发火」。",
};

export const RETRO_TRANSFER_GUIDE: Record<keyof typeof RETRO_TRANSFER_LABELS, string> = {
  TRANSFERABLE: "可迁移：换一个客户、换一类项目也适用；transferNote 写适用于什么场合。",
  CASE_ONLY: "只适用本案：取决于这个案子的特殊条件；transferNote 写取决于什么。",
  UNSURE: "说不准：老孙只在这一处这么说过，或者他自己也没说能不能推广；transferNote 写为什么说不准。",
};

const GUIDE_BLOCK = `【分析维度 dimension】（释义由工程起草，请老孙校订）
${Object.entries(RETRO_DIMENSION_GUIDE).map(([key, text]) => `- ${key}（${RETRO_DIMENSION_LABELS[key as keyof typeof RETRO_DIMENSION_LABELS]}）：${text}`).join("\n")}

【类别 kind】
${Object.entries(RETRO_KIND_GUIDE).map(([key, text]) => `- ${key}（${RETRO_KIND_LABELS[key as keyof typeof RETRO_KIND_LABELS]}）：${text}`).join("\n")}

【迁移性 transfer】（需求文档里的「方法迁移」不单列为维度，而是每条候选都要回答的属性）
${Object.entries(RETRO_TRANSFER_GUIDE).map(([key, text]) => `- ${key}（${RETRO_TRANSFER_LABELS[key as keyof typeof RETRO_TRANSFER_LABELS]}）：${text}`).join("\n")}

【例子与反例】
- 老孙说「先别急着改，先问清楚他为什么要改」→ dimension=ENTRY，kind=METHOD。
- 老孙说「这种客户你得先让他把火发完」→ dimension=INTERACTION，kind=SITUATIONAL，situation=「客户当场情绪激动」。
- 老孙说「没什么依据，经验」→ kind=INTUITION；description 只写他的判断和他说出口的那条理由，不要替他补一套推理。
- 反例：把老孙的话整理成「Why：客户为什么要改；How：怎么改；What：改成什么」——这是套黄金圈，禁止。
- 反例：汇报人说「下次提案前先把这个问清楚」，老孙没有接话——这不是老孙的话，不能当方法候选的依据。
- 反例：老孙只说了一次，就写「老孙一贯认为」「核心方法论」——夸大了，不要写。`;

const OUTPUT_RULE = "只输出一个 JSON 对象，不要输出解释文字，不要用 Markdown 围栏。没有内容的数组给空数组。文字用书面语，去掉口头禅；不要写「老孙认为」以外的揣测。";

const SPEAKER_RULE = `【认人】文字稿每句带一个 speaker，写成「<段号>:<标签>」，例如 "1:S0"、"2:S1"。标签是机器在每段录音里各自区分的，**只在同一段录音里有意义**：第 2 段的 S0 不一定是第 1 段的 S0（中途换过设备、断过重录）；标签也可能分错，或者全部相同。请按内容、逐段判断谁是老孙：他在追问、下判断、给建议、点评；汇报人在讲经过、解释自己当时的做法；其他同事多是插话、提问。speakers.founder 是一个数组，每段录音写一个最常对应老孙的「段号:标签」；labels 给其他「段号:标签」起称呼（只用「汇报人」「其他同事」这类称呼，认得出的可以写名字）。`;

const MISHEARING_RULE = "【听写错字】文字稿是机器听写，同音、近音错字可能很多。按表单里的客户名、项目名和案名、部门、案例标题、回合标题和上下文还原原意，不要被错字带偏，也不要把错字写进成果。影响理解的错字写进 corrections（segmentId、原文里一字不差的 from、还原后的 to），只记有把握的。";

// ---------------------------------------------------------------------------
// ① 逐案提炼
// ---------------------------------------------------------------------------

export const RETRO_EXTRACT_SYSTEM_PROMPT = `你是博加「客户需求复盘库」的整理助手，现在做第一步：逐个案例提炼。

${SCENE}

${HARD_RULES}

${GUIDE_BLOCK}

【这一步要做的】
你会拿到一个案例的表单文字（任务与最初需求、每一回合「我们交了什么 → 客户怎么反馈 → 我们怎么应对」、关联作品的摘要、结果、关键转折、希望讨论的问题）、这个案例附件里客户录音的文字稿（如有），以及这个案例现场点评录音的文字稿。
${SPEAKER_RULE}
然后输出：
- review.process：业务问题及其发展过程，一段叙述，取自表单和汇报人的讲述；processSegmentIds 可以引用点评录音片段或客户录音片段。
- review.disputes：讨论里的关键争议（各方观点都可以引用，客户录音也可以作为客户原话的出处）。
- review.founderPoints：老孙指出的问题；roundIds 指向他所说的那一回合（如「你看第二版这里」）。
- review.suggestions：老孙最终提出的改进建议。
- insights：可能进入本月「核心认识」的点（跨案例归纳在下一步做，这里只列本案里老孙说出的判断）。
- actions：可执行的改进事项（何时、由谁、做什么）。
- methods：方法候选，只从老孙的话里提，字段见输出格式。
- corrections：听写错字的还原。

【引用的写法】
- 点评录音片段写编号数字，例如 12；一个案例有多段录音时，编号已经按段号接续好了。
- 客户录音片段写成 "c<附件id>:<片段号>"，例如 "cast_1:3"。客户录音只能出现在 review.processSegmentIds 和 review.disputes 里；放在别处会被系统剔除。
- 方法候选的 segmentIds 里至少要有一句是老孙说的（按 speakers.founder 里那段录音的标签判断），否则整条会被丢弃。
- roundIds 只能用表单里给出的回合 id。

${MISHEARING_RULE}

【输出】${OUTPUT_RULE}`;

const EXTRACT_OUTPUT_FORMAT = {
  speakers: { founder: ["1:S0", "2:S1"], labels: { "1:S1": "汇报人", "1:S2": "其他同事", "2:S0": "汇报人" } },
  review: {
    process: "业务问题及其发展过程（叙述）",
    processSegmentIds: [3, "c<附件id>:2"],
    disputes: [{ text: "…", segmentIds: [12, 13] }],
    founderPoints: [{ text: "老孙指出的问题", segmentIds: [20], roundIds: ["<回合id>"] }],
    suggestions: [{ text: "最终提出的改进建议", segmentIds: [41] }],
  },
  insights: [{ text: "可能进入核心认识的点", segmentIds: [33] }],
  actions: [{ text: "可执行的改进事项：何时、由谁、做什么", segmentIds: [44] }],
  methods: [
    {
      dimension: "ENTRY | INFO | PATH | VALUE | SOLUTION | INTERACTION",
      kind: "METHOD | INTUITION | SITUATIONAL",
      title: "不超过 40 字",
      description: "老孙怎么做、为什么（只写录音里有的）",
      situation: "SITUATIONAL 必填，其它留空",
      transfer: "TRANSFERABLE | CASE_ONLY | UNSURE",
      transferNote: "迁移性的理由",
      segmentIds: [20, 22],
      roundIds: ["<回合id>"],
    },
  ],
  corrections: [{ segmentId: 9, from: "原文里的错写", to: "还原后的写法" }],
};

const linkLine = (link: RetroSnapshotCase["rounds"][number]["links"][number]) => ({
  库: RETRO_LINK_KIND_LABELS[link.kind],
  标题: link.deleted ? `${link.title}（原作品已删除）` : link.title,
  品牌或客户: link.brand,
  标签: link.tags,
  摘要: link.summary,
});

export function buildRetroExtractMessages(item: RetroSnapshotCase): RetroLlmMessages {
  const roundTitle = new Map(item.rounds.map((round) => [round.id, round.title]));
  const reviewLines: Array<Record<string, unknown>> = caseSegmentIndex(item).map((ref) => ({
    id: ref.n,
    段: ref.partNo,
    t: transcriptClock(ref.segment.startMs),
    speaker: `${ref.partNo}:${ref.segment.speakerId}`,
    text: ref.segment.text,
  }));
  const omittedReview = item.recordings.reduce((sum, recording) => sum + (recording.omittedSegments ?? 0), 0);
  if (omittedReview > 0) {
    reviewLines.push({ id: null, text: `（以下省略 ${omittedReview} 句：点评录音每个案例合计只取前 ${RETRO_LIMITS.reviewTranscriptCharsPerCase / 10000} 万字）` });
  }
  const payload = {
    任务: "提炼这一个案例，严格按「输出格式」输出 JSON。",
    案例: {
      部门: item.department,
      客户: item.clientName,
      标题: item.title,
      客户服务场景: item.sceneTags,
      任务与最初需求: item.background || "（没有填写）",
      回合: item.rounds.map((round) => ({
        id: round.id,
        标题: round.title,
        ...(round.occurredOn ? { 时间: round.occurredOn } : {}),
        ...(round.deliveryText ? { 我们交了什么: round.deliveryText } : {}),
        ...(round.feedbackText ? { 客户怎么反馈: round.feedbackText } : {}),
        ...(round.responseText ? { 我们怎么应对: round.responseText } : {}),
        ...(round.links.length ? { 关联作品: round.links.map(linkLine) } : {}),
      })),
      结果: item.outcome || "（没有填写）",
      关键转折: item.turningPoints || "（没有填写）",
      希望讨论的问题: item.discussionQuestions || "（没有填写）",
    },
    客户录音: item.clientAudio.map((audio) => ({
      附件id: audio.assetId,
      挂在: audio.roundId ? `回合「${roundTitle.get(audio.roundId) ?? audio.roundId}」` : "任务与最初需求（需求凭证）",
      文件名: audio.fileName,
      说明: "客户录音只用来理解客户原话，可以作为「经过」「关键争议」的出处，不能作为方法候选等其它内容的依据。",
      文字稿: [
        ...audio.segments.map((segment) => ({ ref: `c${audio.assetId}:${segment.id}`, t: transcriptClock(segment.startMs), speaker: segment.speakerId, text: segment.text })),
        ...(audio.omittedSegments > 0 ? [{ ref: null, text: `（以下省略 ${audio.omittedSegments} 句：客户录音每个案例合计只取前 3 万字）` }] : []),
      ],
    })),
    点评录音文字稿: reviewLines,
    输出格式: EXTRACT_OUTPUT_FORMAT,
  };
  return { system: RETRO_EXTRACT_SYSTEM_PROMPT, user: JSON.stringify(payload, null, 1) };
}

// ---------------------------------------------------------------------------
// ② 汇总纪要、③ 汇总方法：共用的输入组织
// ---------------------------------------------------------------------------

const SYNTH_REF_RULE = `【引用的写法】
- 案例里的点评录音片段写成 "<案例序号>:<片段号>"，例如 "2:12"；只能用「各案提炼结果」里已经列出的片段（quotes 里有的）。
- 整场总结的片段写成 "S<片段号>"，例如 "S4"。
- 客户录音不能作为这一步任何内容的依据。
- 引用了不存在或没列出的片段会被系统剔除；剔除后一句不剩的条目整条丢弃。`;

function summaryLines(snapshot: RetroGenerateSnapshot) {
  const lines: Array<Record<string, unknown>> = recordingSegmentIndex(snapshot.summaryRecordings).map((ref) => ({
    id: `S${ref.n}`,
    段: ref.partNo,
    t: transcriptClock(ref.segment.startMs),
    speaker: `${ref.partNo}:${ref.segment.speakerId}`,
    text: ref.segment.text,
  }));
  const omitted = snapshot.summaryRecordings.reduce((sum, recording) => sum + (recording.omittedSegments ?? 0), 0);
  if (omitted > 0) lines.push({ id: null, text: `（以下省略 ${omitted} 句：整场总结合计只取前 ${RETRO_LIMITS.summaryTranscriptChars / 10000} 万字）` });
  return lines;
}

/** 把①的出处换成 "<案例序号>:<片段号>"。 */
function refKeysFor(ctx: RetroSynthesisContext, caseId: string, sources: RetroExtractionOutput["insights"][number]["sources"]) {
  const item = ctx.snapshot.cases.find((entry) => entry.caseId === caseId);
  if (!item) return [];
  const index = caseSegmentIndex(item);
  const keys: string[] = [];
  for (const source of sources) {
    if (source.kind !== "REVIEW") continue;
    for (const id of source.segmentIds) {
      const ref = index.find((entry) => entry.recordingId === source.recordingId && entry.segment.id === id);
      if (ref) keys.push(`${item.number}:${ref.n}`);
    }
  }
  return keys;
}

function quotesFor(ctx: RetroSynthesisContext) {
  const index = buildSynthesisRefIndex(ctx);
  const quotes: Record<string, { speaker: string; text: string }> = {};
  for (const citation of index.cases.values()) {
    const labels = ctx.extractions[citation.caseId]?.speakers[citation.ref.recordingId]?.labels ?? {};
    quotes[citation.key] = { speaker: labels[citation.ref.segment.speakerId] ?? citation.ref.segment.speakerId, text: citation.ref.segment.text };
  }
  return quotes;
}

function caseDigest(ctx: RetroSynthesisContext) {
  return [...ctx.snapshot.cases]
    .sort((a, b) => a.number - b.number)
    .filter((item) => ctx.extractions[item.caseId])
    .map((item) => {
      const extraction = ctx.extractions[item.caseId];
      const items = (list: RetroExtractionOutput["insights"]) => list.map((entry) => ({ text: entry.text, segments: refKeysFor(ctx, item.caseId, entry.sources) }));
      return {
        案例序号: item.number,
        部门: item.department,
        客户: item.clientName,
        标题: item.title,
        经过: extraction.review.process,
        关键争议: items(extraction.review.disputes),
        老孙指出的问题: items(extraction.review.founderPoints),
        改进建议: items(extraction.review.suggestions),
        核心认识线索: items(extraction.insights),
        改进事项线索: items(extraction.actions),
      };
    });
}

// ---------------------------------------------------------------------------
// ② 汇总纪要
// ---------------------------------------------------------------------------

export const RETRO_MINUTES_SYSTEM_PROMPT = `你是博加「客户需求复盘库」的整理助手，现在做第二步：汇总本月的教学纪要。

${SCENE}

${HARD_RULES}

【这一步要做的】
你会拿到本月各案例第一步的提炼结果（每条都带引用的片段和原话）以及老孙整场总结的文字稿。案例回顾（经过、争议、老孙指出的问题、改进建议）系统会直接取第一步的结果，你不用重写。你只需要输出：
- summarySpeakers：整场总结文字稿里谁是老孙。写法同第一步：founder 是数组，每段录音写一个「段号:标签」（标签只在同一段录音里有意义）；其他「段号:标签」的称呼写进 labels。整场总结绝大部分是老孙在说。
- insights：本次培训的核心认识。跨案例归纳：几个案例背后是同一个判断的，合成一条，引用取并集；只在一个案例里出现但有分量的，照样单列。不按案例凑数，不按出现次数排序，可以很少。
- actions：可以进入实际工作的改进事项，每条写清在什么时候、由谁、做什么；整场总结里老孙布置的事项优先。说不清这三样的不要写。

${SYNTH_REF_RULE}

【输出】${OUTPUT_RULE}`;

const MINUTES_OUTPUT_FORMAT = {
  summarySpeakers: { founder: ["1:S0"], labels: { "1:S1": "其他同事" } },
  insights: [{ text: "跨案例归纳的核心认识", segments: ["1:12", "3:5", "S4"] }],
  actions: [{ text: "从何时起，由谁，做什么", segments: ["S7", "2:30"] }],
};

export function buildRetroMinutesMessages(ctx: RetroSynthesisContext): RetroLlmMessages {
  const payload = {
    任务: "汇总本月的核心认识和改进事项，严格按「输出格式」输出 JSON。",
    月份: ctx.snapshot.monthKey,
    各案提炼结果: caseDigest(ctx),
    quotes: quotesFor(ctx),
    整场总结文字稿: summaryLines(ctx.snapshot),
    输出格式: MINUTES_OUTPUT_FORMAT,
  };
  return { system: RETRO_MINUTES_SYSTEM_PROMPT, user: JSON.stringify(payload, null, 1) };
}

// ---------------------------------------------------------------------------
// ③ 汇总方法
// ---------------------------------------------------------------------------

export const RETRO_METHODS_SYSTEM_PROMPT = `你是博加「客户需求复盘库」的整理助手，现在做第三步：汇总本月的方法提取记录。

${SCENE}

${HARD_RULES}

${GUIDE_BLOCK}

【这一步要做的】
你会拿到本月各案例第一步提出的方法候选（每条带维度、类别、迁移性和引用的片段原话）以及老孙整场总结的文字稿。输出：
- candidates：本月的方法候选。不同案例里的同一思路可以合成一条，segments 取并集；但不同情境下做法不同的，要分开列，或者写进 observations，不能强行合并。整场总结里老孙说出的方法也可以补成候选（必须引用他的原话）。维度、类别、迁移性按释义判断，可以修正第一步的标注。不按出现次数排序，不打分。
- observations：本月值得注意的现象：同一思路在不同情境下的差异、看似矛盾的判断等。没有就给空数组。

${SYNTH_REF_RULE}
- 方法候选的 segments 里至少要有一句是老孙说的，否则整条丢弃。
- roundIds 只能用第一步候选里给出的回合 id，且必须属于所引用的案例。

【输出】${OUTPUT_RULE}`;

const METHODS_OUTPUT_FORMAT = {
  candidates: [
    {
      dimension: "ENTRY | INFO | PATH | VALUE | SOLUTION | INTERACTION",
      kind: "METHOD | INTUITION | SITUATIONAL",
      title: "不超过 40 字",
      description: "老孙怎么做、为什么（只写录音里有的）",
      situation: "SITUATIONAL 必填，其它留空",
      transfer: "TRANSFERABLE | CASE_ONLY | UNSURE",
      transferNote: "迁移性的理由",
      segments: ["1:20", "3:8", "S5"],
      roundIds: ["<回合id>"],
    },
  ],
  observations: [{ text: "同一思路在不同情境下的差异", segments: ["2:30", "5:11"] }],
};

export function buildRetroMethodsMessages(ctx: RetroSynthesisContext, summarySpeakers: RetroSpeakers | null): RetroLlmMessages {
  const candidates = [...ctx.snapshot.cases]
    .sort((a, b) => a.number - b.number)
    .flatMap((item) => (ctx.extractions[item.caseId]?.methods ?? []).map((method) => ({ item, method })))
    .map(({ item, method }, position) => ({
      id: `m${position + 1}`,
      案例序号: item.number,
      dimension: method.dimension,
      kind: method.kind,
      title: method.title,
      description: method.description,
      situation: method.situation,
      transfer: method.transfer,
      transferNote: method.transferNote,
      segments: refKeysFor(ctx, item.caseId, method.sources),
      roundIds: method.sources.flatMap((source) => (source.kind === "REVIEW" ? source.roundIds ?? [] : [])),
    }));
  const payload = {
    任务: "汇总本月的方法候选和本月观察，严格按「输出格式」输出 JSON。",
    月份: ctx.snapshot.monthKey,
    第一步的方法候选: candidates,
    quotes: quotesFor(ctx),
    整场总结文字稿: summaryLines(ctx.snapshot),
    整场总结里的老孙: ctx.snapshot.summaryRecordings
      .map((recording) => (summarySpeakers?.[recording.recordingId]?.founder ? `${recording.partNo}:${summarySpeakers[recording.recordingId].founder}` : null))
      .filter(Boolean),
    输出格式: METHODS_OUTPUT_FORMAT,
  };
  return { system: RETRO_METHODS_SYSTEM_PROMPT, user: JSON.stringify(payload, null, 1) };
}

export function hashRetroMessages(model: string, promptVersion: string, messages: RetroLlmMessages) {
  return sha256(stableStringify({ model, promptVersion, system: messages.system, user: messages.user }));
}
