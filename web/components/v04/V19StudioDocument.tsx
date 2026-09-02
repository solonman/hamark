"use client";

import { useState, type JSX, type ReactNode } from "react";
import type { V04ChoiceValue, V04CreativeGrade, V04DraftPayloadV1, V04ShotFieldKey } from "@/lib/v04-contract";
import type { V04UiDraft, V04UiShot, V04UiShotGroup } from "@/lib/v04-ui-model";
import { V04_UI_SHOT_FIELDS } from "@/lib/v04-ui-model";
import { numberedV04Shots, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04_UI_BRIDGE_OPTIONS, V04_UI_MECHANISM_OPTIONS, V04_UI_PATHS, V04_UI_STORY_OPTIONS } from "@/lib/v04-ui-fixture";
import type { V19BaseDiff } from "@/lib/v19-base-diff";
import { CASE_REVIEW_TARGETS, type CaseReviewComment } from "@/lib/case-review";
import { cascadeV19Timeline, parseV19TimecodeInput } from "@/lib/v19-timeline";
import { formatShortDateTime } from "@/lib/date-format";
import type { V19FinalIntake } from "@/lib/v19-ui-model";
import {
  deriveV19AuxiliaryPathTrace,
  deriveV19CarrierTrace,
  deriveV19ChoiceFieldTrace,
  deriveV19FinalFieldTrace,
  deriveV19PrimaryDetailTrace,
  describeV19FinalTraceHoverSource,
  describeV19FinalTraceRowLabel,
  firstLineV19TraceValue,
  type V19FinalTraceHistoryRow,
} from "@/lib/v19-final-trace";
import type { V04VocabularyFieldKey } from "@/lib/v04-vocabulary";
import V19EditableValue, { V19SystemValue } from "./V19EditableValue";
import V19ReviewComment from "./V19ReviewComment";
import V04ChoiceField from "./V04ChoiceField";
import styles from "./V04Surface.module.css";

/**
 * V1.9 二合一工作台的正文渲染：三个模块、桥段、镜头、字段。只负责渲染与回调，
 * 不碰网络（见 `docs/18_..._V0.1.md` 五之三「组件边界」）。结构与顺序对齐
 * `docs/demos/2026-08-24-二合一工作台交互demo.html` 的 `shotArticle` / `renderDoc`，
 * 与 `V04DetailClient.tsx` 的只读渲染共享 CSS 类名与字段标签，仅把只读文本换成
 * `V19EditableValue` / `V04ChoiceField`。
 */

/**
 * 评审挂件的接线。评论只出现在开放式条目上——固定选项没有可评的写法，
 * 评它等于评这份词表本身。第二模块整段评在桥段和镜头上。
 */
export type V19StudioReview = {
  canReview: boolean;
  /** 一个条目现在可能挂着好几个版本各写的一条评论，按写入时间升序。 */
  comments: ReadonlyMap<string, CaseReviewComment[]>;
  /** 当前正在看的版本 id（含最终版）；用来判定哪一条评论是「本版」。 */
  currentVersionId: string | null;
  /** 版本尚未落库时无处可锚定，按钮仍在但说明原因。 */
  disabled: boolean;
  onSave: (input: { targetKey: string; targetLabel: string; body: string }) => Promise<void>;
};

const NO_COMMENTS: readonly CaseReviewComment[] = [];

/**
 * 最终版视角下每个可编辑字段需要的额外上下文（spec 五、16/18/19）。缺省
 * （`undefined`）时正文渲染与普通版本完全一样——最终版专属的锁定样式、
 * hover 来源、溯源来源链都只在这个视角下出现。
 */
export type V19StudioFinalContext = {
  /** true when the viewer is looking at the final version but is not 老孙 — still looks editable, but clicking it toasts instead of opening the editor. */
  locked: boolean;
  /** 默认（false）只显示 hover 来源；溯源（true）在每个字段下方展开完整来源链。 */
  traceMode: boolean;
  /**
   * null when the GET response carried no `finalTrace` (should not normally
   * happen once the route always requests it for a final `current` — 本机
   * 走查 bug fix — but `locked` must not depend on this being present, so
   * every lookup here degrades to "no trace data" rather than skipping the
   * whole `final` context).
   */
  originPayload: V04DraftPayloadV1 | null;
  intakes: readonly V19FinalIntake[];
  /** true only for 老孙 — gates the "采纳这一版" button on pending trace rows. */
  canAdopt: boolean;
  onAdopt: (intakeId: string) => void;
  /** v1（原稿）的 ownerName — 溯源列表原稿行的「谁写的」，见 V19FinalTraceRows。 */
  originOwnerName: string;
};

export type V19StudioDocumentProps = {
  draft: V04UiDraft;
  diff: V19BaseDiff | null;
  readOnly: boolean;
  collapsedModules: ReadonlySet<number>;
  onToggleModule: (moduleNumber: number) => void;
  onChange: (mutate: (draft: V04UiDraft) => void) => void;
  onInsertShotAfter: (shotId: string) => void;
  onInsertBridgeAfter: (bridgeId: string) => void;
  onDeleteShot: (shotId: string) => void;
  onDeleteBridge: (bridgeId: string) => void;
  /** 桥段内已无镜头时的唯一入口——没有镜头可供「在其后插入」。 */
  onInsertFirstShot: (bridgeId: string) => void;
  /** 待二次确认的目标 id；由外壳持有，因为确认状态要随保存与切换版本一起收起。 */
  pendingDeleteId: string | null;
  onCancelDelete: () => void;
  /** 存量内容里不符合「开始时间＝上一镜头结束时间＋1秒」的镜头数；0 表示无需处理。 */
  nonCompliantStartCount: number;
  onNormalizeTimeline: () => void;
  /** Only reachable when the script is still empty — there is no bridge to insert after. */
  onInsertFirstBridge?: () => void;
  onInvalid: (message: string) => void;
  /** Vetoes opening any editor — used to redirect an edit to the viewer's own version. */
  onBeforeEdit?: () => boolean;
  /** 缺省即不渲染任何评论入口（只读页与测试用例据此保持原样）。 */
  review?: V19StudioReview;
  /** 缺省即不渲染任何最终版专属的锁定／来源展示（只读页与测试用例据此保持原样）。 */
  final?: V19StudioFinalContext;
};

