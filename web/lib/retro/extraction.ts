// ① 逐案提炼的校验与归一（docs/26 6.4）。纯函数：输入模型返回的原始 JSON 和这个案例的快照，
// 输出能直接进草稿的结构，以及被丢弃的原因（只用于排查，不展示）。
//
// 规则：
// - 点评录音片段用案例内连续编号（1..N，多段录音按段号拼接）；客户录音片段写成 c<assetId>:<segmentId>；
// - 不存在的片段号、回合号剔除；
// - 客户录音引用只能出现在 review.process 和 review.disputes 里，出现在其它地方一律剔除；
// - founderPoints / suggestions / insights / actions / disputes 剔除无效引用后一句不剩就丢弃；
// - 方法候选的 segmentIds 里至少有一句是老孙说的（按录音认定，见 RetroRecordingSpeakers），否则整条丢弃；
// - 枚举值非法、标题为空、SITUATIONAL 没写情境，都丢弃；
// - 文字去首尾空白，标题 40 字、其他 600 字截断；
// - 引文永远由服务端按片段号从转写里取，模型写的引文一律不用。

import {
  RETRO_LIMITS,
  RETRO_METHOD_DIMENSION_LIST,
  RETRO_METHOD_KIND_LIST,
  RETRO_METHOD_TRANSFER_LIST,
  type RetroItem,
  type RetroMethodCandidate,
  type RetroMethodDimension,
  type RetroMethodKind,
  type RetroMethodTransfer,
  type RetroSource,
} from "@/lib/retro-model";
import { dominantSpeaker } from "@/lib/audio-review/transcript";
import { caseSegmentIndex, type RetroSegmentRef, type RetroSnapshotCase } from "./month-snapshot";

/**
 * 一段录音的说话人认定。说话人分离的标签（S0、S1…）只在一段录音内有意义：换了设备、断过重录，
 * 第 2 段里的 S0 未必还是老孙，所以认定按录音分别做（审查意见 4）。
 */
export type RetroRecordingSpeakers = {
  /** 这段录音里老孙对应的标签；没认出来为 null（这段录音的话不能作为方法候选的依据）。 */
  founder: string | null;
  /** 完整称呼表：{ S0: "老孙", S1: "汇报人" }。发布时写进这段录音的 speaker_labels_json。 */
  labels: Record<string, string>;
};

/** 录音 id → 这段录音的说话人认定。 */
export type RetroSpeakers = Record<string, RetroRecordingSpeakers>;

export function isFounderSegment(speakers: RetroSpeakers | null | undefined, recordingId: string, speakerId: string): boolean {
  const founder = speakers?.[recordingId]?.founder;
  return Boolean(founder) && founder === speakerId;
}

export type RetroCorrection = { recordingId: string; segmentId: number; from: string; to: string };

export type RetroExtractionOutput = {
  speakers: RetroSpeakers;
  review: {
    process: string;
    processSources: RetroSource[];
    disputes: RetroItem[];
    founderPoints: RetroItem[];
    suggestions: RetroItem[];
  };
  insights: RetroItem[];
  actions: RetroItem[];
  /** number 在汇总时重排，这里是 0。 */
  methods: RetroMethodCandidate[];
  corrections: RetroCorrection[];
  /** 全部被丢光：纪要里写「这个案例没有提炼出有依据的内容」。 */
  empty: boolean;
};

export type RetroExtractionResult = { output: RetroExtractionOutput; dropped: string[] };

export const FOUNDER_LABEL = "老孙";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function clipText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const chars = [...value.trim()];
  return chars.length > max ? chars.slice(0, max).join("").trim() : chars.join("");
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

const preview = (text: string) => (text.length > 24 ? `${text.slice(0, 24)}…` : text);

type ClientSegmentRef = { assetId: string; roundId: string | null; segmentId: number };

export type ResolvedRefs = { review: RetroSegmentRef[]; client: ClientSegmentRef[]; invalid: string[]; disallowedClient: string[] };

