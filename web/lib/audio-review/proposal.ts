// 模型输出 → 存进 audio_reviews.proposal_json 的提案（docs/25 4.6），以及确认时把选中的改动
// 套到快照上（4.9 第 2 步）。全部是纯函数：不碰数据库、不碰网络，重点单测在
// tests/audio-review-proposal.test.ts。
//
// 校验原则：模型给的东西一律当不可信输入。键不在快照里、不在白名单里、取值不合规的改动
// 丢弃并把原因记进 dropped（不给老孙看，留作排查），绝不让一处坏改动拖垮整份提案。
// 留下来的改动保证「单独套用」和「全部一起套用」都过 assertV04PayloadContract——
// 能相互影响的字段只成对出现（主/辅机制、桥段主/辅作用），所以老孙勾掉任意几处后仍然合规。

import type {
  AudioReviewChange,
  AudioReviewOpinion,
  AudioReviewOpinionKind,
  AudioReviewValueType,
} from "@/lib/audio-review-model";
import {
  V04_VOCABULARY_VERSION,
  type V04Change,
  type V04ChoiceValue,
  type V04DraftPayloadV1,
  type V04PerceptionType,
  type V04RevisionValueType,
} from "@/lib/v04-contract";
import {
  applyV04ChangeSetUnchecked,
  assertV04PayloadContract,
  listV04ContractViolations,
  locateTarget,
} from "@/lib/v04-domain";
import { normalizeThinkingChainText } from "@/lib/thinking-chain";
import { V04_VOCABULARY_OPTIONS, type V04VocabularyFieldKey } from "@/lib/v04-vocabulary";
import {
  AUXILIARY_FIELDS,
  CARRIER_LABELS,
  FACT_FIELDS,
  GROUP_FIELDS,
  PRIMARY_DETAIL_KEYS,
  READ_ONLY_SHOT_FIELDS,
  SHOT_TEXT_FIELDS,
  listEditableItems,
  optionLabel,
  perceptionTypeFromLabel,
  perceptionTypeLabel,
  primaryDetailLabel,
  type EditableItem,
} from "./fields";
import { dominantSpeaker, type AudioReviewTranscriptSegment } from "./transcript";

export const AUDIO_REVIEW_TEXT_MAX_LENGTH = 5000;

export type StoredAudioReviewProposal = {
  speakers: { reviewer: string; labels: Record<string, string> };
  opinions: AudioReviewOpinion[];
  changes: AudioReviewChange[];
  unaddressed: { segmentIds: number[]; reason: string }[];
  corrections: { segmentId: number; from: string; to: string }[];
  dropped: { key: string; reason: string }[];
};

export type ProposalContext = {
  snapshot: V04DraftPayloadV1;
  segments: readonly AudioReviewTranscriptSegment[];
};

/** 主导路径切换的取值：路径类型连同新路径的全部细项，作为一处改动整体确认或整体取消。 */
export type PrimaryPathValue = { primaryType: V04PerceptionType | ""; primaryDetails: Record<string, string> };

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(stable(left ?? null)) === JSON.stringify(stable(right ?? null));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function substantiveLength(value: string) {
  return value.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 取值归一
// ---------------------------------------------------------------------------

const CHAIN_MARK = /^[ \t　]*[-–·•*]\s+/;
const CHAIN_MARK_AT_ZERO = /^[-–·•*]\s+/;

/**
 * 创意思维链按 docs/24 第三节的存储格式规范化。模型常按普通 Markdown 习惯把第一层步骤的「- 」
 * 顶格写在中心下面；而存储格式只认缩进定层级，顶格的「- 步骤」会被读成一条条新的思维链。
 * 所以只要有顶格的带记号行、又有不带记号的中心行，就把所有带记号的行整体右移两格再规范化。
 */
export function normalizeModelThinkingChain(text: string) {
  let lines = text.split(/\r?\n/);
  const markAtZero = lines.some((line) => CHAIN_MARK_AT_ZERO.test(line));
  const hasCentre = lines.some((line) => line.trim() && !CHAIN_MARK.test(line));
  if (markAtZero && hasCentre) lines = lines.map((line) => (CHAIN_MARK.test(line) ? `  ${line}` : line));
  return normalizeThinkingChainText(lines.join("\n"));
}

function normalizeText(value: unknown, options: { thinkingChain?: boolean } = {}): Normalized<string> {
  if (typeof value !== "string") return { ok: false, reason: "改后内容不是文字" };
  let result = value.trim();
  if (options.thinkingChain) result = normalizeModelThinkingChain(value);
  if (!result) return { ok: false, reason: "改后内容为空" };
  if (result.length > AUDIO_REVIEW_TEXT_MAX_LENGTH) return { ok: false, reason: "改后内容过长" };
  return { ok: true, value: result };
}

function normalizeRating(value: unknown): Normalized<"S" | "A" | "B" | "C"> {
  const raw = typeof value === "string" ? value.replace(/[\s级]/g, "").toUpperCase() : "";
  if (raw === "S" || raw === "A" || raw === "B" || raw === "C") return { ok: true, value: raw };
  return { ok: false, reason: "整体创意评价只能是 S、A、B、C" };
}

const LABEL_TO_OPTION = new Map<string, Map<string, string>>();
for (const option of V04_VOCABULARY_OPTIONS) {
  const map = LABEL_TO_OPTION.get(option.fieldKey) ?? new Map<string, string>();
  map.set(option.labelZhCn, option.optionId);
  map.set(option.optionId, option.optionId);
  LABEL_TO_OPTION.set(option.fieldKey, map);
}

/** 标签精确映射成 optionId（容忍首尾空白和半角斜杠），映射不上就整处丢弃。 */
export function optionIdForLabel(field: V04VocabularyFieldKey, label: string) {
  const map = LABEL_TO_OPTION.get(field);
  const normalized = label.trim().replace(/\s+/g, "").replace(/\//g, "／");
  return map?.get(label.trim()) ?? map?.get(normalized) ?? null;
}

function asLabelList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(/[、,，;；]/).map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return (value as string[]).map((item) => item.trim()).filter(Boolean);
  }
  return null;
}