// ---------------------------------------------------------------------------
// UI 草稿字段 → payload target key 映射。`v04PayloadChanges` / `v04UiDraftToPayload`
// (lib/v04-ui-model.ts) 是唯一权威：UI 字段名与 payload 字段名并不总是一致
// （例如 draft.storySummary ↔ facts.storySynopsis）。导出为具名常量以便测试。
// ---------------------------------------------------------------------------

export const V19_FIELD_TARGET_KEYS = {
  facts: {
    commercialIntent: "facts.commercialIntent",
    storySummary: "facts.storySynopsis",
    creativeMotif: "facts.creativeMotif",
    tensionButton: "facts.tensionButton",
    primaryMechanism: "facts.mainMechanism",
    auxiliaryMechanism: "facts.auxiliaryMechanism",
    creativeThinkingChain: "facts.creativeThinkingChain",
    storyReference: "facts.storyReference",
    carriers: "facts.creativeCarriers",
    carrierExplanation: "facts.carrierExplanation",
    creativeContract: "facts.acceptanceContract",
    overallGrade: "facts.overallCreativeRating",
    gradeReason: "facts.ratingReason",
  },
  path: {
    primaryType: "path.primaryType",
    primaryDetails: "path.primaryDetails",
    auxiliaryTypes: "path.auxiliaryTypes",
  },
  shotGroupField: (bridgeId: string, field: "bridgeName" | "keyCreativeDescription" | "primaryCreativeRole" | "auxiliaryCreativeRole") =>
    `shotGroup:${bridgeId}.${field}`,
  shotField: (shotId: string, field: V04ShotFieldKey) => `shot:${shotId}.${field}`,
} as const;

// ---------------------------------------------------------------------------
// 时间线告警（规格第 6 条）：纯函数，与渲染解耦，便于单测。
// ---------------------------------------------------------------------------

export const V19_SHOT_TIME_OVERLAP_WARNING = "与上一镜头结束时间重叠，请校对";
export const V19_SHOT_TIME_INVERTED_WARNING = "结束时间早于开始时间";

export function computeV19ShotTimelineWarnings(
  shot: Pick<V04UiShot, "startTime" | "endTime">,
  previousShot: Pick<V04UiShot, "endTime"> | null,
): { startWarning?: string; endWarning?: string } {
  const start = parseV19TimecodeInput(shot.startTime);
  const end = parseV19TimecodeInput(shot.endTime);
  const previousEnd = previousShot ? parseV19TimecodeInput(previousShot.endTime) : null;
  const startWarning = start != null && previousEnd != null && start <= previousEnd ? V19_SHOT_TIME_OVERLAP_WARNING : undefined;
  const endWarning = start != null && end != null && end < start ? V19_SHOT_TIME_INVERTED_WARNING : undefined;
  return { startWarning, endWarning };
}

// ---------------------------------------------------------------------------
// Local lookups / helpers
// ---------------------------------------------------------------------------

