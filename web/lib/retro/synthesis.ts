// ② 汇总纪要、③ 汇总方法的校验与归一（docs/26 6.5）。纯函数。
//
// 两步的输入是①的结果加整场总结的文字稿；输出里的引用写成：
// - "<案例序号>:<片段号>"：只能是①里那个案例已经引用过的点评录音片段；
// - "S<片段号>"：整场总结里真实存在的片段（多段总结按段号拼成连续编号）。
// 客户录音不能进入核心认识、改进事项、方法候选和本月观察。方法候选至少要有一句老孙的话。
// 案例回顾（经过、争议、老孙指出的问题、改进建议）直接取自①，模型不重写（assembleRetroMinutes）。

import { dominantSpeaker } from "@/lib/audio-review/transcript";
import {
  RETRO_LIMITS,
  RETRO_METHOD_DIMENSION_LIST,
  type RetroCaseReview,
  type RetroItem,
  type RetroMethodCandidate,
  type RetroMethods,
  type RetroMinutes,
  type RetroSource,
} from "@/lib/retro-model";
import {
  caseRefContext,
  clipText,
  extractionReviewSources,
  FOUNDER_LABEL,
  normalizeCandidateFields,
  reviewSources,
  type RetroExtractionOutput,
  type RetroSpeakers,
} from "./extraction";
import {
  analyzedCases,
  recordingSegmentIndex,
  type RetroGenerateSnapshot,
  type RetroSegmentRef,
} from "./month-snapshot";

export type RetroSynthesisContext = {
  snapshot: RetroGenerateSnapshot;
  /** caseId → ①的结果（只有参与提炼的案例）。 */
  extractions: Record<string, RetroExtractionOutput>;
};

export type RetroSummaryOutput = { insights: RetroItem[]; actions: RetroItem[]; speakers: RetroSpeakers };
export type RetroDistillOutput = { candidates: RetroMethodCandidate[]; observations: RetroItem[] };

type CaseCitation = { key: string; caseId: string; caseNumber: number; ref: RetroSegmentRef; founder: string | null };