function normalizeChoice(
  value: unknown,
  before: V04ChoiceValue,
  field: V04VocabularyFieldKey,
  maxOptions: number,
  mechanism: boolean,
): Normalized<V04ChoiceValue> {
  // 允许直接给一个标签或标签数组，当作只改选项。
  const record: Record<string, unknown> = isRecord(value)
    ? value
    : typeof value === "string" || Array.isArray(value) ? { options: value } : {};
  if (!isRecord(value) && !("options" in record)) return { ok: false, reason: "选项字段的取值结构不对" };
  const labels = "options" in record ? asLabelList(record.options) : null;
  if (labels === null && "options" in record) return { ok: false, reason: "options 必须是标签数组" };
  let selectedOptionIds = before.selectedOptionIds;
  if (labels !== null) {
    const ids: string[] = [];
    for (const label of labels) {
      const id = optionIdForLabel(field, label);
      if (!id) return { ok: false, reason: `「${label}」不在词表里` };
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > maxOptions) return { ok: false, reason: `固定选项最多选 ${maxOptions} 项` };
    selectedOptionIds = ids;
  }
  const customText = "custom" in record
    ? (typeof record.custom === "string" ? record.custom.trim() : null)
    : before.customText;
  if (customText === null) return { ok: false, reason: "custom 必须是文字" };
  let advancedText = before.advancedText ?? "";
  if (mechanism && "advanced" in record) {
    if (typeof record.advanced !== "string") return { ok: false, reason: "advanced 必须是文字" };
    advancedText = record.advanced.trim();
  }
  if (mechanism && selectedOptionIds.includes("PENDING_NEW_MECHANISM") && !advancedText) {
    return { ok: false, reason: "选了「现有词表不适用／待形成新机制」却没有写进阶机制层" };
  }
  if (selectedOptionIds.length === 0 && !customText && !(mechanism && advancedText)) {
    return { ok: false, reason: "改后内容为空" };
  }
  return {
    ok: true,
    value: {
      ...before,
      selectedOptionIds,
      customText,
      advancedText,
      vocabularyVersion: V04_VOCABULARY_VERSION,
    },
  };
}

const CARRIER_BY_LABEL = new Map<string, "STORY" | "COPY" | "AUDIOVISUAL_RULE">(
  (Object.entries(CARRIER_LABELS) as Array<["STORY" | "COPY" | "AUDIOVISUAL_RULE", string]>)
    .flatMap(([code, label]) => [[label, code], [code, code]] as const),
);

function normalizeCarriers(value: unknown): Normalized<Array<"STORY" | "COPY" | "AUDIOVISUAL_RULE">> {
  const labels = asLabelList(value);
  if (labels === null) return { ok: false, reason: "承重载体必须是标签数组" };
  const codes: Array<"STORY" | "COPY" | "AUDIOVISUAL_RULE"> = [];
  for (const label of labels) {
    const code = CARRIER_BY_LABEL.get(label);
    if (!code) return { ok: false, reason: `承重载体只能是「故事」「文案」「视听规则」，不能是「${label}」` };
    if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) return { ok: false, reason: "改后内容为空" };
  return { ok: true, value: codes };
}

