// 月度整理的本地假实现（docs/26 十一）：RETRO_AI_PROVIDER=fake 或本机演示模式下用，供本机预览和验收。
// 不碰网络、不产生费用。三步都按快照里真实存在的片段号、回合号确定性地拼出一份原始输出
// （与真模型同一形状），再交给 extraction.ts / synthesis.ts 走同一套校验。产出覆盖：
// 三类候选、跨案例合并（同名候选在③合成一条）、observations、客户录音出处（经过、争议），
// 以及会被校验丢弃的内容（不存在的片段和回合、客户录音放错位置、没有老孙原话的候选、
// 没写情境的情境判断、非法维度、①没引用过的片段）。每次调用等 1.5 秒，整个流程本机十几秒走完。

import { dominantSpeaker } from "@/lib/audio-review/transcript";
import type { LlmOutcome } from "@/lib/audio-review/deepseek";
import type { RetroMethodCandidate, RetroSource } from "@/lib/retro-model";
import { caseSegmentIndex, recordingSegmentIndex, type RetroSnapshotCase } from "./month-snapshot";
import type { RetroLlmProvider, RetroStepContext } from "./month-providers";
import { buildSynthesisRefIndex, type RetroSynthesisContext } from "./synthesis";

export const FAKE_RETRO_LLM_MODEL = "fake-deepseek";
export const FAKE_RETRO_LLM_DELAY_MS = 1_500;

const clip = (text: string, max: number) => {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
};

function founderOf(speakers: string[], segments: Parameters<typeof dominantSpeaker>[0]) {
  return speakers.includes("S0") ? "S0" : dominantSpeaker(segments);
}

export function buildFakeRetroExtraction(item: RetroSnapshotCase) {
  const index = caseSegmentIndex(item);
  const speakers = [...new Set(index.map((ref) => ref.segment.speakerId))];
  const founder = founderOf(speakers, index.map((ref) => ref.segment));
  const founderRefs = index.filter((ref) => ref.segment.speakerId === founder);
  const otherRefs = index.filter((ref) => ref.segment.speakerId !== founder);
  const f = (i: number) => founderRefs[Math.min(i, founderRefs.length - 1)];
  const first = f(0);
  const second = f(1);
  const last = f(founderRefs.length - 1);
  const r1 = item.rounds[0]?.id;
  const r2 = item.rounds[1]?.id ?? r1;
  const firstClient = item.clientAudio.find((audio) => audio.segments.length);
  const clientRef = firstClient ? `c${firstClient.assetId}:${firstClient.segments[0].id}` : null;
  const labels = Object.fromEntries(speakers.filter((speaker) => speaker !== founder).map((speaker, i) => [speaker, i === 0 ? "汇报人" : "其他同事"]));
  const path = item.rounds.map((round) => round.title).join(" → ");

  return {
    speakers: { founder, labels },
    review: {
      process: `${item.clientName}「${item.title}」：${item.background ? `${clip(item.background, 60)}；` : ""}${path ? `经过 ${path}；` : ""}结果：${item.outcome ? clip(item.outcome, 60) : "仍在进行"}。`,
      processSegmentIds: [...(clientRef ? [clientRef] : []), ...(otherRefs[0] ? [otherRefs[0].n] : [])],
      disputes: otherRefs.length
        ? [{
          text: `问题出在哪：汇报方认为「${clip(otherRefs[0].segment.text, 30)}」；老孙认为「${clip(first.segment.text, 30)}」。`,
          segmentIds: [otherRefs[0].n, first.n, ...(clientRef ? [clientRef] : [])],
        }]
        : [],
      founderPoints: [
        { text: `老孙指出：${clip(first.segment.text, 60)}`, segmentIds: [first.n], roundIds: r1 ? [r1] : [] },
        ...(second !== first ? [{ text: clip(second.segment.text, 60), segmentIds: [second.n], roundIds: r2 ? [r2] : [] }] : []),
        // 会被丢弃：引用了不存在的片段。
        { text: "第三版其实也有问题（模型编造，没有出处）", segmentIds: [9999] },
        // 会被丢弃：客户录音不能作为「老孙指出的问题」的依据。
        ...(clientRef ? [{ text: "客户自己也说过不满意", segmentIds: [clientRef] }] : []),
      ],
      suggestions: [{ text: clip(last.segment.text, 60), segmentIds: [last.n] }],
    },
    insights: [{ text: `客户的修改意见是线索，不是答案：${item.clientName}这个案子背后有一个客户没说出来的生意问题。`, segmentIds: [first.n] }],
    actions: [{ text: "下次提案前一天，由项目负责人在提案页最前面写一句「客户这次真正要解决的问题」。", segmentIds: [last.n] }],
    methods: [
      {
        dimension: "ENTRY", kind: "METHOD", title: "先问客户为什么提这个要求，再动手改",
        description: `客户提出修改时，老孙的第一句是问「为什么」，而不是讨论怎么改：${clip(first.segment.text, 50)}`,
        situation: "", transfer: "TRANSFERABLE", transferNote: "可用于任何客户提出具体修改意见的场合",
        segmentIds: [first.n], roundIds: [...(r1 ? [r1] : []), "rnd_not_exist"],
      },
      {
        dimension: "INFO", kind: "INTUITION", title: `凭经验判断${clip(item.clientName, 12)}的真实顾虑`,
        description: `老孙的判断：${clip(second.segment.text, 60)}。他没有给出更多理由。`,
        situation: "", transfer: "UNSURE", transferNote: "老孙只在这一个案例里这么说过",
        segmentIds: [second.n],
      },
      {
        dimension: "INTERACTION", kind: "SITUATIONAL", title: "对方情绪上来时，先别争方案",
        description: `先让对方把话说完，再把关键问题问清楚：${clip(last.segment.text, 40)}`,
        situation: `${clip(item.clientName, 20)}的对接人当场情绪激动`, transfer: "CASE_ONLY", transferNote: "取决于对方当时的处境",
        segmentIds: [last.n], roundIds: r2 ? [r2] : [],
      },
      // 以下三条会被丢弃：情境判断没写情境、没有老孙原话、维度非法（套黄金圈）。
      { dimension: "INTERACTION", kind: "SITUATIONAL", title: "看场合说话", description: "", situation: "", transfer: "UNSURE", transferNote: "", segmentIds: [first.n] },
      { dimension: "PATH", kind: "METHOD", title: "汇报人自己总结的做法", description: "", situation: "", transfer: "UNSURE", transferNote: "", segmentIds: otherRefs.length ? [otherRefs[0].n] : [9998] },
      { dimension: "GOLDEN_CIRCLE", kind: "METHOD", title: "Why-How-What", description: "", situation: "", transfer: "TRANSFERABLE", transferNote: "", segmentIds: [first.n] },
    ],
    corrections: [],
  };
}

