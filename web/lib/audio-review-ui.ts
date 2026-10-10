// 录音点评改写的前端纯函数：页头入口该是哪种形态、轮询结果怎么并回 model、
// 确认面板怎么按意见列改动、点评版正文的「依据 意见 N」「老孙已手改」怎么算、
// 文字稿里校正过的词怎么切出来。不碰 React、不碰网络，客户端组件直接引用。
// 见 docs/25_录音点评改写_实施规格_V0.1.md 二、七。

import type { V04DraftPayloadV1 } from "@/lib/v04-contract";
import {
  isAudioReviewInFlight,
  type AudioReviewChange,
  type AudioReviewOpinion,
  type AudioReviewSegment,
  type AudioReviewView,
  type V19AudioReviewSummary,
} from "@/lib/audio-review-model";

// ---------------------------------------------------------------------------
// 任务摘要：轮询拿到的完整任务 → model.audioReviews 里的一项
// ---------------------------------------------------------------------------

/** 待确认时是拟定改动总数；已生成时是实际写进点评版的处数（与服务端摘要同一口径）。 */
export function summarizeAudioReview(view: AudioReviewView): V19AudioReviewSummary {
  const proposed = view.proposal?.changes.length ?? 0;
  const changeCount = view.status === "GENERATED"
    ? (view.selectedChangeIds?.length ?? proposed)
    : view.status === "PENDING_CONFIRM" ? proposed : 0;
  return {
    id: view.id,
    baseVersionId: view.baseVersionId,
    status: view.status,
    step: view.step,
    failReason: view.failReason,
    changeCount,
    reviewVersionId: view.reviewVersionId,
    reviewVersionNumber: view.reviewVersionNumber,
  };
}

/** 按 id 替换（没有就追加）；放弃了的任务直接从列表里拿掉——入口回到「上传」。 */
export function upsertAudioReviewSummary(
  list: readonly V19AudioReviewSummary[],
  summary: V19AudioReviewSummary,
): V19AudioReviewSummary[] {
  const others = list.filter((item) => item.id !== summary.id);
  return summary.status === "ABANDONED" ? others : [...others, summary];
}

export function removeAudioReviewSummary(list: readonly V19AudioReviewSummary[], reviewId: string): V19AudioReviewSummary[] {
  return list.filter((item) => item.id !== reviewId);
}

/** 这一版在途或已生成的那个点评任务（一版只会有一个，见 audio_reviews_live_base_uidx）。 */
export function audioReviewForVersion(
  list: readonly V19AudioReviewSummary[],
  versionId: string | null,
): V19AudioReviewSummary | null {
  if (!versionId) return null;
  return list.find((item) => item.baseVersionId === versionId && item.status !== "ABANDONED") ?? null;
}

/** 轮询的对象：在途（上传、转写、理解）的任务，按 id 排好拼成一个稳定的键。 */
export function inFlightAudioReviewKey(list: readonly V19AudioReviewSummary[]): string {
  return list.filter((item) => isAudioReviewInFlight(item.status)).map((item) => item.id).sort().join(",");
}

// ---------------------------------------------------------------------------
// 页头入口的五种形态（docs/25 七、1）
// ---------------------------------------------------------------------------

export type V19AudioReviewEntryState =
  | { kind: "HIDDEN" }
  | { kind: "UPLOAD" }
  | { kind: "PROCESSING"; review: V19AudioReviewSummary }
  | { kind: "FAILED"; review: V19AudioReviewSummary }
  | { kind: "PENDING"; review: V19AudioReviewSummary }
  | { kind: "VIEW"; review: V19AudioReviewSummary };

/**
 * 入口只给老孙（`available` 已经替他算好），且只在他看「别人的普通版本」时出现：
 * 集成版、点评版、他自己的版本都不出现（docs/25 二、1）。虚拟 v1 的 id 是 null，
 * 那时还不可能有任何任务挂在它上面，只能是「上传」。
 */
