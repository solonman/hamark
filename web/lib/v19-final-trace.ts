// 集成版溯源视图的纯函数：从 `finalTrace`（`originPayload` + `intakes`）推出
// 一个字段的来源链、当前采用是哪一条、hover 提示用的最新来源，以及横幅下方
// 待采纳的结构改动列表。见 docs/20_最终版与评论跨版本_实施规格_V0.1.md 五、18/19。
//
// 只依赖 `V04DraftPayloadV1` 的形状、`V19FinalIntake` 的形状与
// `lib/v04-vocabulary.ts` 的固定选项表，不导入 `lib/v04-domain.ts`（它顶层
// `import "node:crypto"`，不能进浏览器包 —— 与 `lib/v19-ui-model.ts` 里
// `formatV19VersionLabel` 保留客户端安全副本是同一个理由）。组件层
// （`V19StudioDocument.tsx` / `V04ChoiceField.tsx` / `V04StudioClient.tsx`）
// 只管把这里算出的结果渲染出来，不重新做推导。

import type { V04DraftPayloadV1 } from "./v04-contract";
import type { V19FinalIntake } from "./v19-ui-model";
import { formatShortDateTime } from "./date-format";
import { V04_VOCABULARY_OPTIONS, type V04VocabularyFieldKey } from "./v04-vocabulary";

// ---------------------------------------------------------------------------
// 定位字段（`lib/v04-domain.ts` 的 `locateTarget` 的客户端安全副本）
// ---------------------------------------------------------------------------

function locateV19FinalTarget(
  payload: V04DraftPayloadV1,
  targetKey: string,
): { object: Record<string, unknown>; key: string } | null {
  const groupMatch = targetKey.match(/^shotGroup:([^.]+)\.(.+)$/);
  if (groupMatch) {
    const group = payload.script.shotGroups.find((item) => item.id === groupMatch[1]);
    return group ? { object: group as unknown as Record<string, unknown>, key: groupMatch[2] } : null;
  }
  const shotMatch = targetKey.match(/^shot:([^.]+)\.(.+)$/);
  if (shotMatch) {
    const shot = payload.script.shotGroups.flatMap((group) => group.shots)
      .find((item) => item.id === shotMatch[1]);
    return shot ? { object: shot as unknown as Record<string, unknown>, key: shotMatch[2] } : null;
  }
  const prefixes: Array<[string, Record<string, unknown>]> = [
    ["facts.", payload.factsAndCoreJudgement as unknown as Record<string, unknown>],
    ["path.", payload.perceptionPath as unknown as Record<string, unknown>],
  ];
  for (const [prefix, object] of prefixes) {
    if (targetKey.startsWith(prefix) && !targetKey.slice(prefix.length).includes(".")) {
      return { object, key: targetKey.slice(prefix.length) };
    }
  }
  return null;
}

/** Whether `targetKey` resolves to something in `payload` — spec 18's "原稿里不存在目标时不显示原稿行". */
export function v19FinalTraceTargetExists(payload: V04DraftPayloadV1, targetKey: string): boolean {
  return locateV19FinalTarget(payload, targetKey) !== null;
}

// ---------------------------------------------------------------------------
// 一个字段的来源链（spec 18 + 用户看了线上效果后的简化：合并重复行、当前
// 采用只留一行来源提示、旧写法收成可展开摘要、未纳入照旧完整显示）。
// ---------------------------------------------------------------------------

export type V19FinalTraceHistoryRow = {
  /** React key. */
  key: string;
  /** null for the synthetic origin row — nothing to adopt there. */
  intakeId: string | null;
  isOrigin: boolean;
  value: unknown;
  source: "VERSION" | "FINAL_DIRECT" | "ORIGIN";
  sourceVersionNumber: number | null;
  actorName: string;
  createdAt: string;
};