export type CaseRefContext = {
  item: RetroSnapshotCase;
  index: RetroSegmentRef[];
  byNumber: Map<number, RetroSegmentRef>;
  clientSegments: Map<string, { roundId: string | null; ids: Set<number> }>;
  roundIds: Set<string>;
};

export function caseRefContext(item: RetroSnapshotCase): CaseRefContext {
  const index = caseSegmentIndex(item);
  return {
    item,
    index,
    byNumber: new Map(index.map((ref) => [ref.n, ref])),
    clientSegments: new Map(item.clientAudio.map((audio) => [audio.assetId, { roundId: audio.roundId, ids: new Set(audio.segments.map((segment) => segment.id)) }])),
    roundIds: new Set(item.rounds.map((round) => round.id)),
  };
}

const CLIENT_REF = /^c(.+):(\d+)$/;

/** 解析一组片段引用：数字（或数字字符串）是点评录音片段；c<assetId>:<id> 是客户录音片段。 */
export function resolveCaseRefs(values: unknown, ctx: CaseRefContext, allowClient: boolean): ResolvedRefs {
  const result: ResolvedRefs = { review: [], client: [], invalid: [], disallowedClient: [] };
  const seenReview = new Set<number>();
  const seenClient = new Set<string>();
  for (const value of asArray(values)) {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (/^\d+$/.test(text)) {
      const ref = ctx.byNumber.get(Number(text));
      if (!ref) result.invalid.push(text);
      else if (!seenReview.has(ref.n)) {
        seenReview.add(ref.n);
        result.review.push(ref);
      }
      continue;
    }
    const match = CLIENT_REF.exec(text);
    if (match) {
      const audio = ctx.clientSegments.get(match[1]);
      const segmentId = Number(match[2]);
      if (!audio || !audio.ids.has(segmentId)) {
        result.invalid.push(text);
      } else if (!allowClient) {
        result.disallowedClient.push(text);
      } else if (!seenClient.has(text)) {
        seenClient.add(text);
        result.client.push({ assetId: match[1], roundId: audio.roundId, segmentId });
      }
      continue;
    }
    result.invalid.push(text || String(value));
  }
  return result;
}

export function resolveRoundIds(values: unknown, valid: ReadonlySet<string>): { kept: string[]; invalid: string[] } {
  const kept: string[] = [];
  const invalid: string[] = [];
  for (const value of asArray(values)) {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && valid.has(id)) {
      if (!kept.includes(id)) kept.push(id);
    } else {
      invalid.push(id || String(value));
    }
  }
  return { kept, invalid };
}

/** 点评录音片段按录音分组成出处；回合号挂在第一条出处上（避免「第二版」标记重复出现）。 */
export function reviewSources(refs: readonly RetroSegmentRef[], caseId: string | null, roundIds: readonly string[] = []): RetroSource[] {
  const byRecording = new Map<string, number[]>();
  for (const ref of [...refs].sort((a, b) => a.n - b.n)) {
    const ids = byRecording.get(ref.recordingId) ?? [];
    if (!ids.includes(ref.segment.id)) ids.push(ref.segment.id);
    byRecording.set(ref.recordingId, ids);
  }
  const sources: RetroSource[] = [];
  for (const [recordingId, segmentIds] of byRecording) {
    const source: RetroSource = { kind: "REVIEW", recordingId, segmentIds: [...segmentIds].sort((a, b) => a - b), caseId };
    if (sources.length === 0 && roundIds.length) source.roundIds = [...roundIds];
    sources.push(source);
  }
  return sources;
}

export function clientSources(refs: readonly ClientSegmentRef[], caseId: string): RetroSource[] {
  const byAsset = new Map<string, { roundId: string | null; ids: number[] }>();
  for (const ref of refs) {
    const entry = byAsset.get(ref.assetId) ?? { roundId: ref.roundId, ids: [] };
    if (!entry.ids.includes(ref.segmentId)) entry.ids.push(ref.segmentId);
    byAsset.set(ref.assetId, entry);
  }
  return [...byAsset].map(([assetId, entry]) => ({
    kind: "CLIENT" as const,
    assetId,
    segmentIds: [...entry.ids].sort((a, b) => a - b),
    caseId,
    roundId: entry.roundId,
  }));
}