export function resolveV19AudioReviewEntry(input: {
  available: boolean;
  current: { id: string | null; kind: "PERSONAL" | "AUDIO_REVIEW"; isFinal: boolean; ownerUserId: string };
  viewerUserId: string;
  reviews: readonly V19AudioReviewSummary[];
}): V19AudioReviewEntryState {
  const { available, current, viewerUserId, reviews } = input;
  if (!available || current.isFinal || current.kind !== "PERSONAL") return { kind: "HIDDEN" };
  if (current.ownerUserId === viewerUserId) return { kind: "HIDDEN" };
  const review = audioReviewForVersion(reviews, current.id);
  if (!review) return { kind: "UPLOAD" };
  if (review.status === "GENERATED") return review.reviewVersionId ? { kind: "VIEW", review } : { kind: "PROCESSING", review };
  if (review.status === "PENDING_CONFIRM") return { kind: "PENDING", review };
  if (review.status === "FAILED") return { kind: "FAILED", review };
  return { kind: "PROCESSING", review };
}

/** 失败那一步的叫法，进度气泡的标题用：「转写失败」。 */
export function describeAudioReviewFailure(failedStep: AudioReviewView["failedStep"]): string {
  if (failedStep === "UPLOAD") return "上传失败";
  if (failedStep === "TRANSCRIBE") return "转写失败";
  return "理解点评失败";
}

/** 进入 PENDING_CONFIRM 时那一条 toast（只弹一次，由调用方去重）。 */
export function describeAudioReviewReadyToast(view: AudioReviewView): string {
  const opinions = view.proposal?.opinions.length ?? 0;
  const changes = view.proposal?.changes.length ?? 0;
  return `点评改动已拟好：${opinions} 条意见、${changes} 处改动，点页头的「点评改动待确认」核对`;
}

/**
 * 轮询前后两次状态之间该弹哪条提示。只认「亲眼看到的转变」：打开页面时就已经
 * 待确认的任务不再提示一次。`announced` 记已经弹过的 `id:状态`，由调用方持有。
 */
