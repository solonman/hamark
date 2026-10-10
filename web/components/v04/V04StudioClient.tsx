"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { V04_VOCABULARY_VERSION, type V04ChoiceValue, type V04DraftPayloadV1 } from "@/lib/v04-contract";
import {
  cloneV04UiDraft,
  emptyV04UiDraft,
  v04PayloadChanges,
  v04PayloadToUiDraft,
  v04UiDraftToPayload,
  type V04UiDraft,
  type V04UiShotGroup,
} from "@/lib/v04-ui-model";
import { blankV04Shot, locateV04Target, mintV04LocalId, numberedV04Shots, V04_LOCATED_MARK_MS, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04LatestSaveCoordinator } from "@/lib/v04-save-coordinator";
import { v04UiApi } from "@/lib/v04-ui-api-client";
import {
  formatV19VersionLabel,
  v19Api,
  V04UiApiError,
  type V19CurrentVersion,
  preserveV19UntouchedPerceptionPath,
  type V19FinalActionRequestBody,
  type V19StudioModel,
  type V19VersionKind,
  type V19VersionSummary,
} from "@/lib/v19-ui-model";
import { audioReviewApi, type AudioReviewView } from "@/lib/audio-review-model";
import {
  audioReviewForVersion,
  audioReviewTransitionToast,
  buildV19ReviewBasis,
  inFlightAudioReviewKey,
  nextV19VersionNumber,
  removeAudioReviewSummary,
  resolveV19AudioReviewEntry,
  summarizeAudioReview,
  upsertAudioReviewSummary,
  type V19ReviewBasisEntry,
} from "@/lib/audio-review-ui";
import { describeV19Diff, diffV19AgainstBase, type V19BaseDiff } from "@/lib/v19-base-diff";
import { readJsonResponse } from "@/lib/http-json";
import {
  commentsByTarget,
  emptyCaseReview,
  type CaseReviewComment,
  type CaseReviewModel,
} from "@/lib/case-review";
import { deriveV19StartTimes, findV19NonCompliantStarts, nextV19StartTime } from "@/lib/v19-timeline";
import { formatShortDateTime } from "@/lib/date-format";
import { describeV19StructuralIntake, pendingV19StructuralIntakes } from "@/lib/v19-final-trace";
import type { V19StudioFinalContext } from "./V19StudioDocument";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import ThemeSwitcher from "@/components/shared/ThemeSwitcher";
import V04VideoPlayer from "./V04VideoPlayer";
import V19StudioDocument from "./V19StudioDocument";
import V19AssignmentRating from "./V19AssignmentRating";
import V19AudioReviewEntry from "./V19AudioReviewEntry";
import V19AudioReviewUploadDialog from "./V19AudioReviewUploadDialog";
import V19AudioReviewDrawer from "./V19AudioReviewDrawer";
import V19AudioReviewCard, { V19_AUDIO_REVIEW_CARD_ID } from "./V19AudioReviewCard";
import { AudioReviewIcon, AudioReviewVersionTag } from "./V19AudioReviewParts";
import styles from "./V04Surface.module.css";

/**
 * V1.9 二合一工作台外壳：顶栏（版本菜单、对比基版开关、自动保存状态、目录折叠）、
 * 左侧目录与滚动高亮、到顶/到底、自动保存引擎、视频窗口挂载。正文渲染交给
 * `V19StudioDocument`（该组件只管渲染与回调，不碰网络）。见
 * `docs/18_V1.9_二合一工作台重构实施规格_V0.1.md` 五之三「组件边界」。
 */

export type V19StudioNavigation = { libraryHref: string; detailHref: string };

type V19SaveStatus =
  | { kind: "IDLE" }
  | { kind: "SAVING" }
  | { kind: "SAVED"; at: string }
  | { kind: "ERROR"; message: string };

type V19Toast = { id: string; text: string };

/** How many steps back the studio remembers. Bounded so a long session cannot grow without limit. */
const V19_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Pure helpers — no React, no DOM. Exported so they can be unit-tested
// directly (same technique as `resolveV19CommitValue` in V19EditableValue.tsx
// and `computeV19ShotTimelineWarnings` in V19StudioDocument.tsx).
// ---------------------------------------------------------------------------

/**
 * Spec rule 4: the viewer edits only their own version. When they are looking
 * at someone else's version and already own one, an edit must switch them to
 * their own version instead of touching what they're looking at. When they
 * have no version yet, editing is allowed as-is — the first save auto-creates
 * their version server-side.
 */
export type V19EditGuardDecision =
  | { action: "PROCEED" }
  | { action: "SWITCH_TO_OWN"; versionId: string }
  /** Final version, viewer is not 老孙 (spec 五、16) — the edit is refused outright, never redirected. */
  | { action: "BLOCKED_FINAL" };

/**
 * `canEditFinal` only matters when `current.isFinal` is true — it is the
 * viewer's `viewerCapabilities.canEdit` for that view, which the GET route
 * already sets to `isCaseReviewer(actor)` there (spec 四、4.1). 老孙 on the
 * final version always proceeds and is never switched to his own per-editor
 * version — the final version has no owner, so `current.isMine` is always
 * false there and must not trigger the ordinary fork-redirect below.
 *
 * 点评版（docs/25 五、3）：`isMine` 恒为 false（它不是谁的「我的版本」），所以
 * 归属人（老孙）要靠 `ownerUserId === viewerUserId` 认出来——他直接改点评版本身，
 * 保存时 `basedOnVersionId` 就是点评版。其他人照改别人版本的规则：已有自己的
 * 版本就切回去；还没有就照常编辑，服务端以点评版为底新建他的版本。
 */
export function resolveV19EditGuard(
  current: { isMine: boolean; isFinal?: boolean; kind?: V19VersionKind; ownerUserId?: string },
  myVersionId: string | null,
  canEditFinal?: boolean,
  viewerUserId?: string,
): V19EditGuardDecision {
  if (current.isFinal) return canEditFinal ? { action: "PROCEED" } : { action: "BLOCKED_FINAL" };
  if (current.kind === "AUDIO_REVIEW" && viewerUserId && current.ownerUserId === viewerUserId) return { action: "PROCEED" };
  if (current.isMine) return { action: "PROCEED" };
  if (myVersionId) return { action: "SWITCH_TO_OWN", versionId: myVersionId };
  return { action: "PROCEED" };
}

/**
 * Counts how many shots after the edited one got their timeline cascaded
 * (spec rule 6). `V19StudioDocument` already applies the cascade itself
 * before calling back through `onChange(mutate)`, so this does not re-run
 * the cascade — it only detects it happened, by comparing shot times before
 * and after the mutation, so the shell can show the toast. The first shot
 * (in global order) whose own start/end differs is the edited shot itself
 * (a cascade only ever moves shots strictly after it); every later shot
 * whose start time also differs was cascaded.
 */
export function countV19CascadedShots(before: V04UiDraft, after: V04UiDraft): number {
  const beforeShots = before.shotGroups.flatMap((group) => group.shots);
  const afterShots = after.shotGroups.flatMap((group) => group.shots);
  let rootIndex = -1;
  for (let index = 0; index < afterShots.length; index += 1) {
    const beforeShot = beforeShots[index];
    const afterShot = afterShots[index];
    if (!beforeShot || beforeShot.id !== afterShot.id) return 0;
    if (beforeShot.startTime !== afterShot.startTime || beforeShot.endTime !== afterShot.endTime) {
      rootIndex = index;
      break;
    }
  }
  if (rootIndex < 0) return 0;
  let count = 0;
  for (let index = rootIndex + 1; index < afterShots.length; index += 1) {
    const beforeShot = beforeShots[index];
    const afterShot = afterShots[index];
    if (beforeShot && beforeShot.id === afterShot.id && beforeShot.startTime !== afterShot.startTime) count += 1;
  }
  return count;
}

/**
 * Spec 五、17: after a normal (non-final) version save that actually wrote
 * something, decide whether to toast about `finalIntake` and what to say —
 * "已同步进入集成版" when it merged, an amber "未纳入" warning when it didn't
 * (集成版已定稿). `previousSignature` is the `signature` this returned last
 * time (or null on the first call / after switching versions); a repeat of
 * the exact same `merged`/`pending` outcome returns null so an unbroken run
 * of ordinary autosaves — each individually a real change — does not spam a
 * toast for every keystroke's save, only when that outcome actually shifts.
 */
export function describeV19FinalIntakeToast(
  changes: ReadonlyArray<{ targetLabel: string }>,
  finalIntake: { merged: boolean; pending: number },
  previousSignature: string | null,
): { text: string; signature: string } | null {
  if (changes.length === 0) return null;
  const signature = `${finalIntake.merged}:${finalIntake.pending}`;
  if (signature === previousSignature) return null;
  const label = changes.length === 1 ? changes[0].targetLabel : `本次的 ${changes.length} 处修改`;
  const text = finalIntake.merged
    ? `「${label}」的修改已同步进入集成版`
    : `集成版已定稿，「${label}」的修改未纳入集成版，等老孙取消定稿后采纳`;
  return { text, signature };
}

export type V19VersionTreeRow = { version: V19VersionSummary; depth: number };

/**
 * Builds the version panel's tree, rooted at every version with `baseNumber === null`.
 * 点评版和它的被点评版本是父子关系（baseNumber 就是被点评的那一版），同一层里
 * 点评版排在其他派生版本前面，紧挂在被点评版本下面（docs/25 二、5）。
 */
export function buildV19VersionTree(versions: readonly V19VersionSummary[]): V19VersionTreeRow[] {
  const byBase = new Map<number | "root", V19VersionSummary[]>();
  for (const version of versions) {
    const key: number | "root" = version.baseNumber === null ? "root" : version.baseNumber;
    const bucket = byBase.get(key);
    if (bucket) bucket.push(version); else byBase.set(key, [version]);
  }
  const rows: V19VersionTreeRow[] = [];
  const reviewFirst = (list: V19VersionSummary[] | undefined) => [...(list ?? [])]
    .sort((left, right) => Number(right.kind === "AUDIO_REVIEW") - Number(left.kind === "AUDIO_REVIEW"));
  const walk = (list: V19VersionSummary[] | undefined, depth: number) => {
    for (const version of reviewFirst(list)) {
      rows.push({ version, depth });
      walk(byBase.get(version.number), depth + 1);
    }
  };
  walk(byBase.get("root"), 0);
  return rows;
}

/** 上传时间只到日：卡片与顶栏都不需要精确到分秒。 */
function formatV19Date(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatV19Clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 8);
}

/**
 * 本机走查修饰: every place that used to build a short version label as
 * `v${number}` must say "集成版" instead when `current` is the final version
 * — its `number` is a fixed `0` placeholder (spec 四、4.1), never a real
 * version number to display. Exported so it's directly unit-testable.
 */
export function formatV19CurrentVersionShortLabel(current: { isFinal: boolean; number: number }): string {
  return current.isFinal ? "集成版" : `v${current.number}`;
}

function emptyV19ChoiceValue(): V04ChoiceValue {
  return { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION };
}

// Plain (non-hook) helpers called from inside `useMemo` below instead of
// accessing `model.current.*` inline: the React Compiler's dependency
// inference reads `.current` as a ref access even though `V19CurrentVersion`
// is a plain object field that happens to be named `current`, which makes it
// infer a narrower dependency path than `[model]` and refuse to preserve the
// manual memoization. Routing through an opaque function call (same pattern
// already used for `v04WorkspaceToUiCase(model)` in V04WorkspaceClient.tsx)
// keeps the dependency at the granularity of the whole `model` object.
function computeV19Diff(model: V19StudioModel | null, draft: V04UiDraft): V19BaseDiff | null {
  if (!model || model.current.baseNumber === null) return null;
  return diffV19AgainstBase(draftAsSavedPayload(model, draft), model.current.basePayload);
}

// 草稿表达不了「主导感知类型未选择」（界面把未选当成 LOVE 显示），直接转回 payload 会凭空多出一个
// 主导路径，跟基版一比就成了「已修改」。比较和依据标记都按保存时的同一规则还原，看到的才是真正存下的内容。
function draftAsSavedPayload(model: V19StudioModel, draft: V04UiDraft) {
  return preserveV19UntouchedPerceptionPath(v04UiDraftToPayload(draft, model.current.payload), model.current.payload);
}