// ---------------------------------------------------------------------------
// 键解析
// ---------------------------------------------------------------------------

type ResolvedKey =
  | { kind: "FIELD"; item: EditableItem; before: unknown }
  | { kind: "PRIMARY_TYPE"; item: EditableItem }
  | { kind: "PRIMARY_DETAIL"; subKey: string }
  | { kind: "ERROR"; reason: string };

function resolveKey(snapshot: V04DraftPayloadV1, items: Map<string, EditableItem>, rawKey: string): ResolvedKey {
  const key = rawKey.trim();
  if (!key) return { kind: "ERROR", reason: "缺少键" };
  if (key === "path.primaryType") return { kind: "PRIMARY_TYPE", item: items.get(key)! };

  const detail = /^path\.primaryDetails\.(.+)$/.exec(key);
  if (detail) {
    const sub = detail[1].trim();
    const known = Object.values(PRIMARY_DETAIL_KEYS).some((keys) => keys.includes(sub));
    if (known) return { kind: "PRIMARY_DETAIL", subKey: sub };
    // 模型偶尔会写细项的中文名而不是键。
    for (const type of ["LOVE", "FUN", "PERCEPTION"] as const) {
      const match = PRIMARY_DETAIL_KEYS[type].find((subKey) => primaryDetailLabel(type, subKey) === sub);
      if (match) return { kind: "PRIMARY_DETAIL", subKey: match };
    }
    return { kind: "ERROR", reason: "主导路径细项的键不存在" };
  }

  const auxiliary = /^path\.auxiliaryTypes\.([^.]+)\.(.+)$/.exec(key);
  if (auxiliary) {
    const type = perceptionTypeFromLabel(auxiliary[1]);
    const field = AUXILIARY_FIELDS.find((item) => item.key === auxiliary[2]);
    if (!type || !field) return { kind: "ERROR", reason: "辅助路径的键不存在" };
    const item = items.get(`path.auxiliaryTypes.${type}.${field.key}`);
    if (!item) return { kind: "ERROR", reason: "作业里没有这条辅助路径（不能新增辅助路径）" };
    const aux = snapshot.perceptionPath.auxiliaryTypes.find((entry) => entry.type === type)!;
    return { kind: "FIELD", item, before: aux[field.key] ?? "" };
  }

  const shot = /^shot:([^.]+)\.(.+)$/.exec(key);
  if (shot && (READ_ONLY_SHOT_FIELDS as readonly string[]).includes(shot[2])) {
    return { kind: "ERROR", reason: "时间码只读，不能改" };
  }
  const item = items.get(key);
  if (!item) {
    if (/^(metadata|contract)\b/.test(key) || key === "script.structure" || /\.shots$/.test(key)) {
      return { kind: "ERROR", reason: "不在可改范围（结构、元数据、契约不改）" };
    }
    if (shot || /^shotGroup:/.test(key)) return { kind: "ERROR", reason: "快照里没有这个桥段或镜头字段（不能增删桥段和镜头）" };
    return { kind: "ERROR", reason: "键不存在或不在可改白名单内" };
  }
  const located = locateTarget(snapshot, item.targetKey);
  return { kind: "FIELD", item, before: located ? located.object[located.key] : undefined };
}

function normalizeFieldValue(item: EditableItem, before: unknown, value: unknown): Normalized<unknown> {
  switch (item.valueType) {
    case "TEXT":
    case "PATH_DETAIL":
    case "PATH_AUXILIARY":
      return normalizeText(value, { thinkingChain: item.key === "facts.creativeThinkingChain" });
    case "RATING":
      return normalizeRating(value);
    case "CARRIERS":
      return normalizeCarriers(value);
    case "CHOICE":
    case "MECHANISM":
      return normalizeChoice(
        value,
        before as V04ChoiceValue,
        item.vocabulary!,
        item.maxOptions ?? 1,
        item.valueType === "MECHANISM",
      );
    default:
      return { ok: false, reason: "不支持的字段类型" };
  }
}

// ---------------------------------------------------------------------------
// 人看的「原 → 改」
// ---------------------------------------------------------------------------