export type V19FinalFieldTrace = {
  /**
   * false only when there is truly nothing to attribute at all — the target
   * doesn't exist in `originPayload` and has never had a FIELD intake
   * either, so there is no known applied row and no pending one. The caller
   * renders nothing under the field in that case, same as if `final` were
   * absent entirely. For every ordinary existing field this is true, even
   * one nobody has ever touched — 用户看了线上溯源模式后的调整: the 当前采用
   * line is 溯源模式本身，不显示反而让人以为漏了，所以它现在总是渲染，包括
   * 「当前采用 · v1 赵雅诗 原稿」这种没变过的字段。
   */
  hasTrace: boolean;
  /**
   * The one-line "当前采用 · …" source description (简化规则 2) — rendered
   * for every field that has one, changed or not. null only when there is no
   * known applied row at all (e.g. a freshly inserted shot's field whose
   * only recorded intake is still pending — the value on screen is just
   * that new shot's blank initial state, with no intake to attribute it to).
   */
  currentSourceLabel: string | null;
  /** Superseded rows before the current one, oldest first — one-line collapsible summaries (简化规则 3). Empty for an unchanged field. */
  overridden: V19FinalTraceHistoryRow[];
  /** `applied === false` rows — shown in full, unabbreviated (简化规则 5, unchanged), in seq order. */
  pending: V19FinalTraceHistoryRow[];
  /**
   * The row `currentSourceLabel` was built from, or null when
   * `currentSourceLabel` is null. Exposed so a caller can build its own
   * default-view hover text via `describeV19FinalTraceHoverSource` for a
   * field whose intake `.value` isn't directly comparable to what's on
   * screen (主导路径细项／辅助路径／固定选项字段) — the simple-field default
   * hover (spec 19, unchanged) keeps using `latestAppliedV19FinalIntake` +
   * `describeV19FinalIntakeSource` directly, this is only for those.
   */
  current: V19FinalTraceHistoryRow | null;
};

type V19FinalTraceRawRow = V19FinalTraceHistoryRow & { applied: boolean };

/** A `V19FinalIntake` reduced to just what row-building needs, with `.value` already turned into whatever representation this specific derivation compares/displays (raw text, an extracted sub-key, or a formatted choice label). */
type V19NormalizedIntake = {
  id: string;
  value: unknown;
  source: "VERSION" | "FINAL_DIRECT";
  sourceVersionNumber: number | null;
  actorName: string;
  createdAt: string;
  applied: boolean;
};

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Same "blank" test `firstLineV19TraceValue` uses — a row with nothing in it isn't a 写法 worth listing. */
function isEmptyV19TraceValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  return value == null;
}

/** Every `FIELD` intake for `targetKey`, oldest first. Shared by every derivation below — they only differ in how `.value` gets turned into a row value. */
function filterSortFieldIntakes(intakes: readonly V19FinalIntake[], targetKey: string): V19FinalIntake[] {
  return intakes
    .filter((intake) => intake.kind === "FIELD" && intake.targetKey === targetKey)
    .slice()
    .sort((a, b) => a.seq - b.seq);
}

function toNormalizedIntake(intake: V19FinalIntake, value: unknown): V19NormalizedIntake {
  return {
    id: intake.id,
    value,
    source: intake.source,
    sourceVersionNumber: intake.sourceVersionNumber,
    actorName: intake.actorName,
    createdAt: intake.createdAt,
    applied: intake.applied,
  };
}

/**
 * Builds the synthetic 原稿 row, or `null` when there's nothing to show for
 * it — either `originValue` is `undefined` (the target doesn't exist in
 * `originPayload` at all, e.g. a shot inserted after v1), or (本机复核发现
 * 的假原稿行 bug) `originValue` exactly matches the *last* (highest-seq)
 * intake sourced from v1 itself (`source === "VERSION" &&
 * sourceVersionNumber === 1`) for this same target.
 *
 * `originPayload` is v1's own *current* payload (spec 三、3.3), and the
 * backfill replay includes v1's own revision events — so whenever v1 has
 * ever edited this target, 原稿's value is by construction already captured
 * by v1's own last edit to it. Showing it again as a separate "before" row
 * is always redundant in that case (and can read as a cycle back to the
 * start, since a *different* v1 edit may sit adjacent to it with a
 * different value — 简化规则 1's adjacent-only dedupe does not catch this).
 * The intermediate history is still real and stays; only the redundant
 * 原稿 row itself is dropped.
 */
