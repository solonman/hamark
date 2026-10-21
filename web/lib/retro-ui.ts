// 客户需求复盘库前端专用的纯逻辑：不碰网络、不碰 DOM，组件与单测共用。
// 词表、限额、出处标记文字、月份工具都在 lib/retro-model.ts，这里只补前端才需要的那一层：
// 库首页的分组／筛选／搜索、卡片封面与录音标记、新建对话框的校验、文字稿的说话人与多段拼接、
// 出处标记与浮层的取数、生成前提与整理进度的呈现。规格见 docs/26 十。

import {
  RETRO_LIMITS,
  RETRO_KEYNOTE_REFUSAL,
  classifyRetroFile,
  isRetroKeynoteFile,
  isRetroJobLive,
  currentRetroMonthKey,
  formatRetroClock,
  formatRetroMonth,
  formatRetroSourceLabel,
  normalizeRetroSearch,
  parseRetroSceneTags,
  retroSourceKey,
  shiftRetroMonthKey,
  type RetroCaseCard,
  type RetroCaseBasicsInput,
  type RetroCaseDetail,
  type RetroDraftPatchRequest,
  type RetroGeneratePreconditions,
  type RetroItem,
  type RetroJobView,
  type RetroMethods,
  type RetroMinutes,
  type RetroMonthBadge,
  type RetroMonthCaseRow,
  type RetroMonthSummary,
  type RetroMonthView,
  type RetroQuotedSegment,
  type RetroRecordingBadge,
  type RetroRecordingView,
  type RetroRoundRefs,
  type RetroSource,
  type RetroTranscriptSegment,
} from "./retro-model";

// ---------------------------------------------------------------------------
// 库首页：录音标记、月份成果状态
// ---------------------------------------------------------------------------

export type RetroTone = "none" | "busy" | "ready" | "failed";

/** 卡片封面右上角的录音标记（规格 10.2）：「录音 2 段 · 48:12」「转写中」「转写失败」「无录音」。 */
export function retroRecordingLabel(badge: RetroRecordingBadge): { tone: RetroTone; label: string } {
  switch (badge.state) {
    case "NONE": return { tone: "none", label: "无录音" };
    case "PROCESSING": return { tone: "busy", label: "转写中" };
    case "FAILED": return { tone: "failed", label: "转写失败" };
    default: return { tone: "ready", label: `录音 ${badge.parts} 段 · ${formatRetroClock(badge.durationMs)}` };
  }
}

export type RetroMonthTone = "none" | "running" | "published" | "updated";

/** 月份标题行上的五种成果状态（规格 10.1）。 */
export function retroMonthBadgeLabel(badge: RetroMonthBadge): { tone: RetroMonthTone; label: string } {
  if (badge.state === "NONE") return { tone: "none", label: "未整理" };
  if (badge.state === "RUNNING") {
    return { tone: "running", label: badge.publishedVersion ? `已发布 v${badge.publishedVersion} · 整理中` : "整理中" };
  }
  return badge.changed
    ? { tone: "updated", label: `已发布 v${badge.version} · 有更新` }
    : { tone: "published", label: `已发布 v${badge.version}` };
}

/** 有录音还在上传／转写时，库首页每 10 秒悄悄拉一次（规格 10.1）。 */
export function hasPendingRetroWork(cards: readonly Pick<RetroCaseCard, "recording">[]): boolean {
  return cards.some((card) => card.recording.state === "PROCESSING");
}

// ---------------------------------------------------------------------------
// 库首页：部门、搜索、分组、编号
// ---------------------------------------------------------------------------

/** 部门下拉的选项：取自数据，按首次出现的顺序去重。 */
export function retroDepartments(cards: readonly Pick<RetroCaseCard, "department">[]): string[] {
  return [...new Set(cards.map((card) => card.department).filter(Boolean))];
}

/**
 * 搜索用的文字：标题、客户、部门、场景标签、需求与回合文字、上传者（规格 10.1）。
 * 卡片自己只带需求摘要和回合标题；服务端给了 searchText（需求、回合文字、结果拼起来）就一并搜。
 */
export function retroCardSearchText(card: RetroCaseCard): string {
  return [
    card.title,
    card.clientName,
    card.department,
    card.sceneTags.join(" "),
    card.backgroundExcerpt,
    card.roundTrack.map((round) => round.title).join(" "),
    card.createdByName,
    card.searchText ?? "",
  ].join(" ");
}

export function matchesRetroQuery(card: RetroCaseCard, query: string): boolean {
  const normalized = normalizeRetroSearch(query).trim();
  if (!normalized) return true;
  return normalizeRetroSearch(retroCardSearchText(card)).includes(normalized);
}

export function filterRetroCards(cards: readonly RetroCaseCard[], filter: { department: string; query: string }): RetroCaseCard[] {
  return cards.filter((card) => (filter.department === "ALL" || card.department === filter.department) && matchesRetroQuery(card, filter.query));
}