export function formatAudioReviewValue(valueType: AudioReviewValueType, value: unknown): string {
  const empty = "（空）";
  switch (valueType) {
    case "TEXT":
    case "PATH_DETAIL":
    case "PATH_AUXILIARY":
    case "RATING":
      return text(value) || empty;
    case "CARRIERS": {
      const list = Array.isArray(value) ? value.map((code) => CARRIER_LABELS[code as keyof typeof CARRIER_LABELS] ?? String(code)) : [];
      return list.length ? list.join("、") : empty;
    }
    case "CHOICE":
    case "MECHANISM": {
      const choice = (isRecord(value) ? value : {}) as Partial<V04ChoiceValue>;
      const labels = (choice.selectedOptionIds ?? []).map(optionLabel).join("、");
      const custom = text(choice.customText);
      const advanced = valueType === "MECHANISM" ? text(choice.advancedText) : "";
      let result = valueType === "MECHANISM"
        ? [labels, custom].filter(Boolean).join("｜")
        : [labels, custom ? `自定义：${custom}` : ""].filter(Boolean).join(" ＋ ");
      if (advanced) result = `${result}${result ? "\n" : ""}进阶机制层：${advanced}`;
      return result || empty;
    }
    case "PATH_PRIMARY": {
      const path = (isRecord(value) ? value : {}) as Partial<PrimaryPathValue>;
      if (!path.primaryType) return empty;
      const lines = [perceptionTypeLabel(path.primaryType)];
      for (const subKey of PRIMARY_DETAIL_KEYS[path.primaryType]) {
        lines.push(`${primaryDetailLabel(path.primaryType, subKey)}：${text(path.primaryDetails?.[subKey]) || empty}`);
      }
      return lines.join("\n");
    }
    default:
      return text(value) || empty;
  }
}

// ---------------------------------------------------------------------------
// 套用：选中的改动 → V04 变更集 → 改后快照
// ---------------------------------------------------------------------------

const V04_VALUE_TYPE: Record<AudioReviewValueType, V04RevisionValueType> = {
  TEXT: "TEXT",
  RATING: "TEXT",
  CHOICE: "CHOICE_WITH_CUSTOM",
  MECHANISM: "CHOICE_WITH_CUSTOM",
  CARRIERS: "MULTI_SELECT",
  PATH_DETAIL: "STRUCTURE",
  PATH_PRIMARY: "SINGLE_SELECT",
  PATH_AUXILIARY: "STRUCTURE",
};

type ApplicableChange = Pick<AudioReviewChange, "key" | "targetKey" | "subKey" | "label" | "valueType" | "after" | "opinionIds">;

/**
 * 按落库键合并（细项合并成一个 primaryDetails 对象、辅助路径合并成一个数组），生成 V04 变更集，
 * beforeValue 取快照值；返回套用后的快照（不做契约校验，调用方决定怎么报错）。
 * `reasonFor` 给每条变更写修订原因（「录音点评 意见 N」）。
 */
export function buildAudioReviewChangeSet(
  snapshot: V04DraftPayloadV1,
  changes: readonly ApplicableChange[],
  reasonFor: (opinionIds: readonly string[]) => string = () => "录音点评",
): { changes: V04Change[]; payload: V04DraftPayloadV1 } {
  const v04Changes: V04Change[] = [];
  const path = snapshot.perceptionPath;
  let details: { value: Record<string, string>; opinionIds: Set<string> } | null = null;
  let auxiliaries: { value: V04DraftPayloadV1["perceptionPath"]["auxiliaryTypes"]; opinionIds: Set<string> } | null = null;

  for (const change of changes) {
    if (change.valueType === "PATH_PRIMARY") {
      const after = change.after as PrimaryPathValue;
      v04Changes.push({
        targetKey: "path.primaryType",
        targetLabel: "第三模块 · 主导路径",
        valueType: "SINGLE_SELECT",
        beforeValue: path.primaryType,
        afterValue: after.primaryType,
        reason: reasonFor(change.opinionIds),
      });
      details = { value: { ...after.primaryDetails }, opinionIds: new Set(change.opinionIds) };
      continue;
    }
    if (change.valueType === "PATH_DETAIL") {
      details ??= { value: { ...path.primaryDetails }, opinionIds: new Set() };
      details.value[change.subKey!] = change.after as string;
      change.opinionIds.forEach((id) => details!.opinionIds.add(id));
      continue;
    }
    if (change.valueType === "PATH_AUXILIARY") {
      auxiliaries ??= { value: structuredClone(path.auxiliaryTypes), opinionIds: new Set() };
      const [type, field] = change.subKey!.split(".") as [string, "description" | "creativeRole"];
      const target = auxiliaries.value.find((entry) => entry.type === type);
      if (target) target[field] = change.after as string;
      change.opinionIds.forEach((id) => auxiliaries!.opinionIds.add(id));
      continue;
    }
    const located = locateTarget(snapshot, change.targetKey);
    v04Changes.push({
      targetKey: change.targetKey,
      targetLabel: change.label,
      valueType: V04_VALUE_TYPE[change.valueType],
      beforeValue: located ? structuredClone(located.object[located.key]) : null,
      afterValue: structuredClone(change.after),
      reason: reasonFor(change.opinionIds),
    });
  }
  if (details) {
    v04Changes.push({
      targetKey: "path.primaryDetails",
      targetLabel: "第三模块 · 主导路径细项",
      valueType: "STRUCTURE",
      beforeValue: structuredClone(path.primaryDetails),
      afterValue: details.value,
      reason: reasonFor([...details.opinionIds]),
    });
  }
  if (auxiliaries) {
    v04Changes.push({
      targetKey: "path.auxiliaryTypes",
      targetLabel: "第三模块 · 辅助路径",
      valueType: "STRUCTURE",
      beforeValue: structuredClone(path.auxiliaryTypes),
      afterValue: auxiliaries.value,
      reason: reasonFor([...auxiliaries.opinionIds]),
    });
  }
  return { changes: v04Changes, payload: applyV04ChangeSetUnchecked(snapshot, v04Changes) };
}