export function isDimension(value: unknown): value is RetroMethodDimension {
  return isOneOf(RETRO_METHOD_DIMENSION_LIST, value);
}
export function isKind(value: unknown): value is RetroMethodKind {
  return isOneOf(RETRO_METHOD_KIND_LIST, value);
}
export function isTransfer(value: unknown): value is RetroMethodTransfer {
  return isOneOf(RETRO_METHOD_TRANSFER_LIST, value);
}

/**
 * 方法候选的公共字段校验（①③共用）：枚举、标题、情境、长度。不合格返回丢弃原因。
 */
export function normalizeCandidateFields(raw: Record<string, unknown>):
  | { ok: true; value: Pick<RetroMethodCandidate, "dimension" | "kind" | "title" | "description" | "situation" | "transfer" | "transferNote"> }
  | { ok: false; reason: string } {
  const title = clipText(raw.title, RETRO_LIMITS.draftTitleMax);
  if (!title) return { ok: false, reason: "标题为空" };
  if (!isDimension(raw.dimension)) return { ok: false, reason: `维度不合法（${String(raw.dimension)}）` };
  if (!isKind(raw.kind)) return { ok: false, reason: `类别不合法（${String(raw.kind)}）` };
  if (!isTransfer(raw.transfer)) return { ok: false, reason: `迁移性不合法（${String(raw.transfer)}）` };
  const situation = clipText(raw.situation, RETRO_LIMITS.draftTextMax);
  if (raw.kind === "SITUATIONAL" && !situation) return { ok: false, reason: "情境判断没有写情境" };
  return {
    ok: true,
    value: {
      dimension: raw.dimension,
      kind: raw.kind,
      title,
      description: clipText(raw.description, RETRO_LIMITS.draftTextMax),
      // 只有情境判断才带情境；其它类别模型写了也不保留，避免界面误显示。
      situation: raw.kind === "SITUATIONAL" ? situation : "",
      transfer: raw.transfer,
      transferNote: clipText(raw.transferNote, RETRO_LIMITS.draftTextMax),
    },
  };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

type SpeakerRecording = { recordingId: string; partNo: number; segments: ReadonlyArray<{ speakerId: string; text: string }> };

/** "2:S1" → { partNo: 2, speakerId: "S1" }；只有一段录音时也认裸的 "S1"。 */
function parseSpeakerKey(value: unknown, singlePart: number | null): { partNo: number; speakerId: string } | null {
  const text = typeof value === "string" ? value.trim() : "";
  const keyed = /^(\d+)\s*[:：]\s*(S\d+)$/i.exec(text);
  if (keyed) return { partNo: Number(keyed[1]), speakerId: keyed[2].toUpperCase() };
  const bare = /^(S\d+)$/i.exec(text);
  return bare && singlePart != null ? { partNo: singlePart, speakerId: bare[1].toUpperCase() } : null;
}

/**
 * 按录音归一说话人认定。模型输出 `{ founder: ["1:S0", "2:S1"], labels: { "1:S1": "汇报人" } }`：
 * 键是「段号:标签」。某段录音没认出老孙时记进 dropped；fallbackDominant 时按这段里说得最多的人兜底（整场总结用）。
 */
export function normalizeRecordingSpeakers(
  raw: unknown,
  recordings: readonly SpeakerRecording[],
  dropped: string[],
  options: { label: string; fallbackDominant: boolean },
): RetroSpeakers {
  const record = asRecord(raw);
  const singlePart = recordings.length === 1 ? recordings[0].partNo : null;
  const byPart = new Map(recordings.map((recording) => [recording.partNo, recording]));
  const founders = new Map<number, string>();
  for (const value of Array.isArray(record.founder) ? record.founder : [record.founder]) {
    const key = parseSpeakerKey(value, singlePart);
    if (key && byPart.has(key.partNo) && !founders.has(key.partNo)) founders.set(key.partNo, key.speakerId);
  }
  const result: RetroSpeakers = {};
  for (const recording of recordings) {
    const present = new Set(recording.segments.map((segment) => segment.speakerId));
    let founder = founders.get(recording.partNo) ?? null;
    if (founder && !present.has(founder)) founder = null;
    if (!founder && options.fallbackDominant && recording.segments.length) {
      founder = dominantSpeaker(recording.segments as Parameters<typeof dominantSpeaker>[0]);
      dropped.push(`${options.label}第 ${recording.partNo} 段：模型没有认出老孙，按说得最多的 ${founder} 兜底`);
    } else if (!founder) {
      dropped.push(`${options.label}第 ${recording.partNo} 段：没有认出老孙（founder=${JSON.stringify(record.founder ?? null)}），这段录音的话不能作为方法候选的依据`);
    }
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(asRecord(record.labels))) {
      const parsed = parseSpeakerKey(key, singlePart);
      if (!parsed || parsed.partNo !== recording.partNo || !present.has(parsed.speakerId) || parsed.speakerId === founder) continue;
      const text = clipText(label, 20);
      if (text && text !== FOUNDER_LABEL) labels[parsed.speakerId] = text;
    }
    if (founder) labels[founder] = FOUNDER_LABEL;
    result[recording.recordingId] = { founder, labels };
  }
  return result;
}