/** 卡片上的 CASE 编号：照其它库按全库编号，新上传的在前（最新的是 01），不受筛选影响。 */
export function buildRetroCaseNumberMap(cards: readonly Pick<RetroCaseCard, "id" | "createdAt">[]): Map<string, number> {
  const sorted = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return new Map(sorted.map((card, index) => [card.id, index + 1]));
}

export type RetroMonthSection = {
  monthKey: string;
  /** 这个月里符合筛选的案例，按上传时间倒序。 */
  items: RetroCaseCard[];
  /** 这个月的案例总数（不受筛选影响）。 */
  total: number;
  recordedCaseCount: number;
  badge: RetroMonthBadge;
};

/** 始终按复盘月份分组，月份从新到旧，组内按上传时间倒序（规格 10.1）。服务端没给的月份汇总，用卡片现算。 */
export function groupRetroCardsByMonth(
  visible: readonly RetroCaseCard[],
  all: readonly RetroCaseCard[],
  months: readonly RetroMonthSummary[],
): RetroMonthSection[] {
  const summaryByMonth = new Map(months.map((month) => [month.monthKey, month]));
  const keys = [...new Set(visible.map((card) => card.monthKey))].sort((a, b) => b.localeCompare(a));
  return keys.map((monthKey) => {
    const inMonth = all.filter((card) => card.monthKey === monthKey);
    const summary = summaryByMonth.get(monthKey);
    return {
      monthKey,
      items: visible.filter((card) => card.monthKey === monthKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      total: summary?.caseCount ?? inMonth.length,
      recordedCaseCount: summary?.recordedCaseCount ?? inMonth.filter((card) => card.recording.state === "READY").length,
      badge: summary?.badge ?? { state: "NONE" },
    };
  });
}

export type RetroTrackNode = { label: string; end: boolean; feedback: boolean; empty: boolean };

/**
 * 封面上的回合轨迹（规格 10.2）：「需求 → 第 1 版 → … → 结果」。回合超过 5 个时中间折成「…N」，
 * 有客户反馈的回合圆点描边，没填内容的回合空心，结果没填也是空心。
 */
export function retroCoverTrack(card: Pick<RetroCaseCard, "roundTrack" | "hasOutcome">): RetroTrackNode[] {
  let rounds: RetroTrackNode[] = card.roundTrack.map((round) => ({ label: round.title, end: false, feedback: round.hasFeedback, empty: false }));
  if (rounds.length > 5) {
    rounds = [
      ...rounds.slice(0, 2),
      { label: `…${rounds.length - 4}`, end: false, feedback: false, empty: true },
      ...rounds.slice(-2),
    ];
  }
  return [
    { label: "需求", end: true, feedback: false, empty: false },
    ...rounds,
    { label: "结果", end: card.hasOutcome, feedback: false, empty: !card.hasOutcome },
  ];
}

// ---------------------------------------------------------------------------
// 新建／编辑基本信息
// ---------------------------------------------------------------------------

export type RetroBasicsDraft = { monthKey: string; department: string; clientName: string; title: string; sceneTagsText: string };

export function blankRetroBasics(now: Date = new Date()): RetroBasicsDraft {
  return { monthKey: currentRetroMonthKey(now), department: "", clientName: "", title: "", sceneTagsText: "" };
}

export function retroBasicsFromDetail(detail: Pick<RetroCaseDetail, "monthKey" | "department" | "clientName" | "title" | "sceneTags">): RetroBasicsDraft {
  return {
    monthKey: detail.monthKey,
    department: detail.department,
    clientName: detail.clientName,
    title: detail.title,
    sceneTagsText: detail.sceneTags.join("，"),
  };
}

/** 新建：上月／本月／下月（规格 4.2）。 */
export function retroMonthChoices(now: Date = new Date()): { key: string; label: string }[] {
  const current = currentRetroMonthKey(now);
  return ([["上月", -1], ["本月", 0], ["下月", 1]] as const).map(([label, delta]) => {
    const key = shiftRetroMonthKey(current, delta);
    return { key, label: `${label} · ${formatRetroMonth(key)}` };
  });
}

/** 编辑基本信息：可以改成任意过去的月份，列出下月往前 13 个月；案例本来就在更早的月份时把它也放进去。 */
export function retroEditMonthChoices(currentCaseMonth: string, now: Date = new Date()): { key: string; label: string }[] {
  const top = shiftRetroMonthKey(currentRetroMonthKey(now), 1);
  const keys = Array.from({ length: 13 }, (_, index) => shiftRetroMonthKey(top, -index));
  if (currentCaseMonth && !keys.includes(currentCaseMonth)) keys.push(currentCaseMonth);
  return keys.map((key) => ({ key, label: formatRetroMonth(key) }));
}

/** 校验顺序：月份 → 部门 → 客户 → 标题 →（场景标签）。报错写进对话框里的 formError。 */
export function validateRetroBasics(draft: RetroBasicsDraft, allowedMonths: readonly string[]): string {
  if (!allowedMonths.includes(draft.monthKey)) return "请选择复盘月份。";
  const department = draft.department.trim();
  if (!department) return "请填写部门。";
  if (department.length > RETRO_LIMITS.departmentMax) return `部门不超过 ${RETRO_LIMITS.departmentMax} 字。`;
  const client = draft.clientName.trim();
  if (!client) return "请填写客户。";
  if (client.length > RETRO_LIMITS.clientMax) return `客户不超过 ${RETRO_LIMITS.clientMax} 字。`;
  const title = draft.title.trim();
  if (!title) return "请填写案例标题：一句话说清这件事。";
  if (title.length > RETRO_LIMITS.titleMax) return `案例标题不超过 ${RETRO_LIMITS.titleMax} 字。`;
  const tags = parseRetroSceneTags(draft.sceneTagsText);
  if (tags.length > RETRO_LIMITS.sceneTagsMax) return `客户服务场景最多 ${RETRO_LIMITS.sceneTagsMax} 个。`;
  if (tags.some((tag) => tag.length > RETRO_LIMITS.sceneTagMax)) return `每个场景标签不超过 ${RETRO_LIMITS.sceneTagMax} 字。`;
  return "";
}

export function buildRetroBasicsInput(draft: RetroBasicsDraft): RetroCaseBasicsInput {
  return {
    monthKey: draft.monthKey,
    department: draft.department.trim(),
    clientName: draft.clientName.trim(),
    title: draft.title.trim(),
    sceneTags: parseRetroSceneTags(draft.sceneTagsText),
  };
}

/** 点遮罩、按 Esc：新建时只在表单还空着时关；编辑基本信息时只在没改过时关（规格 10.4）。 */
export function retroBasicsClosable(mode: "create" | "edit", draft: RetroBasicsDraft, dirty: boolean): boolean {
  if (mode === "edit") return !dirty;
  return !draft.department.trim() && !draft.clientName.trim() && !draft.title.trim() && !draft.sceneTagsText.trim();
}

// ---------------------------------------------------------------------------
// 原位编辑：字段上限
// ---------------------------------------------------------------------------

export const RETRO_CASE_FIELD_LIMITS = {
  background: RETRO_LIMITS.backgroundMax,
  outcome: RETRO_LIMITS.outcomeMax,
  turningPoints: RETRO_LIMITS.turningPointsMax,
  reflection: RETRO_LIMITS.reflectionMax,
  discussionQuestions: RETRO_LIMITS.discussionQuestionsMax,
} as const;

export const RETRO_ROUND_FIELD_LIMITS = {
  title: RETRO_LIMITS.roundTitleMax,
  occurredOn: RETRO_LIMITS.roundOccurredMax,
  deliveryText: RETRO_LIMITS.roundTextMax,
  feedbackText: RETRO_LIMITS.roundTextMax,
  responseText: RETRO_LIMITS.roundTextMax,
} as const;

/** 回合除标题外，有没有填过文字、传过附件、关联过作品：有就要在删除前确认（规格 10.3）。 */
export function retroRoundHasContent(round: {
  occurredOn: string; deliveryText: string; feedbackText: string; responseText: string;
  assets: readonly unknown[]; links: readonly unknown[];
}): boolean {
  return [round.occurredOn, round.deliveryText, round.feedbackText, round.responseText].some((text) => text.trim() !== "")
    || round.assets.length > 0
    || round.links.length > 0;
}

/** 新回合的默认标题：「第 N 版」。 */
export function nextRetroRoundTitle(roundCount: number): string {
  return `第 ${roundCount + 1} 版`;
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

export type RetroAttachCheck =
  | { ok: true; type: NonNullable<ReturnType<typeof classifyRetroFile>>["type"] }
  | { ok: false; reason: string };

export function checkRetroAttachFile(file: { name: string; type: string; size: number }): RetroAttachCheck {
  if (isRetroKeynoteFile(file.name, file.type)) return { ok: false, reason: `「${file.name}」：${RETRO_KEYNOTE_REFUSAL}。` };
  const classified = classifyRetroFile(file.name, file.type);
  if (!classified) return { ok: false, reason: `不支持这种文件：${file.name}。支持图片、视频、音频，以及 PDF、Word、Excel、PPT 文档。` };
  if (file.size <= 0) return { ok: false, reason: `「${file.name}」是空文件。` };
  if (classified.type === "IMAGE" && file.size > RETRO_LIMITS.imageMaxBytes) {
    return { ok: false, reason: `「${file.name}」超过 20MB，生成不了在线预览；请压缩后再传。` };
  }
  return { ok: true, type: classified.type };
}

/** 还能再放几个附件（需求凭证、每个回合各自 ≤12）。 */
export function remainingRetroAssetSlots(used: number): number {
  return Math.max(0, RETRO_LIMITS.assetsPerOwnerMax - used);
}

export function docFormatLabel(format: string | null): string {
  switch (format) {
    case "PDF": return "PDF";
    case "WORD": return "DOC";
    case "EXCEL": return "XLS";
    case "PPT": return "PPT";
    default: return "DOC";
  }
}

// ---------------------------------------------------------------------------
// 录音与文字稿
// ---------------------------------------------------------------------------

/** 录音还在上传或转写（案例页每 4 秒拉一次）。 */
export function isRetroRecordingBusy(status: RetroRecordingView["status"]): boolean {
  return status === "UPLOADING" || status === "TRANSCRIBING";
}

/** 案例上还有没到终态的点评录音、客户录音转写，或还在生成预览的文档。 */
export function hasPendingCaseWork(detail: Pick<RetroCaseDetail, "recordings" | "needAssets" | "rounds">): boolean {
  if (detail.recordings.some((recording) => isRetroRecordingBusy(recording.status))) return true;
  const assets = [...detail.needAssets, ...detail.rounds.flatMap((round) => round.assets)];
  return assets.some((asset) => asset.uploadStatus === "READY" && (
    (asset.type === "AUDIO" && asset.transcribe?.status === "TRANSCRIBING")
    // 文档还在生成逐页预览（规格 4.3）：详情接口会顺手向数据万象查一次并收口。
    || (asset.type === "DOC" && asset.derivativeStatus === "PENDING")
  ));
}

/** 一个案例（或整场总结）下还能传的段号：最多 3 段，满了返回 null（规格 5.1）。 */
export function nextRetroPartNo(recordings: readonly Pick<RetroRecordingView, "partNo" | "status">[]): number | null {
  const used = new Set(recordings.filter((recording) => recording.status !== "REMOVED").map((recording) => recording.partNo));
  for (let part = 1; part <= RETRO_LIMITS.recordingPartsMax; part += 1) if (!used.has(part)) return part;
  return null;
}

/** 说话人的显示名：发布后换成 AI 认定的称呼，否则「说话人 N」，N 按在文字稿里首次出现的顺序。 */
export function retroSpeakerName(speakerId: string, labels: Record<string, string> | null, order: readonly string[]): string {
  const labelled = labels?.[speakerId];
  if (labelled) return labelled;
  const index = order.indexOf(speakerId);
  return `说话人 ${index >= 0 ? index + 1 : order.length + 1}`;
}

export function retroSpeakerOrder(segments: readonly Pick<RetroTranscriptSegment, "speakerId">[]): string[] {
  const order: string[] = [];
  for (const segment of segments) if (!order.includes(segment.speakerId)) order.push(segment.speakerId);
  return order;
}

/** 文字稿一行：喂给 V19AudioReviewTranscript（它认 AudioReviewSegment 的形状）。 */
export type RetroTranscriptLine = {
  /** 多段拼接时每行要有全局唯一的 id：段序 × 100000 + 句序号。 */
  id: number;
  startMs: number;
  endMs: number;
  speaker: string;
  isReviewer: boolean;
  text: string;
  corrections: { from: string; to: string }[];
  ownerId: string;
  segmentId: number;
};

export function retroLineId(ownerIndex: number, segmentId: number): number {
  return ownerIndex * 100_000 + segmentId;
}

export function buildRetroTranscript(parts: readonly RetroRecordingView[]): {
  lines: RetroTranscriptLine[];
  dividers: Map<number, string>;
  labelled: boolean;
} {
  const ready = parts.filter((part) => part.status === "READY" && part.segments?.length);
  const order = retroSpeakerOrder(ready.flatMap((part) => part.segments ?? []));
  const lines: RetroTranscriptLine[] = [];
  const dividers = new Map<number, string>();
  ready.forEach((part, index) => {
    (part.segments ?? []).forEach((segment, position) => {
      const speaker = retroSpeakerName(segment.speakerId, part.speakerLabels, order);
      const id = retroLineId(index + 1, segment.id);
      if (position === 0 && ready.length > 1) {
        dividers.set(id, `第 ${part.partNo} 段 · ${part.fileName}${part.durationMs ? ` · ${formatRetroClock(part.durationMs)}` : ""}`);
      }
      lines.push({
        id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        speaker,
        isReviewer: speaker === "老孙",
        text: segment.text,
        corrections: [],
        ownerId: part.id,
        segmentId: segment.id,
      });
    });
  });
  return { lines, dividers, labelled: ready.length > 0 && ready.every((part) => part.speakerLabels !== null) };
}

/** 客户录音（附件里的音频）的文字稿：说话人固定「说话人 N」。 */
export function buildClientTranscript(assetId: string, segments: readonly RetroTranscriptSegment[]): RetroTranscriptLine[] {
  const order = retroSpeakerOrder(segments);
  return segments.map((segment) => ({
    id: retroLineId(1, segment.id),
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: retroSpeakerName(segment.speakerId, null, order),
    isReviewer: false,
    text: segment.text,
    corrections: [],
    ownerId: assetId,
    segmentId: segment.id,
  }));
}

// ---------------------------------------------------------------------------
// 出处标记与浮层（规格 6.7）
// ---------------------------------------------------------------------------

export type RetroSourceContext = {
  monthKey: string;
  quotedSegments: Record<string, RetroQuotedSegment[]>;
  recordingRefs: Record<string, { caseId: string | null; caseNumber: number | null; partNo: number; partCount: number }>;
  /** 案例 id → 冻结的序号（点评录音的 recordingRefs 缺失时兜底）。 */
  caseNumbers: Record<string, number>;
  roundRefs?: RetroRoundRefs;
  /** 案例 id → 展示用名称（出处浮层标题）。 */
  caseLabels?: Record<string, { client: string; title: string }>;
};

export type RetroSourceView = {
  key: string;
  kind: RetroSource["kind"];
  label: string;
  /** 悬停提示：属于第几段、点开看原话。 */
  title: string;
  /** 浮层标题。 */
  heading: string;
  quotes: RetroQuotedSegment[];
  startMs: number;
  /** 「去听原声」要去的地址。 */
  href: string;
  caseId: string | null;
  partNo: number;
  assetId: string | null;
  recordingId: string | null;
  /** 原录音已被移除或快照里没有这些片段。 */
  missing: boolean;
};

function secondsOf(ms: number) {
  return Math.max(0, Math.floor(ms / 1000));
}

export function describeRetroSource(source: RetroSource, ctx: RetroSourceContext): RetroSourceView {
  const key = retroSourceKey(source.kind === "REVIEW"
    ? { kind: "REVIEW", recordingId: source.recordingId }
    : { kind: "CLIENT", assetId: source.assetId });
  const wanted = new Set(source.segmentIds);
  const quotes = (ctx.quotedSegments[key] ?? [])
    .filter((quote) => wanted.has(quote.segmentId))
    .sort((a, b) => a.startMs - b.startMs);
  const startMs = quotes[0]?.startMs ?? 0;
  const sec = secondsOf(startMs);

  if (source.kind === "CLIENT") {
    const number = ctx.caseNumbers[source.caseId] ?? null;
    const label = formatRetroSourceLabel({ kind: "CLIENT", caseNumber: number, partNo: null, partCount: 1, startMs });
    const labelOf = ctx.caseLabels?.[source.caseId];
    return {
      key,
      kind: "CLIENT",
      label,
      title: `${number ? `案例 ${number} 的` : ""}客户录音 · 点开看原话`,
      heading: `${number ? `案例 ${number} · ` : ""}${labelOf ? `${labelOf.client} · ` : ""}客户录音`,
      quotes,
      startMs,
      href: `/retro/${encodeURIComponent(source.caseId)}?audio=${encodeURIComponent(source.assetId)}&t=${sec}#assets`,
      caseId: source.caseId,
      partNo: 1,
      assetId: source.assetId,
      recordingId: null,
      missing: quotes.length === 0,
    };
  }

  const ref = ctx.recordingRefs[source.recordingId];
  const caseId = source.caseId ?? ref?.caseId ?? null;
  const caseNumber = ref?.caseNumber ?? (caseId ? ctx.caseNumbers[caseId] ?? null : null);
  const partNo = ref?.partNo ?? 1;
  const partCount = ref?.partCount ?? 1;
  const label = formatRetroSourceLabel({ kind: "REVIEW", caseNumber, partNo: ref ? partNo : null, partCount, startMs });
  const partQuery = partNo > 1 ? `&p=${partNo}` : "";
  const labelOf = caseId ? ctx.caseLabels?.[caseId] : undefined;
  const isSummary = caseId === null;
  return {
    key,
    kind: "REVIEW",
    label,
    title: `${partCount > 1 ? `第 ${partNo} 段 · ` : ""}点开看原话`,
    heading: isSummary ? "整场总结" : `案例 ${caseNumber ?? "?"}${labelOf ? ` · ${labelOf.client} · ${labelOf.title}` : ""}${partCount > 1 ? ` · 第 ${partNo} 段` : ""}`,
    quotes,
    startMs,
    href: isSummary
      ? `/retro/months/${encodeURIComponent(ctx.monthKey)}?focus=summary&t=${sec}${partQuery}#summary`
      : `/retro/${encodeURIComponent(caseId)}?t=${sec}${partQuery}#recording`,
    caseId,
    partNo,
    assetId: null,
    recordingId: source.recordingId,
    missing: quotes.length === 0,
  };
}

export type RetroRoundMark = { roundId: string; label: string; caseId: string | null; href: string | null };

/** 引用了回合的出处，再加一个「第二版」标记，点击跳到案例页的那一回合（规格 6.7）。 */
export function describeRetroRoundMarks(source: RetroSource, ctx: Pick<RetroSourceContext, "roundRefs">): RetroRoundMark[] {
  if (source.kind !== "REVIEW") return [];
  return (source.roundIds ?? []).map((roundId) => {
    const ref = ctx.roundRefs?.[roundId];
    const caseId = ref?.caseId ?? source.caseId ?? null;
    return {
      roundId,
      label: ref?.title || "对应回合",
      caseId,
      href: caseId ? `/retro/${encodeURIComponent(caseId)}?round=${encodeURIComponent(roundId)}` : null,
    };
  });
}

/** 同一条内容的出处标记去重：同一份录音的同一时间点只留一个。 */
export function uniqueRetroSources(sources: readonly RetroSource[]): RetroSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${retroSourceKey(source.kind === "REVIEW" ? { kind: "REVIEW", recordingId: source.recordingId } : { kind: "CLIENT", assetId: source.assetId })}|${source.segmentIds.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 月份页：概况、生成前提、整理进度
// ---------------------------------------------------------------------------

/** 「4 小时 12 分」。 */
export function formatRetroHM(ms: number): string {
  const totalMinutes = Math.round(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

/** hero 一行概况：「6 个案例 · 录音 5 段 · 总结 1 段 · 合计 4 小时 12 分」。 */
export function retroMonthOverview(view: {
  cases: readonly Pick<RetroMonthCaseRow, "recording">[];
  summaryRecordings: readonly Pick<RetroRecordingView, "status">[];
  totalDurationMs: number;
}): string {
  const caseSegments = view.cases.reduce((sum, row) => sum + (row.recording.state === "READY" ? row.recording.parts : 0), 0);
  const summaryParts = view.summaryRecordings.filter((recording) => recording.status !== "REMOVED").length;
  return `${view.cases.length} 个案例 · 录音 ${caseSegments} 段 · 总结 ${summaryParts} 段 · 合计 ${formatRetroHM(view.totalDurationMs)}`;
}

export type RetroPreconditionItem = { ok: "yes" | "no" | "note"; text: string };

/** 老孙操作区的前提清单（规格 6.1），点评录音和客户录音分开列。 */
export function retroPreconditionItems(
  pre: RetroGeneratePreconditions,
  unrecordedCaseNumbers: readonly number[] = [],
): RetroPreconditionItem[] {
  const items: RetroPreconditionItem[] = [
    pre.recordedCaseCount > 0
      ? { ok: "yes", text: `${pre.recordedCaseCount} 个案例的点评录音已就绪` }
      : { ok: "no", text: "还没有案例的点评录音转写完成" },
    pre.reviewRecordingsProcessing > 0
      ? { ok: "no", text: `有 ${pre.reviewRecordingsProcessing} 段点评录音还在上传或转写，完成后才能生成` }
      : { ok: "yes", text: "没有点评录音还在上传或转写" },
  ];
  if (pre.unrecordedCaseCount > 0) {
    const which = unrecordedCaseNumbers.length ? `（${unrecordedCaseNumbers.map((n) => `案例 ${n}`).join("、")}）` : "";
    items.push({ ok: "note", text: `有 ${pre.unrecordedCaseCount} 个案例没有录音${which}：会列在清单里，不参与提炼` });
  }
  items.push(pre.summaryParts > 0
    ? { ok: "yes", text: "整场总结录音已就绪" }
    : { ok: "note", text: "还没有整场总结录音：也可以生成" });
  const audio = pre.clientAudio;
  if (audio.total === 0) items.push({ ok: "yes", text: "没有客户录音（附件）" });
  else {
    const ok = audio.transcribing > 0 ? "no" : audio.failed > 0 ? "note" : "yes";
    items.push({
      ok,
      text: `客户录音（附件）${audio.total} 段 · 已转写 ${audio.ready}${audio.transcribing ? ` · 转写中 ${audio.transcribing}` : ""}${audio.failed ? ` · 转写失败 ${audio.failed}（不进入提炼）` : ""}`,
    });
  }
  return items;
}

/** 生成前的确认框正文（规格 6.1）：没有要说的就不弹确认框，直接生成。 */
export function retroGenerateConfirmLines(input: {
  fromReview: boolean;
  publishedVersion: number | null;
  pre: Pick<RetroGeneratePreconditions, "unrecordedCaseCount" | "summaryParts" | "clientAudio">;
}): string[] {
  const lines: string[] = [];
  if (input.fromReview) lines.push("重新生成等于放弃当前草稿、再开一个新任务：草稿上的修改会丢。");
  else if (input.publishedVersion) {
    lines.push(`会产生新草稿；再发布就是 v${input.publishedVersion + 1}，v${input.publishedVersion} 原样保留在历史版本里。`);
  }
  if (input.pre.unrecordedCaseCount > 0) {
    lines.push(`有 ${input.pre.unrecordedCaseCount} 个案例没有录音：它们会列在纪要的案例清单里，但不参与提炼。`);
  }
  if (input.pre.summaryParts === 0) lines.push("本月还没有整场总结录音，也可以生成；汇总时只用各案例的录音。");
  if (input.pre.clientAudio.failed > 0) lines.push(`有 ${input.pre.clientAudio.failed} 段客户录音转写失败，它们不会进入提炼。`);
  return lines;
}

export type RetroStepState = "done" | "doing" | "fail" | "todo";

/** 三步进度「逐案提炼 3 / 6 · 汇总纪要 · 汇总方法」的各步状态与计数（规格 10.5）。 */
export function retroJobSteps(job: Pick<RetroJobView, "status" | "progress" | "failedStep">): {
  steps: { key: "EXTRACT" | "SUMMARIZE" | "DISTILL"; state: RetroStepState }[];
  extractLabel: string;
  currentLabel: string;
} {
  const order = ["EXTRACT", "SUMMARIZE", "DISTILL"] as const;
  const failed = job.status === "FAILED";
  const current = failed
    ? job.failedStep ?? "EXTRACT"
    : job.status === "SUMMARIZING" ? "SUMMARIZE" : job.status === "DISTILLING" ? "DISTILL" : "EXTRACT";
  const index = order.indexOf(current);
  const { done, total } = job.progress;
  const position = current === "EXTRACT" ? Math.min(done + (job.status === "EXTRACTING" || failed ? 1 : 0), total) : total;
  return {
    steps: order.map((key, i) => ({ key, state: i < index ? "done" : i === index ? (failed ? "fail" : "doing") : "todo" })),
    extractLabel: `${position} / ${total}`,
    currentLabel: current === "EXTRACT" ? `逐案提炼 ${position}/${total}` : current === "SUMMARIZE" ? "汇总纪要" : "汇总方法",
  };
}

/** 历史版本下拉的选项：新的在前，当前版标注「（当前）」。 */
export function retroVersionOptions(versions: readonly number[]): { version: number; label: string }[] {
  const latest = Math.max(0, ...versions);
  return [...versions].sort((a, b) => b - a).map((version) => ({ version, label: `v${version}${version === latest ? "（当前）" : ""}` }));
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/** 卡片、详情页上的时间只需要「哪天几点」。 */
export function formatRetroTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 跨页提示：删除案例后整页跳回库首页，提示靠 sessionStorage 带过去（库首页读一次就清）。 */
export const RETRO_FLASH_KEY = "retro:flash";

// ---------------------------------------------------------------------------
// 地址栏的跳转参数（规格 6.7、10.3）
// ---------------------------------------------------------------------------

export type RetroCaseJump = {
  /** `?audio=<assetId>`：去听某段客户录音。 */
  audioAssetId: string | null;
  /** `?t=秒数`：从这一秒开始播放。 */
  seconds: number | null;
  /** `?p=段号`：点评录音的第几段，默认 1。 */
  partNo: number;
  /** `?round=<roundId>`：跳到这一回合。 */
  roundId: string | null;
  /** `#recording`：滚到点评录音。 */
  toRecording: boolean;
  /** `?created=1`：刚新建完，光标落在「任务与最初需求」。 */
  created: boolean;
};

export function parseRetroCaseJump(search: string, hash: string): RetroCaseJump {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const t = params.get("t");
  const seconds = t !== null && t.trim() !== "" && Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : null;
  const part = Number(params.get("p") ?? 1);
  return {
    audioAssetId: params.get("audio") || null,
    seconds,
    partNo: Number.isInteger(part) && part >= 1 ? part : 1,
    roundId: params.get("round") || null,
    toRecording: hash === "#recording",
    created: params.get("created") === "1",
  };
}

export type RetroMonthJump = { tab: "CASES" | "MINUTES" | "METHODS"; focusSummary: boolean; seconds: number | null; partNo: number };

/** 月份页：`?tab=MINUTES|METHODS`、`?focus=summary&t=秒&p=段号`。 */
export function parseRetroMonthJump(search: string): RetroMonthJump {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  const t = params.get("t");
  const part = Number(params.get("p") ?? 1);
  const focusSummary = params.get("focus") === "summary";
  return {
    tab: tab === "MINUTES" || tab === "METHODS" ? tab : "CASES",
    focusSummary,
    seconds: focusSummary && t !== null && t.trim() !== "" && Number.isFinite(Number(t)) && Number(t) >= 0 ? Number(t) : null,
    partNo: Number.isInteger(part) && part >= 1 ? part : 1,
  };
}

// ---------------------------------------------------------------------------
// 草稿：本地先改（乐观），服务端回来再对齐（规格 6.6）
// ---------------------------------------------------------------------------

export type RetroDraftData = { minutes: RetroMinutes; methods: RetroMethods };

function updateItems(items: RetroItem[], itemId: string | undefined, apply: (item: RetroItem) => RetroItem | null): RetroItem[] {
  return items.flatMap((item) => {
    if (item.id !== itemId) return [item];
    const next = apply(item);
    return next ? [next] : [];
  });
}

/**
 * 把一次「改」或「删」先落到本地草稿上，让界面不用等一个来回；「补」要等服务端给 id，不在这里做。
 * 改文字的 AI 条目标 edited（老孙补充的不标）。返回新对象，不改入参。
 */
export function applyRetroDraftPatch<T extends RetroDraftData>(
  draft: T,
  request: Pick<RetroDraftPatchRequest, "section" | "caseId" | "itemId" | "op" | "value">,
): T {
  if (request.op === "ADD") return draft;
  const { section, caseId, itemId, op, value } = request;
  const text = value?.text;
  const touch = (item: RetroItem): RetroItem | null => {
    if (op === "DELETE") return null;
    return text === undefined ? item : { ...item, text, edited: item.origin === "AI" ? true : item.edited };
  };

  if (section === "insights" || section === "actions") {
    return { ...draft, minutes: { ...draft.minutes, [section]: updateItems(draft.minutes[section], itemId, touch) } };
  }
  if (section === "observations") {
    return { ...draft, methods: { ...draft.methods, observations: updateItems(draft.methods.observations, itemId, touch) } };
  }
  if (section === "candidates") {
    const candidates = draft.methods.candidates.flatMap((candidate) => {
      if (candidate.id !== itemId) return [candidate];
      if (op === "DELETE") return [];
      return [{ ...candidate, ...(value ?? {}), edited: candidate.origin === "AI" ? true : candidate.edited }];
    });
    return { ...draft, methods: { ...draft.methods, candidates } };
  }
  // case.*：落在对应案例的回顾里
  const field = section.slice("case.".length) as "process" | "disputes" | "founderPoints" | "suggestions";
  const cases = draft.minutes.cases.map((review) => {
    if (review.caseId !== caseId) return review;
    if (field === "process") return text === undefined ? review : { ...review, process: text };
    return { ...review, [field]: updateItems(review[field], itemId, touch) };
  });
  return { ...draft, minutes: { ...draft.minutes, cases } };
}

/** 草稿里「有没有什么能发布」：核心认识、改进事项、方法候选之外也可以空，所以只在整份都空时提醒。 */
export function retroDraftIsEmpty(draft: RetroDraftData): boolean {
  return draft.minutes.cases.every((review) => review.empty)
    && draft.minutes.insights.length === 0
    && draft.minutes.actions.length === 0
    && draft.methods.candidates.length === 0
    && draft.methods.observations.length === 0;
}

export const RETRO_DRAFT_SECTION_LABELS: Record<string, string> = {
  insights: "核心认识",
  actions: "改进事项",
  candidates: "方法候选",
  observations: "本月观察",
};

// ---------------------------------------------------------------------------
// 月份页：成果状态、在途任务
// ---------------------------------------------------------------------------

/** 在途（没到终态）的整理任务；已发布、已放弃的不算。 */
export function retroLiveJob(view: Pick<RetroMonthView, "job">): RetroJobView | null {
  return view.job && isRetroJobLive(view.job.status) ? view.job : null;
}

/** 月份页 hero 上的成果状态：有在途任务就是「整理中」（其他人看到的待审阅也显示成整理中），否则看发布与录音变动。 */
export function retroMonthBadgeFromView(view: Pick<RetroMonthView, "job" | "latestPublication" | "changedSincePublish">): RetroMonthBadge {
  const publishedVersion = view.latestPublication?.versionNumber ?? null;
  if (retroLiveJob(view)) return { state: "RUNNING", publishedVersion };
  if (publishedVersion) return { state: "PUBLISHED", version: publishedVersion, changed: view.changedSincePublish > 0 };
  return { state: "NONE" };
}

/**
 * 轮询结果能不能用：发请求时记下保存序号，回来时序号变了（期间有过保存）或者还有保存在途，就丢掉这次结果，
 * 免得把刚保存的内容盖回旧值。
 */
export function shouldApplyPoll(seqAtRequest: number, seqNow: number, inFlight: number): boolean {
  return seqAtRequest === seqNow && inFlight === 0;
}

/**
 * 吸底栏「重新生成」的闸门：读前提里的 canRegenerate／regenerateBlockedReason（有在途草稿时 canGenerate 本来就是 false，
 * 不能拿它当闸门）。字段是后端新加的，没给时放行，由服务端的事务检查兜底。
 */
export function retroRegenerateGate(pre: RetroGeneratePreconditions): { ok: boolean; reason: string | null } {
  if (pre.canRegenerate === undefined) return { ok: true, reason: null };
  return { ok: pre.canRegenerate, reason: pre.canRegenerate ? null : pre.regenerateBlockedReason ?? "现在还不能重新生成。" };
}

/** 老孙是不是正在审阅草稿（接口只给他草稿内容）。 */
export function isRetroReviewing(view: Pick<RetroMonthView, "job" | "viewer">): boolean {
  return view.viewer.isReviewer && view.job?.status === "PENDING_REVIEW" && view.job.draft !== null;
}

// ---------------------------------------------------------------------------
// 结果与讨论的版面：结果｜关键转折 两栏一行，反思、希望讨论的问题各占整行（2026-10-21）。
// 只剩一半的那一行也占整行；最后一行的格子不画底线，免得和模块边框叠成两条线。
// ---------------------------------------------------------------------------

export type RetroClosingField = "outcome" | "turningPoints" | "reflection" | "discussionQuestions";

const CLOSING_PAIR: readonly RetroClosingField[] = ["outcome", "turningPoints"];

export function retroClosingLayout(fields: readonly RetroClosingField[]): { wide: boolean; lastRow: boolean }[] {
  const pairShown = fields.filter((field) => CLOSING_PAIR.includes(field)).length;
  const cells = fields.map((field) => ({ wide: !CLOSING_PAIR.includes(field) || pairShown < 2, lastRow: false }));
  if (cells.length) {
    const last = cells.length - 1;
    cells[last].lastRow = true;
    if (!cells[last].wide && last > 0 && !cells[last - 1].wide) cells[last - 1].lastRow = true;
  }
  return cells;
}