function contractProblem(payload: V04DraftPayloadV1): string | null {
  try {
    assertV04PayloadContract(payload);
    return null;
  } catch {
    const violations = listV04ContractViolations(payload);
    return violations.length
      ? `不符合选项规则：${violations.map((item) => `${item.targetLabel}（${item.message}）`).join("；")}`
      : "不符合工作稿契约";
  }
}

/** 套用一组改动并给出违反契约的原因（无违反时为 null）。 */
export function checkAudioReviewChanges(snapshot: V04DraftPayloadV1, changes: readonly ApplicableChange[]) {
  try {
    const { payload } = buildAudioReviewChangeSet(snapshot, changes);
    return contractProblem(payload);
  } catch {
    return "改动无法套用到快照上";
  }
}

// ---------------------------------------------------------------------------
// 归一：模型输出 → 存库的提案
// ---------------------------------------------------------------------------

type Candidate = {
  key: string;
  item: EditableItem;
  before: unknown;
  after: unknown;
  rawOpinionIds: string[];
  order: number;
};

type DetailCandidate = { subKey: string; value: unknown; rawOpinionIds: string[]; order: number; key: string };

function rawIdList(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" || typeof item === "number").map(String);
}

function segmentIdList(value: unknown, valid: Set<number>): number[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const ids: number[] = [];
  for (const item of list) {
    const id = Number(item);
    if (Number.isInteger(id) && valid.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((left, right) => left - right);
}

function normalizeKind(value: unknown): AudioReviewOpinionKind {
  return text(value).toUpperCase() === "GENERAL" || text(value) === "总体" ? "GENERAL" : "SPECIFIC";
}

export const UNADDRESSED_FALLBACK_REASON = "系统补列：模型没有把这段话归入任何意见或说明，请人工核对。";
/** 老孙的话去掉标点后不少于这么多字才算「实质发言」，没被归类时由系统补列。 */
export const SUBSTANTIVE_SEGMENT_MIN_CHARS = 12;

export function normalizeAudioReviewProposal(raw: unknown, context: ProposalContext): StoredAudioReviewProposal {
  const input = isRecord(raw) ? raw : {};
  const { snapshot, segments } = context;
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const validSegmentIds = new Set(segmentById.keys());
  const speakerIds = new Set(segments.map((segment) => segment.speakerId));
  const dropped: StoredAudioReviewProposal["dropped"] = [];

  // 说话人
  const rawSpeakers = isRecord(input.speakers) ? input.speakers : {};
  const reviewer = typeof rawSpeakers.reviewer === "string" && speakerIds.has(rawSpeakers.reviewer.trim())
    ? rawSpeakers.reviewer.trim()
    : dominantSpeaker(segments);
  const labels: Record<string, string> = {};
  if (isRecord(rawSpeakers.labels)) {
    for (const [speaker, label] of Object.entries(rawSpeakers.labels)) {
      const name = text(label).slice(0, 20);
      if (speakerIds.has(speaker) && speaker !== reviewer && name) labels[speaker] = name;
    }
  }

  // 意见：按引用片段的最早时间排序，编号 1…N，id 统一换成 o1…oN。
  const rawOpinions = Array.isArray(input.opinions) ? input.opinions : [];
  const parsedOpinions: Array<{
    rawId: string; kind: AudioReviewOpinionKind; summary: string; rationale: string; segmentIds: number[]; index: number;
  }> = [];
  const seenRawIds = new Set<string>();
  rawOpinions.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const summary = text(entry.summary);
    if (!summary) {
      dropped.push({ key: `opinion:${String(entry.id ?? index)}`, reason: "意见没有摘要" });
      return;
    }
    let rawId = text(entry.id) || String(entry.id ?? "") || `#${index}`;
    if (seenRawIds.has(rawId)) rawId = `${rawId}#${index}`;
    seenRawIds.add(rawId);
    parsedOpinions.push({
      rawId,
      kind: normalizeKind(entry.kind),
      summary,
      rationale: text(entry.rationale),
      segmentIds: segmentIdList(entry.segmentIds, validSegmentIds),
      index,
    });
  });
  const earliest = (ids: number[]) => ids.length
    ? Math.min(...ids.map((id) => segmentById.get(id)!.startMs))
    : Number.POSITIVE_INFINITY;
  parsedOpinions.sort((left, right) => earliest(left.segmentIds) - earliest(right.segmentIds) || left.index - right.index);
  const opinionIdByRaw = new Map<string, string>();
  const opinions: AudioReviewOpinion[] = parsedOpinions.map((opinion, index) => {
    const id = `o${index + 1}`;
    opinionIdByRaw.set(opinion.rawId, id);
    return {
      id,
      number: index + 1,
      kind: opinion.kind,
      summary: opinion.summary,
      rationale: opinion.rationale,
      segmentIds: opinion.segmentIds,
      changeIds: [],
    };
  });
  const opinionNumber = new Map(opinions.map((opinion) => [opinion.id, opinion.number]));
  const mapOpinionIds = (rawIds: readonly string[]) => {
    const ids = [...new Set(rawIds.map((id) => opinionIdByRaw.get(id)).filter((id): id is string => Boolean(id)))];
    return ids.sort((left, right) => opinionNumber.get(left)! - opinionNumber.get(right)!);
  };

  // 改动：先解析键与取值，同一个键出现多次就合并（取最后一次的值，意见取并集）。
  const items = new Map(listEditableItems(snapshot).map((item) => [item.key, item]));
  const fieldCandidates = new Map<string, Candidate>();
  const detailCandidates = new Map<string, DetailCandidate>();
  let typeCandidate: { value: unknown; rawOpinionIds: string[]; order: number } | null = null;
  const rawChanges = Array.isArray(input.changes) ? input.changes : [];
  rawChanges.forEach((entry, order) => {
    if (!isRecord(entry)) return;
    const key = text(entry.key);
    const rawOpinionIds = rawIdList(entry.opinionIds ?? entry.opinionId);
    if (mapOpinionIds(rawOpinionIds).length === 0) {
      dropped.push({ key, reason: "没有对应的意见" });
      return;
    }
    const resolved = resolveKey(snapshot, items, key);
    if (resolved.kind === "ERROR") {
      dropped.push({ key, reason: resolved.reason });
      return;
    }
    if (resolved.kind === "PRIMARY_TYPE") {
      typeCandidate = {
        value: entry.value,
        rawOpinionIds: [...new Set([...(typeCandidate?.rawOpinionIds ?? []), ...rawOpinionIds])],
        order,
      };
      return;
    }
    if (resolved.kind === "PRIMARY_DETAIL") {
      const previous = detailCandidates.get(resolved.subKey);
      detailCandidates.set(resolved.subKey, {
        subKey: resolved.subKey,
        key: `path.primaryDetails.${resolved.subKey}`,
        value: entry.value,
        rawOpinionIds: [...new Set([...(previous?.rawOpinionIds ?? []), ...rawOpinionIds])],
        order: previous?.order ?? order,
      });
      return;
    }
    const normalized = normalizeFieldValue(resolved.item, resolved.before, entry.value);
    if (!normalized.ok) {
      dropped.push({ key, reason: normalized.reason });
      return;
    }
    const previous = fieldCandidates.get(resolved.item.key);
    fieldCandidates.set(resolved.item.key, {
      key: resolved.item.key,
      item: resolved.item,
      before: resolved.before,
      after: normalized.value,
      rawOpinionIds: [...new Set([...(previous?.rawOpinionIds ?? []), ...rawOpinionIds])],
      order: previous?.order ?? order,
    });
  });

  type Built = Omit<AudioReviewChange, "id" | "beforeText" | "afterText"> & { position: number };
  const built: Built[] = [];
  const pushBuilt = (item: EditableItem, before: unknown, after: unknown, rawOpinionIds: string[], key = item.key) => {
    if (sameValue(before, after)) {
      dropped.push({ key, reason: "与原值相同" });
      return;
    }
    built.push({
      key,
      targetKey: item.targetKey,
      subKey: item.subKey,
      label: item.label,
      valueType: item.valueType,
      before: structuredClone(before ?? null),
      after,
      opinionIds: mapOpinionIds(rawOpinionIds),
      position: item.position,
    });
  };

  for (const candidate of fieldCandidates.values()) {
    pushBuilt(candidate.item, candidate.before, candidate.after, candidate.rawOpinionIds);
  }

  // 主导路径与细项。
  const path = snapshot.perceptionPath;
  const typeItem = items.get("path.primaryType")!;
  const pendingType = typeCandidate as { value: unknown; rawOpinionIds: string[]; order: number } | null;
  let switchedTo: V04PerceptionType | null = null;
  // 切换失败时，同一批细项是照着新路径写的，套到旧路径上会张冠李戴（「主要承重元素」两边同名），一并丢弃。
  const dropAllDetails = () => {
    for (const detail of detailCandidates.values()) {
      dropped.push({ key: detail.key, reason: "所属的主导路径切换被丢弃" });
    }
    detailCandidates.clear();
  };
  if (pendingType) {
    const nextType = perceptionTypeFromLabel(pendingType.value);
    if (!nextType) {
      dropped.push({ key: "path.primaryType", reason: "主导路径只能是有爱／情感、有趣／预期、有料／感知" });
      dropAllDetails();
    } else if (nextType === path.primaryType) {
      // 没切换：细项照常按当前路径校验。
      dropped.push({ key: "path.primaryType", reason: "与原值相同" });
    } else if (path.auxiliaryTypes.some((auxiliary) => auxiliary.type === nextType)) {
      dropped.push({ key: "path.primaryType", reason: `新的主导路径「${perceptionTypeLabel(nextType)}」与辅助路径重复` });
      dropAllDetails();
    } else {
      const required = PRIMARY_DETAIL_KEYS[nextType];
      const values: Record<string, string> = {};
      let problem: string | null = null;
      for (const subKey of required) {
        const detail = detailCandidates.get(subKey);
        if (!detail) {
          problem = `切换主导路径时没有给出新路径的全部细项（缺「${primaryDetailLabel(nextType, subKey)}」）`;
          break;
        }
        const normalized = normalizeText(detail.value);
        if (!normalized.ok) {
          problem = `新路径细项「${primaryDetailLabel(nextType, subKey)}」${normalized.reason}`;
          break;
        }
        values[subKey] = normalized.value;
      }
      if (problem) {
        dropped.push({ key: "path.primaryType", reason: problem });
        dropAllDetails();
      } else {
        switchedTo = nextType;
        const opinionRawIds = [...pendingType.rawOpinionIds];
        for (const detail of detailCandidates.values()) {
          if (required.includes(detail.subKey)) opinionRawIds.push(...detail.rawOpinionIds);
          else dropped.push({ key: detail.key, reason: "主导路径已切换，这一项不属于新路径" });
        }
        pushBuilt(
          typeItem,
          { primaryType: path.primaryType, primaryDetails: structuredClone(path.primaryDetails) },
          { primaryType: nextType, primaryDetails: values },
          [...new Set(opinionRawIds)],
        );
      }
      detailCandidates.clear();
    }
  }
  if (!switchedTo) {
    for (const detail of detailCandidates.values()) {
      if (!path.primaryType) {
        dropped.push({ key: detail.key, reason: "作业还没有选主导路径，细项无处可落" });
        continue;
      }
      const item = items.get(detail.key);
      if (!item) {
        dropped.push({ key: detail.key, reason: "不属于当前主导路径的细项" });
        continue;
      }
      const normalized = normalizeText(detail.value);
      if (!normalized.ok) {
        dropped.push({ key: detail.key, reason: normalized.reason });
        continue;
      }
      pushBuilt(item, path.primaryDetails[detail.subKey] ?? "", normalized.value, detail.rawOpinionIds);
    }
  }

  // 契约：每处单独套用必须合规，按工作台顺序累加也必须合规；不合规的那一处丢弃。
  built.sort((left, right) => left.position - right.position);
  const accepted: Built[] = [];
  for (const change of built) {
    const alone = checkAudioReviewChanges(snapshot, [change]);
    if (alone) {
      dropped.push({ key: change.key, reason: alone });
      continue;
    }
    const together = checkAudioReviewChanges(snapshot, [...accepted, change]);
    if (together) {
      dropped.push({ key: change.key, reason: `与前面的改动合在一起${together}` });
      continue;
    }
    accepted.push(change);
  }

  const changes: AudioReviewChange[] = accepted.map((change, index) => ({
    id: `c${index + 1}`,
    key: change.key,
    targetKey: change.targetKey,
    subKey: change.subKey,
    label: change.label,
    valueType: change.valueType,
    before: change.before,
    after: change.after,
    beforeText: formatAudioReviewValue(change.valueType, change.before),
    afterText: formatAudioReviewValue(change.valueType, change.after),
    opinionIds: change.opinionIds,
  }));
  for (const opinion of opinions) {
    opinion.changeIds = changes.filter((change) => change.opinionIds.includes(opinion.id)).map((change) => change.id);
  }

  // 没落到条目的话
  const unaddressed: StoredAudioReviewProposal["unaddressed"] = [];
  for (const entry of Array.isArray(input.unaddressed) ? input.unaddressed : []) {
    if (!isRecord(entry)) continue;
    const segmentIds = segmentIdList(entry.segmentIds ?? entry.segmentId, validSegmentIds);
    if (segmentIds.length === 0) continue;
    unaddressed.push({ segmentIds, reason: text(entry.reason) || "没有落到具体条目" });
  }
  // 老孙的每段实质发言，要么被意见引用，要么进「没落到条目的话」——模型漏了的由系统补列。
  const covered = new Set<number>([
    ...opinions.flatMap((opinion) => opinion.segmentIds),
    ...unaddressed.flatMap((entry) => entry.segmentIds),
  ]);
  for (const segment of segments) {
    if (segment.speakerId !== reviewer || covered.has(segment.id)) continue;
    if (substantiveLength(segment.text) < SUBSTANTIVE_SEGMENT_MIN_CHARS) continue;
    unaddressed.push({ segmentIds: [segment.id], reason: UNADDRESSED_FALLBACK_REASON });
  }
  unaddressed.sort((left, right) => earliest(left.segmentIds) - earliest(right.segmentIds));

  // 同音错字校正：只留文字稿里真有「原词」的。
  const corrections: StoredAudioReviewProposal["corrections"] = [];
  for (const entry of Array.isArray(input.corrections) ? input.corrections : []) {
    if (!isRecord(entry)) continue;
    const segmentId = Number(entry.segmentId);
    const from = text(entry.from);
    const to = text(entry.to);
    const segment = segmentById.get(segmentId);
    if (!segment || !from || !to || from === to || !segment.text.includes(from)) continue;
    if (corrections.some((item) => item.segmentId === segmentId && item.from === from)) continue;
    corrections.push({ segmentId, from, to });
  }

  return { speakers: { reviewer, labels }, opinions, changes, unaddressed, corrections, dropped };
}

