// 最终版溯源视图的纯函数：从 `finalTrace`（`originPayload` + `intakes`）推出
// 一个字段的来源链、当前采用是哪一条、hover 提示用的最新来源，以及横幅下方
// 待采纳的结构改动列表。见 docs/20_最终版与评论跨版本_实施规格_V0.1.md 五、18/19。
//
// 只依赖 `V04DraftPayloadV1` 的形状与 `V19FinalIntake` 的形状，不导入
// `lib/v04-domain.ts`（它顶层 `import "node:crypto"`，不能进浏览器包 ——
// 与 `lib/v19-ui-model.ts` 里 `formatV19VersionLabel` 保留客户端安全副本
// 是同一个理由）。组件层（`V19StudioDocument.tsx` / `V04StudioClient.tsx`）
// 只管把这里算出的结果渲染出来，不重新做推导。

import type { V04DraftPayloadV1 } from "./v04-contract";
import type { V19FinalIntake } from "./v19-ui-model";
import { formatShortDateTime } from "./date-format";

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
};

type V19FinalTraceRawRow = V19FinalTraceHistoryRow & { applied: boolean };

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
    if (previous && JSON.stringify(previous.value) === JSON.stringify(row.value)) continue;
    deduped.push(row);
  }
  return deduped;
}

/**
 * `v2 老孙 09-02 11:00` / `v1 赵雅诗 原稿` / `最终版 老孙 直接修改 09-02 11:00` —
 * shared by the 当前采用 line (prefixed with `当前采用 · `, inside
 * `deriveV19FinalFieldTrace`) and each 旧写法摘要行's "版本、作者、时间"
 * column (used as-is by the renderer, exported so it doesn't get re-derived).
 */
export function describeV19FinalTraceRowLabel(row: V19FinalTraceHistoryRow): string {
  if (row.isOrigin) return `v1 ${row.actorName} 原稿`;
  if (row.source === "FINAL_DIRECT") return `最终版 ${row.actorName} 直接修改 ${formatShortDateTime(row.createdAt)}`;
  return `v${row.sourceVersionNumber ?? "?"} ${row.actorName} ${formatShortDateTime(row.createdAt)}`;
}

/** Same "blank" test `firstLineV19TraceValue` uses — a row with nothing in it isn't a 写法 worth listing. */
function isEmptyV19TraceValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  return value == null;
}

/**
 * Spec 五、18, simplified: 原稿 (if it exists in `originPayload`) followed by
 * every `FIELD` intake for `targetKey`, oldest first, deduplicated against
 * its immediate predecessor (简化规则 1). Whichever of those rows is
 * currently in effect (the highest-seq applied one — null when there is no
 * applied row at all) becomes `currentSourceLabel`, rendered every time it
 * exists — including for a field nobody has ever changed, where it's just
 * "当前采用 · v1 赵雅诗 原稿" with empty `overridden`/`pending` (用户看了线上
 * 溯源模式后的调整: 这一行就是溯源本身，不显示反而让人以为漏了). Every other
 * applied row with a non-empty value becomes an `overridden` summary (本机
 * 复核收尾: a blank value — e.g. an empty 原稿 later overridden by real
 * content — isn't a "写法" worth listing, so it's dropped here;
 * `current`/`pending` are unaffected, they can legitimately be empty); every
 * `applied === false` row becomes `pending`, regardless of where it falls in
 * seq order relative to the current row (取消定稿后重开时，未采纳的旧记录可能
 * seq 比之后新产生的已应用记录更早 — 判定纯看各自的 applied 状态，不看位置).
 */
export function deriveV19FinalFieldTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  targetKey: string,
  /** v1's `ownerName` (the case's uploader) — the 谁 column for the origin row. */
  originOwnerName = "",
): V19FinalFieldTrace {
  const rows: V19FinalTraceRawRow[] = [];
  const origin = locateV19FinalTarget(originPayload, targetKey);
  if (origin) {
    rows.push({
      key: "origin",
      intakeId: null,
      isOrigin: true,
      value: origin.object[origin.key],
      source: "ORIGIN",
      sourceVersionNumber: null,
      actorName: originOwnerName,
      createdAt: "",
      applied: true,
    });
  }
  const fieldIntakes = intakes
    .filter((intake) => intake.kind === "FIELD" && intake.targetKey === targetKey)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  for (const intake of fieldIntakes) {
    rows.push({
      key: intake.id,
      intakeId: intake.id,
      isOrigin: false,
      value: intake.value,
      source: intake.source,
      sourceVersionNumber: intake.sourceVersionNumber,
      actorName: intake.actorName,
      createdAt: intake.createdAt,
      applied: intake.applied,
    });
  }

  const merged = dedupeAdjacentV19TraceRows(rows);
  const appliedRows = merged.filter((row) => row.applied);
  const current = appliedRows.length ? appliedRows[appliedRows.length - 1] : null;
  const overridden = appliedRows.slice(0, -1).filter((row) => !isEmptyV19TraceValue(row.value));
  const pending = merged.filter((row) => !row.applied);

  const currentSourceLabel = current ? `当前采用 · ${describeV19FinalTraceRowLabel(current)}` : null;
  // 简化规则 4 (调整后): only truly nothing to attribute — no current line,
  // no history, no pending — hides the whole trace slot. Otherwise the
  // current line always renders on its own even with empty lists.
  const hasTrace = currentSourceLabel !== null || overridden.length > 0 || pending.length > 0;

  return { hasTrace, currentSourceLabel, overridden, pending };
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

/** Spec 19: `v2·李晓芸 08-24 11:05` / `最终版·直接修改 08-24 11:05` — the hover-title source hint. */
export function describeV19FinalIntakeSource(intake: V19FinalIntake): string {
  const who = intake.source === "FINAL_DIRECT"
    ? "最终版·直接修改"
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
    ? `最终版·直接修改 ${intake.actorName}`
    : `v${intake.sourceVersionNumber ?? "?"} ${intake.actorName}`;
  return `${actor} ${describeV19StructuralVerb(intake, currentPayload)}`;
}