/** ①出处 → "<案例序号>:<片段号>"（只取①引用过的）。 */
function keysOf(ctx: RetroSynthesisContext, sources: readonly RetroSource[]) {
  const index = buildSynthesisRefIndex(ctx);
  const keys: string[] = [];
  for (const source of sources) {
    if (source.kind !== "REVIEW") continue;
    for (const citation of index.cases.values()) {
      if (citation.ref.recordingId === source.recordingId && source.segmentIds.includes(citation.ref.segment.id) && !keys.includes(citation.key)) {
        keys.push(citation.key);
      }
    }
  }
  return keys;
}

function summaryFounderRef(ctx: RetroSynthesisContext, founder: string | null) {
  const index = recordingSegmentIndex(ctx.snapshot.summaryRecordings);
  const ref = index.find((entry) => entry.segment.speakerId === founder) ?? index[0];
  return ref ? `S${ref.n}` : null;
}

export function buildFakeRetroSummary(ctx: RetroSynthesisContext) {
  const summarySegments = recordingSegmentIndex(ctx.snapshot.summaryRecordings).map((ref) => ref.segment);
  const founder = summarySegments.length ? founderOf([...new Set(summarySegments.map((segment) => segment.speakerId))], summarySegments) : null;
  const summaryRef = summaryFounderRef(ctx, founder);
  const cases = [...ctx.snapshot.cases].sort((a, b) => a.number - b.number).filter((item) => ctx.extractions[item.caseId]);
  const firstKeys = cases.flatMap((item) => keysOf(ctx, ctx.extractions[item.caseId].review.founderPoints[0]?.sources ?? []).slice(0, 1));
  const secondKeys = cases.flatMap((item) => keysOf(ctx, ctx.extractions[item.caseId].review.suggestions[0]?.sources ?? []).slice(0, 1));
  return {
    summarySpeakers: founder ? { founder, labels: {} } : {},
    insights: [
      { text: "客户的修改意见是线索，不是答案：几个案子背后，都有一个客户没说出来的生意问题。", segments: [...firstKeys, ...(summaryRef ? [summaryRef] : [])] },
      ...(secondKeys.length ? [{ text: "方案和目标矛盾时，画面越好越危险：先对齐目标，再谈好不好看。", segments: secondKeys }] : []),
    ],
    actions: [
      {
        text: "从下月起，各部门提案前一天，由项目负责人在提案页最前面写一句「客户这次真正要解决的问题」，写不出来不提案。",
        segments: summaryRef ? [summaryRef] : firstKeys.slice(0, 1),
      },
      // 会被丢弃：引用了①没有引用过的片段。
      { text: "每周开一次复盘会（没有出处）", segments: ["99:1"] },
    ],
  };
}