function buildV19OriginRow(
  originValue: unknown,
  originOwnerName: string,
  sameTargetIntakesAscending: readonly V19NormalizedIntake[],
): V19FinalTraceRawRow | null {
  if (originValue === undefined) return null;
  const ownVersionRecords = sameTargetIntakesAscending.filter(
    (intake) => intake.source === "VERSION" && intake.sourceVersionNumber === 1,
  );
  const lastOwnVersionRecord = ownVersionRecords[ownVersionRecords.length - 1];
  if (lastOwnVersionRecord && jsonEqual(lastOwnVersionRecord.value, originValue)) return null;
  return {
    key: "origin",
    intakeId: null,
    isOrigin: true,
    value: originValue,
    source: "ORIGIN",
    sourceVersionNumber: null,
    actorName: originOwnerName,
    createdAt: "",
    applied: true,
  };
}

function buildV19IntakeRow(intake: V19NormalizedIntake): V19FinalTraceRawRow {
  return {
    key: intake.id,
    intakeId: intake.id,
    isOrigin: false,
    value: intake.value,
    source: intake.source,
    sourceVersionNumber: intake.sourceVersionNumber,
    actorName: intake.actorName,
    createdAt: intake.createdAt,
    applied: intake.applied,
  };
}

/**
 * 简化规则 1: after sorting 原稿 + 该字段全部 FIELD 汇入记录 by seq, drop any
 * row whose value equals its immediately preceding row's — this is exactly
 * the bug where replaying a workspace's own v1 event during backfill leaves
 * "v1 原稿" and "v1 <its own replayed write>" showing identical content as
 * two separate rows. Only ever compares strictly adjacent rows in this
 * seq-sorted order, and always keeps the earlier-occurring one.
 */
function dedupeAdjacentV19TraceRows(rows: readonly V19FinalTraceRawRow[]): V19FinalTraceRawRow[] {
  const deduped: V19FinalTraceRawRow[] = [];
  for (const row of rows) {
    const previous = deduped[deduped.length - 1];
    if (previous && jsonEqual(previous.value, row.value)) continue;
    deduped.push(row);
  }
  return deduped;
}

/**
 * `v2 老孙 09-02 11:00` / `v1 赵雅诗 原稿` / `集成版 老孙 直接修改 09-02 11:00` —
 * shared by the 当前采用 line (prefixed with `当前采用 · `, inside every
 * `deriveV19*Trace` function below) and each 旧写法摘要行's "版本、作者、时间"
 * column (used as-is by the renderer, exported so it doesn't get re-derived).
 */
export function describeV19FinalTraceRowLabel(row: V19FinalTraceHistoryRow): string {
  if (row.isOrigin) return `v1 ${row.actorName} 原稿`;
  if (row.source === "FINAL_DIRECT") return `集成版 ${row.actorName} 直接修改 ${formatShortDateTime(row.createdAt)}`;
  return `v${row.sourceVersionNumber ?? "?"} ${row.actorName} ${formatShortDateTime(row.createdAt)}`;
}

/**
 * Shared tail of every `deriveV19*Trace` function: dedupe adjacent
 * duplicates (简化规则 1), split into 当前采用／旧写法／未纳入 (简化规则
 * 2/3/5), and decide `hasTrace` (简化规则 4, adjusted): only false when
 * there is truly nothing to attribute — no current line, no history, no
 * pending — otherwise the current line always renders on its own even with
 * empty lists.
 */