const shotFieldLabels = Object.fromEntries(V04_UI_SHOT_FIELDS.map((item) => [item.key, item.label])) as Record<V04ShotFieldKey, string>;
const bridgeRoleLabels = Object.fromEntries(V04_UI_BRIDGE_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const mechanismLabels = Object.fromEntries(V04_UI_MECHANISM_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const storyLabels = Object.fromEntries(V04_UI_STORY_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const pathLabels = Object.fromEntries(V04_UI_PATHS.map((item) => [item.id, item.label]));

const SHOT_FIELD_ROWS: ReadonlyArray<{ className: "readingThree" | "readingTwo" | "readingOne"; keys: V04ShotFieldKey[] }> = [
  { className: "readingThree", keys: ["startTime", "endTime", "shotScale"] },
  { className: "readingTwo", keys: ["cameraAngle", "cameraMovement"] },
  { className: "readingOne", keys: ["visualContent"] },
  { className: "readingTwo", keys: ["screenCopy", "subtitleEffect"] },
  { className: "readingTwo", keys: ["dialogue", "voiceOver"] },
  { className: "readingTwo", keys: ["soundEffect", "music"] },
];

const GRADE_OPTIONS = [
  { value: "", label: "（未选）" },
  { value: "S", label: "S" },
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
];

const PATH_OPTIONS = V04_UI_PATHS.map((item) => ({ value: item.id, label: item.label }));

const PRIMARY_PATH_DETAIL_KEYS: Record<"LOVE" | "FUN" | "PERCEPTION", readonly string[]> = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
};

const CARRIER_LABELS: Record<string, string> = { STORY: "故事", COPY: "文案", AUDIOVISUAL_RULE: "视听规则" };
/** 承重载体是固定三选项（契约限定最多 3 项、不可重复），与既有编辑器保持同一组标签。 */
export const V19_CARRIER_OPTIONS = ["故事", "文案", "视听规则"] as const;

function padNumber(value: number): string {
  return String(value).padStart(2, "0");
}

function isGradeValue(value: string): value is V04CreativeGrade | "" {
  return value === "" || value === "S" || value === "A" || value === "B" || value === "C";
}

function isPathValue(value: string): value is "LOVE" | "FUN" | "PERCEPTION" {
  return value === "LOVE" || value === "FUN" || value === "PERCEPTION";
}

function choiceValueLabel(value: V04ChoiceValue, labels: Record<string, string>): string {
  const fixed = value.selectedOptionIds.map((id) => labels[id] ?? id);
  const parts = [fixed.join("、"), value.customText.trim(), value.advancedText?.trim() ?? ""].filter(Boolean);
  return parts.join(" ｜ ");
}

function factBaseText(diff: V19BaseDiff | null, targetKey: string): string | undefined {
  if (!diff || !diff.changedFields.has(targetKey)) return undefined;
  const raw = diff.changedFields.get(targetKey);
  return raw == null ? "" : String(raw);
}

function carriersBaseText(diff: V19BaseDiff | null, targetKey: string): string | undefined {
  if (!diff || !diff.changedFields.has(targetKey)) return undefined;
  const raw = diff.changedFields.get(targetKey);
  if (!Array.isArray(raw)) return "";
  return raw.map((item) => CARRIER_LABELS[String(item)] ?? String(item)).join("、");
}

function ChoiceDiffNote({ diff, targetKey, labels }: { diff: V19BaseDiff | null; targetKey: string; labels: Record<string, string> }): JSX.Element | null {
  if (!diff || !diff.changedFields.has(targetKey)) return null;
  const raw = diff.changedFields.get(targetKey);
  const label = raw && typeof raw === "object" ? choiceValueLabel(raw as V04ChoiceValue, labels) : "";
  return (
    <>
      <span className={styles.diffTag} data-v19-diff="changed">已修改</span>
      <span className={styles.diffBase}>基版：{label || "—"}</span>
    </>
  );
}

function formatV19TraceValue(value: unknown): string {
  if (typeof value === "string") return value.trim() === "" ? "—" : value;
  if (value == null) return "—";
  return JSON.stringify(value);
}

/**
 * 一条「旧写法」摘要行：整行可点，默认收起只显示第一行预览（超出一行由 CSS
 * 省略号截断），点开换成跟未纳入一样的整段正文。展开状态是这一行自己的本地
 * state——每个摘要行独立记，收起来不影响别的行，也不用往上层传。
 */
function V19FinalTraceSummaryRow({ row }: { row: V19FinalTraceHistoryRow }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className={styles.finalTraceSummaryRow}
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className={styles.finalTraceSummaryLabel}>{describeV19FinalTraceRowLabel(row)}</span>
      <span className={styles.finalTraceSummaryPreview}>
        {expanded ? formatV19TraceValue(row.value) : firstLineV19TraceValue(row.value)}
      </span>
    </button>
  );
}

/**
 * 溯源视图，简化版（用户看了线上效果后的要求，以及看了线上溯源模式后的两点
 * 调整）：`lib/v19-final-trace.ts` 的 `deriveV19FinalFieldTrace` 已经把合并
 * 重复行、当前采用、旧写法、未纳入都算好了——这里只管渲染。「当前采用」这
 * 一行必须紧跟正文（它就是溯源本身，包括没变过的字段），所以永远排第一；
 * 旧写法（收起的摘要）与未纳入（照旧完整展示，带「采纳这一版」）跟在它下面。
 * `hasTrace === false` 时调用方根本不会渲染这个组件（见 `finalFieldExtras`），
 * 所以这里不必再判断一遍。
 */
function V19FinalTraceRows({
  currentSourceLabel,
  overridden,
  pending,
  canAdopt,
  onAdopt,
}: {
  currentSourceLabel: string | null;
  overridden: readonly V19FinalTraceHistoryRow[];
  pending: readonly V19FinalTraceHistoryRow[];
  canAdopt: boolean;
  onAdopt: (intakeId: string) => void;
}): JSX.Element {
  return (
    <div className={styles.finalTrace}>
      {currentSourceLabel && <div className={styles.finalTraceCurrent}>{currentSourceLabel}</div>}
      {overridden.map((row) => <V19FinalTraceSummaryRow key={row.key} row={row} />)}
      {pending.map((row) => {
        // 未纳入照旧：版本/谁写的/时间/全文/采纳按钮，跟简化前完全一样的拼法。
        const versionTag = row.isOrigin ? "v1" : row.source === "FINAL_DIRECT" ? "最终版" : `v${row.sourceVersionNumber ?? "?"}`;
        const who = row.isOrigin ? (row.actorName || "原稿") : row.source === "FINAL_DIRECT" ? `${row.actorName}·直接修改` : row.actorName;
        return (
          <div key={row.key} className={`${styles.finalTraceRow} ${styles.finalTraceRowPending}`}>
            <span className={styles.finalTraceVersion}>{versionTag}</span>
            <span className={styles.finalTraceWho}>{who}</span>
            {row.createdAt && <span className={styles.finalTraceTime}>{formatShortDateTime(row.createdAt)}</span>}
            <span className={styles.finalTraceTag}>未纳入</span>
            <div className={styles.finalTraceValue}>{formatV19TraceValue(row.value)}</div>
            {canAdopt && row.intakeId && (
              <button type="button" className={styles.finalTraceAdopt} onClick={() => onAdopt(row.intakeId as string)}>
                采纳这一版
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Applies spec rule 6's timeline cascade after a shot's end time changes; mutates `next` in place. */
function applyV19TimelineCascade(next: V04UiDraft, shotId: string): void {
  const flatShots = next.shotGroups.flatMap((group) => group.shots);
  const cascaded = cascadeV19Timeline(flatShots, shotId);
  if (!cascaded.changedShotIds.length) return;
  const changed = new Set(cascaded.changedShotIds);
  const updatedById = new Map(cascaded.shots.map((shot) => [shot.id, shot]));
  for (const group of next.shotGroups) {
    for (let index = 0; index < group.shots.length; index += 1) {
      const shot = group.shots[index];
      if (!changed.has(shot.id)) continue;
      const updated = updatedById.get(shot.id);
      if (updated) group.shots[index] = { ...shot, startTime: updated.startTime, endTime: updated.endTime };
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function V19StudioDocument({
  draft,
  diff,
  readOnly,
  collapsedModules,
  onToggleModule,
  onChange,
  onInsertShotAfter,
  onInsertBridgeAfter,
  onDeleteShot,
  onDeleteBridge,
  onInsertFirstShot,
  pendingDeleteId,
  onCancelDelete,
  nonCompliantStartCount,
  onNormalizeTimeline,
  onInsertFirstBridge,
  onInvalid,
  onBeforeEdit,
  review,
  final,
}: V19StudioDocumentProps): JSX.Element {
  const setFactText = (key: "commercialIntent" | "storySummary" | "creativeMotif" | "tensionButton" | "creativeThinkingChain" | "carrierExplanation" | "creativeContract" | "gradeReason") =>
    (value: string) => onChange((next) => { next[key] = value; });

  const setOverallGrade = (value: string) => onChange((next) => { if (isGradeValue(value)) next.overallGrade = value; });

  const toggleCarrier = (carrier: string) => onChange((next) => {
    next.carriers = next.carriers.includes(carrier)
      ? next.carriers.filter((item) => item !== carrier)
      : [...next.carriers, carrier];
  });

  const setPrimaryMechanism = (value: V04ChoiceValue) => onChange((next) => { next.primaryMechanism = value; });
  const setAuxiliaryMechanism = (value: V04ChoiceValue) => onChange((next) => { next.auxiliaryMechanism = value; });
  const setStoryReference = (value: V04ChoiceValue) => onChange((next) => { next.storyReference = value; });

  const setBridgeTitle = (bridgeId: string) => (value: string) => onChange((next) => {
    const group = next.shotGroups.find((item) => item.id === bridgeId);
    if (group) group.title = value;
  });
  const setBridgeDescription = (bridgeId: string) => (value: string) => onChange((next) => {
    const group = next.shotGroups.find((item) => item.id === bridgeId);
    if (group) group.creativeDescription = value;
  });
  const setBridgePrimaryRole = (bridgeId: string) => (value: V04ChoiceValue) => onChange((next) => {
    const group = next.shotGroups.find((item) => item.id === bridgeId);
    if (group) group.primaryRole = value;
  });
  const setBridgeAuxiliaryRole = (bridgeId: string) => (value: V04ChoiceValue) => onChange((next) => {
    const group = next.shotGroups.find((item) => item.id === bridgeId);
    if (group) group.auxiliaryRole = value;
  });

  const setShotField = (shotId: string, field: V04ShotFieldKey) => (value: string) => onChange((next) => {
    for (const group of next.shotGroups) {
      const shot = group.shots.find((item) => item.id === shotId);
      if (!shot) continue;
      shot[field] = value;
      if (field === "endTime") applyV19TimelineCascade(next, shotId);
      return;
    }
  });

  const setPrimaryPath = (value: string) => onChange((next) => { if (isPathValue(value)) next.primaryPath = value; });
  const setPrimaryPathAnswer = (path: "LOVE" | "FUN" | "PERCEPTION", index: number) => (value: string) => onChange((next) => {
    next.primaryPathAnswers[path][index] = value;
  });
  const setAuxiliaryPathDetail = (path: "LOVE" | "FUN" | "PERCEPTION", field: "description" | "role") => (value: string) => onChange((next) => {
    const current = next.auxiliaryPathDetails[path] ?? { description: "", role: "" };
    next.auxiliaryPathDetails[path] = { ...current, [field]: value };
  });

  const numbers = new Map(numberedV04Shots(draft.shotGroups).map((item) => [item.stableId, item.displayNumber]));
  const flatShots = draft.shotGroups.flatMap((group) => group.shots);
  const previousShotById = new Map<string, V04UiShot | null>();
  flatShots.forEach((shot, index) => previousShotById.set(shot.id, index > 0 ? flatShots[index - 1] : null));

  const basePrimaryDetails = (() => {
    if (!diff || !diff.changedFields.has(V19_FIELD_TARGET_KEYS.path.primaryDetails)) return undefined;
    const raw = diff.changedFields.get(V19_FIELD_TARGET_KEYS.path.primaryDetails);
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : undefined;
  })();
  const baseAuxiliaryTypes = (() => {
    if (!diff || !diff.changedFields.has(V19_FIELD_TARGET_KEYS.path.auxiliaryTypes)) return undefined;
    const raw = diff.changedFields.get(V19_FIELD_TARGET_KEYS.path.auxiliaryTypes);
    return Array.isArray(raw) ? (raw as Array<{ type: string; description: string; creativeRole: string }>) : undefined;
  })();

  return (
    <>
      {renderModule1()}
      {renderModule2()}
      {renderModule3()}
    </>
  );

  /** 条目上的评论入口。没接评审时什么都不渲染，正文与从前一模一样。 */
  function commentAnchor(targetKey: string, label: string): ReactNode {
    if (!review) return null;
    return (
      <V19ReviewComment
        targetKey={targetKey}
        targetLabel={label}
        comments={review.comments.get(targetKey) ?? NO_COMMENTS}
        currentVersionId={review.currentVersionId}
        canReview={review.canReview}
        disabled={review.disabled}
        onSave={review.onSave}
      />
    );
  }

  /** 开放式条目的标题行：条目名后面跟评论按钮。 */
  function labelWithComment(label: string, targetKey: string): ReactNode {
    return <small>{label}{commentAnchor(targetKey, label)}</small>;
  }

  /**
   * Shared tail for every `final*Extras` helper below: given an already-
   * computed trace and `final`'s view mode, builds the `{sourceHint, after}`
   * half of the props (`locked` is always the same and handled by each
   * caller directly, since it applies even before there's any trace data).
   * 溯源视图下方挂完整来源链；默认视图只在 hover 标题里带最新来源.
   */
  function finalTraceRenderProps(
    trace: {
      hasTrace: boolean;
      currentSourceLabel: string | null;
      overridden: readonly V19FinalTraceHistoryRow[];
      pending: readonly V19FinalTraceHistoryRow[];
      current: V19FinalTraceHistoryRow | null;
    },
    ctx: V19StudioFinalContext,
  ): { sourceHint?: string; after?: ReactNode } {
    // 简化规则 4: nothing changed at all — render nothing, same as a plain field.
    if (!trace.hasTrace) return {};
    if (ctx.traceMode) {
      return {
        after: (
          <V19FinalTraceRows
            currentSourceLabel={trace.currentSourceLabel}
            overridden={trace.overridden}
            pending={trace.pending}
            canAdopt={ctx.canAdopt}
            onAdopt={ctx.onAdopt}
          />
        ),
      };
    }
    return { sourceHint: describeV19FinalTraceHoverSource(trace.current) };
  }

  /**
   * 最终版专属的 `V19EditableValue` 附加 props（spec 五、16/18/19）。没接
   * `final` 时返回 `{}`，正文行为与普通版本完全一样。锁定态（非老孙）两种
   * 视图都要传，让字段始终看得出「这里能点，但点了会被拦下」。
   */
  function finalFieldExtras(targetKey: string): { locked?: boolean; sourceHint?: string; after?: ReactNode } {
    // `locked` must apply purely from being on the final version as a
    // non-老孙 viewer — it must never depend on `finalTrace` having loaded
    // (本机走查 bug fix: that response field is optional server-side, and a
    // missing/slow one must still lock the field, just without a source
    // chain or hover hint to show).
    if (!final) return {};
    if (!final.originPayload) return { locked: final.locked };
    const trace = deriveV19FinalFieldTrace(final.originPayload, final.intakes, targetKey, final.originOwnerName);
    return { locked: final.locked, ...finalTraceRenderProps(trace, final) };
  }

  /** 主导路径细项 (spec 五、18 补充): `path.primaryDetails.<detailKey>` — see `deriveV19PrimaryDetailTrace`. */
  function finalPrimaryDetailExtras(detailKey: string): { locked?: boolean; sourceHint?: string; after?: ReactNode } {
    if (!final) return {};
    if (!final.originPayload) return { locked: final.locked };
    const trace = deriveV19PrimaryDetailTrace(final.originPayload, final.intakes, detailKey, final.originOwnerName);
    return { locked: final.locked, ...finalTraceRenderProps(trace, final) };
  }

  /** 辅助路径描述／创意作用 (spec 五、18 补充): `path.auxiliaryTypes[type].<field>` — see `deriveV19AuxiliaryPathTrace`. */
  function finalAuxiliaryPathExtras(
    auxType: string,
    field: "description" | "creativeRole",
  ): { locked?: boolean; sourceHint?: string; after?: ReactNode } {
    if (!final) return {};
    if (!final.originPayload) return { locked: final.locked };
    const trace = deriveV19AuxiliaryPathTrace(final.originPayload, final.intakes, auxType, field, final.originOwnerName);
    return { locked: final.locked, ...finalTraceRenderProps(trace, final) };
  }

  /** 固定选项字段 (spec 五、18 补充): V04ChoiceField 支持的 `after`/`sourceHint` 插槽 — see `deriveV19ChoiceFieldTrace`. */
  function finalChoiceFieldExtras(
    targetKey: string,
    vocabularyField: V04VocabularyFieldKey,
  ): { locked?: boolean; sourceHint?: string; after?: ReactNode } {
    if (!final) return {};
    if (!final.originPayload) return { locked: final.locked };
    const trace = deriveV19ChoiceFieldTrace(final.originPayload, final.intakes, targetKey, vocabularyField, final.originOwnerName);
    return { locked: final.locked, ...finalTraceRenderProps(trace, final) };
  }

  /**
   * 创意承重载体 (spec 五、18 补充): the fixed three-option chip toggle is
   * neither a `V19EditableValue` nor a `V04ChoiceField`, so there's no
   * `locked`/`sourceHint` prop to spread here — this only renders the
   * `after` slot (溯源视图下方的当前采用／旧写法／未纳入), by hand, right
   * under the chip group. See `deriveV19CarrierTrace`.
   */
  function finalCarrierExtras(): ReactNode {
    if (!final || !final.originPayload) return null;
    const trace = deriveV19CarrierTrace(final.originPayload, final.intakes, final.originOwnerName);
    return finalTraceRenderProps(trace, final).after ?? null;
  }

  function moduleHeader(number: number, eyebrow: string, title: string): ReactNode {
    return (
      <header className={styles.stickyModuleHeader}>
        <div><small>{eyebrow}</small><h2>{title}</h2></div>
        <button type="button" onClick={() => onToggleModule(number)}>{collapsedModules.has(number) ? "展开" : "收起"}</button>
      </header>
    );
  }

  function renderModule1(): ReactNode {
    const collapsed = collapsedModules.has(1);
    return (
      <section className={styles.readingModule} id="module-1">
        {moduleHeader(1, "MODULE 01", "第一模块｜全片事实与核心判断")}
        {!collapsed && (
          <div className={styles.readingCore}>
            <div id={V04_WORKSPACE_TARGETS.commercialIntent}>
              {labelWithComment("商业意图", V19_FIELD_TARGET_KEYS.facts.commercialIntent)}
              <V19EditableValue kind="textarea" block ariaLabel="商业意图" value={draft.commercialIntent} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.commercialIntent)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.commercialIntent)}
                onCommit={setFactText("commercialIntent")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.storySummary}>
              {labelWithComment("故事梗概", V19_FIELD_TARGET_KEYS.facts.storySummary)}
              <V19EditableValue kind="textarea" block ariaLabel="故事梗概" value={draft.storySummary} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.storySummary)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.storySummary)}
                onCommit={setFactText("storySummary")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.creativeMotif}>
              {labelWithComment("创意母题", V19_FIELD_TARGET_KEYS.facts.creativeMotif)}
              <V19EditableValue kind="textarea" block ariaLabel="创意母题" value={draft.creativeMotif} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.creativeMotif)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.creativeMotif)}
                onCommit={setFactText("creativeMotif")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.tensionButton}>
              {labelWithComment("张力按钮", V19_FIELD_TARGET_KEYS.facts.tensionButton)}
              <V19EditableValue kind="textarea" block ariaLabel="张力按钮" value={draft.tensionButton} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.tensionButton)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.tensionButton)}
                onCommit={setFactText("tensionButton")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.creativeThinkingChain}>
              {labelWithComment("创意思维链", V19_FIELD_TARGET_KEYS.facts.creativeThinkingChain)}
              <V19EditableValue kind="textarea" block ariaLabel="创意思维链" value={draft.creativeThinkingChain} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.creativeThinkingChain)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.creativeThinkingChain)}
                onCommit={setFactText("creativeThinkingChain")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.storyReference}>
              <small>故事参照类型</small>
              <V04ChoiceField label="故事参照类型" value={draft.storyReference} options={V04_UI_STORY_OPTIONS}
                customLabel="自定义故事参照类型" readOnly={readOnly} onChange={setStoryReference}
                {...finalChoiceFieldExtras(V19_FIELD_TARGET_KEYS.facts.storyReference, "storyReferenceType")} />
              <ChoiceDiffNote diff={diff} targetKey={V19_FIELD_TARGET_KEYS.facts.storyReference} labels={storyLabels} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.primaryMechanism}>
              <small>创意主导手法及机制</small>
              <V04ChoiceField label="创意主导手法及机制" value={draft.primaryMechanism} options={V04_UI_MECHANISM_OPTIONS}
                customLabel="自定义通用机制" showAdvanced={draft.primaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM")}
                advancedTargetId={V04_WORKSPACE_TARGETS.primaryMechanismAdvanced} readOnly={readOnly} onChange={setPrimaryMechanism}
                {...finalChoiceFieldExtras(V19_FIELD_TARGET_KEYS.facts.primaryMechanism, "generalMechanism")} />
              <ChoiceDiffNote diff={diff} targetKey={V19_FIELD_TARGET_KEYS.facts.primaryMechanism} labels={mechanismLabels} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.auxiliaryMechanism}>
              <small>创意辅助手法及机制</small>
              <V04ChoiceField label="创意辅助手法及机制" value={draft.auxiliaryMechanism} options={V04_UI_MECHANISM_OPTIONS} multiple
                customLabel="自定义辅助机制" showAdvanced={draft.auxiliaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM")}
                advancedTargetId={V04_WORKSPACE_TARGETS.auxiliaryMechanismAdvanced} readOnly={readOnly} onChange={setAuxiliaryMechanism}
                {...finalChoiceFieldExtras(V19_FIELD_TARGET_KEYS.facts.auxiliaryMechanism, "generalMechanism")} />
              <ChoiceDiffNote diff={diff} targetKey={V19_FIELD_TARGET_KEYS.facts.auxiliaryMechanism} labels={mechanismLabels} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.carriers}>
              <small>创意承重载体</small>
              {/* 固定三选项的多选，不是自由文本：契约限定最多 3 项且不重复，放开输入
                  会让保存在契约校验处失败，而用户看不出哪里写错了。 */}
              <section className={styles.inlineChoices}>
                {V19_CARRIER_OPTIONS.map((carrier) => (
                  <button type="button" key={carrier} disabled={readOnly}
                    aria-pressed={draft.carriers.includes(carrier)}
                    className={draft.carriers.includes(carrier) ? styles.isSelected : ""}
                    onClick={() => toggleCarrier(carrier)}>{carrier}</button>
                ))}
              </section>
              {carriersBaseText(diff, V19_FIELD_TARGET_KEYS.facts.carriers) === undefined ? null : (
                <>
                  <span className={styles.diffTag}>已修改</span>
                  <span className={styles.diffBase}>
                    基版：{carriersBaseText(diff, V19_FIELD_TARGET_KEYS.facts.carriers) || "—"}
                  </span>
                </>
              )}
              {finalCarrierExtras()}
            </div>
            <div id={V04_WORKSPACE_TARGETS.carrierExplanation}>
              {labelWithComment("创意承重载体具体说明", V19_FIELD_TARGET_KEYS.facts.carrierExplanation)}
              <V19EditableValue kind="textarea" block ariaLabel="创意承重载体具体说明" value={draft.carrierExplanation} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.carrierExplanation)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.carrierExplanation)}
                onCommit={setFactText("carrierExplanation")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.creativeContract} style={{ gridColumn: "1 / -1" }}>
              {labelWithComment("创意成立契约（隐含情理）", V19_FIELD_TARGET_KEYS.facts.creativeContract)}
              <V19EditableValue kind="textarea" block ariaLabel="创意成立契约（隐含情理）" value={draft.creativeContract} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.creativeContract)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.creativeContract)}
                onCommit={setFactText("creativeContract")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
          </div>
        )}
      </section>
    );
  }

  function renderModule2(): ReactNode {
    const collapsed = collapsedModules.has(2);
    return (
      <section className={styles.readingModule} id="module-2">
        {moduleHeader(2, "MODULE 02", "第二模块｜脚本反写")}
        {!collapsed && !readOnly && nonCompliantStartCount > 0 && (
          // 换规则不等于可以改写别人写下的时间：只报告，由人决定要不要重排。
          <div className={styles.timelineNotice}>
            <span>
              有 {nonCompliantStartCount} 个镜头的开始时间是过去自由录入的，
              与「开始时间＝上一镜头结束时间＋1秒」不一致。
            </span>
            <button type="button" onClick={onNormalizeTimeline}>按规则重排</button>
          </div>
        )}
        {!collapsed && draft.shotGroups.map((group, groupIndex) => renderBridge(group, groupIndex))}
        {!collapsed && draft.shotGroups.length === 0 && (
          <div className={styles.readingGroup}>
            {readOnly ? (
              <p>尚未拆解桥段。</p>
            ) : (
              <div className={styles.insertBridgeRow} data-v19-first-bridge>
                <button type="button" onClick={onInsertFirstBridge}>＋ 添加第一个桥段</button>
              </div>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderBridge(group: V04UiShotGroup, groupIndex: number): ReactNode {
    const isNewBridge = Boolean(diff?.newBridgeIds.has(group.id));
    return (
      <section className={styles.readingGroup} id={`bridge-${group.id}`} key={group.id}>
        <header>
          <V19SystemValue title="桥段序号由系统自动维护">桥段 {padNumber(groupIndex + 1)}</V19SystemValue>
          <div className={styles.studioBridgeTitle}>
            <small>桥段名称</small>
            <h3>
              <V19EditableValue ariaLabel="桥段名称" value={group.title} placeholder="未命名桥段" readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "bridgeName"))}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "bridgeName"))}
                onCommit={setBridgeTitle(group.id)} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
              {commentAnchor(
                CASE_REVIEW_TARGETS.bridge(group.id),
                `桥段${padNumber(groupIndex + 1)}｜${group.title || "未命名桥段"}`,
              )}
              {isNewBridge && <span className={styles.diffNew} data-v19-diff="new">本版新增</span>}
            </h3>
          </div>
        </header>
        <div className={styles.readingBridgeMeta}>
          <div>
            <small>桥段创意作用</small>
            <V04ChoiceField label="桥段主创意作用" value={group.primaryRole} options={V04_UI_BRIDGE_OPTIONS}
              customLabel="自定义主创意作用" readOnly={readOnly} onChange={setBridgePrimaryRole(group.id)}
              {...finalChoiceFieldExtras(V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "primaryCreativeRole"), "bridgeCreativeRole")} />
            <ChoiceDiffNote diff={diff} targetKey={V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "primaryCreativeRole")} labels={bridgeRoleLabels} />
            <V04ChoiceField label="桥段辅助创意作用" value={group.auxiliaryRole} options={V04_UI_BRIDGE_OPTIONS} multiple max={3}
              customLabel="自定义辅助创意作用" readOnly={readOnly} onChange={setBridgeAuxiliaryRole(group.id)}
              {...finalChoiceFieldExtras(V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "auxiliaryCreativeRole"), "bridgeCreativeRole")} />
            <ChoiceDiffNote diff={diff} targetKey={V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "auxiliaryCreativeRole")} labels={bridgeRoleLabels} />
          </div>
          <div>
            <small>本桥段关键创意描述</small>
            <V19EditableValue kind="textarea" block ariaLabel="本桥段关键创意描述" value={group.creativeDescription} readOnly={readOnly}
              baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "keyCreativeDescription"))}
              {...finalFieldExtras(V19_FIELD_TARGET_KEYS.shotGroupField(group.id, "keyCreativeDescription"))}
              onCommit={setBridgeDescription(group.id)} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
          </div>
        </div>
        {group.shots.map((shot) => renderShot(shot, groupIndex))}
        {!readOnly && group.shots.length === 0 && (
          <div className={styles.insertShotRow} data-v19-empty-bridge>
            <button type="button" onClick={() => onInsertFirstShot(group.id)}>＋ 添加第一个镜头</button>
          </div>
        )}
        {!readOnly && (
          <div className={styles.insertBridgeRow}>
            <button type="button" onClick={() => onInsertBridgeAfter(group.id)}>＋ 在此桥段后插入桥段</button>
            <button type="button" className={styles.deleteAction}
              data-v19-confirming={pendingDeleteId === group.id ? "true" : undefined}
              onClick={() => onDeleteBridge(group.id)}>
              {pendingDeleteId === group.id
                ? `再点一次删除此桥段${group.shots.length > 0 ? `及其 ${group.shots.length} 个镜头` : ""}`
                : "－ 删除此桥段"}
            </button>
            {pendingDeleteId === group.id && (
              <button type="button" className={styles.cancelDelete} data-v19-cancel-delete
                onClick={onCancelDelete}>取消</button>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderShot(shot: V04UiShot, groupIndex: number): ReactNode {
    const globalNumber = numbers.get(shot.id) ?? 0;
    const previousShot = previousShotById.get(shot.id) ?? null;
    const { endWarning } = computeV19ShotTimelineWarnings(shot, previousShot);
    const isNewShot = Boolean(diff?.newShotIds.has(shot.id));
    return (
      <article className={styles.readingShot} id={`row-${shot.id}`} key={shot.id}>
        <h4>
          <V19SystemValue title="桥段与镜头序号由系统自动维护">
            桥段{padNumber(groupIndex + 1)}－镜头{padNumber(globalNumber)}
          </V19SystemValue>
          {commentAnchor(
            CASE_REVIEW_TARGETS.shot(shot.id),
            `桥段${padNumber(groupIndex + 1)}－镜头${padNumber(globalNumber)}`,
          )}
          {isNewShot && <span className={styles.diffNew} data-v19-diff="new">本版新增</span>}
        </h4>
        {SHOT_FIELD_ROWS.map(({ className, keys }) => (
          <div className={`${styles.readingShotBlock} ${styles[className]}`} key={keys.join("-")}>
            {keys.map((key) => (
              <div key={key}>
                <small>{shotFieldLabels[key]}</small>
                {key === "startTime" && globalNumber !== 1 ? (
                  // 开始时间＝上一镜头结束时间＋1秒，由系统维护：用户只填结束时间，
                  // 增删镜头后时间线自动闭合，重叠与倒挂无从发生。
                  <V19SystemValue title="由上一镜头结束时间＋1秒自动推导；调整时间请改上一镜头的结束时间">
                    {shot[key] || "—"}
                  </V19SystemValue>
                ) : (
                  <V19EditableValue
                    kind={key === "startTime" || key === "endTime" ? "timecode" : key === "visualContent" ? "textarea" : "text"}
                    block={key === "visualContent"}
                    ariaLabel={shotFieldLabels[key]}
                    value={shot[key]}
                    readOnly={readOnly}
                    warning={key === "endTime" ? endWarning : undefined}
                    baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.shotField(shot.id, key))}
                    {...finalFieldExtras(V19_FIELD_TARGET_KEYS.shotField(shot.id, key))}
                    onCommit={setShotField(shot.id, key)}
                    onInvalid={onInvalid} onBeforeEdit={onBeforeEdit}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
        {!readOnly && (
          <div className={styles.insertShotRow}>
            <button type="button" onClick={() => onInsertShotAfter(shot.id)} title="新镜头开始时间自动继承本镜头结束时间＋1秒">
              ＋ 在此镜头后插入镜头
            </button>
            <button type="button" className={styles.deleteAction}
              data-v19-confirming={pendingDeleteId === shot.id ? "true" : undefined}
              onClick={() => onDeleteShot(shot.id)}>
              {pendingDeleteId === shot.id ? "再点一次删除此镜头" : "－ 删除此镜头"}
            </button>
            {pendingDeleteId === shot.id && (
              <button type="button" className={styles.cancelDelete} data-v19-cancel-delete
                onClick={onCancelDelete}>取消</button>
            )}
          </div>
        )}
      </article>
    );
  }

  function renderModule3(): ReactNode {
    const collapsed = collapsedModules.has(3);
    const path = draft.primaryPath;
    const pathFieldLabels = V04_UI_PATHS.find((item) => item.id === path)?.fields ?? [];
    return (
      <section className={styles.readingModule} id="module-3">
        {moduleHeader(3, "MODULE 03", "第三模块｜主导感知类型发生路径与整体评价")}
        {!collapsed && (
          <div className={styles.readingCore}>
            <div>
              {labelWithComment("主导路径", V19_FIELD_TARGET_KEYS.path.primaryType)}
              <V19EditableValue kind="select" options={PATH_OPTIONS} ariaLabel="主导路径" value={path} readOnly={readOnly}
                baseValue={(() => {
                  if (!diff || !diff.changedFields.has(V19_FIELD_TARGET_KEYS.path.primaryType)) return undefined;
                  const raw = diff.changedFields.get(V19_FIELD_TARGET_KEYS.path.primaryType);
                  return raw == null ? "" : pathLabels[String(raw)] ?? String(raw);
                })()}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.path.primaryType)}
                onCommit={setPrimaryPath} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            {draft.primaryPathAnswers[path].map((value, index) => (
              <div key={index}>
                <small>
                  {pathFieldLabels[index]}
                  {commentAnchor(CASE_REVIEW_TARGETS.primaryPathDetail(path, index), pathFieldLabels[index] ?? "主导路径细项")}
                </small>
                {/* 后端把这一路径下全部细项合并存成一条 path.primaryDetails 汇入记录
                    （值是 { <detailKey>: string }），deriveV19PrimaryDetailTrace
                    按 detailKey 从每条记录里单独抽一次再走通用的合并/展示规则。 */}
                <V19EditableValue kind="textarea" block ariaLabel={pathFieldLabels[index] ?? "主导路径细项"} value={value} readOnly={readOnly}
                  baseValue={basePrimaryDetails ? (basePrimaryDetails[PRIMARY_PATH_DETAIL_KEYS[path][index]] ?? "") : undefined}
                  {...finalPrimaryDetailExtras(PRIMARY_PATH_DETAIL_KEYS[path][index])}
                  onCommit={setPrimaryPathAnswer(path, index)} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
              </div>
            ))}
            {draft.auxiliaryPaths.map((auxPath) => {
              const detail = draft.auxiliaryPathDetails[auxPath] ?? { description: "", role: "" };
              const baseEntry = baseAuxiliaryTypes?.find((item) => item.type === auxPath);
              return (
                <div key={auxPath}>
                  <small>
                    辅助路径｜{pathLabels[auxPath]}
                    {commentAnchor(CASE_REVIEW_TARGETS.auxiliaryPath(auxPath), `辅助路径｜${pathLabels[auxPath]}`)}
                  </small>
                  {/* 同上：path.auxiliaryTypes 是一条合并的结构记录（[{type, description,
                      creativeRole}]），deriveV19AuxiliaryPathTrace 按 (type, 字段) 单独抽一次。 */}
                  <V19EditableValue kind="textarea" block ariaLabel={`辅助路径描述｜${pathLabels[auxPath]}`} value={detail.description} readOnly={readOnly}
                    baseValue={baseAuxiliaryTypes ? (baseEntry?.description ?? "") : undefined}
                    {...finalAuxiliaryPathExtras(auxPath, "description")}
                    onCommit={setAuxiliaryPathDetail(auxPath, "description")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
                  <V19EditableValue kind="textarea" block ariaLabel={`辅助路径创意作用｜${pathLabels[auxPath]}`} value={detail.role} readOnly={readOnly}
                    baseValue={baseAuxiliaryTypes ? (baseEntry?.creativeRole ?? "") : undefined}
                    {...finalAuxiliaryPathExtras(auxPath, "creativeRole")}
                    onCommit={setAuxiliaryPathDetail(auxPath, "role")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
                </div>
              );
            })}
            <div id={V04_WORKSPACE_TARGETS.overallGrade}>
              {labelWithComment("整体创意评价", V19_FIELD_TARGET_KEYS.facts.overallGrade)}
              <V19EditableValue kind="select" options={GRADE_OPTIONS} monospace ariaLabel="整体创意评价" value={draft.overallGrade} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.overallGrade)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.overallGrade)}
                onCommit={setOverallGrade} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
            <div id={V04_WORKSPACE_TARGETS.gradeReason}>
              {labelWithComment("评价理由", V19_FIELD_TARGET_KEYS.facts.gradeReason)}
              <V19EditableValue kind="textarea" block ariaLabel="评价理由" value={draft.gradeReason} readOnly={readOnly}
                baseValue={factBaseText(diff, V19_FIELD_TARGET_KEYS.facts.gradeReason)}
                {...finalFieldExtras(V19_FIELD_TARGET_KEYS.facts.gradeReason)}
                onCommit={setFactText("gradeReason")} onInvalid={onInvalid} onBeforeEdit={onBeforeEdit} />
            </div>
          </div>
        )}
      </section>
    );
  }
}
