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
import { blankV04Shot, locateV04Target, mintV04LocalId, numberedV04Shots, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04LatestSaveCoordinator } from "@/lib/v04-save-coordinator";
import {
  formatV19VersionLabel,
  v19Api,
  V04UiApiError,
  type V19CurrentVersion,
  preserveV19UntouchedPerceptionPath,
  type V19StudioModel,
  type V19VersionSummary,
} from "@/lib/v19-ui-model";
import { describeV19Diff, diffV19AgainstBase, type V19BaseDiff } from "@/lib/v19-base-diff";
import { nextV19StartTime } from "@/lib/v19-timeline";
import V04VideoPlayer from "./V04VideoPlayer";
import V19StudioDocument from "./V19StudioDocument";
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
  | { action: "SWITCH_TO_OWN"; versionId: string };

export function resolveV19EditGuard(
  current: { isMine: boolean },
  myVersionId: string | null,
): V19EditGuardDecision {
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

export type V19VersionTreeRow = { version: V19VersionSummary; depth: number };

/** Builds the version panel's tree, rooted at every version with `baseNumber === null`. */
export function buildV19VersionTree(versions: readonly V19VersionSummary[]): V19VersionTreeRow[] {
  const byBase = new Map<number | "root", V19VersionSummary[]>();
  for (const version of versions) {
    const key: number | "root" = version.baseNumber === null ? "root" : version.baseNumber;
    const bucket = byBase.get(key);
    if (bucket) bucket.push(version); else byBase.set(key, [version]);
  }
  const rows: V19VersionTreeRow[] = [];
  const walk = (list: V19VersionSummary[] | undefined, depth: number) => {
    for (const version of list ?? []) {
      rows.push({ version, depth });
      walk(byBase.get(version.number), depth + 1);
    }
  };
  walk(byBase.get("root"), 0);
  return rows;
}

function formatV19Clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 8);
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
  const payload = v04UiDraftToPayload(draft, model.current.payload);
  return diffV19AgainstBase(payload, model.current.basePayload);
}

function computeV19DefaultBaseId(model: V19StudioModel | null): string {
  if (!model) return "";
  return model.current.id ?? model.versions.find((version) => version.id !== null)?.id ?? "";
}

const MODULE_ONE_NAV_FIELDS: ReadonlyArray<readonly [string, string]> = [
  [V04_WORKSPACE_TARGETS.commercialIntent, "商业意图"],
  [V04_WORKSPACE_TARGETS.storySummary, "故事梗概"],
  [V04_WORKSPACE_TARGETS.creativeMotif, "创意母题"],
  [V04_WORKSPACE_TARGETS.tensionButton, "张力按钮"],
  [V04_WORKSPACE_TARGETS.creativeThinkingChain, "创意思维链"],
  [V04_WORKSPACE_TARGETS.storyReference, "故事参照类型"],
  [V04_WORKSPACE_TARGETS.primaryMechanism, "创意主导手法及机制"],
  [V04_WORKSPACE_TARGETS.auxiliaryMechanism, "创意辅助手法及机制"],
  [V04_WORKSPACE_TARGETS.carriers, "创意承重载体"],
  [V04_WORKSPACE_TARGETS.carrierExplanation, "创意承重载体具体说明"],
  [V04_WORKSPACE_TARGETS.creativeContract, "创意成立契约"],
];