function reduceV19TraceRows(rows: readonly V19FinalTraceRawRow[]): V19FinalFieldTrace {
  const merged = dedupeAdjacentV19TraceRows(rows);
  const appliedRows = merged.filter((row) => row.applied);
  const current = appliedRows.length ? appliedRows[appliedRows.length - 1] : null;
  const overridden = appliedRows.slice(0, -1).filter((row) => !isEmptyV19TraceValue(row.value));
  const pending = merged.filter((row) => !row.applied);

  const currentSourceLabel = current ? `当前采用 · ${describeV19FinalTraceRowLabel(current)}` : null;
  const hasTrace = currentSourceLabel !== null || overridden.length > 0 || pending.length > 0;

  return { hasTrace, currentSourceLabel, overridden, pending, current };
}

/**
 * Spec 19's default-view hover text for a field whose current row came from
 * `deriveV19PrimaryDetailTrace`/`deriveV19AuxiliaryPathTrace`/
 * `deriveV19ChoiceFieldTrace` — same `v2·李晓芸 08-24 11:05` /
 * `集成版·直接修改 08-24 11:05` shape as `describeV19FinalIntakeSource`
 * (which takes a raw `V19FinalIntake` the simple-field path already has;
 * this is the same format for a `V19FinalTraceHistoryRow` instead). `null`
 * when there's nothing to attribute, or the current row is 原稿 itself — an
 * unchanged field's hover carries no source suffix, same as before.
 */
export function describeV19FinalTraceHoverSource(row: V19FinalTraceHistoryRow | null): string | undefined {
  if (!row || row.isOrigin) return undefined;
  const who = row.source === "FINAL_DIRECT" ? "集成版·直接修改" : `v${row.sourceVersionNumber ?? "?"}·${row.actorName}`;
  return `${who} ${formatShortDateTime(row.createdAt)}`;
}

/** Builds `rows` (原稿 + every same-target intake, values already normalized to whatever this derivation compares/displays) and reduces them. Shared by every `deriveV19*Trace` function below. */
function deriveV19TraceFromNormalized(
  originValue: unknown,
  originOwnerName: string,
  normalizedIntakes: readonly V19NormalizedIntake[],
): V19FinalFieldTrace {
  const rows: V19FinalTraceRawRow[] = [];
  const originRow = buildV19OriginRow(originValue, originOwnerName, normalizedIntakes);
  if (originRow) rows.push(originRow);
  for (const intake of normalizedIntakes) rows.push(buildV19IntakeRow(intake));
  return reduceV19TraceRows(rows);
}

/**
 * Spec 五、18, simplified: 原稿 (if it exists in `originPayload`) followed by
 * every `FIELD` intake for `targetKey`, oldest first. For plain text/select
 * fields whose intake `.value` is already the field's own raw value — see
 * `deriveV19PrimaryDetailTrace`/`deriveV19AuxiliaryPathTrace`/
 * `deriveV19ChoiceFieldTrace` for the fields whose intake value is a
 * combined record and needs extracting first.
 */
export function deriveV19FinalFieldTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  targetKey: string,
  /** v1's `ownerName` (the case's uploader) — the 谁 column for the origin row. */
  originOwnerName = "",
): V19FinalFieldTrace {
  const origin = locateV19FinalTarget(originPayload, targetKey);
  const originValue = origin ? origin.object[origin.key] : undefined;
  const normalized = filterSortFieldIntakes(intakes, targetKey).map((intake) => toNormalizedIntake(intake, intake.value));
  return deriveV19TraceFromNormalized(originValue, originOwnerName, normalized);
}