export type SynthesisRefIndex = {
  /** "3:12" → 引用信息；只含①里引用过的片段。 */
  cases: Map<string, CaseCitation>;
  /** "S4" → 整场总结片段。 */
  summary: Map<string, RetroSegmentRef>;
  summaryIndex: RetroSegmentRef[];
  /** 回合 id → 所属案例。 */
  roundCase: Map<string, string>;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function buildSynthesisRefIndex(ctx: RetroSynthesisContext): SynthesisRefIndex {
  const cases = new Map<string, CaseCitation>();
  for (const item of analyzedCases(ctx.snapshot)) {
    const extraction = ctx.extractions[item.caseId];
    if (!extraction) continue;
    const refCtx = caseRefContext(item);
    const cited = new Set<string>();
    for (const source of extractionReviewSources(extraction)) {
      if (source.kind !== "REVIEW") continue;
      for (const id of source.segmentIds) cited.add(`${source.recordingId}#${id}`);
    }
    for (const ref of refCtx.index) {
      if (!cited.has(`${ref.recordingId}#${ref.segment.id}`)) continue;
      const key = `${item.number}:${ref.n}`;
      cases.set(key, { key, caseId: item.caseId, caseNumber: item.number, ref, founder: extraction.speakers.founder });
    }
  }
  const summaryIndex = recordingSegmentIndex(ctx.snapshot.summaryRecordings);
  const roundCase = new Map<string, string>();
  for (const item of ctx.snapshot.cases) for (const round of item.rounds) roundCase.set(round.id, item.caseId);
  return { cases, summary: new Map(summaryIndex.map((ref) => [`S${ref.n}`, ref])), summaryIndex, roundCase };
}

export function normalizeSynthesisRef(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  const caseMatch = /^(\d+)\s*[:：]\s*(\d+)$/.exec(text);
  if (caseMatch) return `${Number(caseMatch[1])}:${Number(caseMatch[2])}`;
  const summaryMatch = /^[Ss]\s*[:：]?\s*(\d+)$/.exec(text);
  if (summaryMatch) return `S${Number(summaryMatch[1])}`;
  return null;
}

type ResolvedSynthesisRefs = { cases: CaseCitation[]; summary: RetroSegmentRef[]; invalid: string[] };

export function resolveSynthesisRefs(values: unknown, index: SynthesisRefIndex): ResolvedSynthesisRefs {
  const result: ResolvedSynthesisRefs = { cases: [], summary: [], invalid: [] };
  const seen = new Set<string>();
  for (const value of asArray(values)) {
    const key = normalizeSynthesisRef(value);
    if (!key) {
      result.invalid.push(String(value));
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const citation = index.cases.get(key);
    if (citation) {
      result.cases.push(citation);
      continue;
    }
    const summary = index.summary.get(key);
    if (summary) {
      result.summary.push(summary);
      continue;
    }
    result.invalid.push(key);
  }
  return result;
}

/** 按案例分组建出处；回合号挂在所属案例的第一条出处上。整场总结的出处 caseId 为 null。 */
export function synthesisSources(refs: ResolvedSynthesisRefs, roundsByCase: Map<string, string[]> = new Map()): RetroSource[] {
  const byCase = new Map<string, RetroSegmentRef[]>();
  for (const citation of refs.cases) {
    const list = byCase.get(citation.caseId) ?? [];
    list.push(citation.ref);
    byCase.set(citation.caseId, list);
  }
  const sources: RetroSource[] = [];
  for (const [caseId, list] of byCase) sources.push(...reviewSources(list, caseId, roundsByCase.get(caseId) ?? []));
  sources.push(...reviewSources(refs.summary, null));
  return sources;
}

function normalizeSynthesisItems(raw: unknown, index: SynthesisRefIndex, section: string, idPrefix: string, dropped: string[]): RetroItem[] {
  const items: RetroItem[] = [];
  asArray(raw).forEach((entry, position) => {
    const record = asRecord(entry);
    const label = `${section}[${position}]`;
    const text = clipText(record.text, RETRO_LIMITS.draftTextMax);
    if (!text) {
      dropped.push(`${label}：文字为空`);
      return;
    }
    const refs = resolveSynthesisRefs(record.segments ?? record.segmentIds, index);
    if (refs.invalid.length) dropped.push(`${label}：剔除不存在或①没引用过的片段 ${refs.invalid.join("、")}`);
    const sources = synthesisSources(refs);
    if (!sources.length) {
      dropped.push(`${label}：没有任何有效的录音依据，整条丢弃`);
      return;
    }
    items.push({ id: `${idPrefix}${items.length + 1}`, text, sources, origin: "AI", edited: false });
  });
  return items;
}

function normalizeSummarySpeakers(raw: unknown, index: SynthesisRefIndex, dropped: string[]): RetroSpeakers {
  const segments = index.summaryIndex.map((ref) => ref.segment);
  if (!segments.length) return { founder: null, labels: {} };
  const record = asRecord(raw);
  const present = new Set(segments.map((segment) => segment.speakerId));
  let founder = typeof record.founder === "string" && present.has(record.founder.trim()) ? record.founder.trim() : null;
  if (!founder) {
    // 整场总结是老孙一个人的总结，绝大部分是他在说：没认出来时按说得最多的那位兜底。
    founder = dominantSpeaker(segments);
    dropped.push(`整场总结说话人：模型没有认出老孙（${String(record.founder)}），按说得最多的 ${founder} 兜底`);
  }
  const labels: Record<string, string> = {};
  for (const [speakerId, label] of Object.entries(asRecord(record.labels))) {
    if (!present.has(speakerId) || speakerId === founder) continue;
    const text = clipText(label, 20);
    if (text && text !== FOUNDER_LABEL) labels[speakerId] = text;
  }
  labels[founder] = FOUNDER_LABEL;
  return { founder, labels };
}

/** ② 汇总纪要：核心认识、改进事项，以及整场总结的说话人认定。 */
export function normalizeRetroSummary(raw: Record<string, unknown>, ctx: RetroSynthesisContext): { output: RetroSummaryOutput; dropped: string[] } {
  const index = buildSynthesisRefIndex(ctx);
  const dropped: string[] = [];
  const speakers = normalizeSummarySpeakers(raw.summarySpeakers, index, dropped);
  const insights = normalizeSynthesisItems(raw.insights, index, "insights", "ins-", dropped);
  const actions = normalizeSynthesisItems(raw.actions, index, "actions", "act-", dropped);
  return { output: { insights, actions, speakers }, dropped };
}

/** ③ 汇总方法：方法候选（可跨案例合并、出处取并集）和本月观察。 */
export function normalizeRetroDistill(
  raw: Record<string, unknown>,
  ctx: RetroSynthesisContext,
  summaryFounder: string | null,
): { output: RetroDistillOutput; dropped: string[] } {
  const index = buildSynthesisRefIndex(ctx);
  const dropped: string[] = [];
  const candidates: RetroMethodCandidate[] = [];
  asArray(raw.candidates).forEach((entry, position) => {
    const record = asRecord(entry);
    const label = `candidates[${position}]`;
    const fields = normalizeCandidateFields(record);
    if (!fields.ok) {
      dropped.push(`${label}：${fields.reason}，整条丢弃`);
      return;
    }
    const refs = resolveSynthesisRefs(record.segments ?? record.segmentIds, index);
    if (refs.invalid.length) dropped.push(`${label}：剔除不存在或①没引用过的片段 ${refs.invalid.join("、")}`);
    const hasFounder =
      refs.cases.some((citation) => citation.founder && citation.ref.segment.speakerId === citation.founder) ||
      (summaryFounder != null && refs.summary.some((ref) => ref.segment.speakerId === summaryFounder));
    if (!hasFounder) {
      dropped.push(`${label}：没有引用老孙的原话，整条丢弃（${fields.value.title}）`);
      return;
    }
    const citedCases = new Set(refs.cases.map((citation) => citation.caseId));
    const roundsByCase = new Map<string, string[]>();
    for (const value of asArray(record.roundIds)) {
      const id = typeof value === "string" ? value.trim() : "";
      const caseId = index.roundCase.get(id);
      if (!caseId || !citedCases.has(caseId)) {
        dropped.push(`${label}：剔除不存在或不属于所引案例的回合 ${id || String(value)}`);
        continue;
      }
      const list = roundsByCase.get(caseId) ?? [];
      if (!list.includes(id)) list.push(id);
      roundsByCase.set(caseId, list);
    }
    candidates.push({
      id: `cand-${candidates.length + 1}`,
      number: 0,
      ...fields.value,
      sources: synthesisSources(refs, roundsByCase),
      origin: "AI",
      edited: false,
    });
  });
  const observations = normalizeSynthesisItems(raw.observations, index, "observations", "obs-", dropped);
  return { output: { candidates: orderRetroCandidates(candidates), observations }, dropped };
}

// ---------------------------------------------------------------------------
// 组装草稿
// ---------------------------------------------------------------------------

/** 按维度顺序排列（不按出现次数，规格三-5、10.5），同维度保持原有先后，重新编号 1..N。 */
export function orderRetroCandidates(candidates: readonly RetroMethodCandidate[]): RetroMethodCandidate[] {
  return candidates
    .map((candidate, position) => ({ candidate, position }))
    .sort((a, b) =>
      RETRO_METHOD_DIMENSION_LIST.indexOf(a.candidate.dimension) - RETRO_METHOD_DIMENSION_LIST.indexOf(b.candidate.dimension) ||
      a.position - b.position)
    .map(({ candidate }, position) => ({ ...candidate, number: position + 1 }));
}

/** 教学纪要：案例回顾直接取自①（按冻结序号），核心认识与改进事项取自②。 */
export function assembleRetroMinutes(ctx: RetroSynthesisContext, summary: Pick<RetroSummaryOutput, "insights" | "actions">): RetroMinutes {
  const cases: RetroCaseReview[] = [];
  const unanalyzedCaseIds: string[] = [];
  for (const item of [...ctx.snapshot.cases].sort((a, b) => a.number - b.number)) {
    const extraction = ctx.extractions[item.caseId];
    if (!extraction) {
      unanalyzedCaseIds.push(item.caseId);
      continue;
    }
    cases.push({
      caseId: item.caseId,
      process: extraction.review.process,
      processSources: extraction.review.processSources,
      disputes: extraction.review.disputes,
      founderPoints: extraction.review.founderPoints,
      suggestions: extraction.review.suggestions,
      empty: extraction.empty,
    });
  }
  return { cases, unanalyzedCaseIds, insights: summary.insights, actions: summary.actions };
}

export function emptyRetroMethods(): RetroMethods {
  return { candidates: [], observations: [] };
}