const MODULE_THREE_NAV_FIELDS: ReadonlyArray<readonly [string, string]> = [
  [V04_WORKSPACE_TARGETS.overallGrade, "整体创意评价"],
  [V04_WORKSPACE_TARGETS.gradeReason, "评价理由"],
];

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

  const pushToast = useCallback((text: string) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
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
  }, []);

  const switchToVersion = useCallback(async (versionId: string | null, options?: { announce?: boolean }) => {
    try {
      const next = await v19Api.load(videoId, versionId ?? undefined);
      applyLoadedModel(next);
      if (options?.announce) {
        pushToast(`每人只有一个版本：已切换到你的版本 ${formatV19VersionLabel({
          number: next.current.number,
          baseNumber: next.current.baseNumber,
          ownerName: next.current.ownerName,
          ownerIsUploader: false,
        })}，请在此继续编辑`);
      }
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "切换版本失败，请重试。");
    }
  }, [videoId, applyLoadedModel, pushToast]);

  // Guard at the top of every mutating entry point (onChange / insert shot /
  // insert bridge): switches away BEFORE anything changes, discarding this
  // one edit — see `resolveV19EditGuard`.
  const interceptForeignEdit = useCallback((): boolean => {
    const current = modelRef.current;
    if (!current) return false;
    const decision = resolveV19EditGuard(current.current, current.myVersionId);
    if (decision.action === "PROCEED") return false;
    void switchToVersion(decision.versionId, { announce: true });
    return true;
  }, [switchToVersion]);

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
    try {
      const response = await v19Api.save(videoId, {
        basedOnVersionId: currentModel.current.id,
        changeSetId,
        changes,
      });
      const latest = modelRef.current ?? currentModel;
      const createdVersion = response.createdVersion;
      const nextCurrent: V19CurrentVersion = {
        ...latest.current,
        id: response.versionId,
        number: response.versionNumber,
        revision: response.revision,
        contentHash: response.contentHash,
        updatedAt: response.updatedAt,
        payload: afterPayload,
        isMine: true,
        isVirtual: false,
        ...(createdVersion ? {
          baseNumber: latest.current.number,
          basePayload: structuredClone(basePayload),
          ownerUserId: viewerUserId,
          ownerName: viewerName,
          createdAt: response.updatedAt,
        } : {}),
      };
      const updatedModel: V19StudioModel = { ...latest, myVersionId: latest.myVersionId ?? response.versionId, current: nextCurrent };
      modelRef.current = updatedModel;
      setModelState(updatedModel);
      savedPayloadRef.current = afterPayload;
      setSaveStatus({ kind: "SAVED", at: response.updatedAt });
      if (createdVersion) {
        pushToast(`已创建 ${formatV19VersionLabel({
          number: response.versionNumber,
          baseNumber: nextCurrent.baseNumber,
          ownerName: viewerName,
          ownerIsUploader: false,
        })}，你的修改保存在这个版本`);
        void refreshVersionList();
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
  }, [videoId, viewerName, viewerUserId, refreshVersionList, pushToast]);

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

  const applyEdit = useCallback((mutate: (draft: V04UiDraft) => void) => {
    if (!modelRef.current?.viewerCapabilities.canEdit) return;
    if (interceptForeignEdit()) return;
    const before = draftRef.current;
    const next = cloneV04UiDraft(before);
    mutate(next);
    const cascaded = countV19CascadedShots(before, next);
    if (cascaded > 0) pushToast(`已级联顺延后续 ${cascaded} 个镜头的时间线（各镜头时长保持不变）`);
    commitDraft(next);
  }, [interceptForeignEdit, commitDraft, pushToast]);

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
    void switchToVersion(versionId);
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
      });
      pushToast(`已创建 ${label}，后续修改自动保存至该版本`);
    } catch (reason) {
      pushToast(reason instanceof V04UiApiError ? reason.message : "创建版本失败，请重试。");
    }
  }, [effectiveCreateBaseId, videoId, switchToVersion, viewerName, pushToast]);

  const numbers = useMemo(() => new Map(numberedV04Shots(draft.shotGroups).map((entry) => [entry.stableId, entry.displayNumber])), [draft.shotGroups]);
  const diff = useMemo(() => computeV19Diff(model, draft), [model, draft]);

  const toggleDiff = useCallback(() => {
    setDiffOn((current) => {
      const next = !current;
      if (!next) return next;
      if (diff) pushToast(describeV19Diff(diff));
      // Turning the comparison on is a request to see what differs, and the
      // first difference is rarely on screen. Jumping there beats leaving the
      // reader to hunt for the markers they just asked for. Deferred one frame
      // because the markers only exist after this state change renders; a
      // collapsed module can hide them all, in which case nothing moves.
      window.setTimeout(() => {
        const marker = document.querySelector<HTMLElement>("[data-v19-diff]");
        marker?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
      return next;
    });
  }, [diff, pushToast]);

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

  const versionRows = useMemo(() => (model ? buildV19VersionTree(model.versions) : []), [model]);
  const createBaseOptions = useMemo(
    () => (model ? model.versions.filter((version): version is V19VersionSummary & { id: string } => version.id !== null) : []),
    [model],
  );
  const latestVersion = useMemo(() => {
    if (!model || !model.versions.length) return null;
    return model.versions.reduce((left, right) => (right.updatedAt >= left.updatedAt ? right : left));
  }, [model]);

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

  return (
    <main className={styles.surface} data-v04-page="studio" data-v19-viewer-id={viewerUserId}>
      <header className={styles.siteHeader} data-v04-fixed-header>
        <Link href={links.libraryHref} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写 · 二合一工作台</small></Link>
        <nav className={styles.siteNav}>
          <button
            type="button"
            className={`${styles.navToggle} ${navCollapsed ? "" : styles.on}`.trim()}
            onClick={() => setNavCollapsed((current) => !current)}
            title={navCollapsed ? "展开左侧目录" : "收起左侧目录，扩大内容区"}
          >
            ☰ 目录
          </button>
          <span className={styles.headerCaseTitle} title={model.case.title}>{model.case.title}</span>
        </nav>
        <div className={styles.siteUtilities}>
          <div ref={versionPanelRef} style={{ position: "relative", display: "inline-flex" }}>
            <button
              type="button"
              className={styles.versionButton}
              aria-haspopup="true"
              aria-expanded={versionPanelOpen}
              onClick={() => setVersionPanelOpen((current) => !current)}
            >
              {formatV19VersionLabel({
                number: model.current.number,
                baseNumber: model.current.baseNumber,
                ownerName: model.current.ownerName,
                ownerIsUploader: false,
              })}
            </button>
            {versionPanelOpen && (
              <div className={styles.versionPanel} role="dialog" aria-label="版本链">
                <h4>版本链（每位编辑者一个版本，创建即固定基于当时快照，互不覆盖）</h4>
                {versionRows.map(({ version, depth }) => (
                  <div
                    key={version.id ?? "virtual"}
                    className={`${styles.versionRow} ${model.current.id === version.id ? styles.versionRowCurrent : ""}`.trim()}
                    role="button"
                    tabIndex={0}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => viewVersion(version.id)}
                    onKeyDown={(event) => { if (event.key === "Enter") viewVersion(version.id); }}
                  >
                    <span className={styles.versionNumber}>v{version.number}</span>
                    <span className={styles.versionMeta}>
                      {version.baseNumber === null ? "初始版本" : `基于 v${version.baseNumber}`}，{version.ownerName}
                    </span>
                    {version.isMine && <span className={styles.versionMine}>我的</span>}
                    {latestVersion?.id === version.id && <span className={styles.versionLatest}>最新·默认展示</span>}
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
                ) : createBaseOptions.length > 0 && (
                  <div className={styles.versionCreate}>
                    <span>你还没有版本，可手动新建：基于</span>
                    <select value={effectiveCreateBaseId} onChange={(event) => setCreateBaseId(event.target.value)}>
                      {createBaseOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {formatV19VersionLabel({ number: option.number, baseNumber: option.baseNumber, ownerName: option.ownerName, ownerIsUploader: false })}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void createOwnVersion()}>创建我的版本</button>
                  </div>
                ))}
                <p className={styles.versionNote}>进入页面默认展示最新修改的版本，可在此切换查看任意版本；直接编辑也会自动创建或切回你自己的版本。</p>
              </div>
            )}
          </div>
          {model.current.baseNumber !== null && (
            <button type="button" className={`${styles.diffToggle} ${diffOn ? styles.on : ""}`.trim()} onClick={toggleDiff}>
              对比基版 v{model.current.baseNumber}
            </button>
          )}
          <span className={[styles.saveChip, saveStatus.kind === "SAVING" ? styles.saveChipSaving : "", saveStatus.kind === "SAVED" ? styles.saveChipSaved : ""].filter(Boolean).join(" ")}>
            <span className={styles.saveDot} />
            <span>
              {saveStatus.kind === "SAVING" && "保存中…"}
              {saveStatus.kind === "SAVED" && `已自动保存至 v${model.current.number} · ${formatV19Clock(saveStatus.at)}`}
              {saveStatus.kind === "ERROR" && saveStatus.message}
              {saveStatus.kind === "IDLE" && "已自动保存"}
            </span>
            {saveStatus.kind === "ERROR" && <button type="button" onClick={retrySave}>重试</button>}
          </span>
          <span>{viewerName}</span>
        </div>
      </header>

      <div className={`${styles.workspaceGrid} ${navCollapsed ? styles.navCollapsed : ""}`.trim()}>
        <nav className={styles.workspaceNav} aria-label="V1.9 工作台目录">
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

        <div className={styles.editorColumn}>
          <V04VideoPlayer caseId={model.case.id} title={model.case.title} surface="detail" media={model.media} chrome="studio" />
          {readOnly && <p style={{ color: "var(--v04-muted)", fontSize: 12, margin: "0 0 16px" }}>当前身份无法编辑此工作台，仅可查看内容与历史版本。</p>}
          <V19StudioDocument
            draft={draft}
            diff={diffOn ? diff : null}
            readOnly={readOnly}
            collapsedModules={collapsedModules}
            onToggleModule={handleToggleModule}
            onChange={applyEdit}
            onInsertShotAfter={onInsertShotAfter}
            onInsertBridgeAfter={onInsertBridgeAfter}
            onInsertFirstBridge={onInsertFirstBridge}
            onInvalid={pushToast}
            onBeforeEdit={() => !interceptForeignEdit()}
          />
        </div>
      </div>

      {!readOnly && (historyDepth.undo > 0 || historyDepth.redo > 0) && (
        <div className={styles.historyControl} aria-label="撤销与重做">
          <button type="button" onClick={undoEdit} disabled={historyDepth.undo === 0}
            title="撤销上一步（⌘/Ctrl+Z）" aria-label="撤销上一步">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.2 6.6h6.3a3.3 3.3 0 0 1 0 6.6H6.1" /><path d="M5.8 3.6 3 6.6l2.8 3" />
            </svg>
          </button>
          <i className={styles.historyDivider} />
          <button type="button" onClick={redoEdit} disabled={historyDepth.redo === 0}
            title="重做（⌘/Ctrl+Shift+Z）" aria-label="重做">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.8 6.6H6.5a3.3 3.3 0 0 0 0 6.6h3.4" /><path d="M10.2 3.6 13 6.6l-2.8 3" />
            </svg>
          </button>
        </div>
      )}

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
              background: "rgba(31,25,20,.97)", color: "var(--v04-ink)", border: "1px solid var(--v04-line)",
              borderRadius: 12, padding: "10px 16px", fontSize: 12, boxShadow: "0 16px 42px rgba(0,0,0,.38)",
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