/** 存库的 proposal_json → 结构（读库时用；坏数据返回 null）。 */
export function parseStoredProposal(value: unknown): StoredAudioReviewProposal | null {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!isRecord(raw) || !Array.isArray(raw.opinions) || !Array.isArray(raw.changes)) return null;
  return {
    speakers: isRecord(raw.speakers)
      ? {
        reviewer: typeof raw.speakers.reviewer === "string" ? raw.speakers.reviewer : "S0",
        labels: isRecord(raw.speakers.labels) ? raw.speakers.labels as Record<string, string> : {},
      }
      : { reviewer: "S0", labels: {} },
    opinions: raw.opinions as AudioReviewOpinion[],
    changes: raw.changes as AudioReviewChange[],
    unaddressed: Array.isArray(raw.unaddressed) ? raw.unaddressed as StoredAudioReviewProposal["unaddressed"] : [],
    corrections: Array.isArray(raw.corrections) ? raw.corrections as StoredAudioReviewProposal["corrections"] : [],
    dropped: Array.isArray(raw.dropped) ? raw.dropped as StoredAudioReviewProposal["dropped"] : [],
  };
}

/** 「录音点评 意见 1、3」——修订事件的 reason。 */
export function audioReviewChangeReason(opinionIds: readonly string[], opinions: readonly AudioReviewOpinion[]) {
  const numbers = opinionIds
    .map((id) => opinions.find((opinion) => opinion.id === id)?.number)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right);
  return numbers.length ? `录音点评 意见 ${numbers.join("、")}` : "录音点评";
}

// 供提示词与测试引用的字段清单（避免两处各写一份）。
export { FACT_FIELDS, GROUP_FIELDS, SHOT_TEXT_FIELDS };