export function buildFakeRetroDistill(ctx: RetroSynthesisContext, summaryFounder: string | null) {
  const groups = new Map<string, { method: RetroMethodCandidate; keys: string[]; roundIds: string[] }>();
  const cases = [...ctx.snapshot.cases].sort((a, b) => a.number - b.number).filter((item) => ctx.extractions[item.caseId]);
  for (const item of cases) {
    for (const method of ctx.extractions[item.caseId].methods) {
      // 同名候选跨案例合并，出处取并集（规格 6.5）；情境判断按案例分开列。
      const groupKey = method.kind === "SITUATIONAL" ? `${method.title}@${item.caseId}` : method.title;
      const group = groups.get(groupKey) ?? { method, keys: [], roundIds: [] };
      for (const key of keysOf(ctx, method.sources)) if (!group.keys.includes(key)) group.keys.push(key);
      for (const source of method.sources) {
        if (source.kind === "REVIEW") for (const id of source.roundIds ?? []) if (!group.roundIds.includes(id)) group.roundIds.push(id);
      }
      groups.set(groupKey, group);
    }
  }
  const candidates: Array<Record<string, unknown>> = [...groups.values()].map(({ method, keys, roundIds }) => ({
    dimension: method.dimension,
    kind: method.kind,
    title: method.title,
    description: method.description,
    situation: method.situation,
    transfer: method.transfer,
    transferNote: method.transferNote,
    segments: keys,
    roundIds,
  }));
  const summaryRef = summaryFounderRef(ctx, summaryFounder);
  if (summaryRef) {
    candidates.push({
      dimension: "PATH", kind: "METHOD", title: "回头看每一版：在回答客户的问题，还是我们以为的问题",
      description: "改了三版以上的项目，逐版回看：这一版回答的是客户真正要解决的问题，还是我们自己以为的问题。",
      situation: "", transfer: "TRANSFERABLE", transferNote: "适用于多轮改稿的项目复盘",
      segments: [summaryRef],
    });
  }
  const situational = candidates.filter((candidate) => candidate.kind === "SITUATIONAL");
  const observations: Array<{ text: string; segments: string[] }> = [];
  if (situational.length >= 2) {
    observations.push({
      text: "几个案例里老孙都建议「先退一步」，但情境不同：分开列为情境判断，没有合并。",
      segments: situational.flatMap((candidate) => (candidate.segments as string[]).slice(0, 1)),
    });
  } else if (candidates[0]) {
    observations.push({ text: "老孙并不一律推翻客户的字面要求，而是先问清楚背后的原因。", segments: (candidates[0].segments as string[]).slice(0, 1) });
  }
  // 会被丢弃：引用了不存在的整场总结片段。
  observations.push({ text: "本月案例普遍偏难（没有出处）", segments: ["S9999"] });
  return { candidates, observations };
}

export function buildFakeRetroOutput(context: RetroStepContext) {
  if (context.step === "EXTRACT") return buildFakeRetroExtraction(context.item);
  if (context.step === "SUMMARIZE") return buildFakeRetroSummary(context.synthesis);
  return buildFakeRetroDistill(context.synthesis, context.summaryFounder);
}

export function createFakeRetroLlm(sleep: (ms: number) => Promise<void>, clock: () => number = Date.now): RetroLlmProvider {
  return {
    kind: "fake",
    model: FAKE_RETRO_LLM_MODEL,
    async complete(_messages, context): Promise<LlmOutcome> {
      const started = clock();
      await sleep(FAKE_RETRO_LLM_DELAY_MS);
      return {
        ok: true,
        content: JSON.stringify(buildFakeRetroOutput(context)),
        finishReason: "stop",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, fake: true },
        model: FAKE_RETRO_LLM_MODEL,
        durationMs: Math.max(0, clock() - started),
      };
    },
  };
}