type ItemRule = { section: string; idPrefix: string; allowClient: boolean };

function normalizeItems(raw: unknown, ctx: CaseRefContext, rule: ItemRule, dropped: string[]): RetroItem[] {
  const items: RetroItem[] = [];
  asArray(raw).forEach((entry, index) => {
    const record = asRecord(entry);
    const text = clipText(record.text, RETRO_LIMITS.draftTextMax);
    const label = `${rule.section}[${index}]`;
    if (!text) {
      dropped.push(`${label}：文字为空`);
      return;
    }
    const refs = resolveCaseRefs(record.segmentIds, ctx, rule.allowClient);
    if (refs.invalid.length) dropped.push(`${label}：剔除不存在的片段 ${refs.invalid.join("、")}`);
    if (refs.disallowedClient.length) dropped.push(`${label}：客户录音不能作为这一项的依据，剔除 ${refs.disallowedClient.join("、")}`);
    const rounds = resolveRoundIds(record.roundIds, ctx.roundIds);
    if (rounds.invalid.length) dropped.push(`${label}：剔除不存在的回合 ${rounds.invalid.join("、")}`);
    const sources = [
      ...reviewSources(refs.review, ctx.item.caseId, rounds.kept),
      ...clientSources(refs.client, ctx.item.caseId),
    ];
    if (!sources.length) {
      dropped.push(`${label}：没有任何有效的录音依据，整条丢弃（${preview(text)}）`);
      return;
    }
    items.push({ id: `${ctx.item.caseId}.${rule.idPrefix}${items.length + 1}`, text, sources, origin: "AI", edited: false });
  });
  return items;
}

function normalizeMethods(raw: unknown, ctx: CaseRefContext, speakers: RetroSpeakers, dropped: string[]): RetroMethodCandidate[] {
  const methods: RetroMethodCandidate[] = [];
  asArray(raw).forEach((entry, index) => {
    const record = asRecord(entry);
    const label = `methods[${index}]`;
    const fields = normalizeCandidateFields(record);
    if (!fields.ok) {
      dropped.push(`${label}：${fields.reason}，整条丢弃`);
      return;
    }
    const refs = resolveCaseRefs(record.segmentIds, ctx, false);
    if (refs.invalid.length) dropped.push(`${label}：剔除不存在的片段 ${refs.invalid.join("、")}`);
    if (refs.disallowedClient.length) dropped.push(`${label}：客户录音不能作为方法候选的依据，剔除 ${refs.disallowedClient.join("、")}`);
    // 按 (录音, 说话人) 判断：第 2 段的 S0 不一定是第 1 段的 S0。
    if (!refs.review.some((ref) => isFounderSegment(speakers, ref.recordingId, ref.segment.speakerId))) {
      dropped.push(`${label}：没有引用老孙的原话，整条丢弃（${fields.value.title}）`);
      return;
    }
    const rounds = resolveRoundIds(record.roundIds, ctx.roundIds);
    if (rounds.invalid.length) dropped.push(`${label}：剔除不存在的回合 ${rounds.invalid.join("、")}`);
    methods.push({
      id: `${ctx.item.caseId}.m${methods.length + 1}`,
      number: 0,
      ...fields.value,
      sources: reviewSources(refs.review, ctx.item.caseId, rounds.kept),
      origin: "AI",
      edited: false,
    });
  });
  return methods;
}