/**
 * 主导路径细项 (spec 五、18 补充): the backend stores every change to any of
 * a path's detail fields as one combined `path.primaryDetails` FIELD record
 * whose value is `{ <detailKey>: string }` (spec 三、3.1 — it is not
 * `script.structure`, so `decomposeV19ChangesForFinal` records it whole,
 * not split per key). This extracts just `detailKey`'s value out of 原稿
 * and every such record, oldest first; a record that never touched
 * `detailKey` still carries whatever value it had at that point, so it
 * naturally merges into its neighbor once extracted (简化规则 1). A key
 * that a given record simply doesn't have — e.g. it was written while
 * `primaryType` was a different path, using a different key set — reads as
 * empty, per spec.
 */
export function deriveV19PrimaryDetailTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  detailKey: string,
  originOwnerName = "",
): V19FinalFieldTrace {
  const originValue = originPayload.perceptionPath.primaryDetails[detailKey] ?? "";
  const normalized = filterSortFieldIntakes(intakes, "path.primaryDetails").map((intake) => {
    const record = intake.value && typeof intake.value === "object" ? (intake.value as Record<string, unknown>) : {};
    const extracted = record[detailKey];
    return toNormalizedIntake(intake, typeof extracted === "string" ? extracted : "");
  });
  return deriveV19TraceFromNormalized(originValue, originOwnerName, normalized);
}

/**
 * 辅助路径描述／创意作用 (spec 五、18 补充): `path.auxiliaryTypes` FIELD
 * records store the *entire* auxiliary-path list as
 * `[{ type, description, creativeRole }]` (same reasoning as
 * `path.primaryDetails` above). This extracts `field` for the entry whose
 * `type` matches `auxType`, from 原稿 and every such record; a record (or
 * 原稿) that doesn't currently carry this `auxType` at all — it wasn't an
 * active auxiliary path at that point — reads as empty.
 */
export function deriveV19AuxiliaryPathTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  auxType: string,
  field: "description" | "creativeRole",
  originOwnerName = "",
): V19FinalFieldTrace {
  const originEntry = originPayload.perceptionPath.auxiliaryTypes.find((item) => item.type === auxType);
  const originValue = originEntry ? originEntry[field] : "";
  const normalized = filterSortFieldIntakes(intakes, "path.auxiliaryTypes").map((intake) => {
    const list = Array.isArray(intake.value) ? intake.value as Array<Record<string, unknown>> : [];
    const entry = list.find((item) => item.type === auxType);
    const extracted = entry ? entry[field] : "";
    return toNormalizedIntake(intake, typeof extracted === "string" ? extracted : "");
  });
  return deriveV19TraceFromNormalized(originValue, originOwnerName, normalized);
}

// ---------------------------------------------------------------------------
// 固定选项字段（V04ChoiceField 与 path.primaryType 之外的 select 字段）：值是
// `{ selectedOptionIds, customText, advancedText?, vocabularyVersion }`。
// ---------------------------------------------------------------------------

const V19_CHOICE_LABELS: Record<V04VocabularyFieldKey, Record<string, string>> = {
  bridgeCreativeRole: {},
  generalMechanism: {},
  storyReferenceType: {},
};
for (const option of V04_VOCABULARY_OPTIONS) {
  V19_CHOICE_LABELS[option.fieldKey][option.optionId] = option.labelZhCn;
}

/**
 * Formats a `V04ChoiceValue`-shaped value into human-readable text — option
 * id(s) turned into their 中文 label via `vocabularyField`'s lookup table
 * (复用 `V04ChoiceField` 用的同一份表, `lib/v04-vocabulary.ts`), multiple
 * selections joined with "、", custom/advanced text appended. Selected ids
 * are sorted before formatting so two representations of the same selection
 * (e.g. differing only in the order options were toggled) render — and so
 * compare, since the trace machinery only ever compares the already-
 * formatted string — identically ("比较是否相同用规范化后的 JSON" 的规范化
 * 部分因此落在这里：排序 id、trim 文本，而不是另存一份原始结构值只为比较用).
 * Returns "" for anything that isn't recognizably a choice value.
 */