// 点评版视角下正文的「依据 意见 N」「老孙已手改」（docs/25 七、6）。和 computeV19Diff
// 一样放在组件外：理由见上面那段关于 React Compiler 与 `.current` 的说明。
function computeV19ReviewBasis(
  model: V19StudioModel | null,
  draft: V04UiDraft,
  review: { id: string; view: AudioReviewView } | null,
): ReadonlyMap<string, V19ReviewBasisEntry> | undefined {
  if (!model || model.current.kind !== "AUDIO_REVIEW" || !review || review.id !== model.current.audioReviewId) return undefined;
  return buildV19ReviewBasis(review.view, draftAsSavedPayload(model, draft));
}

function computeV19DefaultBaseId(model: V19StudioModel | null): string {
  if (!model) return "";
  // The final version's own row uses the literal "final" as its <option>
  // value (its real id, when it has one, only identifies the row — the
  // create-version API takes the string "final", not that id; spec 五、13).
  if (model.current.isFinal) return "final";
  return model.current.id ?? model.versions.find((version) => version.id !== null)?.id ?? "";
}

const MODULE_ONE_NAV_FIELDS: ReadonlyArray<readonly [string, string]> = [
  [V04_WORKSPACE_TARGETS.commercialIntent, "商业意图"],
  [V04_WORKSPACE_TARGETS.storySummary, "故事梗概"],
  [V04_WORKSPACE_TARGETS.creativeMotif, "创意母题"],
  [V04_WORKSPACE_TARGETS.tensionButton, "张力按钮"],
  [V04_WORKSPACE_TARGETS.creativeThinkingChain, "创意思维链"],
  [V04_WORKSPACE_TARGETS.storyReference, "故事参照类型"],
  [V04_WORKSPACE_TARGETS.primaryMechanism, "主导机制"],
  [V04_WORKSPACE_TARGETS.auxiliaryMechanism, "辅助机制"],
  [V04_WORKSPACE_TARGETS.carriers, "创意承重载体"],
  [V04_WORKSPACE_TARGETS.carrierExplanation, "创意承重载体具体说明"],
  [V04_WORKSPACE_TARGETS.creativeContract, "创意成立契约"],
];

const MODULE_THREE_NAV_FIELDS: ReadonlyArray<readonly [string, string]> = [
  [V04_WORKSPACE_TARGETS.overallGrade, "整体创意评价"],
  [V04_WORKSPACE_TARGETS.gradeReason, "评价理由"],
];