export function audioReviewTransitionToast(
  previous: V19AudioReviewSummary | null,
  next: AudioReviewView,
  announced: Set<string>,
): string | null {
  if (!previous || previous.status === next.status) return null;
  const key = `${next.id}:${next.status}`;
  if (announced.has(key)) return null;
  if (next.status === "PENDING_CONFIRM") {
    announced.add(key);
    return describeAudioReviewReadyToast(next);
  }
  if (next.status === "FAILED") {
    announced.add(key);
    return `点评录音处理失败：${next.failReason || "原因未知"}。可以在页头重试或重新上传`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 确认面板：按意见列改动。两条意见改到同一处时只列一处，挂在第一条意见下，
// 另标「同时依据 意见 X」（docs/25 二、4）。
// ---------------------------------------------------------------------------

export type AudioReviewOpinionGroup = {
  opinion: AudioReviewOpinion;
  /** 列在这条意见下面的改动（文档里只出现一次）。 */
  changes: Array<{ change: AudioReviewChange; alsoNumbers: number[] }>;
  /** 这条意见的改动被并到别的意见下列出时，那几条意见的编号。 */
  listedUnder: number[];
};

export function groupAudioReviewOpinions(view: Pick<AudioReviewView, "proposal">): AudioReviewOpinionGroup[] {
  const proposal = view.proposal;
  if (!proposal) return [];
  const opinions = [...proposal.opinions].sort((left, right) => left.number - right.number);
  const numberOf = new Map(opinions.map((opinion) => [opinion.id, opinion.number]));
  const ownerOf = new Map<string, string>();
  for (const change of proposal.changes) {
    const owner = change.opinionIds.find((id) => numberOf.has(id))
      ?? opinions.find((opinion) => opinion.changeIds.includes(change.id))?.id;
    if (owner) ownerOf.set(change.id, owner);
  }
  return opinions.map((opinion) => {
    const listed = proposal.changes.filter((change) => ownerOf.get(change.id) === opinion.id);
    const related = proposal.changes.filter((change) =>
      change.opinionIds.includes(opinion.id) || opinion.changeIds.includes(change.id));
    const listedUnder = [...new Set(related
      .filter((change) => ownerOf.get(change.id) && ownerOf.get(change.id) !== opinion.id)
      .map((change) => numberOf.get(ownerOf.get(change.id) as string) as number))]
      .sort((left, right) => left - right);
    return {
      opinion,
      changes: listed.map((change) => ({
        change,
        alsoNumbers: change.opinionIds
          .filter((id) => id !== opinion.id && numberOf.has(id))
          .map((id) => numberOf.get(id) as number)
          .sort((left, right) => left - right),
      })),
      listedUnder,
    };
  });
}

/** 一条意见实际落进点评版的处数：它关联的改动里被选中的那些（共享的改动两边都算）。 */
export function audioReviewOpinionLanded(view: Pick<AudioReviewView, "proposal" | "selectedChangeIds">, opinion: AudioReviewOpinion): number {
  const proposal = view.proposal;
  if (!proposal) return 0;
  const selected = view.selectedChangeIds ? new Set(view.selectedChangeIds) : null;
  return proposal.changes.filter((change) =>
    (change.opinionIds.includes(opinion.id) || opinion.changeIds.includes(change.id))
    && (!selected || selected.has(change.id))).length;
}

/** 意见引用的原话：按片段时间排好。片段找不到（文字稿缺失）就跳过。 */
export function audioReviewOpinionQuotes(
  segments: readonly AudioReviewSegment[],
  segmentIds: readonly number[],
): AudioReviewSegment[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return segmentIds
    .map((id) => byId.get(id))
    .filter((segment): segment is AudioReviewSegment => Boolean(segment))
    .sort((left, right) => left.startMs - right.startMs);
}

/** 播放到 `ms` 时该高亮哪一句：最后一个开始时间不晚于它的片段。 */
export function activeAudioReviewSegmentId(segments: readonly AudioReviewSegment[], ms: number): number | null {
  let active: AudioReviewSegment | null = null;
  for (const segment of segments) {
    if (segment.startMs <= ms && (!active || segment.startMs >= active.startMs)) active = segment;
  }
  return active ? active.id : null;
}

/**
 * 把一句文字稿按「按词表校正过的词」切开：校正后的词（`to`）单独成段并带上原听写，
 * 渲染时给它虚线下划线、悬停看原听写。同一个词出现多次就都标；互相重叠时先到先得。
 */
export function splitAudioReviewCorrections(
  text: string,
  corrections: ReadonlyArray<{ from: string; to: string }>,
): Array<{ text: string; correction: { from: string; to: string } | null }> {
  const usable = corrections.filter((item) => item.to.trim() !== "");
  if (usable.length === 0) return [{ text, correction: null }];
  const marks: Array<{ start: number; end: number; correction: { from: string; to: string } }> = [];
  for (const correction of usable) {
    let from = 0;
    while (from <= text.length) {
      const index = text.indexOf(correction.to, from);
      if (index < 0) break;
      const end = index + correction.to.length;
      if (!marks.some((mark) => index < mark.end && end > mark.start)) marks.push({ start: index, end, correction });
      from = end;
    }
  }
  marks.sort((left, right) => left.start - right.start);
  const parts: Array<{ text: string; correction: { from: string; to: string } | null }> = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) parts.push({ text: text.slice(cursor, mark.start), correction: null });
    parts.push({ text: text.slice(mark.start, mark.end), correction: mark.correction });
    cursor = mark.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), correction: null });
  return parts;
}

// ---------------------------------------------------------------------------
// 点评版正文：「依据 意见 N」与「老孙已手改」（docs/25 二、9，七、6）
// ---------------------------------------------------------------------------

export type V19ReviewBasisEntry = {
  /** 这一处依据的意见编号，升序。 */
  numbers: number[];
  /** 悬停看的意见摘要，一条意见一行。 */
  tip: string;
  /** 点评版里这一处的当前值已经不是提案的写法——老孙生成后又手改过。 */
  handEdited: boolean;
};

/**
 * 一处改动在 payload 里的当前值。键沿用提案的细粒度键：`facts.<key>`、
 * `shotGroup:<id>.<field>`、`shot:<id>.<field>`、`path.primaryType`、
 * `path.primaryDetails[.<sub>]`、`path.auxiliaryTypes[.<TYPE>.<field>]`。
 * 位置已经不存在（镜头被删了）时返回 undefined。
 */