function normalizeCorrections(raw: unknown, ctx: CaseRefContext, dropped: string[]): RetroCorrection[] {
  const corrections: RetroCorrection[] = [];
  asArray(raw).forEach((entry, index) => {
    const record = asRecord(entry);
    const ref = ctx.byNumber.get(Number(record.segmentId));
    const from = typeof record.from === "string" ? record.from.trim() : "";
    const to = clipText(record.to, 40);
    if (!ref || !from || !to || !ref.segment.text.includes(from) || from === to) {
      dropped.push(`corrections[${index}]：片段不存在或原文对不上，丢弃`);
      return;
    }
    corrections.push({ recordingId: ref.recordingId, segmentId: ref.segment.id, from, to });
  });
  return corrections;
}

export function normalizeRetroExtraction(raw: Record<string, unknown>, item: RetroSnapshotCase): RetroExtractionResult {
  const ctx = caseRefContext(item);
  const dropped: string[] = [];
  const speakers = normalizeRecordingSpeakers(raw.speakers, item.recordings, dropped, { label: "点评录音", fallbackDominant: false });
  const review = asRecord(raw.review);

  const process = clipText(review.process, RETRO_LIMITS.draftTextMax);
  const processRefs = resolveCaseRefs(review.processSegmentIds, ctx, true);
  if (processRefs.invalid.length) dropped.push(`review.process：剔除不存在的片段 ${processRefs.invalid.join("、")}`);
  const processSources = [...reviewSources(processRefs.review, item.caseId), ...clientSources(processRefs.client, item.caseId)];

  const disputes = normalizeItems(review.disputes, ctx, { section: "review.disputes", idPrefix: "d", allowClient: true }, dropped);
  const founderPoints = normalizeItems(review.founderPoints, ctx, { section: "review.founderPoints", idPrefix: "f", allowClient: false }, dropped);
  const suggestions = normalizeItems(review.suggestions, ctx, { section: "review.suggestions", idPrefix: "s", allowClient: false }, dropped);
  const insights = normalizeItems(raw.insights, ctx, { section: "insights", idPrefix: "i", allowClient: false }, dropped);
  const actions = normalizeItems(raw.actions, ctx, { section: "actions", idPrefix: "a", allowClient: false }, dropped);
  const methods = normalizeMethods(raw.methods, ctx, speakers, dropped);
  const corrections = normalizeCorrections(raw.corrections, ctx, dropped);

  const empty = !disputes.length && !founderPoints.length && !suggestions.length && !insights.length && !actions.length && !methods.length;
  return {
    output: {
      speakers,
      review: { process, processSources, disputes, founderPoints, suggestions },
      insights,
      actions,
      methods,
      corrections,
      empty,
    },
    dropped,
  };
}

/** 一个案例的提炼结果里所有点评录音出处（②③ 只能引用这些片段）。 */
export function extractionReviewSources(output: RetroExtractionOutput): RetroSource[] {
  const lists: RetroItem[][] = [output.review.disputes, output.review.founderPoints, output.review.suggestions, output.insights, output.actions];
  const sources: RetroSource[] = [...output.review.processSources];
  for (const list of lists) for (const item of list) sources.push(...item.sources);
  for (const method of output.methods) sources.push(...method.sources);
  return sources.filter((source) => source.kind === "REVIEW");
}