export function describeV19ChoiceValue(value: unknown, vocabularyField: V04VocabularyFieldKey): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const choice = value as { selectedOptionIds?: unknown; customText?: unknown; advancedText?: unknown };
  const ids = Array.isArray(choice.selectedOptionIds) ? [...choice.selectedOptionIds as string[]].sort() : [];
  const labels = V19_CHOICE_LABELS[vocabularyField];
  const labeled = ids.map((id) => labels[id] ?? id);
  const customText = typeof choice.customText === "string" ? choice.customText.trim() : "";
  const advancedText = typeof choice.advancedText === "string" ? choice.advancedText.trim() : "";
  return [labeled.join("、"), customText, advancedText].filter(Boolean).join(" ｜ ");
}

/**
 * 固定选项字段 (spec 五、18 补充): 故事参照类型／创意主导·辅助手法及机制／
 * 桥段主·辅创意作用 — every `V04ChoiceField`-backed target. `locateV19FinalTarget`
 * already handles both `facts.<field>` and `shotGroup:<id>.<field>` shapes
 * generically, so this only adds the choice-to-text formatting on top;
 * everything else (合并、当前采用、旧写法、未纳入、假原稿行兜底) is shared.
 */
export function deriveV19ChoiceFieldTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  targetKey: string,
  vocabularyField: V04VocabularyFieldKey,
  originOwnerName = "",
): V19FinalFieldTrace {
  const origin = locateV19FinalTarget(originPayload, targetKey);
  const originValue = origin ? describeV19ChoiceValue(origin.object[origin.key], vocabularyField) : undefined;
  const normalized = filterSortFieldIntakes(intakes, targetKey)
    .map((intake) => toNormalizedIntake(intake, describeV19ChoiceValue(intake.value, vocabularyField)));
  return deriveV19TraceFromNormalized(originValue, originOwnerName, normalized);
}

// ---------------------------------------------------------------------------
// 创意承重载体 (`facts.creativeCarriers`): a plain array of fixed carrier ids
// (`"STORY" | "COPY" | "AUDIOVISUAL_RULE"`), not a `V04ChoiceValue` — it's
// rendered as a chip toggle group, not a `V04ChoiceField`. Same reasoning as
// `describeV19ChoiceValue`/`deriveV19ChoiceFieldTrace` above, just for this
// simpler shape (复用 `lib/v04-ui-model.ts` 的 carrierToUi 会把这份很小的
// browser-safe 文件拖进一个更大的模块，所以就地存一份同样的三项映射).
// ---------------------------------------------------------------------------

const V19_CARRIER_LABELS: Record<string, string> = {
  STORY: "故事",
  COPY: "文案",
  AUDIOVISUAL_RULE: "视听规则",
};

/** Formats a `facts.creativeCarriers`-shaped id array into its 中文 labels, joined with "、". Returns "" for anything that isn't an array. */
export function describeV19CarrierListValue(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((id) => (typeof id === "string" ? V19_CARRIER_LABELS[id] ?? id : ""))
    .filter(Boolean)
    .join("、");
}

/** 创意承重载体 (spec 五、18 补充): the one remaining field module 1 hadn't wired — same shared merge/current/overridden/pending machinery, `describeV19CarrierListValue` doing the formatting. */
export function deriveV19CarrierTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  originOwnerName = "",
): V19FinalFieldTrace {
  const targetKey = "facts.creativeCarriers";
  const origin = locateV19FinalTarget(originPayload, targetKey);
  const originValue = origin ? describeV19CarrierListValue(origin.object[origin.key]) : undefined;
  const normalized = filterSortFieldIntakes(intakes, targetKey)
    .map((intake) => toNormalizedIntake(intake, describeV19CarrierListValue(intake.value)));
  return deriveV19TraceFromNormalized(originValue, originOwnerName, normalized);
}