const V19_FINAL_TRACE_MODE_KEY = "v19-final-trace-mode";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function V04StudioClient({
  videoId,
  viewerName,
  viewerUserId,
  navigation,
}: {
  videoId: string;
  viewerName: string;
  viewerUserId: string;
  navigation?: V19StudioNavigation;
}) {
  const links = navigation ?? { libraryHref: "/", detailHref: `/videos/${encodeURIComponent(videoId)}` };

  const modelRef = useRef<V19StudioModel | null>(null);
  const [model, setModelState] = useState<V19StudioModel | null>(null);
  const draftRef = useRef<V04UiDraft>(emptyV04UiDraft());
  const [draft, setDraftState] = useState<V04UiDraft>(() => emptyV04UiDraft());
  const savedPayloadRef = useRef<V04DraftPayloadV1 | null>(null);
  const editVersionRef = useRef(0);
  const undoStackRef = useRef<V04UiDraft[]>([]);
  const redoStackRef = useRef<V04UiDraft[]>([]);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const [diffIndex, setDiffIndex] = useState(0);
  // 待确认的删除目标。删除会带走内容，所以要按两次；确认态在别处发生任何
  // 变化时都会失效，免得停在半路的确认被下一次误点接住。
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const saveCoordinatorRef = useRef(new V04LatestSaveCoordinator<V04UiDraft>());
  const changeSetIdsRef = useRef(new Map<number, string>());
  const [saveStatus, setSaveStatus] = useState<V19SaveStatus>({ kind: "IDLE" });
  const [loadError, setLoadError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const [collapsedModules, setCollapsedModules] = useState<Set<number>>(new Set());
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [versionPanelOpen, setVersionPanelOpen] = useState(false);
  const versionPanelRef = useRef<HTMLDivElement>(null);
  const [diffOn, setDiffOn] = useState(false);
  const [toasts, setToasts] = useState<V19Toast[]>([]);
  const [activeNavId, setActiveNavId] = useState("module-1");
  const [scrollState, setScrollState] = useState({ atTop: true, atBottom: false });
  const [createBaseId, setCreateBaseId] = useState("");
  // 评审（评分与逐条目评论）跟着「当前正在看的版本」走，与作业内容分开读写：
  // 读不到评审不影响写作业，写评审也不进版本链的变更集。
  const [review, setReview] = useState<CaseReviewModel>(() => emptyCaseReview());
  // 集成版「默认｜溯源」分段开关：状态存组件内，顺带记到 localStorage 里，
  // 换个案例、刷新页面都保留上一次的选择（spec 五、14）。
  const [finalTraceMode, setFinalTraceModeState] = useState(false);
  const [finalActionBusy, setFinalActionBusy] = useState(false);
  // 普通版本保存后的 finalIntake toast 去重签名（spec 五、17）：只在
  // merged/pending 这次的结果跟上次不一样时才提示，见 describeV19FinalIntakeToast。
  const finalIntakeSignatureRef = useRef<string | null>(null);
  // 上传者/管理员删除入口：做法与只读成果页（`V04DetailClient`）逐字对应——先弹
  // 确认弹窗，确认后调用同一套软删接口，成功跳回案例库；显示只看
  // viewerCapabilities.canTrash，跟当前正看着哪个版本无关。
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [trashError, setTrashError] = useState("");
  const trashKeyRef = useRef(`trash-${videoId}-${crypto.randomUUID()}`);
  // 录音点评改写（docs/25 七）：上传弹层、确认抽屉、放弃确认、轮询拿到的完整任务、
  // 点评版顶部录音卡用的那一份任务。toast 去重记在 ref 里（只认亲眼看到的转变）。
  const [audioUploadOpen, setAudioUploadOpen] = useState(false);
  const [audioUploading, setAudioUploading] = useState(false);
  const [audioDrawerReviewId, setAudioDrawerReviewId] = useState<string | null>(null);
  const [audioReviewBusy, setAudioReviewBusy] = useState(false);
  const [audioAbandonTarget, setAudioAbandonTarget] = useState<string | null>(null);
  const [audioReviewViews, setAudioReviewViews] = useState<Record<string, AudioReviewView>>({});
  const [currentAudioReview, setCurrentAudioReview] = useState<{ id: string; view: AudioReviewView } | null>(null);
  const [currentAudioReviewError, setCurrentAudioReviewError] = useState<{ id: string; message: string } | null>(null);
  const [currentAudioReviewReload, setCurrentAudioReviewReload] = useState(0);
  const audioReviewAnnouncedRef = useRef(new Set<string>());

  const pushToast = useCallback((text: string) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
  }, []);

  // 计数必须等于「实际能跳到的处数」，所以数的是页面上真正渲染出的标记，
  // 而不是差异统计——统计里的一个 payload 键未必对应页面上的一个可见标记
  // （例如整块新增只标一次，折叠的模块则一个都不渲染）。两者不一致时，
  // 计数会说 7 而下一处能走到 11，读的人无从判断自己看完了没有。
  const [diffTotal, setDiffTotal] = useState(0);

  // 差异导航：以页面上实际渲染出的标记为准，而不是回头把 payload 键映射成
  // DOM id——折叠的模块里没有标记，这样「下一处」就不会跳进看不见的地方。
  // （放在切换版本之前定义：进入点评版时要自动打开比较并跳到第一处。）
  const diffMarkers = useCallback((): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>("[data-v19-diff]")], []);

  const revealDiffAt = useCallback((index: number) => {
    const markers = diffMarkers();
    if (markers.length === 0) return;
    const bounded = ((index % markers.length) + markers.length) % markers.length;
    const marker = markers[bounded];
    // 圈出承载差异的内容，而不是徽标本身：改动过的字段圈它那一格，
    // 新增的镜头/桥段圈整块。复用既有的定位脉冲，别再造一种「看这里」。
    const scope = marker.getAttribute("data-v19-diff") === "new"
      ? marker.closest<HTMLElement>("article, section")
      : marker.parentElement;
    const target = scope ?? marker;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.setAttribute("data-v04-located", "true");
    window.setTimeout(() => {
      if (target.isConnected) target.removeAttribute("data-v04-located");
    }, V04_LOCATED_MARK_MS);
    setDiffIndex(bounded);
    setDiffTotal(markers.length);
  }, [diffMarkers]);

  // 等某个元素渲染出来再动手：切版本、打开比较、读回点评任务都是异步的，
  // 标记什么时候出现说不准，隔一小会儿找一次，找够了还没有就放弃。
  const whenRendered = useCallback((find: () => HTMLElement | null, then: (node: HTMLElement) => void, onMissing?: () => void) => {
    let tries = 0;
    const attempt = () => {
      const node = find();
      if (node) { then(node); return; }
      tries += 1;
      if (tries < 20) window.setTimeout(attempt, 120); else onMissing?.();
    };
    window.setTimeout(attempt, 0);
  }, []);

  const applyLoadedModel = useCallback((next: V19StudioModel) => {
    modelRef.current = next;
    setModelState(next);
    const nextDraft = v04PayloadToUiDraft(next.current.payload);
    draftRef.current = nextDraft;
    setDraftState(nextDraft);
    savedPayloadRef.current = next.current.payload;
    editVersionRef.current = 0;
    // History belongs to the version being edited — never let an undo reach
    // back into a different version's content.
    undoStackRef.current = [];
    redoStackRef.current = [];
    setHistoryDepth({ undo: 0, redo: 0 });
    changeSetIdsRef.current.clear();
    if (!saveCoordinatorRef.current.isRunning) saveCoordinatorRef.current.resetFromServer(0);
    setSaveStatus({ kind: "IDLE" });
    finalIntakeSignatureRef.current = null;
  }, []);

  useEffect(() => {
    try {
      // A lazy `useState(() => ...)` initializer would run during SSR too,
      // where `window` doesn't exist, and would also diverge from the
      // server-rendered markup on a client whose localStorage says "1" —
      // a hydration mismatch. Reading it only after mount is the correct
      // SSR-safe shape for this "restore a browser-only preference" case;
      // `react-hooks/set-state-in-effect` doesn't have a better answer for
      // that case, so it's suppressed here rather than worked around.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(V19_FINAL_TRACE_MODE_KEY) === "1") setFinalTraceModeState(true);
    } catch {
      // localStorage 不可用（隐私模式等）：分段开关照旧只存在组件状态里。
    }
  }, []);
  const setFinalTraceMode = useCallback((next: boolean) => {
    setFinalTraceModeState(next);
    try {
      window.localStorage.setItem(V19_FINAL_TRACE_MODE_KEY, next ? "1" : "0");
    } catch {
      // 同上，写失败就只影响这次会话记不住选择，不影响开关本身。
    }
  }, []);

  const switchToVersion = useCallback(async (
    versionId: string | null,
    options?: {
      /** true：每人一个版本的切回提示；"review"：从点评版上动手被切回自己的版本。 */
      announce?: boolean | "review";
      /** 进入点评版：自动打开比较并跳到第一处（docs/25 二、9）。 */
      compare?: boolean;
    },
  ): Promise<boolean> => {
    try {
      const next = await v19Api.load(videoId, versionId ?? undefined);
      applyLoadedModel(next);
      if (options?.announce) {
        const label = formatV19VersionLabel({
          number: next.current.number,
          baseNumber: next.current.baseNumber,
          ownerName: next.current.ownerName,
          ownerIsUploader: false,
        });
        pushToast(options.announce === "review"
          ? `点评版只有老孙可以直接改：已切换到你的版本 ${label}，请在此继续编辑`
          : `每人只有一个版本：已切换到你的版本 ${label}，请在此继续编辑`);
      }
      if (options?.compare && next.current.baseNumber !== null) {
        setDiffOn(true);
        setDiffIndex(0);
        // 等新版本真正渲染出来再跳：旧页面上的差异标记在这一刻可能还在。
        const shownId = next.current.id ?? "";
        whenRendered(
          () => document.querySelector<HTMLElement>(`[data-v19-version-id="${CSS.escape(shownId)}"] [data-v19-diff]`),
          () => revealDiffAt(0),
        );
      }
      return true;
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "切换版本失败，请重试。");
      return false;
    }
  }, [videoId, applyLoadedModel, pushToast, whenRendered, revealDiffAt]);

  // Guard at the top of every mutating entry point (onChange / insert shot /
  // insert bridge): switches away BEFORE anything changes, discarding this
  // one edit — see `resolveV19EditGuard`. On the final version this also
  // carries the spec 五、16 toast for a non-老孙 viewer instead of a redirect —
  // `V19EditableValue`'s `onBeforeEdit` prop (wired below) is the only place
  // that fires for a `locked` field, since it is `readOnly` and so never
  // reaches `applyEdit`'s own `canEdit` gate.
  const interceptForeignEdit = useCallback((): boolean => {
    const current = modelRef.current;
    if (!current) return false;
    const decision = resolveV19EditGuard(current.current, current.myVersionId, current.viewerCapabilities.canEdit, viewerUserId);
    if (decision.action === "PROCEED") return false;
    if (decision.action === "BLOCKED_FINAL") {
      pushToast("集成版只有老孙可以编辑。你的修改请写在自己的版本里，进行态下会自动汇入集成版");
      return true;
    }
    void switchToVersion(decision.versionId, { announce: current.current.kind === "AUDIO_REVIEW" ? "review" : true });
    return true;
  }, [switchToVersion, pushToast, viewerUserId]);

  // Best-effort background refresh after a save auto-creates the viewer's
  // version: only refreshes the version list / myVersionId so the panel
  // reflects it. Never touches `current` or the local draft — those are
  // already correct from the save response, and clobbering them here could
  // race a newer save that completed after this fetch was issued.
  const refreshVersionList = useCallback(async () => {
    try {
      const before = modelRef.current;
      if (!before) return;
      const fresh = await v19Api.load(videoId, before.current.id ?? undefined);
      const latest = modelRef.current;
      if (!latest) return;
      const merged: V19StudioModel = {
        ...latest,
        case: fresh.case,
        media: fresh.media,
        viewerCapabilities: fresh.viewerCapabilities,
        versions: fresh.versions,
        myVersionId: fresh.myVersionId,
      };
      modelRef.current = merged;
      setModelState(merged);
    } catch {
      // Version list simply stays as-is until the next successful load.
    }
  }, [videoId]);

  // Best-effort background refresh after 老孙 saves directly onto the final
  // version (本机走查 bug fix): the save response itself carries the new
  // payload but not an updated `finalTrace` — without this, the field he
  // just edited still shows only its `v1 原稿` row as 当前采用 in 溯源视图,
  // and its default-view hover source never picks up the 集成版·直接修改
  // entry. Re-fetches `?version=final` and merges only `final` /
  // `finalTrace` — never `current` or the local draft, so it cannot clobber
  // whatever the person is mid-typing (same discipline as `refreshVersionList`).
  const refreshFinalTrace = useCallback(async () => {
    try {
      const fresh = await v19Api.load(videoId, "final");
      const latest = modelRef.current;
      if (!latest) return;
      const merged: V19StudioModel = {
        ...latest,
        final: fresh.final,
        ...(fresh.finalTrace ? { finalTrace: fresh.finalTrace } : {}),
      };
      modelRef.current = merged;
      setModelState(merged);
    } catch {
      // Trace simply stays as-is until the next successful load/switch.
    }
  }, [videoId]);

  const commitSaveAttempt = useCallback(async (attempt: { version: number; draft: V04UiDraft }): Promise<boolean> => {
    const currentModel = modelRef.current;
    if (!currentModel) return false;
    setSaveStatus({ kind: "SAVING" });
    const basePayload = savedPayloadRef.current ?? currentModel.current.payload;
    const afterPayload = preserveV19UntouchedPerceptionPath(
      v04UiDraftToPayload(attempt.draft, basePayload),
      basePayload,
    );
    const changes = v04PayloadChanges(basePayload, afterPayload);
    if (changes.length === 0) {
      setSaveStatus({ kind: "SAVED", at: currentModel.current.updatedAt });
      return true;
    }
    const changeSetId = changeSetIdsRef.current.get(attempt.version) ?? crypto.randomUUID();
    changeSetIdsRef.current.set(attempt.version, changeSetId);
    // spec 五、16: 老孙 editing the final version saves against the literal
    // string "final", not its (possibly still-null, still-virtual) row id —
    // the PUT route branches on that exact string (spec 三、3.5 / 四、4.2).
    const isFinalSave = currentModel.current.isFinal;
    try {
      const response = await v19Api.save(videoId, {
        basedOnVersionId: isFinalSave ? "final" : currentModel.current.id,
        changeSetId,
        changes,
      });
      const latest = modelRef.current ?? currentModel;
      const createdVersion = response.createdVersion;
      // 老孙改的是点评版本身（docs/25 五、1）：写回的仍是点评版，视角不变——不能把
      // current 改成「我的版本」，myVersionId 也不动，更没有集成版汇入可提示。
      // 老后端不带 versionKind 时，按「写回的就是当前这一版点评版」认。
      const savedIntoReview = !isFinalSave && (response.versionKind === "AUDIO_REVIEW"
        || (response.versionKind === undefined && latest.current.kind === "AUDIO_REVIEW" && response.versionId === latest.current.id));
      // 保存成功后不能把 current 切成别的版本（spec 五、16）：集成版视角下
      // 保留 isFinal / isMine:false / ownerName「集成版」/ baseNumber:null，
      // 只更新这次写回的 id（虚拟集成版首次落库会拿到一个真实 id）、
      // number（后端固定回 0）、payload 与保存元数据。
      const nextCurrent: V19CurrentVersion = isFinalSave
        ? {
          ...latest.current,
          id: response.versionId,
          number: response.versionNumber,
          revision: response.revision,
          contentHash: response.contentHash,
          updatedAt: response.updatedAt,
          payload: afterPayload,
          isFinal: true,
          isMine: false,
          isVirtual: false,
          ownerUserId: "",
          ownerName: "集成版",
          baseNumber: null,
          basePayload: null,
        }
        : savedIntoReview ? {
          ...latest.current,
          id: response.versionId,
          number: response.versionNumber,
          revision: response.revision,
          contentHash: response.contentHash,
          updatedAt: response.updatedAt,
          payload: afterPayload,
          isMine: false,
          isVirtual: false,
          kind: "AUDIO_REVIEW",
        }
        : {
          ...latest.current,
          id: response.versionId,
          number: response.versionNumber,
          revision: response.revision,
          contentHash: response.contentHash,
          updatedAt: response.updatedAt,
          payload: afterPayload,
          isMine: true,
          isVirtual: false,
          // 写进的是个人版本：从点评版上动手的人新建了自己的版本，也落在这里。
          kind: "PERSONAL",
          audioReviewId: null,
          ...(createdVersion ? {
            baseNumber: latest.current.number,
            basePayload: structuredClone(basePayload),
            ownerUserId: viewerUserId,
            ownerName: viewerName,
            createdAt: response.updatedAt,
          } : {}),
        };
      const updatedModel: V19StudioModel = {
        ...latest,
        myVersionId: isFinalSave || savedIntoReview ? latest.myVersionId : (latest.myVersionId ?? response.versionId),
        current: nextCurrent,
        // A direct final save can materialize a previously-virtual final
        // version (id was null) — keep the summary's id/isVirtual in step so
        // the version panel and a later 定稿/采纳 call see the real row.
        ...(isFinalSave && latest.final
          ? { final: { ...latest.final, id: response.versionId, isVirtual: false, updatedAt: response.updatedAt } }
          : {}),
      };
      modelRef.current = updatedModel;
      setModelState(updatedModel);
      savedPayloadRef.current = afterPayload;
      setSaveStatus({ kind: "SAVED", at: response.updatedAt });
      if (savedIntoReview) {
        // 点评版不汇入集成版（docs/25 二、7）：不弹汇入提示，保存状态胶囊已经说明写到了哪一版。
      } else if (!isFinalSave) {
        if (createdVersion) {
          pushToast(`已创建 ${formatV19VersionLabel({
            number: response.versionNumber,
            baseNumber: nextCurrent.baseNumber,
            ownerName: viewerName,
            ownerIsUploader: false,
          })}，你的修改保存在这个版本`);
          void refreshVersionList();
        }
        // spec 五、17: only toast finalIntake when this save's merged/pending
        // outcome actually differs from the last time it was shown — see
        // describeV19FinalIntakeToast for why that avoids spamming a toast
        // on every ordinary autosave.
        const finalIntakeToast = describeV19FinalIntakeToast(changes, response.finalIntake, finalIntakeSignatureRef.current);
        if (finalIntakeToast) {
          finalIntakeSignatureRef.current = finalIntakeToast.signature;
          pushToast(finalIntakeToast.text);
        }
      } else {
        // 本机走查 bug fix: refresh finalTrace so the field 老孙 just edited
        // shows its new 集成版·直接修改 row as 当前采用 (溯源视图) and the
        // right hover source (默认视图), instead of staying stuck on
        // whatever was loaded when the page opened.
        void refreshFinalTrace();
      }
      if (response.skippedTargets && response.skippedTargets.length > 0) {
        pushToast(`${response.skippedTargets.length} 项修改所在的镜头或桥段已不存在，其余修改已保存`);
      }
      return true;
    } catch (reason) {
      // A failed save must NEVER clear or revert the local draft: neither
      // `draftRef.current` nor the `draft` state is touched below, only the
      // status chip reflects the failure. The next edit — or the 重试 button
      // — re-flushes the same staged attempt automatically.
      const message = reason instanceof V04UiApiError ? reason.message : "保存失败，请重试，内容已保留在本机。";
      setSaveStatus({ kind: "ERROR", message });
      return false;
    }
  }, [videoId, viewerName, viewerUserId, refreshVersionList, refreshFinalTrace, pushToast]);

  // Undo/redo. On a surface with no save button there is also no "discard
  // changes", so stepping back has to be its own affordance. An undo is just
  // another edit: it goes through the same save path, so the record follows
  // what is on screen, which is the whole promise of this page.
  const commitDraft = useCallback((next: V04UiDraft, options?: { history?: "record" | "skip" }) => {
    if ((options?.history ?? "record") === "record") {
      undoStackRef.current.push(cloneV04UiDraft(draftRef.current));
      if (undoStackRef.current.length > V19_HISTORY_LIMIT) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
    setHistoryDepth({ undo: undoStackRef.current.length, redo: redoStackRef.current.length });
    draftRef.current = next;
    setDraftState(next);
    editVersionRef.current += 1;
    const version = editVersionRef.current;
    saveCoordinatorRef.current.stage({ version, draft: cloneV04UiDraft(next) });
    void saveCoordinatorRef.current.flush(commitSaveAttempt);
  }, [commitSaveAttempt]);

  const undoEdit = useCallback(() => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(cloneV04UiDraft(draftRef.current));
    commitDraft(previous, { history: "skip" });
  }, [interceptForeignEdit, commitDraft]);

  const redoEdit = useCallback(() => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(cloneV04UiDraft(draftRef.current));
    commitDraft(next, { history: "skip" });
  }, [interceptForeignEdit, commitDraft]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      // Inside an open field the browser's own text undo is the useful one.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      if (event.shiftKey) redoEdit(); else undoEdit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoEdit, redoEdit]);

  const retrySave = useCallback(() => {
    void saveCoordinatorRef.current.flush(commitSaveAttempt);
  }, [commitSaveAttempt]);

  // 任何改动时间线结构的操作之后都重新推导开始时间——插入、删除、改结束时间
  // 都可能让后面的推导值失效。推导本身是幂等的，重复调用无副作用。
  const withDerivedStarts = useCallback((draftToFix: V04UiDraft): V04UiDraft => {
    const flat = draftToFix.shotGroups.flatMap((group) => group.shots);
    const { shots, changedShotIds } = deriveV19StartTimes(flat);
    if (changedShotIds.length === 0) return draftToFix;
    const byId = new Map(shots.map((shot) => [shot.id, shot]));
    for (const group of draftToFix.shotGroups) {
      for (let index = 0; index < group.shots.length; index += 1) {
        const updated = byId.get(group.shots[index].id);
        if (updated) group.shots[index] = updated;
      }
    }
    return draftToFix;
  }, []);

  const applyEdit = useCallback((mutate: (draft: V04UiDraft) => void) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    setPendingDeleteId(null);
    const before = draftRef.current;
    const next = cloneV04UiDraft(before);
    mutate(next);
    withDerivedStarts(next);
    const cascaded = countV19CascadedShots(before, next);
    if (cascaded > 0) pushToast(`已级联顺延后续 ${cascaded} 个镜头的时间线（各镜头时长保持不变）`);
    commitDraft(next);
  }, [interceptForeignEdit, withDerivedStarts, commitDraft, pushToast]);

  const onInsertShotAfter = useCallback((shotId: string) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const next = cloneV04UiDraft(draftRef.current);
    let insertedId: string | null = null;
    let insertedStart = "";
    for (const group of next.shotGroups) {
      const index = group.shots.findIndex((shot) => shot.id === shotId);
      if (index < 0) continue;
      const previous = group.shots[index];
      const blank = blankV04Shot(mintV04LocalId("shot"));
      blank.startTime = previous.endTime ? nextV19StartTime(previous.endTime) : "";
      group.shots.splice(index + 1, 0, blank);
      insertedId = blank.id;
      insertedStart = blank.startTime;
      break;
    }
    if (!insertedId) return;
    commitDraft(next);
    pushToast(`已插入新镜头，开始时间继承上一镜头结束时间 +1 秒${insertedStart ? `（${insertedStart}）` : ""}；填入其结束时间后，后续镜头将级联顺延`);
    void locateV04Target(`row-${insertedId}`);
  }, [interceptForeignEdit, commitDraft, pushToast]);

  const onInsertBridgeAfter = useCallback((bridgeId: string) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const next = cloneV04UiDraft(draftRef.current);
    const index = next.shotGroups.findIndex((group) => group.id === bridgeId);
    if (index < 0) return;
    const previousShots = next.shotGroups[index].shots;
    const last = previousShots[previousShots.length - 1];
    const blankShot = blankV04Shot(mintV04LocalId("shot"));
    blankShot.startTime = last?.endTime ? nextV19StartTime(last.endTime) : "";
    const newGroup: V04UiShotGroup = {
      id: mintV04LocalId("bridge"),
      title: "",
      primaryRole: emptyV19ChoiceValue(),
      auxiliaryRole: emptyV19ChoiceValue(),
      creativeDescription: "",
      shots: [blankShot],
    };
    next.shotGroups.splice(index + 1, 0, newGroup);
    commitDraft(next);
    pushToast(`已在桥段${String(index + 1).padStart(2, "0")}后插入新桥段，桥段序号与镜头序号已自动重排`);
    void locateV04Target(`bridge-${newGroup.id}`);
  }, [interceptForeignEdit, commitDraft, pushToast]);

  const onCancelDelete = useCallback(() => setPendingDeleteId(null), []);

  // 进入确认态后必须有明确的退路：除了旁边的「取消」按钮，按 Esc 或点到别处
  // 也解除。没有这些，用户只能靠做一次无关编辑把它蹭掉，那不是可发现的设计。
  useEffect(() => {
    if (!pendingDeleteId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingDeleteId(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-v19-confirming], [data-v19-cancel-delete]")) return;
      setPendingDeleteId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [pendingDeleteId]);

  const onNormalizeTimeline = useCallback(() => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const next = withDerivedStarts(cloneV04UiDraft(draftRef.current));
    commitDraft(next);
    pushToast("已按规则重排开始时间；可用顶栏「撤销」还原");
  }, [interceptForeignEdit, withDerivedStarts, commitDraft, pushToast]);

  const onInsertFirstShot = useCallback((bridgeId: string) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    setPendingDeleteId(null);
    const next = cloneV04UiDraft(draftRef.current);
    const group = next.shotGroups.find((item) => item.id === bridgeId);
    if (!group || group.shots.length > 0) return;
    const previousShots = next.shotGroups
      .slice(0, next.shotGroups.indexOf(group))
      .flatMap((item) => item.shots);
    const last = previousShots[previousShots.length - 1];
    const shot = blankV04Shot(mintV04LocalId("shot"));
    shot.startTime = last?.endTime ? nextV19StartTime(last.endTime) : "";
    group.shots.push(shot);
    commitDraft(next);
    pushToast("已添加镜头，开始时间继承上一镜头结束时间");
    void locateV04Target(`row-${shot.id}`);
  }, [interceptForeignEdit, commitDraft, pushToast]);

  // 删除按两次：第一次亮出确认，第二次才动手。删除不级联调整后续镜头的
  // 时间——时间码记的是视频里客观发生的时刻，删掉一条记录不会让别的镜头
  // 改在别的时间发生；插入时顺延是因为那是「漏记了一条」。序号是系统维护的，
  // 会自动重排。
  const onDeleteShot = useCallback((shotId: string) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    if (pendingDeleteId !== shotId) { setPendingDeleteId(shotId); return; }
    setPendingDeleteId(null);
    const next = cloneV04UiDraft(draftRef.current);
    const group = next.shotGroups.find((item) => item.shots.some((shot) => shot.id === shotId));
    if (!group) return;
    const index = group.shots.findIndex((shot) => shot.id === shotId);
    const removedNumber = numberedV04Shots(draftRef.current.shotGroups)
      .find((item) => item.stableId === shotId)?.displayNumber;
    group.shots.splice(index, 1);
    withDerivedStarts(next);
    commitDraft(next);
    pushToast(`已删除镜头${removedNumber ? String(removedNumber).padStart(2, "0") : ""}，序号已重排；可用顶栏「撤销」找回`);
  }, [interceptForeignEdit, withDerivedStarts, commitDraft, pushToast, pendingDeleteId]);

  const onDeleteBridge = useCallback((bridgeId: string) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    if (pendingDeleteId !== bridgeId) { setPendingDeleteId(bridgeId); return; }
    setPendingDeleteId(null);
    const next = cloneV04UiDraft(draftRef.current);
    const index = next.shotGroups.findIndex((group) => group.id === bridgeId);
    if (index < 0) return;
    const removed = next.shotGroups[index];
    next.shotGroups.splice(index, 1);
    withDerivedStarts(next);
    commitDraft(next);
    pushToast(`已删除桥段${String(index + 1).padStart(2, "0")}${removed.shots.length ? `及其 ${removed.shots.length} 个镜头` : ""}，序号已重排；可用顶栏「撤销」找回`);
  }, [interceptForeignEdit, withDerivedStarts, commitDraft, pushToast, pendingDeleteId]);

  // A case whose script is still empty has no bridge to insert after, so
  // without this the very first bridge could never be created on this surface.
  const onInsertFirstBridge = useCallback(() => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const next = cloneV04UiDraft(draftRef.current);
    if (next.shotGroups.length > 0) return;
    const newGroup: V04UiShotGroup = {
      id: mintV04LocalId("bridge"),
      title: "",
      primaryRole: emptyV19ChoiceValue(),
      auxiliaryRole: emptyV19ChoiceValue(),
      creativeDescription: "",
      shots: [blankV04Shot(mintV04LocalId("shot"))],
    };
    next.shotGroups.push(newGroup);
    commitDraft(next);
    pushToast("已添加第一个桥段，可继续在其后插入桥段与镜头");
    void locateV04Target(`bridge-${newGroup.id}`);
  }, [interceptForeignEdit, commitDraft, pushToast]);

  const viewVersion = useCallback((versionId: string | null) => {
    const current = modelRef.current;
    if (!current) return;
    if (current.current.id === versionId) { setVersionPanelOpen(false); return; }
    const dirty = saveCoordinatorRef.current.isRunning || editVersionRef.current > saveCoordinatorRef.current.savedVersion;
    if (dirty) {
      if (saveStatus.kind === "ERROR") void saveCoordinatorRef.current.flush(commitSaveAttempt);
      pushToast("当前修改仍在保存，请稍候完成后再切换版本。");
      return;
    }
    setVersionPanelOpen(false);
    // 从版本菜单进入点评版也自动打开比较（同 demo 的 gotoView）。
    const entering = current.versions.find((version) => version.id === versionId);
    void switchToVersion(versionId, { compare: entering?.kind === "AUDIO_REVIEW" });
  }, [saveStatus.kind, commitSaveAttempt, switchToVersion, pushToast]);

  // Default base for "create my version" — computed at render time, not via
  // an effect: `createBaseId` state only holds an explicit user choice from
  // the <select>, and falls back to this whenever it's empty.
  const defaultCreateBaseId = useMemo(() => computeV19DefaultBaseId(model), [model]);
  const effectiveCreateBaseId = createBaseId || defaultCreateBaseId;

  const createOwnVersion = useCallback(async () => {
    if (!effectiveCreateBaseId) return;
    try {
      const response = await v19Api.createVersion(videoId, effectiveCreateBaseId);
      await switchToVersion(response.versionId);
      const label = formatV19VersionLabel({
        number: response.versionNumber,
        baseNumber: modelRef.current?.current.baseNumber ?? null,
        ownerName: viewerName,
        ownerIsUploader: false,
        baseIsFinal: modelRef.current?.current.baseIsFinal ?? false,
      });
      pushToast(`已创建 ${label}，后续修改自动保存至该版本`);
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "创建版本失败，请重试。");
    }
  }, [effectiveCreateBaseId, videoId, switchToVersion, viewerName, pushToast]);

  // 定稿／取消定稿／采纳（spec 五、14/18，接口 4.3）：三个动作都只有老孙能碰到
  // 触发它们的按钮（渲染时已经拿 viewerCapabilities.canEdit 挡过），服务端也
  // 重新校验。响应带回最新的 final 摘要；随后重新读一次 ?version=final，
  // 让 finalTrace（每处的来源链、待采纳记录）跟着刷新——`final` 接口本身
  // 不返回 trace，且规格明确要求「用返回的 final 更新 model 并重新加载
  // ?version=final 以刷新 trace」。
  const runFinalAction = useCallback(async (body: V19FinalActionRequestBody) => {
    if (finalActionBusy) return;
    setFinalActionBusy(true);
    try {
      const response = await v19Api.finalAction(videoId, body);
      const before = modelRef.current;
      if (before) {
        const merged: V19StudioModel = { ...before, final: response.final };
        modelRef.current = merged;
        setModelState(merged);
      }
      const fresh = await v19Api.load(videoId, "final");
      applyLoadedModel(fresh);
      if (body.action === "DONE") {
        pushToast("集成版已定稿：此后其他版本的修改不再进入集成版，只记录为「未纳入」");
      } else if (body.action === "OPEN") {
        const pending = response.final.pendingCount;
        pushToast(`集成版已回到进行态：此后其他版本的修改重新自动汇入${pending > 0 ? `；定稿期间的 ${pending} 处修改仍待逐条采纳` : ""}`);
      } else if (body.action === "ADOPT_REVIEW") {
        const reviewNumber = before?.versions.find((version) => version.id === body.reviewVersionId)?.number;
        pushToast(`已采纳点评版${reviewNumber ? ` v${reviewNumber} ` : ""}的写法，集成版已更新`);
      } else {
        pushToast(`已采纳 ${response.adopted ?? 0} 处未纳入的修改`);
      }
    } catch (reason) {
      // 本机走查 bug fix: 定稿／取消定稿／采纳失败时（例如后端 404）之前
      // 什么反馈都没有——状态胶囊纹丝不动，人不知道点了有没有用。始终报一次
      // 服务端的错误文案，拿不到就用这条集成版专属的兜底，跟其他操作共用的
      // 「操作失败，请重试」区分开，一眼看出是定稿/采纳这条链路出的问题。
      pushToast(reason instanceof V04UiApiError ? reason.message : "集成版操作失败，请重试。");
    } finally {
      setFinalActionBusy(false);
    }
  }, [videoId, finalActionBusy, applyLoadedModel, pushToast]);

  const toggleFinalStatus = useCallback(() => {
    void runFinalAction({ action: modelRef.current?.final?.status === "OPEN" ? "DONE" : "OPEN" });
  }, [runFinalAction]);

  const adoptFinalIntake = useCallback((intakeId: string) => {
    void runFinalAction({ action: "ADOPT", intakeIds: [intakeId] });
  }, [runFinalAction]);

  const adoptAllFinalIntakes = useCallback(() => {
    void runFinalAction({ action: "ADOPT", all: true });
  }, [runFinalAction]);

  // 集成版溯源里点评版候选行的「采纳」（docs/25 六）：一次只采一处。
  const adoptReviewCandidate = useCallback((reviewVersionId: string, targetKey: string) => {
    void runFinalAction({ action: "ADOPT_REVIEW", reviewVersionId, targetKeys: [targetKey] });
  }, [runFinalAction]);

  // ---------------------------------------------------------------------------
  // 录音点评改写（docs/25 七）
  // ---------------------------------------------------------------------------

  const patchModel = useCallback((update: (current: V19StudioModel) => V19StudioModel) => {
    const latest = modelRef.current;
    if (!latest) return;
    const next = update(latest);
    modelRef.current = next;
    setModelState(next);
  }, []);

  // 版本列表与点评任务摘要以服务端为准：生成了点评版、物化了虚拟 v1 之后重读一次，
  // 只并这几项，不碰 current 和本地草稿（同 refreshVersionList 的约束）。
  const refreshAudioReviewState = useCallback(async () => {
    try {
      const before = modelRef.current;
      if (!before) return;
      const fresh = await v19Api.load(videoId, before.current.isFinal ? "final" : before.current.id ?? undefined);
      patchModel((latest) => ({
        ...latest,
        versions: fresh.versions,
        myVersionId: fresh.myVersionId,
        audioReviews: fresh.audioReviews,
        audioReviewAvailable: fresh.audioReviewAvailable,
      }));
    } catch {
      // 下一次正常读取时再对齐。
    }
  }, [videoId, patchModel]);

  /** 拿到一份完整任务（轮询、上传、重试、确认的返回）：并回摘要，按需弹一次 toast。 */
  const applyAudioReviewView = useCallback((view: AudioReviewView, options?: { silent?: boolean }) => {
    const latest = modelRef.current;
    if (!latest) return;
    const previous = latest.audioReviews.find((item) => item.id === view.id) ?? null;
    patchModel((current) => ({ ...current, audioReviews: upsertAudioReviewSummary(current.audioReviews, summarizeAudioReview(view)) }));
    setAudioReviewViews((current) => ({ ...current, [view.id]: view }));
    if (!options?.silent) {
      const text = audioReviewTransitionToast(previous, view, audioReviewAnnouncedRef.current);
      if (text) pushToast(text);
    }
    if (view.status === "GENERATED" && previous?.status !== "GENERATED") void refreshAudioReviewState();
  }, [patchModel, pushToast, refreshAudioReviewState]);

  const dropAudioReview = useCallback((reviewId: string) => {
    patchModel((current) => ({ ...current, audioReviews: removeAudioReviewSummary(current.audioReviews, reviewId) }));
  }, [patchModel]);

  const openAudioReviewVersion = useCallback((reviewVersionId: string) => {
    const dirty = saveCoordinatorRef.current.isRunning || editVersionRef.current > saveCoordinatorRef.current.savedVersion;
    if (dirty) {
      pushToast("当前修改仍在保存，请稍候完成后再切换版本。");
      return;
    }
    setVersionPanelOpen(false);
    void switchToVersion(reviewVersionId, { compare: true });
  }, [switchToVersion, pushToast]);

  const retryAudioReview = useCallback(async (reviewId: string) => {
    setAudioReviewBusy(true);
    try {
      const { review: next } = await audioReviewApi.action(videoId, reviewId, { action: "RETRY" });
      applyAudioReviewView(next, { silent: true });
      pushToast("已重新开始处理点评录音，好了会在页头提示");
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "重试没有成功，请稍后再试。");
    } finally {
      setAudioReviewBusy(false);
    }
  }, [videoId, applyAudioReviewView, pushToast]);

  /**
   * 放弃这次点评；`reupload` 时随后打开上传弹层（「重新上传」就是放弃再新建，docs/25 4.1）。
   * `closeDrawer` 为 false 时由调用方晚一拍再关抽屉：确认弹窗和抽屉各自锁着 body 滚动、
   * 各自在关闭时还原，弹窗必须先还原、抽屉后还原，否则页面会一直锁着滚不动。
   */
  const abandonAudioReview = useCallback(async (reviewId: string, reupload: boolean, closeDrawer = true) => {
    setAudioReviewBusy(true);
    try {
      await audioReviewApi.action(videoId, reviewId, { action: "ABANDON" });
      dropAudioReview(reviewId);
      if (closeDrawer) setAudioDrawerReviewId(null);
      if (reupload) setAudioUploadOpen(true); else pushToast("已放弃这次点评录音，可以重新上传");
      return true;
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "放弃没有成功，请稍后再试。");
      return false;
    } finally {
      setAudioReviewBusy(false);
    }
  }, [videoId, dropAudioReview, pushToast]);

  const confirmAudioReview = useCallback(async (view: AudioReviewView, selectedChangeIds: string[]) => {
    setAudioReviewBusy(true);
    try {
      const response = await audioReviewApi.action(videoId, view.id, { action: "CONFIRM", selectedChangeIds });
      applyAudioReviewView(response.review, { silent: true });
      const reviewVersionId = response.reviewVersionId ?? response.review.reviewVersionId;
      setAudioDrawerReviewId(null);
      if (reviewVersionId) await switchToVersion(reviewVersionId, { compare: true });
      const number = response.review.reviewVersionNumber;
      pushToast(`点评版${number ? ` v${number}` : ""} 已生成：${selectedChangeIds.length} 处改动，比较已打开；v${view.baseVersionNumber} 保持原样`);
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "点评版没有生成，请重试。");
    } finally {
      setAudioReviewBusy(false);
    }
  }, [videoId, applyAudioReviewView, switchToVersion, pushToast]);

  const onAudioReviewCreated = useCallback((view: AudioReviewView) => {
    applyAudioReviewView(view, { silent: true });
    // 被点评的是虚拟 v1：服务端建任务时已经把它物化成真实的一行，这里接上它的 id，
    // 入口才能按 baseVersionId 认出这个任务；版本列表随后重读一次。
    const latest = modelRef.current;
    if (latest && !latest.current.isFinal && latest.current.id === null) {
      patchModel((current) => ({ ...current, current: { ...current.current, id: view.baseVersionId, isVirtual: false } }));
      void refreshAudioReviewState();
    }
  }, [applyAudioReviewView, patchModel, refreshAudioReviewState]);

  const onAudioReviewUploaded = useCallback((view: AudioReviewView, fileName: string) => {
    applyAudioReviewView(view, { silent: true });
    setAudioUploadOpen(false);
    pushToast(`已上传「${fileName}」，正在处理……大约需要一两分钟，可以先做别的`);
  }, [applyAudioReviewView, pushToast]);

  const jumpToReviewOpinion = useCallback((opinionNumber: number) => {
    setCollapsedModules(new Set());
    setDiffOn(true);
    whenRendered(
      () => document.querySelector<HTMLElement>(`[data-v19-basis~="${opinionNumber}"]`),
      (badge) => {
        const tag = badge.previousElementSibling as HTMLElement | null;
        const index = tag?.hasAttribute("data-v19-diff") ? diffMarkers().indexOf(tag) : -1;
        if (index >= 0) { revealDiffAt(index); return; }
        const target = badge.parentElement ?? badge;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.setAttribute("data-v04-located", "true");
        window.setTimeout(() => { if (target.isConnected) target.removeAttribute("data-v04-located"); }, V04_LOCATED_MARK_MS);
      },
      () => pushToast(`意见 ${opinionNumber} 改的地方已经不在了（可能已被改回原样）`),
    );
  }, [whenRendered, diffMarkers, revealDiffAt, pushToast]);

  const numbers = useMemo(() => new Map(numberedV04Shots(draft.shotGroups).map((entry) => [entry.stableId, entry.displayNumber])), [draft.shotGroups]);
  const diff = useMemo(() => computeV19Diff(model, draft), [model, draft]);
  const nonCompliantStartCount = useMemo(
    () => findV19NonCompliantStarts(draft.shotGroups.flatMap((group) => group.shots)).length,
    [draft]);
  useEffect(() => {
    if (!diffOn) return;
    // 标记要等这次状态变更渲染完才存在，所以推到下一个任务里再数。
    const id = window.setTimeout(
      () => setDiffTotal(document.querySelectorAll("[data-v19-diff]").length), 0);
    return () => window.clearTimeout(id);
  }, [diffOn, draft]);

  const stepDiff = useCallback((delta: number) => {
    // 首尾相接：读到最后一处再按「下一处」回到第一处，比走到头就没反应好。
    revealDiffAt(diffIndex + delta);
  }, [diffIndex, revealDiffAt]);

  const toggleDiff = useCallback(() => {
    setDiffOn((current) => {
      const next = !current;
      if (!next) { setDiffIndex(0); setDiffTotal(0); return next; }
      if (diff) pushToast(describeV19Diff(diff));
      // Turning the comparison on is a request to see what differs, and the
      // first difference is rarely on screen. Jumping there beats leaving the
      // reader to hunt for the markers they just asked for. Deferred one frame
      // because the markers only exist after this state change renders; a
      // collapsed module can hide them all, in which case nothing moves.
      window.setTimeout(() => revealDiffAt(0), 0);
      return next;
    });
  }, [diff, pushToast, revealDiffAt]);

  const handleToggleModule = useCallback((moduleNumber: number) => {
    setCollapsedModules((current) => {
      const next = new Set(current);
      if (next.has(moduleNumber)) next.delete(moduleNumber); else next.add(moduleNumber);
      return next;
    });
  }, []);

  // Initial load + retry (the 重试 button on the load-error screen bumps
  // `retryToken`, which re-runs this effect).
  useEffect(() => {
    const controller = new AbortController();
    v19Api.load(videoId, undefined, controller.signal)
      .then((next) => { if (!controller.signal.aborted) { applyLoadedModel(next); setLoadError(""); } })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(reason instanceof V04UiApiError ? reason.message : "工作台暂时无法读取，请稍后重试。");
      });
    return () => controller.abort();
  }, [videoId, retryToken, applyLoadedModel]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrollState({ atTop: window.scrollY < 40, atBottom: window.scrollY > max - 40 });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (!versionPanelOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (versionPanelRef.current && !versionPanelRef.current.contains(event.target as Node)) setVersionPanelOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") setVersionPanelOpen(false); };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [versionPanelOpen]);

  useEffect(() => {
    const ids = [
      "module-1", "module-2", "module-3",
      ...MODULE_ONE_NAV_FIELDS.map(([id]) => id),
      ...draft.shotGroups.flatMap((group) => [`bridge-${group.id}`, ...group.shots.map((shot) => `row-${shot.id}`)]),
      ...MODULE_THREE_NAV_FIELDS.map(([id]) => id),
    ];
    const nodes = ids.map((id) => document.getElementById(id)).filter((node): node is HTMLElement => Boolean(node));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((left, right) => Math.abs(left.boundingClientRect.top - 120) - Math.abs(right.boundingClientRect.top - 120));
      if (visible[0]?.target.id) setActiveNavId(visible[0].target.id);
    }, { rootMargin: "-96px 0px -70% 0px", threshold: [0, .05] });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [draft.shotGroups, collapsedModules]);

  const reviewVersionId = model?.current.id ?? null;

  // 轮询（docs/25 七、7）：有在途任务（上传、转写、理解）且页面可见时每 4 秒读一次；
  // 切到后台暂停，切回来立刻补一次。只有老孙看得到在途任务，所以别人从不轮询。
  const inFlightKey = model ? inFlightAudioReviewKey(model.audioReviews) : "";
  useEffect(() => {
    if (!inFlightKey) return;
    const ids = inFlightKey.split(",");
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (running || cancelled || document.visibilityState !== "visible") return;
      running = true;
      try {
        for (const id of ids) {
          try {
            const { review: next } = await audioReviewApi.get(videoId, id);
            if (cancelled) return;
            applyAudioReviewView(next);
          } catch (reason) {
            // 404：任务在别处被放弃了，入口回到「上传」。其余错误留给下一轮。
            if (!cancelled && reason instanceof V04UiApiError && reason.status === 404) dropAudioReview(id);
          }
        }
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 4000);
    const onVisibility = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [inFlightKey, videoId, applyAudioReviewView, dropAudioReview]);

  // 点评版顶部录音卡与正文「依据」用的那一份任务（全站可见，已生成）。
  const currentAudioReviewId = model && model.current.kind === "AUDIO_REVIEW" ? model.current.audioReviewId : null;
  useEffect(() => {
    if (!currentAudioReviewId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { review: loaded } = await audioReviewApi.get(videoId, currentAudioReviewId, controller.signal);
        if (controller.signal.aborted) return;
        setCurrentAudioReview({ id: currentAudioReviewId, view: loaded });
        setCurrentAudioReviewError(null);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setCurrentAudioReviewError({
          id: currentAudioReviewId,
          message: reason instanceof V04UiApiError ? reason.message : "录音点评暂时读不出来。",
        });
      }
    })();
    return () => controller.abort();
  }, [videoId, currentAudioReviewId, currentAudioReviewReload]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const search = reviewVersionId ? `?version=${encodeURIComponent(reviewVersionId)}` : "";
        const response = await fetch(
          `/api/videos/${encodeURIComponent(videoId)}/review${search}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) return;
        const next = await readJsonResponse<CaseReviewModel>(response, "评审读取");
        if (!controller.signal.aborted) setReview(next);
      } catch {
        // 评审读不出来不该挡住写作业；保持上一次的状态，下次切版本再试。
      }
    })();
    return () => controller.abort();
  }, [videoId, reviewVersionId]);

  const postReview = useCallback(async <T,>(body: unknown, action: string): Promise<T> => {
    const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
    const data = await readJsonResponse<T & { error?: string }>(response, action);
    if (!response.ok) throw new Error(data.error || `${action}失败，请重试。`);
    return data;
  }, [videoId]);

  const saveReviewComment = useCallback(async (input: { targetKey: string; targetLabel: string; body: string }) => {
    const versionId = modelRef.current?.current.id;
    if (!versionId) throw new Error("这一版还没有保存过内容，保存后才能评论。");
    const data = await postReview<{ comment: CaseReviewComment | null }>(
      { kind: "COMMENT", versionId, ...input }, "评论保存",
    );
    // 一个条目现在可能挂着好几个版本各写的一条评论，所以按 (versionId, targetKey)
    // 替换，不能再只按 targetKey——那会把别的版本写的那条也顶掉。
    setReview((current) => {
      const others = current.comments.filter(
        (item) => !(item.targetKey === input.targetKey && item.versionId === versionId),
      );
      return { ...current, comments: data.comment ? [...others, data.comment] : others };
    });
  }, [postReview]);

  const saveReviewRating = useCallback(async (stars: number) => {
    const versionId = modelRef.current?.current.id;
    if (!versionId) throw new Error("这一版还没有保存过内容，保存后才能评分。");
    const data = await postReview<{ stars: number | null }>({ kind: "RATING", versionId, stars }, "评分保存");
    setReview((current) => ({ ...current, stars: data.stars }));
  }, [postReview]);

  const reviewComments = useMemo(() => commentsByTarget(review.comments), [review.comments]);
  // 集成版页面不渲染评分组件（规格一之 A 第 5 条）。
  const isFinalVersionView = Boolean(model?.current.isFinal);

  const versionRows = useMemo(() => (model ? buildV19VersionTree(model.versions) : []), [model]);
  const createBaseOptions = useMemo(
    () => (model ? model.versions.filter((version): version is V19VersionSummary & { id: string } => version.id !== null) : []),
    [model],
  );
  const latestVersion = useMemo(() => {
    // 「最新修改」不含点评版（docs/25 3.3）：它不是谁的作业。
    const personal = model ? model.versions.filter((version) => version.kind !== "AUDIO_REVIEW") : [];
    if (!personal.length) return null;
    return personal.reduce((left, right) => (right.updatedAt >= left.updatedAt ? right : left));
  }, [model]);
  const reviewBasis = useMemo(
    () => computeV19ReviewBasis(model, draft, currentAudioReview),
    [model, draft, currentAudioReview],
  );

  if (loadError) {
    return (
      <main className={styles.surface} data-v04-page="studio" data-v19-viewer-id={viewerUserId}>
        <section className={styles.emptyState}>
          <h2>工作台读取失败</h2>
          <p>{loadError}</p>
          <button type="button" onClick={() => { setLoadError(""); setRetryToken((token) => token + 1); }}>重新读取</button>
        </section>
      </main>
    );
  }
  if (!model) {
    return (
      <main className={styles.surface} data-v04-page="studio" data-v19-viewer-id={viewerUserId}>
        <section className={styles.emptyState}><h2>正在读取工作台…</h2></section>
      </main>
    );
  }

  const readOnly = !model.viewerCapabilities.canEdit;
  const myVersionNumber = model.myVersionId ? model.versions.find((version) => version.id === model.myVersionId)?.number : undefined;
  // 集成版 + 非老孙：GET 已经把这个视角下的 canEdit 算成 isCaseReviewer
  // （spec 四、4.1），所以 `readOnly` 在这个视角只可能因为「不是老孙」而成立——
  // 锁定态就是「集成版视角下的只读」，据此区分「压根不是可编辑区」的普通只读。
  const finalLocked = isFinalVersionView && readOnly;
  const canAdoptFinal = isFinalVersionView && !readOnly;
  // 点评版 id → 点评人：集成版溯源里点评版候选行写「老孙录音点评」（docs/25 六）。
  const reviewerNames = new Map(model.versions
    .filter((version): version is V19VersionSummary & { id: string } => version.kind === "AUDIO_REVIEW" && version.id !== null)
    .map((version) => [version.id, version.ownerName]));
  // `finalContext` (and so `locked`) must not depend on `model.finalTrace`
  // having loaded — it's an optional field on the GET response, and gating
  // the whole context on it left a colleague opening the case with no
  // `?version` (current defaults to the final version, spec 二、11) with no
  // locked styling, no toast, and no source chain (本机走查 bug). Trace data
  // degrades gracefully to null/empty inside `finalFieldExtras` instead.
  const finalContext: V19StudioFinalContext | undefined = isFinalVersionView
    ? {
      locked: finalLocked,
      traceMode: finalTraceMode,
      originPayload: model.finalTrace?.originPayload ?? null,
      intakes: model.finalTrace?.intakes ?? [],
      canAdopt: canAdoptFinal,
      onAdopt: adoptFinalIntake,
      originOwnerName: model.versions.find((version) => version.number === 1)?.ownerName ?? "",
      reviewCandidates: model.finalTrace?.reviewCandidates ?? [],
      onAdoptReview: adoptReviewCandidate,
      reviewerNames,
      reviewVersionNumbers: new Set(model.versions.filter((version) => version.kind === "AUDIO_REVIEW").map((version) => version.number)),
    }
    : undefined;
  // Reads `model.finalTrace` directly rather than `finalContext.intakes`:
  // `finalContext` carries `onAdopt` (a `useCallback` closing over `modelRef`,
  // a real ref), and `eslint-plugin-react-hooks`'s `react-hooks/refs` rule
  // conservatively treats a later property read off that same object as a
  // render-time ref read (本机走查 bug fix — this file used to fail lint).
  // Passing `finalContext` itself as a prop below is fine; only synchronously
  // reading a property off it in this render body tripped the rule.
  const pendingStructuralIntakes = isFinalVersionView && finalTraceMode
    ? pendingV19StructuralIntakes(model.finalTrace?.intakes ?? [])
    : [];

  // 录音点评改写（docs/25 二、七）：当前是不是点评版、页头入口该是哪种形态、
  // 被点评版本上的提示条、版本菜单里点评版的说明。
  const isReviewVersionView = !isFinalVersionView && model.current.kind === "AUDIO_REVIEW";
  const audioEntry = resolveV19AudioReviewEntry({
    available: model.audioReviewAvailable,
    current: model.current,
    viewerUserId,
    reviews: model.audioReviews,
  });
  const audioEntryReview = "review" in audioEntry ? audioEntry.review : null;
  const currentBaseLabel = `v${model.current.number} ${model.current.ownerName}`;
  const reviewOfCurrent = !isFinalVersionView && model.current.kind === "PERSONAL"
    ? audioReviewForVersion(model.audioReviews, model.current.id)
    : null;
  const reviewNotice = reviewOfCurrent?.status === "GENERATED" && reviewOfCurrent.reviewVersionId ? reviewOfCurrent : null;
  const reviewVersionOwner = (versionId: string | null) =>
    model.versions.find((version) => version.id === versionId)?.ownerName || "老孙";
  const reviewSummaryByVersion = new Map(model.audioReviews
    .filter((item) => item.reviewVersionId)
    .map((item) => [item.reviewVersionId as string, item]));
  const hasReviewVersions = model.versions.some((version) => version.kind === "AUDIO_REVIEW");
  const shownAudioReview = currentAudioReview && currentAudioReview.id === model.current.audioReviewId ? currentAudioReview.view : null;
  const shownAudioReviewError = currentAudioReviewError && currentAudioReviewError.id === model.current.audioReviewId
    ? currentAudioReviewError.message : "";

  return (
    <main className={styles.surface} data-v04-page="studio" data-v19-viewer-id={viewerUserId}>
      <header className={styles.siteHeader} data-v04-fixed-header>
        <div className={styles.studioIdentity}>
          <Link href={links.libraryHref} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
          <button
            type="button"
            className={`${styles.navToggle} ${navCollapsed ? "" : styles.on}`.trim()}
            onClick={() => setNavCollapsed((current) => !current)}
            title={navCollapsed ? "展开左侧目录" : "收起左侧目录，扩大内容区"}
          >
            ☰ 目录
          </button>
        </div>
        <nav className={styles.siteNav}>
          <span className={styles.studioCaseTitle} title={model.case.title}>{model.case.title}</span>
          {/* 反写的是别人拿来的片子，来源本身是判断依据的一部分。 */}
          {(model.case.uploaderName || model.case.uploadedAt) && (
            <span className={styles.studioCaseSource}>
              {model.case.uploaderName ? `${model.case.uploaderName} 上传` : "上传"}
              {model.case.uploadedAt ? ` · ${formatV19Date(model.case.uploadedAt)}` : ""}
            </span>
          )}
        </nav>
        <div className={styles.siteUtilities}>
          {/* 删除案例入口：与只读成果页（`V04DetailClient`）同一份 viewerCapabilities.canTrash
              门禁，跟当前正看着谁的版本无关；位置在页头右侧、集成版 pill（下面的 versionSplit）
              之前，与报告工作台页头「删除报告」同一个位置、同一套样式（见 V04Surface.module.css
              的 .trashButton）。 */}
          {model.viewerCapabilities.canTrash ? (
            <button
              type="button"
              className={styles.trashButton}
              data-v04-trash-case
              disabled={trashing}
              onClick={() => { setTrashError(""); setConfirmingTrash(true); }}
            >
              删除案例
            </button>
          ) : null}
          {/* 老孙的点评录音入口（docs/25 二、1）：只在他看别人的普通版本时出现，
              位置在版本胶囊之前；五种形态见 V19AudioReviewEntry。 */}
          <V19AudioReviewEntry
            key={audioEntry.kind}
            state={audioEntry}
            view={audioEntryReview ? audioReviewViews[audioEntryReview.id] ?? null : null}
            baseLabel={currentBaseLabel}
            uploadingLocally={audioUploading}
            busy={audioReviewBusy}
            onUpload={() => setAudioUploadOpen(true)}
            onOpenDrawer={() => { if (audioEntryReview) setAudioDrawerReviewId(audioEntryReview.id); }}
            onView={openAudioReviewVersion}
            onRetry={() => { if (audioEntryReview) void retryAudioReview(audioEntryReview.id); }}
            onReupload={() => { if (audioEntryReview) void abandonAudioReview(audioEntryReview.id, true); }}
            onAbandon={() => { if (audioEntryReview) setAudioAbandonTarget(audioEntryReview.id); }}
          />
          {/* 比较基版属于「当前这个版本」，所以两者共用一个容器、中间一道分隔，
              让从属关系由结构说明，而不是靠摆放位置暗示。没有基版时右段整段
              不渲染，控件自身就说明了这个版本无可比较的基版。 */}
          <div className={styles.versionSplit}>
          <div ref={versionPanelRef} className={styles.versionSplitAnchor}>
            <button
              type="button"
              className={styles.versionSegment}
              aria-haspopup="true"
              aria-expanded={versionPanelOpen}
              aria-label={isFinalVersionView
                ? `当前版本 集成版（${model.final?.status === "DONE" ? "已定稿" : "未定稿"}），点击切换版本`
                : `当前版本 ${formatV19VersionLabel({
                  number: model.current.number,
                  baseNumber: model.current.baseNumber,
                  ownerName: model.current.ownerName,
                  ownerIsUploader: false,
                  baseIsFinal: model.current.baseIsFinal,
                  kind: model.current.kind,
                })}，点击切换版本`}
              onClick={() => setVersionPanelOpen((current) => !current)}
            >
              {isFinalVersionView ? (
                <>
                  <span className={`${styles.versionNum} ${styles.finalVersionNum}`}>集成版</span>
                  {model.final && (
                    <span className={`${styles.finalStatusPill} ${model.final.status === "DONE" ? styles.finalStatusDone : styles.finalStatusOpen}`}>
                      <span className={styles.finalStatusDot} aria-hidden="true" />
                      {model.final.status === "DONE" ? "已定稿" : "未定稿"}
                    </span>
                  )}
                </>
              ) : isReviewVersionView ? (
                // 点评版：「v3 老孙录音点评 基于 v1」（docs/25 二、5）。
                <>
                  <span className={styles.versionNum}>v{model.current.number}</span>
                  <span className={styles.versionOwner}>{model.current.ownerName}录音点评</span>
                  {model.current.baseNumber !== null && (
                    <span className={styles.versionBase}>基于 v{model.current.baseNumber}</span>
                  )}
                </>
              ) : (
                // 姓名紧跟版本号，因为它归属的是这个版本；派生关系排在最后并弱化，
                // 否则「v2 ←v1 晏恩华」会被读成 v1 是晏恩华的。
                <>
                  <span className={styles.versionNum}>v{model.current.number}</span>
                  <span className={styles.versionOwner}>{model.current.ownerName}</span>
                  {(model.current.baseNumber !== null || model.current.baseIsFinal) && (
                    <span className={styles.versionBase}>
                      {model.current.baseIsFinal ? "基于集成版" : `基于 v${model.current.baseNumber}`}
                    </span>
                  )}
                </>
              )}
              <span className={styles.versionCaret} aria-hidden="true">▾</span>
            </button>
            {versionPanelOpen && (
              <div className={styles.versionPanel} role="dialog" aria-label="版本链">
                <h4>
                  版本链：集成版置顶；其余每位编辑者一个版本，创建即固定基于当时快照，互不覆盖
                  {hasReviewVersions && "；点评版由老孙的录音点评生成，挂在被点评的版本下面"}
                </h4>
                {model.final && (
                  <div
                    className={`${styles.versionRow} ${styles.versionRowFinal} ${isFinalVersionView ? styles.versionRowCurrent : ""}`.trim()}
                    role="button"
                    tabIndex={0}
                    onClick={() => viewVersion("final")}
                    onKeyDown={(event) => { if (event.key === "Enter") viewVersion("final"); }}
                  >
                    <span className={styles.versionNumber}>集成版</span>
                    {/* "默认展示"跟着浏览者走：自己已有版本时默认展示自己的版本，
                        标注挂到下面 `model.myVersionId` 那一条普通版本行；没有
                        自己的版本时，集成版才是默认展示的那一个。 */}
                    {!model.myVersionId && <span className={styles.versionLatest}>默认展示</span>}
                    <span className={`${styles.finalStatusPill} ${model.final.status === "DONE" ? styles.finalStatusDone : styles.finalStatusOpen}`}>
                      <span className={styles.finalStatusDot} aria-hidden="true" />
                      {model.final.status === "DONE" ? `已定稿 ${model.final.doneAt ? formatShortDateTime(model.final.doneAt) : ""}`.trim() : "未定稿"}
                    </span>
                    {model.final.pendingCount > 0 && (
                      <span className={styles.finalPendingBadge}>{model.final.pendingCount} 处未纳入</span>
                    )}
                    <span className={styles.versionTime}>{formatV19Clock(model.final.updatedAt)}</span>
                    <span className={styles.versionDesc}>
                      集成版：每一处内容都取各版本里最新的那次修改；进行态自动汇入，定稿后停止。
                    </span>
                  </div>
                )}
                {versionRows.map(({ version, depth }) => version.kind === "AUDIO_REVIEW" ? (
                  // 点评版一行（docs/25 二、5）：挂在被点评版本下面，带「点评版」标记与说明；
                  // 不是谁的作业，所以没有「我的」「最新修改」「默认展示」。
                  <div
                    key={version.id ?? `review-${version.number}`}
                    className={`${styles.versionRow} ${styles.versionRowReview} ${!isFinalVersionView && model.current.id === version.id ? styles.versionRowCurrent : ""}`.trim()}
                    role="button"
                    tabIndex={0}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    data-v19-review-version-row
                    onClick={() => viewVersion(version.id)}
                    onKeyDown={(event) => { if (event.key === "Enter") viewVersion(version.id); }}
                  >
                    <span className={styles.versionNumber}>v{version.number}</span>
                    <span className={styles.versionMeta}>
                      {version.ownerName}录音点评，基于 v{version.baseNumber ?? "?"}
                    </span>
                    <AudioReviewVersionTag />
                    <span className={styles.versionTime}>{formatV19Clock(version.updatedAt)}</span>
                    <span className={styles.versionDesc}>
                      据录音点评改写 v{version.baseNumber ?? "?"}
                      {version.id && reviewSummaryByVersion.get(version.id) ? `，${reviewSummaryByVersion.get(version.id)?.changeCount ?? 0} 处改动` : ""}
                      ；不占个人版本名额，不汇入集成版。
                    </span>
                  </div>
                ) : (
                  <div
                    key={version.id ?? "virtual"}
                    className={`${styles.versionRow} ${!isFinalVersionView && model.current.id === version.id ? styles.versionRowCurrent : ""}`.trim()}
                    role="button"
                    tabIndex={0}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => viewVersion(version.id)}
                    onKeyDown={(event) => { if (event.key === "Enter") viewVersion(version.id); }}
                  >
                    <span className={styles.versionNumber}>v{version.number}</span>
                    <span className={styles.versionMeta}>
                      {version.baseIsFinal ? "基于集成版" : version.baseNumber === null ? "初始版本" : `基于 v${version.baseNumber}`}，{version.ownerName}
                    </span>
                    {version.isMine && <span className={styles.versionMine}>我的</span>}
                    {/* 自己已有版本时，默认展示的就是这一行（不管它是不是最近
                        修改过的那一版）；"最新修改"只是信息性标注，跟默认展示
                        是两件事，可能同时出现在同一行。`model.final` 判空是
                        因为大家都还没有真实版本时 `myVersionId`/`version.id`
                        都是 null——那种情形维持原样，只显示"最新修改"。 */}
                    {model.final && model.myVersionId === version.id ? (
                      <span className={styles.versionLatest}>
                        {latestVersion?.id === version.id ? "最新修改·默认展示" : "默认展示"}
                      </span>
                    ) : latestVersion?.id === version.id && (
                      <span className={styles.versionLatest}>最新修改</span>
                    )}
                    <span className={styles.versionTime}>{formatV19Clock(version.updatedAt)}</span>
                  </div>
                ))}
                {!readOnly && (model.myVersionId ? (
                  <div className={styles.versionMineNote}>
                    <span>每人只有一个版本，你的是 v{myVersionNumber ?? "?"}</span>
                    {model.current.id !== model.myVersionId && (
                      <button type="button" onClick={() => viewVersion(model.myVersionId)}>回到 v{myVersionNumber ?? ""}</button>
                    )}
                  </div>
                ) : (createBaseOptions.length > 0 || model.final) && (
                  <div className={styles.versionCreate}>
                    <span>你还没有版本，可手动新建：基于</span>
                    <select value={effectiveCreateBaseId} onChange={(event) => setCreateBaseId(event.target.value)}>
                      {model.final && <option value="final">集成版（当前汇聚结果）</option>}
                      {createBaseOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {formatV19VersionLabel({ number: option.number, baseNumber: option.baseNumber, ownerName: option.ownerName, ownerIsUploader: false, baseIsFinal: option.baseIsFinal, kind: option.kind })}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void createOwnVersion()}>创建我的版本</button>
                  </div>
                ))}
                <p className={styles.versionNote}>
                  进入页面默认展示你自己的版本，还没有自己的版本时展示集成版；可在此切换查看任意版本；直接编辑也会自动创建或切回你自己的版本。
                  {hasReviewVersions && "点评版只有老孙可以直接改；其他人在上面编辑，改动进自己的版本。"}
                </p>
              </div>
            )}
          </div>
          {model.current.baseNumber !== null && (
            <>
              <i className={styles.versionSplitDivider} aria-hidden="true" />
              <button
                type="button"
                className={`${styles.compareSegment} ${diffOn ? styles.on : ""}`.trim()}
                aria-pressed={diffOn}
                title={`比较与基版 v${model.current.baseNumber} 的差异`}
                onClick={toggleDiff}
              >
                {/* 左右分栏的方框：这个功能就是把基版摆在当前值旁边看。 */}
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2"
                    fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 3.25v9.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M3.6 6.4h2.8M3.6 9.6h2.8" stroke="currentColor" strokeWidth="1.2"
                    strokeLinecap="round" opacity=".65" />
                </svg>
                <span>比较</span>
              </button>
              {/* 逐处查看只在比较开启时存在，所以它长在比较这一段之后，
                  而不是另起一个悬浮控件。计数同时回答了「一共改了多少」——
                  开启时那条提示会消失，这里是常驻的答案。 */}
              {diffOn && diffTotal > 0 && (
                <>
                  <i className={styles.versionSplitDivider} aria-hidden="true" />
                  <span className={styles.diffNav} role="group" aria-label="逐处查看差异">
                    <button type="button" onClick={() => stepDiff(-1)}
                      title="上一处差异" aria-label="上一处差异">‹</button>
                    <span className={styles.diffCount} aria-live="polite">
                      {Math.min(diffIndex + 1, diffTotal)}/{diffTotal}
                    </span>
                    <button type="button" onClick={() => stepDiff(1)}
                      title="下一处差异" aria-label="下一处差异">›</button>
                  </span>
                </>
              )}
            </>
          )}
          </div>
          {/* 集成版专属：默认／溯源分段开关 + 老孙的定稿／取消定稿（spec 五、14）。
              比较基版属于「普通版本」这一段（上面已经因 baseNumber 恒为 null 自动
              隐藏），这两个是集成版独有的一段，只在集成版视角出现。 */}
          {isFinalVersionView && (
            <div className={styles.finalViewSwitch} role="group" aria-label="集成版视图">
              <button type="button" className={finalTraceMode ? undefined : styles.on}
                title="只显示各处当前采用的内容" onClick={() => setFinalTraceMode(false)}>默认</button>
              <button type="button" className={finalTraceMode ? styles.on : undefined}
                title="每一处都按更新顺序列出所有版本的写法" onClick={() => setFinalTraceMode(true)}>溯源</button>
            </div>
          )}
          {isFinalVersionView && !readOnly && model.final && (
            <button
              type="button"
              className={`${styles.finalActionButton} ${model.final.status === "DONE" ? styles.finalActionButtonUndo : ""}`.trim()}
              disabled={finalActionBusy}
              title={model.final.status === "OPEN" ? "定稿后其他版本的修改不再进入集成版" : "回到进行态，其他版本的修改重新自动汇入"}
              onClick={toggleFinalStatus}
            >
              {model.final.status === "OPEN"
                ? "✓ 定稿"
                : `取消定稿${model.final.pendingCount > 0 ? `（${model.final.pendingCount} 处待采纳）` : ""}`}
            </button>
          )}
          {!readOnly && (historyDepth.undo > 0 || historyDepth.redo > 0) && (
            <div className={styles.historyControl} role="group" aria-label="撤销与重做">
              <button type="button" onClick={undoEdit} disabled={historyDepth.undo === 0}
                title="撤销上一步（⌘/Ctrl+Z）" aria-label="撤销上一步">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.2 6.6h6.3a3.3 3.3 0 0 1 0 6.6H6.1" /><path d="M5.8 3.6 3 6.6l2.8 3" />
                </svg>
                <span>撤销</span>
              </button>
              <i className={styles.historyDivider} />
              <button type="button" onClick={redoEdit} disabled={historyDepth.redo === 0}
                title="重做（⌘/Ctrl+Shift+Z）" aria-label="重做">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12.8 6.6H6.5a3.3 3.3 0 0 0 0 6.6h3.4" /><path d="M10.2 3.6 13 6.6l-2.8 3" />
                </svg>
                <span>重做</span>
              </button>
            </div>
          )}
          <span className={[styles.saveChip, saveStatus.kind === "SAVING" ? styles.saveChipSaving : "", saveStatus.kind === "SAVED" ? styles.saveChipSaved : ""].filter(Boolean).join(" ")}>
            <span className={styles.saveDot} />
            <span>
              {saveStatus.kind === "SAVING" && "保存中…"}
              {saveStatus.kind === "SAVED" && `已自动保存至 ${formatV19CurrentVersionShortLabel(model.current)} · ${formatV19Clock(saveStatus.at)}`}
              {saveStatus.kind === "ERROR" && saveStatus.message}
              {saveStatus.kind === "IDLE" && "已自动保存"}
            </span>
            {saveStatus.kind === "ERROR" && <button type="button" onClick={retrySave}>重试</button>}
          </span>
          <ThemeSwitcher />
          <span>{viewerName}</span>
        </div>
      </header>

      {/* 弹出式确认对话框（@/components/shared/DeleteConfirmDialog.tsx），跟报告库卡片、
          报告工作台「删除报告」、只读成果页「删除案例」共用同一个组件，不是页内确认条。 */}
      <DeleteConfirmDialog
        open={confirmingTrash}
        heading="删除案例"
        title={model.case.title}
        lines={[
          "案例会从案例库中移除，保留 90 天，可由上传者或系统管理员恢复；原始视频文件不会被清理。",
          "已有的工作稿、修订历史和提交版本都会一并保留，不会被删除。",
        ]}
        error={trashError}
        pending={trashing}
        onConfirm={() => {
          void (async () => {
            setTrashing(true);
            setTrashError("");
            try {
              await v04UiApi.trash(videoId, { reason: "上传者在工作台移入回收站" }, trashKeyRef.current);
              window.location.assign(links.libraryHref);
            } catch (reason) {
              setTrashError(reason instanceof V04UiApiError ? reason.message : "删除未完成，案例未发生变化，可重试。");
              setTrashing(false);
            }
          })();
        }}
        onCancel={() => setConfirmingTrash(false)}
      />

      {/* 录音点评改写的三个浮层：上传、确认抽屉、放弃确认（放弃确认复用同一个共享弹窗）。 */}
      <V19AudioReviewUploadDialog
        open={audioUploadOpen}
        videoId={videoId}
        baseVersionId={model.current.id}
        baseLabel={currentBaseLabel}
        caseTitle={model.case.title}
        onClose={() => setAudioUploadOpen(false)}
        onCreated={onAudioReviewCreated}
        onUploaded={onAudioReviewUploaded}
        onDiscarded={dropAudioReview}
        onUploadingChange={setAudioUploading}
      />
      <V19AudioReviewDrawer
        open={audioDrawerReviewId !== null}
        videoId={videoId}
        reviewId={audioDrawerReviewId}
        baseLabel={currentBaseLabel}
        nextVersionNumber={nextV19VersionNumber(model.versions)}
        busy={audioReviewBusy}
        covered={audioAbandonTarget !== null}
        onClose={() => setAudioDrawerReviewId(null)}
        onConfirm={(view, selectedChangeIds) => { void confirmAudioReview(view, selectedChangeIds); }}
        onAbandon={() => { if (audioDrawerReviewId) setAudioAbandonTarget(audioDrawerReviewId); }}
        onReupload={() => { if (audioDrawerReviewId) void abandonAudioReview(audioDrawerReviewId, true); }}
      />
      <DeleteConfirmDialog
        open={audioAbandonTarget !== null}
        eyebrow="AUDIO REVIEW"
        heading="放弃这次点评"
        title={model.case.title}
        question="放弃这次点评录音？"
        lines={[
          "已上传的录音和拟定的改动都不再使用，入口回到「上传点评录音」，可以重新上传。",
          "录音文件本身不会被删除。",
        ]}
        pending={audioReviewBusy}
        confirmLabel="放弃这次点评"
        pendingLabel="正在放弃…"
        onConfirm={() => {
          const target = audioAbandonTarget;
          if (!target) return;
          void abandonAudioReview(target, false, false).then((done) => {
            setAudioAbandonTarget(null);
            // 等弹窗先关掉、还原了它锁的滚动，再关抽屉（见 abandonAudioReview 的说明）。
            if (done) window.setTimeout(() => setAudioDrawerReviewId(null), 0);
          });
        }}
        onCancel={() => setAudioAbandonTarget(null)}
      />

      <div className={`${styles.workspaceGrid} ${navCollapsed ? styles.navCollapsed : ""}`.trim()}>
        <nav className={styles.workspaceNav} aria-label="V1.9 工作台目录">
          {isReviewVersionView && (
            <button type="button" onClick={() => void locateV04Target(V19_AUDIO_REVIEW_CARD_ID)}>
              <b>{model.current.ownerName}的录音点评</b><span>录音、意见与文字稿</span>
            </button>
          )}
          <button type="button" className={activeNavId === "module-1" ? styles.navActive : undefined} onClick={() => void locateV04Target("module-1")}>
            <b>第一模块</b><span>全片事实与核心判断</span>
          </button>
          <div className={styles.navChildren}>
            {MODULE_ONE_NAV_FIELDS.map(([id, label]) => (
              <button key={id} type="button" className={activeNavId === id ? styles.navActive : undefined} onClick={() => void locateV04Target(id)}>{label}</button>
            ))}
          </div>
          <button type="button" className={activeNavId === "module-2" ? styles.navActive : undefined} onClick={() => void locateV04Target("module-2")}>
            <b>第二模块</b><span>脚本反写</span>
          </button>
          <div className={styles.navChildren}>
            {draft.shotGroups.map((group, groupIndex) => (
              <div key={group.id}>
                <button
                  type="button"
                  className={activeNavId === `bridge-${group.id}` ? styles.navActive : undefined}
                  onClick={() => void locateV04Target(`bridge-${group.id}`)}
                >
                  桥段{String(groupIndex + 1).padStart(2, "0")} · {group.title || "未命名"}
                </button>
                {group.shots.map((shot) => (
                  <button
                    key={shot.id}
                    type="button"
                    className={activeNavId === `row-${shot.id}` ? styles.navActive : undefined}
                    onClick={() => void locateV04Target(`row-${shot.id}`)}
                  >
                    镜头 {String(numbers.get(shot.id) ?? 0).padStart(2, "0")}
                    <span> {shot.startTime || "--:--"}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button type="button" className={activeNavId === "module-3" ? styles.navActive : undefined} onClick={() => void locateV04Target("module-3")}>
            <b>第三模块</b><span>主导感知路径与整体评价</span>
          </button>
          <div className={styles.navChildren}>
            {MODULE_THREE_NAV_FIELDS.map(([id, label]) => (
              <button key={id} type="button" className={activeNavId === id ? styles.navActive : undefined} onClick={() => void locateV04Target(id)}>{label}</button>
            ))}
          </div>
        </nav>

        <div className={styles.editorColumn} data-v19-version-id={isFinalVersionView ? "final" : model.current.id ?? ""}>
          <V04VideoPlayer caseId={model.case.id} title={model.case.title} surface="detail" media={model.media} chrome="studio" />
          {/* 被点评版本上的提示条（docs/25 二、10）：所有人可见，这一版本身保持原样。 */}
          {reviewNotice && (
            <div className={styles.reviewNotice} data-v19-review-notice>
              <AudioReviewIcon name="mic" />
              <span>
                <b>{reviewVersionOwner(reviewNotice.reviewVersionId)}对这一版做了录音点评</b>，据此生成了点评版 v{reviewNotice.reviewVersionNumber ?? "?"}（{reviewNotice.changeCount} 处改动）。这一版保持原样。
              </span>
              <button type="button" className={styles.reviewGhostButton}
                onClick={() => openAudioReviewVersion(reviewNotice.reviewVersionId as string)}>去看点评版</button>
            </div>
          )}
          {readOnly && !isFinalVersionView && (
            <p style={{ color: "var(--v04-muted)", fontSize: 12, margin: "0 0 16px" }}>当前身份无法编辑此工作台，仅可查看内容与历史版本。</p>
          )}
          {/* 视频下方横幅（spec 五、15）：只在集成版视角出现，说明当前是未定稿
              还是已定稿、有没有未纳入的修改，以及怎么处理它们。 */}
          {isFinalVersionView && model.final && (
            <div className={styles.finalBanner}>
              <span className={`${styles.finalStatusPill} ${model.final.status === "DONE" ? styles.finalStatusDone : styles.finalStatusOpen}`}>
                <span className={styles.finalStatusDot} aria-hidden="true" />
                {model.final.status === "OPEN" ? "未定稿" : "已定稿"}
              </span>
              <span>
                {model.final.status === "OPEN"
                  ? "各版本的每一处修改都会自动汇入这里，后改的覆盖先改的"
                  : `老孙于 ${model.final.doneAt ? formatShortDateTime(model.final.doneAt) : ""} 定稿，此后其他版本的修改不再进入集成版`}
                {model.final.pendingCount > 0 && (
                  <span className={styles.finalPendingText}>；定稿期间有 {model.final.pendingCount} 处修改未纳入</span>
                )}
              </span>
              <span className={styles.finalBannerSpacer} />
              {model.final.pendingCount > 0 && !readOnly && (
                <button type="button" disabled={finalActionBusy} onClick={adoptAllFinalIntakes}>全部采纳</button>
              )}
              {model.final.pendingCount > 0 && !finalTraceMode && (
                <button type="button" onClick={() => setFinalTraceMode(true)}>到溯源视图逐条看</button>
              )}
            </div>
          )}
          {/* 结构改动未纳入（spec 五、18）：INSERT/REMOVE 这类没有单个字段可挂的
              汇入记录，单独列在横幅下方，只在溯源视图出现。位置按 currentPayload
              （集成版已保存的内容，不是本地草稿）里找不找得到 afterId/parentGroupId
              判定退化，见 lib/v19-final-trace.ts。 */}
          {isFinalVersionView && finalTraceMode && pendingStructuralIntakes.length > 0 && (
            <div className={styles.finalStructuralPending}>
              <b>结构改动未纳入</b>
              {pendingStructuralIntakes.map((intake) => (
                <div key={intake.id} className={styles.finalStructuralRow}>
                  <span>{describeV19StructuralIntake(intake, model.current.payload)}</span>
                  {canAdoptFinal && (
                    <button type="button" disabled={finalActionBusy} onClick={() => adoptFinalIntake(intake.id)}>
                      采纳这一版
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* 点评版顶部的录音卡（docs/25 二、5）：录音、意见清单、完整文字稿，全站可见。 */}
          {isReviewVersionView && (
            <V19AudioReviewCard
              videoId={videoId}
              review={shownAudioReview}
              loadError={shownAudioReviewError}
              baseVersionNumber={model.current.baseNumber}
              onRetry={() => setCurrentAudioReviewReload((token) => token + 1)}
              onJumpToOpinion={jumpToReviewOpinion}
            />
          )}
          <V19StudioDocument
            draft={draft}
            caseTitle={model.case.title}
            diff={diffOn ? diff : null}
            readOnly={readOnly}
            collapsedModules={collapsedModules}
            onToggleModule={handleToggleModule}
            onChange={applyEdit}
            onInsertShotAfter={onInsertShotAfter}
            onInsertBridgeAfter={onInsertBridgeAfter}
            onInsertFirstBridge={onInsertFirstBridge}
            onInsertFirstShot={onInsertFirstShot}
            onDeleteShot={onDeleteShot}
            onDeleteBridge={onDeleteBridge}
            pendingDeleteId={pendingDeleteId}
            onCancelDelete={onCancelDelete}
            nonCompliantStartCount={nonCompliantStartCount}
            onNormalizeTimeline={onNormalizeTimeline}
            onInvalid={pushToast}
            onBeforeEdit={() => !interceptForeignEdit()}
            review={{
              canReview: review.canReview,
              comments: reviewComments,
              currentVersionId: model.current.id,
              disabled: !model.current.id,
              onSave: saveReviewComment,
            }}
            final={finalContext}
            reviewBasis={isReviewVersionView && diffOn ? reviewBasis : undefined}
          />
          {/* 打分放在正文末尾：读完整份作业才谈得上给分。集成版、点评版都不评分——
              星级只锚定个人版本，`review.canRate` 与集成版／点评版视角都会关掉它（docs/25 二、8）。 */}
          {!isFinalVersionView && !isReviewVersionView && review.canRate && (
            <V19AssignmentRating
              stars={review.stars}
              canReview={review.canReview}
              versionLabel={`${formatV19CurrentVersionShortLabel(model.current)} · ${model.current.ownerName}`}
              disabled={!model.current.id}
              onRate={saveReviewRating}
            />
          )}
        </div>
      </div>

      <div className={styles.pageJump}>
        <button type="button" disabled={scrollState.atTop} title="回到顶部" aria-label="回到顶部" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 3.4h8" /><path d="M8 13V6.4" /><path d="M5.1 9.3 8 6.2l2.9 3.1" />
          </svg>
        </button>
        <i className={styles.pageJumpDivider} />
        <button
          type="button"
          disabled={scrollState.atBottom}
          title="跳到底部"
          aria-label="跳到底部"
          onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12.6h8" /><path d="M8 3v6.6" /><path d="M5.1 6.7 8 9.8l2.9-3.1" />
          </svg>
        </button>
      </div>

      <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 99, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", pointerEvents: "none" }}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            style={{
              background: "var(--v04-warn-surface)", color: "var(--v04-ink)", border: "1px solid var(--v04-line)",
              borderRadius: 12, padding: "10px 16px", fontSize: 12, boxShadow: "0 16px 42px rgb(var(--v04-shadow-rgb) / calc(.38 * var(--v04-shadow-strength)))",
              maxWidth: "80vw", lineHeight: 1.55,
            }}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </main>
  );
}
