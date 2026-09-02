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
// 一个字段的来源链（spec 18：默认取值，之后按 seq 升序的 FIELD 记录）
// ---------------------------------------------------------------------------

export type V19FinalTraceRow = {
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
  applied: boolean;
  status: "current" | "overridden" | "pending";
};

export type V19FinalFieldTrace = {
  rows: V19FinalTraceRow[];
  /** Index into `rows` of the row currently in effect; -1 when the chain is empty. */
  currentIndex: number;
};

/**
 * Spec 五、18: builds the source chain shown under a field in 溯源 view —
 * `原稿` (if it exists in `originPayload`) followed by every `FIELD` intake
 * for `targetKey`, oldest first. The last `applied` row is `current`, the
 * `applied` ones before it are `overridden`, and any `applied === false` rows
 * are `pending` (采纳这一版 is offered there, gated by the caller on 老孙).
 */
export function deriveV19FinalFieldTrace(
  originPayload: V04DraftPayloadV1,
  intakes: readonly V19FinalIntake[],
  targetKey: string,
): V19FinalFieldTrace {
  const rows: V19FinalTraceRow[] = [];
  const origin = locateV19FinalTarget(originPayload, targetKey);
  if (origin) {
    rows.push({
      key: "origin",
      intakeId: null,
      isOrigin: true,
      value: origin.object[origin.key],
      source: "ORIGIN",
      sourceVersionNumber: null,
      actorName: "",
      createdAt: "",
      applied: true,
      status: "overridden",
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
      status: intake.applied ? "overridden" : "pending",
    });
  }
  let currentIndex = -1;
  rows.forEach((row, index) => { if (row.applied) currentIndex = index; });
  if (currentIndex >= 0 && rows[currentIndex].status !== "current") {
    rows[currentIndex] = { ...rows[currentIndex], status: "current" };
  }
  return { rows, currentIndex };
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