/** The first line of a trace value, trimmed to "—" when empty — the collapsed preview for a 旧写法摘要行 (简化规则 3). Full-text display and expand/collapse belong to the renderer. */
export function firstLineV19TraceValue(value: unknown): string {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  const trimmed = text.trim();
  if (trimmed === "") return "—";
  const [firstLine] = trimmed.split("\n");
  return firstLine;
}

/** The most recently applied `FIELD` intake for `targetKey`, or null when only the origin applies. */
export function latestAppliedV19FinalIntake(
  intakes: readonly V19FinalIntake[],
  targetKey: string,
): V19FinalIntake | null {
  let latest: V19FinalIntake | null = null;
  for (const intake of intakes) {
    if (intake.kind !== "FIELD" || intake.targetKey !== targetKey || !intake.applied) continue;
    if (!latest || intake.seq > latest.seq) latest = intake;
  }
  return latest;
}

/** Spec 19: `v2·李晓芸 08-24 11:05` / `集成版·直接修改 08-24 11:05` — the hover-title source hint. */
export function describeV19FinalIntakeSource(intake: V19FinalIntake): string {
  const who = intake.source === "FINAL_DIRECT"
    ? "集成版·直接修改"
    : `v${intake.sourceVersionNumber ?? "?"}·${intake.actorName}`;
  return `${who} ${formatShortDateTime(intake.createdAt)}`;
}

// ---------------------------------------------------------------------------
// 结构类未纳入记录（spec 18：横幅下方的“结构改动未纳入”一组）
// ---------------------------------------------------------------------------

/** Every `INSERT_*`/`REMOVE_*` intake still `applied === false`, oldest first. */
export function pendingV19StructuralIntakes(intakes: readonly V19FinalIntake[]): V19FinalIntake[] {
  return intakes
    .filter((intake) => intake.kind !== "FIELD" && !intake.applied)
    .slice()
    .sort((a, b) => a.seq - b.seq);
}

function padV19Number(value: number): string {
  return String(value).padStart(2, "0");
}

function describeV19StructuralVerb(intake: V19FinalIntake, currentPayload: V04DraftPayloadV1): string {
  const value = (intake.value ?? {}) as { afterId?: string | null; parentGroupId?: string };
  if (intake.kind === "INSERT_SHOT") {
    const groupIndex = currentPayload.script.shotGroups.findIndex((group) => group.id === value.parentGroupId);
    return groupIndex >= 0 ? `在桥段${padV19Number(groupIndex + 1)}后插入镜头` : "插入镜头";
  }
  if (intake.kind === "INSERT_GROUP") {
    if (value.afterId == null) return "插入桥段（列表最前）";
    const groupIndex = currentPayload.script.shotGroups.findIndex((group) => group.id === value.afterId);
    return groupIndex >= 0 ? `在桥段${padV19Number(groupIndex + 1)}后插入桥段` : "插入桥段";
  }
  if (intake.kind === "REMOVE_GROUP") {
    return intake.targetLabel && intake.targetLabel !== "桥段" ? `删除桥段「${intake.targetLabel}」` : "删除桥段";
  }
  // REMOVE_SHOT
  return "删除镜头";
}

/**
 * Spec 五、18's one-line description for a pending structural intake, e.g.
 * `v3 张三 在桥段02后插入镜头`. Position is read off `currentPayload` (the
 * final version's current, saved payload — not a local draft) via
 * `afterId`/`parentGroupId`; when that id no longer exists there the
 * position degrades to the bare verb, per spec.
 */
export function describeV19StructuralIntake(intake: V19FinalIntake, currentPayload: V04DraftPayloadV1): string {
  const actor = intake.source === "FINAL_DIRECT"
    ? `集成版·直接修改 ${intake.actorName}`
    : `v${intake.sourceVersionNumber ?? "?"} ${intake.actorName}`;
  return `${actor} ${describeV19StructuralVerb(intake, currentPayload)}`;
}