export function audioReviewValueAt(payload: V04DraftPayloadV1, key: string): unknown {
  const groupMatch = key.match(/^shotGroup:([^.]+)\.(.+)$/);
  if (groupMatch) {
    const group = payload.script.shotGroups.find((item) => item.id === groupMatch[1]);
    return group ? (group as unknown as Record<string, unknown>)[groupMatch[2]] : undefined;
  }
  const shotMatch = key.match(/^shot:([^.]+)\.(.+)$/);
  if (shotMatch) {
    const shot = payload.script.shotGroups.flatMap((group) => group.shots).find((item) => item.id === shotMatch[1]);
    return shot ? (shot as unknown as Record<string, unknown>)[shotMatch[2]] : undefined;
  }
  if (key.startsWith("facts.")) {
    return (payload.factsAndCoreJudgement as unknown as Record<string, unknown>)[key.slice("facts.".length)];
  }
  const path = payload.perceptionPath;
  if (key === "path.primaryType") return path.primaryType;
  if (key === "path.primaryDetails") return path.primaryDetails;
  if (key.startsWith("path.primaryDetails.")) return path.primaryDetails[key.slice("path.primaryDetails.".length)] ?? "";
  if (key === "path.auxiliaryTypes") return path.auxiliaryTypes;
  const auxMatch = key.match(/^path\.auxiliaryTypes\.([^.]+)\.(description|creativeRole)$/);
  if (auxMatch) {
    const entry = path.auxiliaryTypes.find((item) => item.type === auxMatch[1]);
    return entry ? entry[auxMatch[2] as "description" | "creativeRole"] : undefined;
  }
  return undefined;
}

function normalizeAudioReviewValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalizeAudioReviewValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.selectedOptionIds)) {
      // 固定选项：只比选了什么、自定义写了什么，不比词表版本和选择先后。
      return {
        selectedOptionIds: [...(record.selectedOptionIds as unknown[]).map(String)].sort(),
        customText: typeof record.customText === "string" ? record.customText.trim() : "",
        advancedText: typeof record.advancedText === "string" ? record.advancedText.trim() : "",
      };
    }
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalizeAudioReviewValue(record[key])]));
  }
  return value ?? null;
}

export function sameAudioReviewValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeAudioReviewValue(left)) === JSON.stringify(normalizeAudioReviewValue(right));
}

function opinionTip(opinion: AudioReviewOpinion): string {
  return `意见 ${opinion.number}（${opinion.kind === "GENERAL" ? "总体" : "具体"}）：${opinion.summary}`;
}

/**
 * 点评版里每一处被选中落地的改动 → 正文差异标记旁的「依据」。键是提案的
 * 细粒度键（主导路径细项是 `path.primaryDetails.<sub>`），正文按同样的键去找。
 * `currentPayload` 是点评版此刻的内容（含老孙生成后的手改），和提案写法不一样就标手改。
 */
export function buildV19ReviewBasis(
  view: Pick<AudioReviewView, "proposal" | "selectedChangeIds">,
  currentPayload: V04DraftPayloadV1,
): Map<string, V19ReviewBasisEntry> {
  const basis = new Map<string, V19ReviewBasisEntry>();
  const proposal = view.proposal;
  if (!proposal) return basis;
  const selected = view.selectedChangeIds ? new Set(view.selectedChangeIds) : null;
  const opinionById = new Map(proposal.opinions.map((opinion) => [opinion.id, opinion]));
  for (const change of proposal.changes) {
    if (selected && !selected.has(change.id)) continue;
    const current = audioReviewValueAt(currentPayload, change.key);
    if (current === undefined) continue;
    const opinions = [...new Set([
      ...change.opinionIds,
      ...proposal.opinions.filter((opinion) => opinion.changeIds.includes(change.id)).map((opinion) => opinion.id),
    ])]
      .map((id) => opinionById.get(id))
      .filter((opinion): opinion is AudioReviewOpinion => Boolean(opinion))
      .sort((left, right) => left.number - right.number);
    const existing = basis.get(change.key);
    const numbers = [...new Set([...(existing?.numbers ?? []), ...opinions.map((opinion) => opinion.number)])].sort((a, b) => a - b);
    const tips = [...new Set([...(existing ? existing.tip.split("\n") : []), ...opinions.map(opinionTip)])];
    basis.set(change.key, {
      numbers,
      tip: tips.join("\n"),
      handEdited: Boolean(existing?.handEdited) || !sameAudioReviewValue(current, change.after),
    });
  }
  return basis;
}

/** 下一个版本号：确认面板里预告「确认后生成点评版 vN」。 */
export function nextV19VersionNumber(versions: ReadonlyArray<{ number: number }>): number {
  return versions.reduce((max, version) => Math.max(max, version.number), 0) + 1;
}
