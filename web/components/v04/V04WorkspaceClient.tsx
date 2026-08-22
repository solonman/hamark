"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";
import { HOME_NAVIGATION_EVENT } from "@/app/components/GlobalHomeButton";
import { V04_PAYLOAD_SCHEMA_VERSION, V04_VOCABULARY_VERSION, type V04ChoiceValue, type V04ShotFieldKey } from "@/lib/v04-contract";
import {
  clearV04Recovery,
  decideV04Recovery,
  discoverV04Recoveries,
  initialV04DraftSaveState,
  isV04LeaseFailure,
  readV04Recovery,
  reduceV04DraftSaveState,
  runV04WithTimeout,
  v04SaveFailureMessage,
  V04_AUTOSAVE_DEBOUNCE_MS,
  writeV04Recovery,
  type V04DraftSaveAction,
  type V04RecoveryIdentity,
  type V04RecoveryRecord,
} from "@/lib/v04-draft-save-state";
import type { V04ServerWorkspaceModel, V04UiDraft, V04UiShotGroup } from "@/lib/v04-ui-model";
import { applyV04PayloadValues, cloneV04UiDraft, emptyV04UiDraft, v04PayloadChanges, v04PayloadTargetValue, v04UiDraftToPayload, v04WorkspaceToUiCase, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { blankV04Shot, evaluateV04FixturePublication, locateV04Target, moveV04Shot, nextV04Timecode, numberedV04Shots, v04GroupPrimaryRoleTargetId, v04GroupTitleTargetId, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04_UI_BRIDGE_OPTIONS, V04_UI_MECHANISM_OPTIONS, V04_UI_PATHS, V04_UI_STORY_OPTIONS } from "@/lib/v04-ui-fixture";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import {
  canSubmitV04ServerDraft,
  canMutateV04Draft,
  canRecoverV04LeaseProof,
  canStartV04Restore,
  classifyV04RecoveryConfirmation,
  atomicallyClearConfirmedV04RecoveryRecords,
  clearSelectedV04RecoveryRecord,
  planV04EditAccessRecovery,
  planV04RecoveryMerge,
  planV04ThreeWayChanges,
  runV04LeaseBoundMutationWithSingleRecovery,
  shouldDisableV04Submission,
  shouldReleaseV04Lease,
  V04LatestSaveCoordinator,
} from "@/lib/v04-save-coordinator";
import {
  decideV04FreshWorkspaceTransition,
  decideV04ManualSave,
  effectiveV04SaveStatus,
  ensureV04NavigationCoordinator,
  installV04NavigationTakeover,
  normalizeV04LocalDraftFacts,
  runV04DraftResume,
  runV04SubmissionAwareNavigation,
  shouldProtectV04Unload,
  shouldRetryV04DraftOnResume,
  V04GuardedNavigationCoordinator,
  V04SingleFlight,
  v04NavigationFailureMessage,
  type V04LocalDraftFacts,
} from "@/lib/v04-workspace-lifecycle";
import { useV04VideoSession } from "./V04VideoSessionProvider";
import V04VideoPlayer from "./V04VideoPlayer";
import V04WorkspaceNavigation from "./V04WorkspaceNavigation";
import V04ShotEditor from "./V04ShotEditor";
import V04ChoiceField from "./V04ChoiceField";
import V04HistoryDrawer from "./V04HistoryDrawer";
import V04CommentDrawer, { type V04CommentComposeTarget } from "./V04CommentDrawer";
import V04AiAssistPanel from "./V04AiAssistPanel";
import styles from "./V04Surface.module.css";

type LeaseProof = { tabToken: string; leaseToken: string; leaseVersion: number };
type LeaseResult = { leaseId: string; leaseToken: string; leaseVersion: number; expiresAt: string; reused: boolean };
type SaveResult = { revision: number; contentHash: string; savedAt?: string; workflowState?: V04ServerWorkspaceModel["state"]; rebased?: boolean };
type V04Payload = V04ServerWorkspaceModel["payload"];
type V04StagedDraft = { draft: V04UiDraft; basePayload: V04Payload };
type RecoveryPrompt = {
  kind: "RESTORE_AVAILABLE" | "CONFLICT";
  record: V04RecoveryRecord<V04UiDraft, V04Payload>;
  records: V04RecoveryRecord<V04UiDraft, V04Payload>[];
  selectedIndex: number;
  comparing: boolean;
};
type V04WorkspaceNavigation = {
  libraryHref: string;
  detailHref: string;
  workspaceHref: string;
  detailLabel?: string;
  workspaceLabel?: string;
};
const pathLabels = Object.fromEntries(V04_UI_PATHS.map((item) => [item.id, item.label]));
const pathKeys = {
  LOVE: ["emotionalBase", "accumulation", "gapPressure", "releaseMethod", "mainCarrier"],
  FUN: ["originalExpectation", "deviation", "reveal", "reinterpretation", "mainCarrier"],
  PERCEPTION: ["perceptionRule", "repetitionVariation", "audiovisualRelation", "payoff", "mainCarrier"],
} as const;
const RECOVERY_SUBMIT_BLOCKED_MESSAGE = "仍有未吸收、冲突或尚未安全清理的本地恢复副本；请先恢复、对照或继续使用服务器版本，系统不会创建提交。";

function recoveryRecordKey(record: V04RecoveryRecord<V04UiDraft, V04Payload>) {
  return `${record.identity.userId}:${record.identity.workspaceId}:${record.identity.roundId}:${record.identity.tabId}:${record.writtenAt}`;
}

function getBrowserStorage(kind: "localStorage" | "sessionStorage") {
  if (typeof window === "undefined") return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function Field({ id, label, value, readOnly, tall = false, required = true, targetKey, moduleLabel = "第二模块｜全片事实与核心判断", onComment, onChange }: { id: string; label: string; value: string; readOnly: boolean; tall?: boolean; required?: boolean; targetKey?: string; moduleLabel?: string; onComment?: (target: V04CommentComposeTarget) => void; onChange: (value: string) => void }) {
  const controlId = `${id}-control`;
  return <label className={styles.formField} id={id} htmlFor={controlId}><span><b>{label}</b><i>{required && <em>发布必填</em>}{targetKey && onComment ? <button type="button" onClick={(event) => { event.preventDefault(); onComment({ targetKey, targetLabel: label, moduleLabel, originalExcerpt: value }); }}>批注</button> : null}</i></span>{tall ? <textarea id={controlId} data-v04-primary-focus value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /> : <input id={controlId} data-v04-primary-focus value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />}</label>;
}

export default function V04WorkspaceClient({
  videoId,
  viewerName,
  viewerUserId,
  navigation,
}: {
  videoId: string;
  viewerName: string;
  viewerUserId: string;
  navigation?: V04WorkspaceNavigation;
}) {
  const router = useRouter();
  const localIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const localIdSequence = useRef(0);
  const links = navigation ?? {
    libraryHref: "/v04-shadow",
    detailHref: `/v04-shadow/videos/${videoId}`,
    workspaceHref: `/v04-shadow/videos/${videoId}/workspace`,
  };
  const { getWorkspaceSession, setWorkspaceLeaseProof } = useV04VideoSession();
  const tabToken = useRef("");
  const leaseProof = useRef<LeaseProof | null>(null);
  const modelRef = useRef<V04ServerWorkspaceModel | null>(null);
  const [model, setModelState] = useState<V04ServerWorkspaceModel | null>(null);
  const [draft, setDraftState] = useState<V04UiDraft>(() => emptyV04UiDraft());
  const draftRef = useRef(draft);
  const [loadError, setLoadError] = useState("");
  const [saveMachine, dispatchSave] = useReducer(
    reduceV04DraftSaveState,
    undefined,
    initialV04DraftSaveState,
  );
  const saveMachineRef = useRef(saveMachine);
  const editVersionRef = useRef(0);
  const requestTokenRef = useRef(0);
  const saveCoordinatorRef = useRef(new V04LatestSaveCoordinator<V04StagedDraft>());
  const draftBasePayloadRef = useRef<V04Payload | null>(null);
  const draftBaseRevisionRef = useRef<number | null>(null);
  const draftBaseHashRef = useRef<string | null>(null);
  const changeSetIdsRef = useRef(new Map<number, string>());
  const submitKeysRef = useRef(new Map<string, string>());
  const restoreKeysRef = useRef(new Map<string, string>());
  const submitInFlightRef = useRef<Promise<boolean> | null>(null);
  const restoreInFlightRef = useRef<Promise<void> | null>(null);
  const materializeKeyRef = useRef(`materialize-${videoId}-${crypto.randomUUID()}`);
  const recoveryTabIdRef = useRef("");
  const recoveryIdentityRef = useRef<V04RecoveryIdentity | null>(null);
  const recoveryRecordsAwaitingConfirmationRef = useRef<Array<V04RecoveryRecord<V04UiDraft, V04Payload>>>([]);
  const [recoveryPrompt, setRecoveryPrompt] = useState<RecoveryPrompt | null>(null);
  const recoveryPromptRef = useRef<RecoveryPrompt | null>(null);
  const [recoveryIntegrityBlocked, setRecoveryIntegrityBlocked] = useState(false);
  const recoveryIntegrityBlockedRef = useRef(false);
  const [recoveryStorageAvailable, setRecoveryStorageAvailable] = useState(true);
  const [documentIdentityNotice, setDocumentIdentityNotice] = useState("");
  const [editAccessNotice, setEditAccessNotice] = useState("");
  const [editAccessPending, setEditAccessPending] = useState(false);
  const [editAccessRetryVersion, setEditAccessRetryVersion] = useState(0);
  const editAccessAttemptRef = useRef<Promise<boolean> | null>(null);
  const resumeCoordinatorRef = useRef(new V04SingleFlight());
  const navigationCoordinatorRef = useRef(new V04GuardedNavigationCoordinator());
  const [navigating, setNavigating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState(false);
  const [comments, setComments] = useState(false);
  const [commentTarget, setCommentTarget] = useState<V04CommentComposeTarget | null>(null);
  const [ai, setAi] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState("");
  const [navigationIssue, setNavigationIssue] = useState<{ message: string; href: string } | null>(null);
  const [draggedShotId, setDraggedShotId] = useState<string | null>(null);
  const [pendingLocateId, setPendingLocateId] = useState<string | null>(null);
  const focusContext = useRef<{ element: HTMLElement; scrollY: number } | null>(null);
  const item = useMemo(() => model ? v04WorkspaceToUiCase(model) : null, [model]);
  const hasDraftEditCapability = Boolean(model?.viewerCapabilities.canEdit || (model?.logicalEmpty && model.viewerCapabilities.canMaterialize));
  const recoveryPending = Boolean(recoveryPrompt) || recoveryIntegrityBlocked;
  const canEdit = canMutateV04Draft({
    capability: hasDraftEditCapability,
    restoring: restoring || recoveryPending,
    submitting,
    navigating,
  });
  const publication = useMemo(() => evaluateV04FixturePublication(draft), [draft]);
  const numbers = useMemo(() => new Map(numberedV04Shots(draft.shotGroups).map((entry) => [entry.stableId, entry.displayNumber])), [draft.shotGroups]);
  const allShots = draft.shotGroups.flatMap((group) => group.shots);
  const openComment = (target: V04CommentComposeTarget) => { setCommentTarget(target); setComments(true); };

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    saveMachineRef.current = saveMachine;
  }, [saveMachine]);

  const dispatchSaveState = useCallback((action: V04DraftSaveAction) => {
    // React may render the reducer one frame later. Navigation and submit
    // guards use this synchronous mirror as their authoritative fact source.
    saveMachineRef.current = reduceV04DraftSaveState(saveMachineRef.current, action);
    dispatchSave(action);
  }, []);

  useEffect(() => {
    recoveryPromptRef.current = recoveryPrompt;
  }, [recoveryPrompt]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const setModel = useCallback((next: V04ServerWorkspaceModel) => {
    modelRef.current = next;
    setModelState(next);
  }, []);

  const localDraftFacts = useCallback((): V04LocalDraftFacts => normalizeV04LocalDraftFacts({
    saveStatus: saveMachineRef.current.status,
    saveInFlight: saveCoordinatorRef.current.isRunning,
    editVersion: editVersionRef.current,
    savedVersion: saveCoordinatorRef.current.savedVersion,
    recoveryPending: Boolean(recoveryPromptRef.current) || recoveryIntegrityBlockedRef.current,
  }), []);

  const setRecoveryIntegrity = useCallback((blocked: boolean) => {
    recoveryIntegrityBlockedRef.current = blocked;
    setRecoveryIntegrityBlocked(blocked);
  }, []);

  const recoveryIdentityFor = useCallback((server: V04ServerWorkspaceModel): V04RecoveryIdentity => {
    if (!recoveryTabIdRef.current) throw new Error("V04_DOCUMENT_IDENTITY_NOT_READY");
    return {
      userId: viewerUserId,
      workspaceId: server.workspaceId ?? `logical-${videoId}`,
      roundId: server.roundId ?? "logical-empty",
      tabId: recoveryTabIdRef.current,
      payloadSchemaVersion: V04_PAYLOAD_SCHEMA_VERSION,
    };
  }, [videoId, viewerUserId]);

  const migrateRecoveryIdentity = useCallback((server: V04ServerWorkspaceModel) => {
    if (typeof window === "undefined") return;
    const nextIdentity = recoveryIdentityFor(server);
    const previousIdentity = recoveryIdentityRef.current;
    if (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(nextIdentity)) {
      const storage = getBrowserStorage("localStorage");
      if (!storage) {
        setRecoveryStorageAvailable(false);
        recoveryIdentityRef.current = nextIdentity;
        return;
      }
      const existing = readV04Recovery<V04UiDraft, V04Payload>(storage, previousIdentity);
      if (existing) {
        const migrated = { ...existing, identity: nextIdentity };
        if (!writeV04Recovery(storage, migrated)) {
          setRecoveryStorageAvailable(false);
        } else {
          clearV04Recovery(storage, previousIdentity);
          setRecoveryPrompt((current) => current ? {
            ...current,
            record: { ...current.record, identity: nextIdentity },
            records: current.records.map((record) => record === current.record
              ? { ...record, identity: nextIdentity }
              : record),
          } : null);
        }
      }
    }
    recoveryIdentityRef.current = nextIdentity;
  }, [recoveryIdentityFor]);

  const persistRecovery = useCallback((
    nextDraft: V04UiDraft,
    server = modelRef.current,
    basePayload = draftBasePayloadRef.current ?? server?.payload ?? null,
  ) => {
    if (!server || typeof window === "undefined") return null;
    const identity = recoveryIdentityFor(server);
    recoveryIdentityRef.current = identity;
    const comparisonBase = basePayload ?? server.payload;
    const payload = v04UiDraftToPayload(nextDraft, comparisonBase);
    const dirtyTargets = v04PayloadChanges(comparisonBase, payload).map((change) => change.targetKey);
    const record: V04RecoveryRecord<V04UiDraft, V04Payload> = {
      identity,
      serverRevision: draftBaseRevisionRef.current ?? server.draftRevision,
      serverHash: draftBaseHashRef.current ?? server.draftContentHash,
      ...(basePayload ? { basePayload: structuredClone(basePayload) } : {}),
      payload: cloneV04UiDraft(nextDraft),
      dirtyTargets,
      writtenAt: new Date().toISOString(),
    };
    const storage = getBrowserStorage("localStorage");
    if (!storage || !writeV04Recovery(storage, record)) {
      setRecoveryStorageAvailable(false);
      setActionError("本机恢复副本未能写入；请保持页面打开并立即手动保存。");
      return null;
    }
    setRecoveryStorageAvailable(true);
    return record;
  }, [recoveryIdentityFor]);

  const clearLeaseProof = useCallback(() => {
    leaseProof.current = null;
    setWorkspaceLeaseProof(videoId, null);
  }, [setWorkspaceLeaseProof, videoId]);

  const clearRecoveryRecord = useCallback((identity: V04RecoveryIdentity) => {
    const storage = getBrowserStorage("localStorage");
    if (!storage || !clearV04Recovery(storage, identity)) {
      setRecoveryStorageAvailable(false);
      return false;
    }
    setRecoveryStorageAvailable(true);
    return true;
  }, []);

  const recoveryRecordIsConfirmed = useCallback((
    record: V04RecoveryRecord<V04UiDraft, V04Payload>,
    server: V04ServerWorkspaceModel,
  ) => {
    if (!record.basePayload) return false;
    try {
      const intendedPayload = v04UiDraftToPayload(record.payload, record.basePayload);
      const originalChanges = v04PayloadChanges(record.basePayload, intendedPayload);
      return classifyV04RecoveryConfirmation(
        originalChanges,
        (targetKey) => v04PayloadTargetValue(server.payload, targetKey),
      ) === "CONFIRMED";
    } catch {
      return false;
    }
  }, []);

  const reconcileConfirmedRecoveries = useCallback((server: V04ServerWorkspaceModel) => {
    const prompt = recoveryPromptRef.current;
    const storage = getBrowserStorage("localStorage");
    if (!storage) {
      setRecoveryStorageAvailable(false);
      setRecoveryIntegrity(true);
      return false;
    }
    const records = new Map<string, V04RecoveryRecord<V04UiDraft, V04Payload>>();
    for (const record of [
      ...recoveryRecordsAwaitingConfirmationRef.current,
      ...(prompt?.records ?? []),
    ]) records.set(recoveryRecordKey(record), record);
    if (recoveryIdentityRef.current) {
      const activeRecord = readV04Recovery<V04UiDraft, V04Payload>(storage, recoveryIdentityRef.current);
      if (activeRecord?.dirtyTargets.length) records.set(recoveryRecordKey(activeRecord), activeRecord);
    }
    if (!records.size) {
      setRecoveryIntegrity(false);
      return true;
    }
    const candidates = [...records.values()];
    const clearance = atomicallyClearConfirmedV04RecoveryRecords(
      candidates,
      (record) => recoveryRecordIsConfirmed(record, server),
      (record) => clearV04Recovery(storage, record.identity),
      (record) => writeV04Recovery(storage, record),
    );
    if (clearance === "CLEARED") {
      recoveryRecordsAwaitingConfirmationRef.current = [];
      recoveryPromptRef.current = null;
      setRecoveryPrompt(null);
      setRecoveryStorageAvailable(true);
      setRecoveryIntegrity(false);
      return true;
    }
    if (clearance === "STORAGE_FAILED") {
      setRecoveryStorageAvailable(false);
      setRecoveryIntegrity(true);
    }
    const selected = prompt?.record;
    const selectedIndex = selected ? Math.max(0, candidates.findIndex((record) => recoveryRecordKey(record) === recoveryRecordKey(selected))) : 0;
    const record = candidates[selectedIndex] ?? candidates[0];
    const decision = decideV04Recovery(record, {
      revision: server.draftRevision,
      hash: server.draftContentHash,
    });
    const nextPrompt: RecoveryPrompt = {
      kind: decision.kind === "RESTORE_AVAILABLE" ? "RESTORE_AVAILABLE" : "CONFLICT",
      record,
      records: candidates,
      selectedIndex,
      comparing: true,
    };
    recoveryPromptRef.current = nextPrompt;
    setRecoveryPrompt(nextPrompt);
    return false;
  }, [recoveryRecordIsConfirmed, setRecoveryIntegrity]);

  const synchronizeCleanServerDraft = useCallback((server: V04ServerWorkspaceModel) => {
    const serverDraft = v04WorkspaceToUiCase(server).draft;
    draftBasePayloadRef.current = structuredClone(server.payload);
    draftBaseRevisionRef.current = server.draftRevision;
    draftBaseHashRef.current = server.draftContentHash;
    draftRef.current = serverDraft;
    setDraftState(serverDraft);
    editVersionRef.current = 0;
    saveCoordinatorRef.current.resetFromServer(0);
    changeSetIdsRef.current.clear();
    dispatchSaveState({
      type: "RESET_FROM_SERVER",
      savedAt: server.lastSavedAt ?? new Date().toISOString(),
    });
  }, [dispatchSaveState]);

  const reconcileFreshWorkspace = useCallback((
    previous: V04ServerWorkspaceModel,
    fresh: V04ServerWorkspaceModel,
    recoveryPending = Boolean(recoveryPromptRef.current),
  ) => {
    const decision = decideV04FreshWorkspaceTransition({
      facts: { ...localDraftFacts(), recoveryPending },
      base: {
        revision: draftBaseRevisionRef.current ?? previous.draftRevision,
        hash: draftBaseHashRef.current ?? previous.draftContentHash,
      },
      fresh: {
        revision: fresh.draftRevision,
        hash: fresh.draftContentHash,
      },
    });
    if (decision === "SYNC_SERVER") {
      synchronizeCleanServerDraft(fresh);
      return decision;
    }
    if (decision === "PRESERVE_LOCAL_COMPARE") {
      const record = persistRecovery(
        draftRef.current,
        fresh,
        draftBasePayloadRef.current ?? previous.payload,
      );
      if (record) {
        const prompt: RecoveryPrompt = {
          kind: "CONFLICT",
          record,
          records: [record],
          selectedIndex: 0,
          comparing: true,
        };
        recoveryPromptRef.current = prompt;
        setRecoveryPrompt(prompt);
      }
      setActionError("服务器工作稿已更新；本地内容保持不变。请先对照服务器版本，系统不会自动覆盖任何一方。");
    }
    return decision;
  }, [localDraftFacts, persistRecovery, synchronizeCleanServerDraft]);

  const loadWorkspace = useCallback(() => runV04WithTimeout((signal) =>
    v04UiApi.workspace<V04ServerWorkspaceModel>(videoId, tabToken.current, signal)), [videoId]);

  const refreshWorkspace = useCallback(async () => {
    const next = await loadWorkspace();
    setModel(next);
    return next;
  }, [loadWorkspace, setModel]);

  const acquireLease = useCallback(async (current: V04ServerWorkspaceModel) => {
    if (current.logicalEmpty) {
      await runV04WithTimeout((signal) =>
        v04UiApi.materialize(videoId, {}, materializeKeyRef.current, signal));
      current = await refreshWorkspace();
      migrateRecoveryIdentity(current);
    }
    if (leaseProof.current) {
      try {
        await runV04WithTimeout((signal) =>
          v04UiApi.heartbeatLease(videoId, leaseProof.current!, signal));
        return leaseProof.current;
      } catch (reason) {
        if (!(reason instanceof V04UiApiError) || !isV04LeaseFailure(reason.code)) throw reason;
        clearLeaseProof();
        current = await refreshWorkspace();
        if (reason.code === "LEASE_HELD_BY_OTHER" && !canRecoverV04LeaseProof(current.viewerCapabilities)) {
          throw reason;
        }
      }
    }
    if (!current.viewerCapabilities.canAcquireLease && !current.viewerCapabilities.canEdit && !current.logicalEmpty) {
      throw new V04UiApiError(423, "LEASE_HELD_BY_OTHER", "当前工作稿正由另一个编辑端维护。");
    }
    const result = await runV04WithTimeout((signal) => v04UiApi.acquireLease<LeaseResult>(videoId, {
      tabToken: tabToken.current,
    }, signal));
    leaseProof.current = { tabToken: tabToken.current, leaseToken: result.leaseToken, leaseVersion: result.leaseVersion };
    setWorkspaceLeaseProof(videoId, leaseProof.current);
    const refreshed = await refreshWorkspace();
    migrateRecoveryIdentity(refreshed);
    return leaseProof.current;
  }, [clearLeaseProof, migrateRecoveryIdentity, refreshWorkspace, setWorkspaceLeaseProof, videoId]);

  const requestEditAccess = useCallback((
    known?: V04ServerWorkspaceModel,
    options?: { initialRecoveryPending?: boolean },
  ) => {
    if (editAccessAttemptRef.current) return editAccessAttemptRef.current;
    const operation = (async () => {
      setEditAccessPending(true);
      try {
        const current = known ?? await refreshWorkspace();
        reconcileFreshWorkspace(
          current,
          current,
          options?.initialRecoveryPending ?? Boolean(recoveryPromptRef.current),
        );
        if (current.logicalEmpty && current.viewerCapabilities.canMaterialize) {
          setEditAccessNotice("");
          return true;
        }
        if (!canRecoverV04LeaseProof(current.viewerCapabilities)) {
          setEditAccessNotice(current.lease
            ? "工作稿当前由另一编辑端维护；本页已保护为只读。租约释放或到期后会自动重试。"
            : "当前身份暂未取得编辑权；本页已保护为只读，系统会继续安全重试。");
          return false;
        }
        await acquireLease(current);
        const fresh = modelRef.current ?? current;
        reconcileFreshWorkspace(
          current,
          fresh,
          options?.initialRecoveryPending ?? Boolean(recoveryPromptRef.current),
        );
        setEditAccessNotice("");
        return true;
      } catch (reason) {
        const apiError = reason instanceof V04UiApiError ? reason : null;
        if (apiError && isV04LeaseFailure(apiError.code)) clearLeaseProof();
        let refreshed: V04ServerWorkspaceModel | null = null;
        try { refreshed = await refreshWorkspace(); } catch { /* keep the actionable local notice */ }
        if (refreshed) reconcileFreshWorkspace(refreshed, refreshed);
        setEditAccessNotice(refreshed?.lease || apiError?.code === "LEASE_HELD_BY_OTHER"
          ? "工作稿当前由另一编辑端维护；本页已保护为只读。租约释放或到期后会自动重试。"
          : "编辑权尚未取得，可能是网络或租约状态刚刚变化。已保留当前页面，可点击重试。");
        return false;
      } finally {
        setEditAccessPending(false);
      }
    })();
    editAccessAttemptRef.current = operation;
    void operation.finally(() => {
      if (editAccessAttemptRef.current === operation) editAccessAttemptRef.current = null;
    });
    return operation;
  }, [acquireLease, clearLeaseProof, reconcileFreshWorkspace, refreshWorkspace]);

  useEffect(() => {
    let active = true;
    void getWorkspaceSession(videoId).then((session) => {
      if (!active) throw new Error("V04_WORKSPACE_UNMOUNTED");
      tabToken.current = session.tabToken;
      recoveryTabIdRef.current = session.recoveryTabId;
      leaseProof.current = session.leaseProof;
      if (session.identityFailClosed) {
        setDocumentIdentityNotice("标签页隔离能力不可确认，已为当前页面启用独立临时身份；不会复用其他标签页租约，本地恢复副本仍会保留。");
      }
      return loadWorkspace();
    }).then(async (next) => {
      if (!active) return;
      const serverDraft = v04WorkspaceToUiCase(next).draft;
      draftBasePayloadRef.current = structuredClone(next.payload);
      draftBaseRevisionRef.current = next.draftRevision;
      draftBaseHashRef.current = next.draftContentHash;
      draftRef.current = serverDraft;
      setDraftState(serverDraft);
      migrateRecoveryIdentity(next);
      setLoadError("");
      let initialRecoveryPending = false;
      if (typeof window !== "undefined") {
        const identity = recoveryIdentityFor(next);
        const storage = getBrowserStorage("localStorage");
        const discovered = storage ? discoverV04Recoveries<V04UiDraft, V04Payload>(storage, [
          {
            userId: identity.userId,
            workspaceId: identity.workspaceId,
            roundId: identity.roundId,
            payloadSchemaVersion: identity.payloadSchemaVersion,
          },
          {
            userId: identity.userId,
            workspaceId: `logical-${videoId}`,
            roundId: "logical-empty",
            payloadSchemaVersion: identity.payloadSchemaVersion,
          },
        ]) : { available: false as const, records: [] };
        if (!discovered.available) setRecoveryStorageAvailable(false);
        const candidates: Array<{ kind: "RESTORE_AVAILABLE" | "CONFLICT"; record: V04RecoveryRecord<V04UiDraft, V04Payload> }> = [];
        for (const record of discovered.records) {
          const decision = decideV04Recovery(record, {
            revision: next.draftRevision,
            hash: next.draftContentHash,
          });
          if (decision.kind === "SERVER_MATCHES") {
            clearV04Recovery(storage!, record.identity);
          } else if (decision.kind === "RESTORE_AVAILABLE" || decision.kind === "CONFLICT") {
            candidates.push({ kind: decision.kind, record: decision.record });
          }
        }
        if (candidates.length) {
          const prompt: RecoveryPrompt = {
            kind: candidates[0].kind,
            record: candidates[0].record,
            records: candidates.map((candidate) => candidate.record),
            selectedIndex: 0,
            comparing: candidates.length > 1 || candidates[0].kind === "CONFLICT",
          };
          initialRecoveryPending = true;
          recoveryPromptRef.current = prompt;
          setRecoveryPrompt(prompt);
          dispatchSaveState({
            type: "RECOVERY_DISCOVERED",
            conflict: candidates.length > 1 || candidates.some((candidate) => candidate.kind === "CONFLICT"),
            savedAt: next.lastSavedAt ?? "",
          });
        }
      }
      if (!initialRecoveryPending) {
        dispatchSaveState({ type: "SERVER_CONFIRMED", editVersion: 0, savedAt: next.lastSavedAt ?? "" });
      }
      setModel(next);
      // A logical empty workspace is a read-only projection until the first
      // actual save. The save path materializes it atomically before leasing.
      if (!next.logicalEmpty) await requestEditAccess(next, { initialRecoveryPending });
    }).catch((reason: unknown) => {
      if (active) setLoadError(reason instanceof V04UiApiError ? reason.message : "公共工作稿暂时无法读取。");
    });
    return () => { active = false; };
  }, [dispatchSaveState, getWorkspaceSession, loadWorkspace, migrateRecoveryIdentity, recoveryIdentityFor, requestEditAccess, setModel, videoId]);

  const commitSaveAttempt = useCallback(async (attempt: { version: number; draft: V04StagedDraft }) => {
    if (restoreInFlightRef.current) return false;
    const initial = modelRef.current;
    if (!initial) return false;
    let current: V04ServerWorkspaceModel = initial;
    const requestToken = ++requestTokenRef.current;
    dispatchSaveState({ type: "SAVE_STARTED", requestToken, editVersion: attempt.version });
    setActionError("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      dispatchSaveState({ type: "SAVE_OFFLINE", requestToken });
      setActionError(v04SaveFailureMessage("NETWORK_ERROR"));
      return false;
    }
    const changeSetId = changeSetIdsRef.current.get(attempt.version) ??
      `change-${videoId}-${tabToken.current}-${attempt.version}-${crypto.randomUUID()}`;
    changeSetIdsRef.current.set(attempt.version, changeSetId);
    const originalPayload = v04UiDraftToPayload(attempt.draft.draft, attempt.draft.basePayload);
    const originalChanges = v04PayloadChanges(attempt.draft.basePayload, originalPayload);
    try {
      let result: SaveResult | null = null;
      result = await runV04LeaseBoundMutationWithSingleRecovery({
        run: async () => {
          const proof = await acquireLease(current);
          const server = modelRef.current!;
          const plan = planV04ThreeWayChanges(
            originalChanges,
            (targetKey) => v04PayloadTargetValue(server.payload, targetKey),
          );
          if (plan.conflicts.length) {
            throw new V04UiApiError(409, "REVISION_CONFLICT", "服务器工作稿已更新，本地草稿未覆盖冲突字段。");
          }
          const changes = plan.changes;
          if (!changes.length) return null;
          return runV04WithTimeout((signal) => v04UiApi.save<SaveResult>(videoId, {
            expectedRevision: server.draftRevision,
            expectedHash: server.draftContentHash,
            changeSetId,
            changes,
            lease: proof,
          }, tabToken.current, signal));
        },
        leaseFailureCode: (reason) => reason instanceof V04UiApiError && isV04LeaseFailure(reason.code)
          ? reason.code
          : null,
        invalidate: clearLeaseProof,
        canReacquire: async (code) => {
          current = await refreshWorkspace();
          return code !== "LEASE_HELD_BY_OTHER" || canRecoverV04LeaseProof(current.viewerCapabilities);
        },
      });
      const updated = await refreshWorkspace();
      migrateRecoveryIdentity(updated);
      const confirmation = classifyV04RecoveryConfirmation(
        originalChanges,
        (targetKey) => v04PayloadTargetValue(updated.payload, targetKey),
      );
      if (confirmation !== "CONFIRMED") {
        throw new V04UiApiError(
          confirmation === "CONFLICT" ? 409 : 503,
          confirmation === "CONFLICT" ? "REVISION_CONFLICT" : "SAVE_CONFIRMATION_FAILED",
          "服务器尚未确认最新草稿内容，本地恢复副本保持不变。",
        );
      }
      const savedTime = updated.lastSavedAt ?? result?.savedAt ?? new Date().toISOString();
      dispatchSaveState({ type: "SAVE_SUCCEEDED", requestToken, editVersion: attempt.version, savedAt: savedTime });
      changeSetIdsRef.current.delete(attempt.version);
      if (editVersionRef.current === attempt.version) {
        draftBasePayloadRef.current = structuredClone(updated.payload);
        draftBaseRevisionRef.current = updated.draftRevision;
        draftBaseHashRef.current = updated.draftContentHash;
        const serverDraft = v04WorkspaceToUiCase(updated).draft;
        draftRef.current = serverDraft;
        setDraftState(serverDraft);
        reconcileConfirmedRecoveries(updated);
      } else {
        persistRecovery(draftRef.current, updated, attempt.draft.basePayload);
      }
      return true;
    } catch (reason) {
      const apiError = reason instanceof V04UiApiError
        ? reason
        : new V04UiApiError(500, "SAVE_FAILED", "保存失败。");
      if (isV04LeaseFailure(apiError.code)) {
        clearLeaseProof();
      }
      if (isV04LeaseFailure(apiError.code) || apiError.code === "REVISION_CONFLICT") {
        try {
          const refreshed = await refreshWorkspace();
          reconcileFreshWorkspace(refreshed, refreshed);
        } catch { /* keep the local recovery copy */ }
      }
      if (apiError.code === "REVISION_CONFLICT") {
        dispatchSaveState({ type: "SAVE_CONFLICT", requestToken });
      } else if (apiError.code === "NETWORK_ERROR") {
        dispatchSaveState({ type: "SAVE_OFFLINE", requestToken });
      } else {
        dispatchSaveState({
          type: "SAVE_FAILED",
          requestToken,
          retryable: apiError.retryable || isV04LeaseFailure(apiError.code),
          errorCode: apiError.code,
        });
      }
      setActionError(v04SaveFailureMessage(apiError.code));
      return false;
    }
  }, [acquireLease, clearLeaseProof, dispatchSaveState, migrateRecoveryIdentity, persistRecovery, reconcileConfirmedRecoveries, reconcileFreshWorkspace, refreshWorkspace, videoId]);

  const requestSave = useCallback((nextDraft = cloneV04UiDraft(draftRef.current), version = editVersionRef.current) => {
    const basePayload = draftBasePayloadRef.current ?? modelRef.current?.payload;
    if (!basePayload) return Promise.resolve(false);
    saveCoordinatorRef.current.stage({
      version,
      draft: { draft: cloneV04UiDraft(nextDraft), basePayload: structuredClone(basePayload) },
    });
    return saveCoordinatorRef.current.flush(commitSaveAttempt);
  }, [commitSaveAttempt]);

  const guardWorkspaceNavigation = useCallback(async (navigate: () => void, href = "") => {
    setNavigating(true);
    setNavigationIssue(null);
    const coordinator = ensureV04NavigationCoordinator(navigationCoordinatorRef.current);
    navigationCoordinatorRef.current = coordinator;
    try {
      const result = await runV04SubmissionAwareNavigation({
        pendingSubmission: submitInFlightRef.current,
        runNavigation: () => coordinator.run({
          facts: localDraftFacts,
          preserveRecovery: () => { persistRecovery(draftRef.current); },
          flush: () => requestSave(cloneV04UiDraft(draftRef.current), editVersionRef.current),
          navigate,
          navigationKey: href || "UPDATE_RELOAD",
        }),
      });
      const message = v04NavigationFailureMessage(result);
      if (message) {
        setActionError(message);
        setNavigationIssue({ message, href });
      } else if (result === "NAVIGATED") {
        setNavigationIssue(null);
      }
      return result;
    } finally {
      if (!coordinator.isRunning) setNavigating(false);
    }
  }, [localDraftFacts, persistRecovery, requestSave]);

  useEffect(() => {
    return installV04NavigationTakeover(window, HOME_NAVIGATION_EVENT, {
      // This is synchronous and precedes every await. Even a browser/process
      // interruption leaves the newest local edit discoverable after reload.
      preserveRecovery: () => { persistRecovery(draftRef.current); },
      run: (navigate) => { void guardWorkspaceNavigation(navigate); },
    });
  }, [guardWorkspaceNavigation, persistRecovery]);

  useEffect(() => {
    // React development Strict Mode may run an effect cleanup/setup cycle
    // without rebuilding refs. Replace the disposed coordinator on each setup
    // while keeping the prior generation cancelled against late navigation.
    const coordinator = new V04GuardedNavigationCoordinator();
    navigationCoordinatorRef.current = coordinator;
    return () => navigationCoordinatorRef.current.dispose();
  }, []);

  const resumeDraft = useCallback((forceAcquire = false) => resumeCoordinatorRef.current.run(() =>
    runV04DraftResume({
      facts: localDraftFacts,
      forceAcquire,
      acquire: () => requestEditAccess(),
      hasRecoveryConflict: () => recoveryPromptRef.current?.kind === "CONFLICT",
      flush: () => requestSave(cloneV04UiDraft(draftRef.current), editVersionRef.current),
    })), [localDraftFacts, requestEditAccess, requestSave]);

  useEffect(() => {
    if (!model || hasDraftEditCapability || submitting || restoring) return;
    const plan = planV04EditAccessRecovery({
      logicalEmpty: model.logicalEmpty,
      canMaterialize: model.viewerCapabilities.canMaterialize,
      canEdit: model.viewerCapabilities.canEdit,
      canAcquireLease: model.viewerCapabilities.canAcquireLease,
      member: model.viewerCapabilities.roles.member,
      leaseExpiresAt: model.lease?.expiresAt ?? null,
    });
    if (plan.retryAfterMs === null) return;
    const timer = window.setTimeout(() => {
      void resumeDraft(true).then((recovered) => {
        if (!recovered) setEditAccessRetryVersion((version) => version + 1);
      });
    }, plan.retryAfterMs);
    return () => window.clearTimeout(timer);
  }, [editAccessRetryVersion, hasDraftEditCapability, model, restoring, resumeDraft, submitting]);

  useEffect(() => {
    if (saveMachine.status !== "DIRTY" || recoveryPending) return;
    const timer = window.setTimeout(() => {
      void requestSave(cloneV04UiDraft(draftRef.current), editVersionRef.current);
    }, V04_AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [recoveryPending, requestSave, saveMachine.status, saveMachine.editVersion]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const proof = leaseProof.current;
      if (!proof || saveCoordinatorRef.current.isRunning) return;
      void runV04WithTimeout((signal) => v04UiApi.heartbeatLease(videoId, proof, signal))
        .catch(async (reason) => {
          const apiError = reason instanceof V04UiApiError ? reason : null;
          if (!apiError || !isV04LeaseFailure(apiError.code)) {
            setActionError(v04SaveFailureMessage(apiError?.code ?? "NETWORK_ERROR"));
            return;
          }
          clearLeaseProof();
          setActionError(v04SaveFailureMessage(apiError.code));
          try { await resumeDraft(true); } catch { /* the visible recovery/error state remains authoritative */ }
        });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [clearLeaseProof, resumeDraft, videoId]);

  useEffect(() => {
    const protectOrRelease = () => {
      const proof = leaseProof.current;
      if (shouldProtectV04Unload(localDraftFacts())) {
        persistRecovery(draftRef.current);
        return;
      }
      if (proof && shouldReleaseV04Lease({
        saveStatus: saveMachineRef.current.status,
        saveInFlight: saveCoordinatorRef.current.isRunning,
        editVersion: editVersionRef.current,
        savedVersion: saveCoordinatorRef.current.savedVersion,
      })) v04UiApi.releaseLeaseKeepalive(videoId, proof, tabToken.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        const facts = localDraftFacts();
        if (shouldProtectV04Unload(facts)) {
          persistRecovery(draftRef.current);
          if (shouldRetryV04DraftOnResume(facts)) {
            void requestSave(cloneV04UiDraft(draftRef.current), editVersionRef.current);
          }
        } else {
          protectOrRelease();
        }
      } else {
        void resumeDraft(true);
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldProtectV04Unload(localDraftFacts())) return;
      persistRecovery(draftRef.current);
      event.preventDefault();
      event.returnValue = "";
    };
    const onOnline = () => { void resumeDraft(); };
    const onHistoryTraversal = () => {
      if (shouldProtectV04Unload(localDraftFacts())) persistRecovery(draftRef.current);
    };
    window.addEventListener("pagehide", protectOrRelease);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("online", onOnline);
    window.addEventListener("popstate", onHistoryTraversal);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", protectOrRelease);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("popstate", onHistoryTraversal);
      document.removeEventListener("visibilitychange", onVisibility);
      protectOrRelease();
    };
  }, [localDraftFacts, persistRecovery, requestSave, resumeDraft, videoId]);

  const updateDraft = (mutate: (next: V04UiDraft) => void) => {
    if (!canEdit) return;
    const next = cloneV04UiDraft(draftRef.current);
    mutate(next);
    draftRef.current = next;
    setDraftState(next);
    editVersionRef.current += 1;
    dispatchSaveState({ type: "EDIT" });
    persistRecovery(next);
    saveCoordinatorRef.current.stage({
      version: editVersionRef.current,
      draft: {
        draft: cloneV04UiDraft(next),
        basePayload: structuredClone(draftBasePayloadRef.current ?? modelRef.current!.payload),
      },
    });
    setActionError("");
    setSubmitted(false);
  };

  const manualSave = async () => {
    if (decideV04ManualSave(localDraftFacts()) === "BLOCK_RECOVERY") {
      setActionError("当前存在未吸收或冲突的本地恢复副本；请先在恢复区选择要保存的草稿，系统不会保存另一份稿件。 ");
      document.querySelector<HTMLElement>('[aria-label="本地草稿恢复"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (!canEdit) return;
    const active = document.activeElement as HTMLElement | null;
    const context = focusContext.current?.element === active
      ? focusContext.current
      : active?.matches("input,textarea")
        ? { element: active, scrollY: window.scrollY }
        : focusContext.current ?? { element: active ?? document.body, scrollY: window.scrollY };
    const saving = requestSave(cloneV04UiDraft(draftRef.current), editVersionRef.current);
    const restore = () => {
      window.scrollTo({ top: context.scrollY, behavior: "auto" });
      if (context.element.isConnected && context.element !== document.body) context.element.focus({ preventScroll: true });
    };
    restore();
    requestAnimationFrame(() => requestAnimationFrame(restore));
    window.setTimeout(restore, 320);
    window.setTimeout(restore, 720);
    await saving;
    restore();
  };

  const navigateWithSavedDraft = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void guardWorkspaceNavigation(() => router.push(href), href);
  };

  const updateGroup = (groupId: string, updater: (group: V04UiShotGroup) => void) => updateDraft((next) => { const group = next.shotGroups.find((entry) => entry.id === groupId); if (group) updater(group); });
  const updateChoice = (field: "primaryMechanism" | "auxiliaryMechanism" | "storyReference", value: V04ChoiceValue) => updateDraft((next) => { next[field] = value; });
  const locate = (id: string) => {
    const moduleNumber = id === "module-2" || id.startsWith("field-") && !id.startsWith("field-path-") && !/^field-aux-(LOVE|FUN|PERCEPTION)-/.test(id)
      ? 2
      : id === "module-3" || id.startsWith("field-path-") || id.startsWith("field-aux-")
        ? 3
        : null;
    if (moduleNumber) setCollapsed((current) => {
      if (!current.has(moduleNumber)) return current;
      const next = new Set(current);
      next.delete(moduleNumber);
      return next;
    });
    window.requestAnimationFrame(() => { void locateV04Target(id); });
  };
  useEffect(() => {
    if (!pendingLocateId) return;
    let active = true;
    window.requestAnimationFrame(() => {
      if (!active) return;
      void locateV04Target(pendingLocateId).finally(() => {
        if (active) setPendingLocateId(null);
      });
    });
    return () => { active = false; };
  }, [pendingLocateId, draft.shotGroups]);
  const addFirstGroup = () => {
    const id = `bridge-${crypto.randomUUID()}`;
    updateDraft((next) => { next.shotGroups.push({ id, title: "", primaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION }, auxiliaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION }, creativeDescription: "", shots: [blankV04Shot(`shot-${crypto.randomUUID()}`)] }); });
    setPendingLocateId(`group-${id}`);
  };
  const addShot = (groupId: string) => {
    localIdSequence.current += 1;
    const next = blankV04Shot(`shot-${localIdPrefix}-${localIdSequence.current}`);
    next.startTime = nextV04Timecode(draft.shotGroups.flatMap((entry) => entry.shots).at(-1)?.endTime ?? "");
    updateGroup(groupId, (group) => { group.shots.push(next); });
    setPendingLocateId(`shot-${next.id}`);
  };
  const addGroupAfter = (groupId: string) => {
    localIdSequence.current += 1;
    const id = `bridge-${localIdPrefix}-${localIdSequence.current}`;
    updateDraft((next) => { const index = next.shotGroups.findIndex((group) => group.id === groupId); next.shotGroups.splice(index + 1, 0, { id, title: "", primaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION }, auxiliaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION }, creativeDescription: "", shots: [blankV04Shot(`shot-${id}-01`)] }); });
    setPendingLocateId(`group-${id}`);
  };
  const moveShotBy = (shotId: string, delta: number) => {
    updateDraft((next) => { const group = next.shotGroups.find((entry) => entry.shots.some((shot) => shot.id === shotId)); if (!group) return; const index = group.shots.findIndex((shot) => shot.id === shotId); next.shotGroups = moveV04Shot(next.shotGroups, shotId, group.id, index + delta); });
    setPendingLocateId(`shot-${shotId}`);
  };
  const moveShotTo = (shotId: string, groupId: string) => {
    updateDraft((next) => { const target = next.shotGroups.find((group) => group.id === groupId); if (!target) return; next.shotGroups = moveV04Shot(next.shotGroups, shotId, groupId, target.shots.length); });
    setPendingLocateId(`shot-${shotId}`);
  };
  const toggleModule = (number: number) => setCollapsed((current) => { const next = new Set(current); if (next.has(number)) next.delete(number); else next.add(number); return next; });
  const effectiveSaveStatus = effectiveV04SaveStatus({
    saveStatus: saveMachine.status,
    saveInFlight: saveMachine.status === "SAVING",
    editVersion: saveMachine.editVersion,
    savedVersion: saveMachine.savedEditVersion,
    recoveryPending,
  });
  const saveLabel = recoveryPending ? recoveryIntegrityBlocked
    ? "未确认保存 · 本机恢复副本尚未安全清理"
    : `未确认保存 · ${recoveryPrompt?.records.length ?? 1} 份本地恢复副本待处理`
    : navigating ? "正在保存最新修改后离开…"
    : restoring ? "正在恢复历史版本…草稿编辑已暂时锁定"
    : submitting ? "正在保存并提交当前版本…草稿编辑已暂时锁定"
    : effectiveSaveStatus === "DIRTY" ? "有未保存修改"
    : effectiveSaveStatus === "SAVING" ? "正在保存…"
      : effectiveSaveStatus === "OFFLINE_LOCAL" ? "已保留本地副本 · 等待网络"
        : effectiveSaveStatus === "CONFLICT" ? "已保留本地副本 · 需对照"
          : effectiveSaveStatus === "ERROR_RETRYABLE" ? "保存未完成 · 可重试"
            : effectiveSaveStatus === "ERROR_FATAL" ? "保存被阻止 · 请处理"
              : `已保存${saveMachine.savedAt || model?.lastSavedAt ? ` · ${saveMachine.savedAt || model?.lastSavedAt}` : ""}`;
  const visibleSaveLabel = recoveryPending
    ? saveLabel
    : !hasDraftEditCapability
    ? editAccessPending ? "正在取得编辑权…" : "只读 · 编辑权未取得"
    : saveLabel;

  const submitDraft = () => {
    if (!canEdit || restoreInFlightRef.current) return null;
    if (submitInFlightRef.current) return submitInFlightRef.current;
    const operation = (async () => {
      setSubmitting(true);
      setActionError("");
      try {
        if (recoveryPromptRef.current || recoveryIntegrityBlockedRef.current) {
          const fresh = await refreshWorkspace();
          if (!reconcileConfirmedRecoveries(fresh)) {
            setActionError(RECOVERY_SUBMIT_BLOCKED_MESSAGE);
            setNavigationIssue({ message: RECOVERY_SUBMIT_BLOCKED_MESSAGE, href: "" });
            return false;
          }
          setNavigationIssue(null);
        }
        if (!evaluateV04FixturePublication(draftRef.current).ready) {
          setActionError("请先完成第四模块列出的必填项，再提交。");
          return false;
        }
        let flushPasses = 0;
        let saveCompleted = false;
        do {
          const targetVersion = editVersionRef.current;
          if (!await requestSave(cloneV04UiDraft(draftRef.current), targetVersion)) return false;
          saveCompleted = true;
          flushPasses += 1;
        } while (editVersionRef.current > saveCoordinatorRef.current.savedVersion && flushPasses < 3);
        if (editVersionRef.current > saveCoordinatorRef.current.savedVersion) {
          setActionError("你仍在输入新内容；请结束输入后再点击提交，已填内容仍保留。");
          return false;
        }
        const current = modelRef.current;
        if (!current) return false;
        const serverPublication = evaluateV04FixturePublication(v04WorkspaceToUiCase(current).draft);
        if (!canSubmitV04ServerDraft({
          localPublicationReady: evaluateV04FixturePublication(draftRef.current).ready,
          serverPublicationReady: serverPublication.ready,
          saveCompleted,
          editVersion: editVersionRef.current,
          savedVersion: saveCoordinatorRef.current.savedVersion,
        })) {
          setActionError("服务器复核发现仍有必填项未保存；本地内容已保留，请重试保存后再提交。");
          return false;
        }
        const proof = await acquireLease(current);
        const source = modelRef.current!;
        const sourceKey = `${source.draftRevision}:${source.draftContentHash}`;
        const idempotencyKey = submitKeysRef.current.get(sourceKey) ??
          `submission-${videoId}-${tabToken.current}-${source.draftRevision}-${crypto.randomUUID()}`;
        submitKeysRef.current.set(sourceKey, idempotencyKey);
        await runV04WithTimeout((signal) => v04UiApi.submit(videoId, {
          expectedDraftRevision: source.draftRevision,
          expectedDraftHash: source.draftContentHash,
          lease: proof,
        }, idempotencyKey, tabToken.current, signal));
        const refreshed = await refreshWorkspace();
        if (editVersionRef.current === saveCoordinatorRef.current.savedVersion) {
          const serverDraft = v04WorkspaceToUiCase(refreshed).draft;
          draftBasePayloadRef.current = structuredClone(refreshed.payload);
          draftBaseRevisionRef.current = refreshed.draftRevision;
          draftBaseHashRef.current = refreshed.draftContentHash;
          draftRef.current = serverDraft;
          setDraftState(serverDraft);
          saveCoordinatorRef.current.markServerConfirmed(editVersionRef.current);
          dispatchSaveState({
            type: "SERVER_CONFIRMED",
            editVersion: editVersionRef.current,
            savedAt: refreshed.lastSavedAt ?? new Date().toISOString(),
          });
          reconcileConfirmedRecoveries(refreshed);
        } else {
          persistRecovery(draftRef.current, refreshed);
        }
        setSubmitted(true);
        setActionError("");
        return true;
      } catch (reason) {
        const apiError = reason instanceof V04UiApiError ? reason : null;
        if (apiError && isV04LeaseFailure(apiError.code)) {
          clearLeaseProof();
          try { await refreshWorkspace(); } catch { /* preserve local recovery */ }
        }
        setActionError(v04SaveFailureMessage(apiError?.code ?? "SUBMIT_FAILED"));
        return false;
      } finally {
        setSubmitting(false);
      }
    })();
    submitInFlightRef.current = operation;
    void operation.finally(() => {
      if (submitInFlightRef.current === operation) submitInFlightRef.current = null;
    });
    return operation;
  };
  const submitDisabled = shouldDisableV04Submission({
    canEdit,
    publicationReady: publication.ready,
    submitting,
    recoveryPending,
    noChangesToSubmit: Boolean((saveMachine.status === "SAVED" || saveMachine.status === "CLEAN") &&
      model?.latestSubmission?.contentHash === model?.draftContentHash),
  });
  const submitActionProps = {
    type: "button" as const,
    disabled: submitDisabled,
    onClick: () => { void submitDraft(); },
  };

  const restoreVersion = async (source: { sourceType: "BASELINE" | "WORKING" | "SUBMISSION"; sourceId: string }) => {
    if (!canEdit) return;
    if (restoreInFlightRef.current) return restoreInFlightRef.current;
    if (!canStartV04Restore({
      saveStatus: saveMachineRef.current.status,
      saveInFlight: saveCoordinatorRef.current.isRunning,
      submitting: submitting || Boolean(submitInFlightRef.current),
      restoring: Boolean(restoreInFlightRef.current),
      editVersion: editVersionRef.current,
      savedVersion: saveCoordinatorRef.current.savedVersion,
    })) {
      persistRecovery(draftRef.current);
      setActionError("当前仍有未确认修改或保存/提交正在进行。请先保存成功；本地恢复副本已保留，历史恢复尚未执行。");
      return;
    }
    const current = modelRef.current;
    if (!current) return;
    const sourceKey = `${source.sourceType}:${source.sourceId}`;
    const idempotencyKey = restoreKeysRef.current.get(sourceKey) ??
      `restore-${videoId}-${tabToken.current}-${crypto.randomUUID()}`;
    restoreKeysRef.current.set(sourceKey, idempotencyKey);
    const operation = (async () => {
      setRestoring(true);
      setActionError("");
      try {
        const proof = await acquireLease(current);
        await runV04WithTimeout((signal) => v04UiApi.restore(videoId, {
          ...source, reason: "从历史版本创建恢复稿", lease: proof,
        }, idempotencyKey, tabToken.current, signal));
        const refreshed = await refreshWorkspace();
        const serverDraft = v04WorkspaceToUiCase(refreshed).draft;
        draftRef.current = serverDraft;
        setDraftState(serverDraft);
        draftBasePayloadRef.current = structuredClone(refreshed.payload);
        draftBaseRevisionRef.current = refreshed.draftRevision;
        draftBaseHashRef.current = refreshed.draftContentHash;
        editVersionRef.current = 0;
        saveCoordinatorRef.current.resetFromServer(0);
        changeSetIdsRef.current.clear();
        dispatchSaveState({
          type: "RESET_FROM_SERVER",
          savedAt: refreshed.lastSavedAt ?? new Date().toISOString(),
        });
        if (typeof window !== "undefined" && recoveryIdentityRef.current) {
          clearRecoveryRecord(recoveryIdentityRef.current);
        }
        restoreKeysRef.current.delete(sourceKey);
        setHistory(false);
      } catch (reason) {
        persistRecovery(draftRef.current);
        setActionError(reason instanceof V04UiApiError
          ? v04SaveFailureMessage(reason.code)
          : "历史恢复未完成，本地草稿已保留，可使用同一请求安全重试。");
      } finally {
        setRestoring(false);
      }
    })();
    restoreInFlightRef.current = operation;
    void operation.finally(() => {
      if (restoreInFlightRef.current === operation) restoreInFlightRef.current = null;
    });
    return operation;
  };

  const setExpertPreference = async (grade: "S" | "A" | "B" | "C") => {
    if (!canEdit) return;
    const submissionId = modelRef.current?.latestSubmission?.id;
    if (!submissionId) return;
    try {
      await v04UiApi.grantExpertPreference(videoId, submissionId, { grade, reason: "专家在公共工作稿中优选" }, `expert-${videoId}-${crypto.randomUUID()}`);
      await refreshWorkspace();
    } catch (reason) {
      setActionError(reason instanceof V04UiApiError ? reason.message : "专家优选未完成。");
    }
  };

  const withdrawExpertPreference = async () => {
    if (!canEdit) return;
    if (!modelRef.current?.expertPreference) return;
    try {
      await v04UiApi.withdrawExpertPreference(videoId, { reason: "专家撤回当前优选" }, `expert-withdraw-${videoId}-${crypto.randomUUID()}`);
      await refreshWorkspace();
    } catch (reason) {
      setActionError(reason instanceof V04UiApiError ? reason.message : "撤回专家优选未完成。");
    }
  };

  const finalizeRecoveredDraft = (current: V04ServerWorkspaceModel) => {
    draftBasePayloadRef.current = structuredClone(current.payload);
    draftBaseRevisionRef.current = current.draftRevision;
    draftBaseHashRef.current = current.draftContentHash;
    editVersionRef.current += 1;
    dispatchSaveState({ type: "EDIT" });
    const aggregate = persistRecovery(draftRef.current, current, current.payload);
    if (!aggregate) {
      setRecoveryIntegrity(true);
      const records = recoveryRecordsAwaitingConfirmationRef.current;
      if (records.length) {
        const prompt: RecoveryPrompt = {
          kind: "CONFLICT",
          record: records[0],
          records,
          selectedIndex: 0,
          comparing: true,
        };
        recoveryPromptRef.current = prompt;
        setRecoveryPrompt(prompt);
      }
      setActionError("恢复稿已保留在当前页面，但本机副本未能安全写入；保存保持阻止，请勿关闭页面。 ");
      return false;
    }
    recoveryRecordsAwaitingConfirmationRef.current.push(aggregate);
    saveCoordinatorRef.current.stage({
      version: editVersionRef.current,
      draft: { draft: cloneV04UiDraft(draftRef.current), basePayload: structuredClone(current.payload) },
    });
    recoveryPromptRef.current = null;
    setRecoveryPrompt(null);
    setRecoveryIntegrity(false);
    setActionError("已安全合并所选本地草稿；服务器的非冲突变化已保留，等待正常自动保存。 ");
    return true;
  };

  const restoreLocalRecovery = () => {
    if (!recoveryPrompt) return;
    try {
      const current = modelRef.current;
      const basePayload = recoveryPrompt.record.basePayload;
      if (!current || !basePayload) {
        setRecoveryPrompt((prompt) => prompt ? { ...prompt, comparing: true } : null);
        setActionError("该旧恢复副本缺少安全三方合并依据，只能对照，不能自动保存或覆盖服务器。");
        return;
      }
      const recoveredPayload = v04UiDraftToPayload(recoveryPrompt.record.payload, basePayload);
      const originalChanges = v04PayloadChanges(basePayload, recoveredPayload);
      const activePayload = v04UiDraftToPayload(draftRef.current, current.payload);
      const plan = planV04RecoveryMerge(
        originalChanges,
        (targetKey) => v04PayloadTargetValue(current.payload, targetKey),
        (targetKey) => v04PayloadTargetValue(activePayload, targetKey),
      );
      if (plan.kind !== "MERGE") {
        const nextPrompt = { ...recoveryPrompt, kind: "CONFLICT" as const, comparing: true };
        recoveryPromptRef.current = nextPrompt;
        setRecoveryPrompt(nextPrompt);
        setActionError(`${plan.kind === "SERVER_CONFLICT" ? "服务器" : "另一份本地副本"}已有 ${plan.conflicts.length} 个同字段变化；恢复保持在对照态，未自动保存或覆盖。`);
        return;
      }
      const mergedPayload = applyV04PayloadValues(activePayload, plan.changes);
      const recovered = cloneV04UiDraft(v04WorkspaceToUiCase({ ...current, payload: mergedPayload }).draft);
      draftRef.current = recovered;
      setDraftState(recovered);
      recoveryRecordsAwaitingConfirmationRef.current.push(recoveryPrompt.record);
      const remaining = recoveryPrompt.records.filter((_, index) => index !== recoveryPrompt.selectedIndex);
      if (remaining.length) {
        const record = remaining[0];
        const decision = decideV04Recovery(record, {
          revision: current.draftRevision,
          hash: current.draftContentHash,
        });
        const nextPrompt: RecoveryPrompt = {
          kind: decision.kind === "CONFLICT" ? "CONFLICT" : "RESTORE_AVAILABLE",
          record,
          records: remaining,
          selectedIndex: 0,
          comparing: true,
        };
        recoveryPromptRef.current = nextPrompt;
        setRecoveryPrompt(nextPrompt);
        setActionError(`所选恢复稿已加入待保存草稿；还有 ${remaining.length} 份独立副本，请继续逐份恢复、对照或保留服务器版本。`);
        return;
      }
      finalizeRecoveredDraft(current);
    } catch {
      const nextPrompt = recoveryPromptRef.current ? { ...recoveryPromptRef.current, comparing: true } : null;
      recoveryPromptRef.current = nextPrompt;
      setRecoveryPrompt(nextPrompt);
      setActionError("本地恢复副本无法安全解析；服务器版本保持不变，未自动写入。");
    }
  };

  const keepServerDraft = () => {
    const promptToClear = recoveryPrompt;
    if (!promptToClear) return;
    const result = clearSelectedV04RecoveryRecord(
      promptToClear.records,
      promptToClear.selectedIndex,
      (record) => clearRecoveryRecord(record.identity),
    );
    if (result.status === "STORAGE_FAILED") {
      const message = "本机恢复副本未能安全清理；页面仍保留该副本和对照状态，请重试，提交保持禁用。";
      setActionError(message);
      setNavigationIssue({ message, href: "" });
      return;
    }
    const remaining = result.remaining;
    setRecoveryIntegrity(false);
    if (!remaining.length) {
      recoveryPromptRef.current = null;
      setRecoveryPrompt(null);
      if (recoveryRecordsAwaitingConfirmationRef.current.length && modelRef.current) {
        finalizeRecoveredDraft(modelRef.current);
        setNavigationIssue(null);
        return;
      } else if (!saveCoordinatorRef.current.isRunning && modelRef.current) {
        synchronizeCleanServerDraft(modelRef.current);
      }
    } else {
      const record = remaining[0];
      const current = modelRef.current!;
      const decision = decideV04Recovery(record, {
        revision: current.draftRevision,
        hash: current.draftContentHash,
      });
      const prompt: RecoveryPrompt = {
        kind: decision.kind === "CONFLICT" ? "CONFLICT" : "RESTORE_AVAILABLE",
        record,
        records: remaining,
        selectedIndex: 0,
        comparing: remaining.length > 1 || decision.kind === "CONFLICT",
      };
      recoveryPromptRef.current = prompt;
      setRecoveryPrompt(prompt);
    }
    setNavigationIssue(null);
    setActionError("");
  };

  const selectRecoveryRecord = (selectedIndex: number) => {
    if (!recoveryPrompt || !modelRef.current) return;
    const record = recoveryPrompt.records[selectedIndex];
    if (!record) return;
    const decision = decideV04Recovery(record, {
      revision: modelRef.current.draftRevision,
      hash: modelRef.current.draftContentHash,
    });
    const nextPrompt: RecoveryPrompt = {
      ...recoveryPrompt,
      kind: decision.kind === "CONFLICT" ? "CONFLICT" : "RESTORE_AVAILABLE",
      record,
      selectedIndex,
      comparing: true,
    };
    recoveryPromptRef.current = nextPrompt;
    setRecoveryPrompt(nextPrompt);
  };

  if (loadError) return <main className={styles.surface} data-v04-page="workspace"><section className={styles.emptyState}><h2>公共工作稿读取失败</h2><p>{loadError}</p><Link href={links.libraryHref}>返回案例库</Link></section></main>;
  if (!item || !model) return <main className={styles.surface} data-v04-page="workspace"><section className={styles.emptyState}><h2>正在读取公共工作稿…</h2></section></main>;
  const fixedNavigationIssue = navigationIssue ?? (recoveryPending
    ? { message: RECOVERY_SUBMIT_BLOCKED_MESSAGE, href: "" }
    : null);

  return <main className={styles.surface} data-v04-page="workspace">
    <header className={styles.siteHeader} data-v04-fixed-header><Link href={links.libraryHref} onClick={(event) => navigateWithSavedDraft(event, links.libraryHref)} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link><nav className={styles.siteNav}><span className={styles.headerCaseTitle} data-v04-case-title title={item.title}>{item.title}</span><Link href={links.libraryHref} onClick={(event) => navigateWithSavedDraft(event, links.libraryHref)}>案例库</Link><Link href={links.detailHref} onClick={(event) => navigateWithSavedDraft(event, links.detailHref)}>{links.detailLabel ?? "只读成果"}</Link><Link href={links.workspaceHref} className={styles.activeNav}>{links.workspaceLabel ?? "公共工作稿"}</Link></nav><div className={styles.saveCluster}><span role="status" aria-live="polite">{visibleSaveLabel}</span><button onClick={() => setHistory(true)}>历史</button><button onPointerDown={(event) => event.preventDefault()} onClick={manualSave} disabled={!hasDraftEditCapability || submitting || restoring || navigating}>保存</button><button className={styles.headerSubmit} {...submitActionProps}>提交并更新案例</button></div></header>
    {fixedNavigationIssue && <aside className={styles.navigationAlert} role="alert" aria-live="assertive"><span>{fixedNavigationIssue.message}</span>{(recoveryPrompt || fixedNavigationIssue.href) && <button type="button" disabled={navigating} onClick={() => {
      if (recoveryPromptRef.current) {
        document.querySelector<HTMLElement>('[aria-label="本地草稿恢复"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      if (fixedNavigationIssue.href) void guardWorkspaceNavigation(() => router.push(fixedNavigationIssue.href), fixedNavigationIssue.href);
    }}>{recoveryPrompt ? "处理恢复副本" : navigating ? "正在重试…" : "重试离开"}</button>}</aside>}
    <section className={styles.workspaceStatus} data-viewer-user-id={viewerUserId}><div><b>{recoveryPending ? "本地恢复副本待处理 · 正文暂时只读" : canEdit ? `${viewerName} 正在编辑公共工作稿` : item.activeEditor ? `只读旁观 · ${item.activeEditor} 正在编辑` : editAccessPending ? "当前无人编辑 · 正在安全取得编辑权" : "当前无人编辑 · 编辑权尚未取得"}</b><span>保存写入当前公共工作稿；提交才创建不可变版本，提交不释放编辑权。</span><span role="status" aria-live="polite">{visibleSaveLabel}</span></div><strong>{V04_UI_STATE_LABELS[item.workState]}</strong></section>
    {documentIdentityNotice && <section className={styles.actionError} role="status" aria-live="polite"><p>{documentIdentityNotice}</p></section>}
    {!recoveryStorageAvailable && <section className={styles.actionError} role="status" aria-live="polite"><p>本机恢复副本不可用；编辑仍可继续，请保持页面打开并及时手动保存。</p></section>}
    {recoveryPrompt && <section id="v04-recovery-message" className={styles.recoveryBanner} role="alertdialog" aria-label="本地草稿恢复"><div><b>{recoveryPrompt.kind === "CONFLICT" ? "发现与服务器不同的本地草稿" : "发现未确认保存的本地草稿"}</b><span>写入于 {recoveryPrompt.record.writtenAt}，涉及 {recoveryPrompt.record.dirtyTargets.length} 个稳定内容单元。</span>{recoveryPrompt.records.length > 1 && <><p>发现 {recoveryPrompt.records.length} 份相互独立的标签页恢复副本；不会自动合并或覆盖，请逐份选择。</p><ol>{recoveryPrompt.records.map((record, index) => <li key={`${record.identity.tabId}:${record.writtenAt}`}><button type="button" aria-pressed={index === recoveryPrompt.selectedIndex} onClick={() => selectRecoveryRecord(index)}>{index === 0 ? "最新" : `副本 ${index + 1}`} · {record.writtenAt} · rev {record.serverRevision} · {record.dirtyTargets.length} 项</button></li>)}</ol></>}{recoveryPrompt.comparing && <p>本地草稿基于 rev {recoveryPrompt.record.serverRevision}；当前服务器为 rev {model.draftRevision}。系统只会三方合并未冲突字段；同字段冲突保持对照态且绝不自动保存。</p>}{documentIdentityNotice && <p>当前页面使用隔离的临时文档身份；旧租约不会被强制释放，系统会在其到期后安全重取编辑权，全部副本按当前案例汇总供逐份处理。</p>}</div><div><button type="button" onClick={restoreLocalRecovery}>恢复本地草稿</button><button type="button" onClick={() => setRecoveryPrompt((current) => current ? { ...current, comparing: !current.comparing } : null)}>对照服务器</button><button type="button" onClick={keepServerDraft}>继续使用服务器版本</button></div></section>}
    {actionError && <section className={styles.actionError} role="alert" aria-live="assertive"><p>{actionError}</p>{(saveMachine.status === "ERROR_RETRYABLE" || saveMachine.status === "OFFLINE_LOCAL") && <button type="button" onClick={() => { void requestSave(cloneV04UiDraft(draftRef.current), editVersionRef.current); }}>重试保存</button>}</section>}
    <section className={styles.workspaceTitle}><p>PUBLIC WORKING DRAFT</p><h1>{item.title}</h1><span>四模块 · 逐镜 12 项 · 固定值与自定义值分源保留</span></section>
    <div className={styles.workspaceGrid}>
      <V04WorkspaceNavigation draft={draft} onLocate={locate} />
      <div className={styles.editorColumn}>
        {!hasDraftEditCapability && <section id="v04-edit-access-message" className={styles.editAccessBanner} role="status" aria-live="polite" data-v04-edit-access-blocked><div><b>当前字段为只读</b><span>{editAccessNotice || (item.activeEditor ? "另一编辑端正在维护这份公共工作稿；释放后系统会自动重试。" : "系统正在核对租约状态并安全取得编辑权。")}</span></div><button type="button" disabled={editAccessPending} onClick={() => { void requestEditAccess(); }}>{editAccessPending ? "正在重试…" : "刷新并重试编辑权"}</button></section>}
        <div aria-readonly={!canEdit} aria-describedby={recoveryPending ? "v04-recovery-message" : !hasDraftEditCapability ? "v04-edit-access-message" : undefined} className={`${styles.editorFieldset} ${!canEdit ? styles.readOnlyEditor : ""}`} onFocusCapture={(event) => {
          const element = event.target as HTMLElement;
          if (!element.matches("input,textarea")) return;
          focusContext.current = { element, scrollY: window.scrollY };
          window.setTimeout(() => {
            if (document.activeElement === element) focusContext.current = { element, scrollY: window.scrollY };
          }, 80);
        }}>
          <section className={`${styles.editorModule} ${collapsed.has(1) ? styles.collapsed : ""}`} id="module-1"><header><small>第一模块</small><h2>第一模块｜脚本反写</h2><p>先按桥段组织，再逐镜还原；每个镜头保持 12 项独立科目。</p><button type="button" onClick={() => toggleModule(1)}>{collapsed.has(1) ? "展开" : "收起"}</button></header>{!collapsed.has(1) && <>
            {!draft.shotGroups.length && <div className={styles.bridgeActions}><button type="button" disabled={!canEdit} onClick={addFirstGroup}>＋ 新增第一个桥段</button></div>}
            {draft.shotGroups.map((group, groupIndex) => <article className={`${styles.bridgeCard} ${draggedShotId ? styles.isDropTarget : ""}`} key={group.id} id={`group-${group.id}`} onDragOver={(event) => { if (!canEdit || !draggedShotId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { if (!canEdit || !draggedShotId) return; event.preventDefault(); moveShotTo(draggedShotId, group.id); setDraggedShotId(null); }}>
              <header className={styles.bridgeHeader}><b>桥段 {String(groupIndex + 1).padStart(2, "0")}</b><input id={v04GroupTitleTargetId(group.id)} data-v04-primary-focus aria-label="桥段名称" value={group.title} readOnly={!canEdit} onChange={(event) => updateGroup(group.id, (next) => { next.title = event.target.value; })} placeholder="桥段名称" /></header>
              <div className={styles.bridgeChoices}><V04ChoiceField targetId={v04GroupPrimaryRoleTargetId(group.id)} label="桥段主创意作用" value={group.primaryRole} options={V04_UI_BRIDGE_OPTIONS} customLabel="自定义主创意作用" readOnly={!canEdit} onComment={() => openComment({ targetKey: `shotGroup:${group.id}.primaryCreativeRole`, targetLabel: "桥段主创意作用", moduleLabel: "第一模块｜脚本反写", originalExcerpt: [...group.primaryRole.selectedOptionIds, group.primaryRole.customText].filter(Boolean).join("、") })} onChange={(value) => updateGroup(group.id, (next) => { next.primaryRole = value; next.auxiliaryRole = { ...next.auxiliaryRole, selectedOptionIds: next.auxiliaryRole.selectedOptionIds.filter((id) => !value.selectedOptionIds.includes(id)) }; })} /><V04ChoiceField label="桥段辅助创意作用" value={group.auxiliaryRole} options={V04_UI_BRIDGE_OPTIONS.filter((option) => !group.primaryRole.selectedOptionIds.includes(option.optionId))} customLabel="自定义辅助创意作用" multiple max={3} readOnly={!canEdit} onComment={() => openComment({ targetKey: `shotGroup:${group.id}.auxiliaryCreativeRole`, targetLabel: "桥段辅助创意作用", moduleLabel: "第一模块｜脚本反写", originalExcerpt: [...group.auxiliaryRole.selectedOptionIds, group.auxiliaryRole.customText].filter(Boolean).join("、") })} onChange={(value) => updateGroup(group.id, (next) => { next.auxiliaryRole = value; })} /></div>
              <Field id={`field-${group.id}-description`} label="本桥段关键创意描述" value={group.creativeDescription} readOnly={!canEdit} tall required={false} targetKey={`shotGroup:${group.id}.keyCreativeDescription`} moduleLabel="第一模块｜脚本反写" onComment={openComment} onChange={(value) => updateGroup(group.id, (next) => { next.creativeDescription = value; })} />
              {group.shots.map((shot) => { const globalIndex = allShots.findIndex((entry) => entry.id === shot.id); return <V04ShotEditor key={shot.id} shot={shot} number={numbers.get(shot.id) ?? 0} groupNumber={groupIndex + 1} groupId={group.id} groupTargets={draft.shotGroups.map((target, index) => ({ id: target.id, label: `桥段 ${String(index + 1).padStart(2, "0")} · ${target.title || "未命名"}` }))} previousShot={globalIndex > 0 ? allShots[globalIndex - 1] : null} readOnly={!canEdit} onComment={openComment} onChange={(key: V04ShotFieldKey, value) => updateGroup(group.id, (next) => { const current = next.shots.find((entry) => entry.id === shot.id); if (current) current[key] = value; })} onMoveUp={() => moveShotBy(shot.id, -1)} onMoveDown={() => moveShotBy(shot.id, 1)} onMoveTo={(targetGroupId) => moveShotTo(shot.id, targetGroupId)} onDragStart={() => setDraggedShotId(shot.id)} onDragEnd={() => setDraggedShotId(null)} />; })}
              <footer className={styles.bridgeActions}><button type="button" disabled={!canEdit} onClick={() => addShot(group.id)}>＋ 新增镜头</button><button type="button" disabled={!canEdit} onClick={() => addGroupAfter(group.id)}>＋ 在此桥段后新增桥段</button></footer>
            </article>)}</>}
          </section>
          <section className={`${styles.editorModule} ${collapsed.has(2) ? styles.collapsed : ""}`} id="module-2"><header><small>第二模块</small><h2>第二模块｜全片事实与核心判断</h2><button type="button" onClick={() => toggleModule(2)}>{collapsed.has(2) ? "展开" : "收起"}</button></header>{!collapsed.has(2) && <>
            <div className={styles.fieldGrid}><Field id="field-commercialIntent" label="商业意图" value={draft.commercialIntent} readOnly={!canEdit} tall targetKey="facts.commercialIntent" onComment={openComment} onChange={(value) => updateDraft((next) => { next.commercialIntent = value; })} /><Field id="field-storySummary" label="故事梗概" value={draft.storySummary} readOnly={!canEdit} tall targetKey="facts.storySynopsis" onComment={openComment} onChange={(value) => updateDraft((next) => { next.storySummary = value; })} /><Field id="field-creativeMotif" label="创意母题" value={draft.creativeMotif} readOnly={!canEdit} tall targetKey="facts.creativeMotif" onComment={openComment} onChange={(value) => updateDraft((next) => { next.creativeMotif = value; })} /><Field id="field-tensionButton" label="张力按钮" value={draft.tensionButton} readOnly={!canEdit} tall targetKey="facts.tensionButton" onComment={openComment} onChange={(value) => updateDraft((next) => { next.tensionButton = value; })} /></div>
            <V04ChoiceField targetId={V04_WORKSPACE_TARGETS.primaryMechanism} advancedTargetId={V04_WORKSPACE_TARGETS.primaryMechanismAdvanced} label="创意主导手法及机制" value={draft.primaryMechanism} options={V04_UI_MECHANISM_OPTIONS} customLabel="自定义通用机制" showAdvanced={draft.primaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM")} readOnly={!canEdit} onComment={() => openComment({ targetKey: "facts.mainMechanism", targetLabel: "创意主导手法及机制", moduleLabel: "第二模块｜全片事实与核心判断", originalExcerpt: [...draft.primaryMechanism.selectedOptionIds, draft.primaryMechanism.customText, draft.primaryMechanism.advancedText ?? ""].filter(Boolean).join("、") })} onChange={(value) => updateChoice("primaryMechanism", value)} />
            <V04ChoiceField targetId={V04_WORKSPACE_TARGETS.auxiliaryMechanism} advancedTargetId={V04_WORKSPACE_TARGETS.auxiliaryMechanismAdvanced} label="创意辅助手法及机制" value={draft.auxiliaryMechanism} options={V04_UI_MECHANISM_OPTIONS.filter((option) => !draft.primaryMechanism.selectedOptionIds.includes(option.optionId))} customLabel="自定义辅助机制" multiple showAdvanced={draft.auxiliaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM")} readOnly={!canEdit} onComment={() => openComment({ targetKey: "facts.auxiliaryMechanism", targetLabel: "创意辅助手法及机制", moduleLabel: "第二模块｜全片事实与核心判断", originalExcerpt: [...draft.auxiliaryMechanism.selectedOptionIds, draft.auxiliaryMechanism.customText, draft.auxiliaryMechanism.advancedText ?? ""].filter(Boolean).join("、") })} onChange={(value) => updateChoice("auxiliaryMechanism", value)} />
            <Field id="field-creativeThinkingChain" label="创意思维链" value={draft.creativeThinkingChain} readOnly={!canEdit} tall targetKey="facts.creativeThinkingChain" onComment={openComment} onChange={(value) => updateDraft((next) => { next.creativeThinkingChain = value; })} />
            <div className={styles.fieldGrid}><div id="field-storyReference"><V04ChoiceField label="故事参照类型" value={draft.storyReference} options={V04_UI_STORY_OPTIONS} customLabel="自定义故事参照类型" readOnly={!canEdit} onComment={() => openComment({ targetKey: "facts.storyReference", targetLabel: "故事参照类型", moduleLabel: "第二模块｜全片事实与核心判断", originalExcerpt: [...draft.storyReference.selectedOptionIds, draft.storyReference.customText].filter(Boolean).join("、") })} onChange={(value) => updateChoice("storyReference", value)} /></div><section className={styles.inlineChoices} id="field-carriers" tabIndex={canEdit ? undefined : 0}><label>创意承重载体 <button type="button" onClick={() => openComment({ targetKey: "facts.creativeCarriers", targetLabel: "创意承重载体", moduleLabel: "第二模块｜全片事实与核心判断", originalExcerpt: draft.carriers.join("、") })}>批注</button></label>{["故事", "文案", "视听规则"].map((carrier) => <button type="button" key={carrier} disabled={!canEdit} className={draft.carriers.includes(carrier) ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.carriers = next.carriers.includes(carrier) ? next.carriers.filter((item) => item !== carrier) : [...next.carriers, carrier]; })}>{carrier}</button>)}</section></div>
            <Field id="field-carrierExplanation" label="创意承重载体具体说明" value={draft.carrierExplanation} readOnly={!canEdit} tall targetKey="facts.carrierExplanation" onComment={openComment} onChange={(value) => updateDraft((next) => { next.carrierExplanation = value; })} /><Field id="field-creativeContract" label="创意成立契约（隐含情理）" value={draft.creativeContract} readOnly={!canEdit} tall targetKey="facts.acceptanceContract" onComment={openComment} onChange={(value) => updateDraft((next) => { next.creativeContract = value; })} />
            <section className={styles.gradeSection} id="field-overallGrade" tabIndex={canEdit ? undefined : 0}><label>整体创意评价 <em>发布必填</em> <button type="button" onClick={() => openComment({ targetKey: "facts.overallCreativeRating", targetLabel: "整体创意评价", moduleLabel: "第二模块｜全片事实与核心判断", originalExcerpt: draft.overallGrade })}>批注</button></label><div>{(["S", "A", "B", "C"] as const).map((grade) => { const description = { S: "极少见的强创意；母题、张力按钮、机制与表达高度统一。", A: "明确且有力量的优秀创意；至少一个环节突出，品牌连接自然。", B: "创意成立且完成度合格；结构可识别，机制或品牌拥有权一般。", C: "主要依赖常规表达或执行包装；张力按钮不清或品牌连接牵强。" }[grade]; return <button type="button" key={grade} disabled={!canEdit} className={draft.overallGrade === grade ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.overallGrade = grade; })}><b>{grade}</b><span>{description}</span></button>; })}</div></section><Field id="field-gradeReason" label="评价理由" value={draft.gradeReason} readOnly={!canEdit} tall targetKey="facts.ratingReason" onComment={openComment} onChange={(value) => updateDraft((next) => { next.gradeReason = value; })} />
          </>}</section>
          <section className={`${styles.editorModule} ${collapsed.has(3) ? styles.collapsed : ""}`} id="module-3"><header><small>第三模块</small><h2>第三模块｜主导感知类型发生路径</h2><button type="button" onClick={() => toggleModule(3)}>{collapsed.has(3) ? "展开" : "收起"}</button></header>{!collapsed.has(3) && <><div className={styles.pathSelector}>{V04_UI_PATHS.map((path) => <button type="button" key={path.id} disabled={!canEdit} className={draft.primaryPath === path.id ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.primaryPath = path.id; next.auxiliaryPaths = next.auxiliaryPaths.filter((item) => item !== path.id); })}><b>{path.label}</b><span>点击显示 5 项条件</span></button>)}</div><div className={styles.fieldGrid}>{V04_UI_PATHS.find((path) => path.id === draft.primaryPath)?.fields.map((label, index) => <Field key={label} id={`field-path-${index}`} label={label} value={draft.primaryPathAnswers[draft.primaryPath][index]} readOnly={!canEdit} moduleLabel="第三模块｜主导感知类型发生路径" targetKey={`path.primaryDetails.${pathKeys[draft.primaryPath][index]}`} onComment={openComment} onChange={(value) => updateDraft((next) => { next.primaryPathAnswers[next.primaryPath][index] = value; })} />)}</div><section className={styles.inlineChoices}><label>辅助路径 · 与主导互斥</label>{V04_UI_PATHS.filter((path) => path.id !== draft.primaryPath).map((path) => <button type="button" key={path.id} disabled={!canEdit} className={draft.auxiliaryPaths.includes(path.id) ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.auxiliaryPaths = next.auxiliaryPaths.includes(path.id) ? next.auxiliaryPaths.filter((item) => item !== path.id) : [...next.auxiliaryPaths, path.id].slice(0, 2); if (!next.auxiliaryPathDetails[path.id]) next.auxiliaryPathDetails[path.id] = { description: "", role: "" }; })}>{pathLabels[path.id]}</button>)}</section>{draft.auxiliaryPaths.map((path) => <div className={styles.fieldGrid} key={path}><Field id={`field-aux-${path}-description`} label={`${pathLabels[path]}｜辅助路径说明`} value={draft.auxiliaryPathDetails[path]?.description ?? ""} readOnly={!canEdit} moduleLabel="第三模块｜主导感知类型发生路径" targetKey={`path.auxiliary:${path}.description`} onComment={openComment} onChange={(value) => updateDraft((next) => { next.auxiliaryPathDetails[path] = { description: value, role: next.auxiliaryPathDetails[path]?.role ?? "" }; })} /><Field id={`field-aux-${path}-role`} label={`${pathLabels[path]}｜创意作用`} value={draft.auxiliaryPathDetails[path]?.role ?? ""} readOnly={!canEdit} moduleLabel="第三模块｜主导感知类型发生路径" targetKey={`path.auxiliary:${path}.creativeRole`} onComment={openComment} onChange={(value) => updateDraft((next) => { next.auxiliaryPathDetails[path] = { description: next.auxiliaryPathDetails[path]?.description ?? "", role: value }; })} /></div>)}</>}</section>
          <section className={styles.editorModule} id="module-4"><header><small>第四模块</small><h2>第四模块｜提交</h2><p>只显示发布完整度、未填写项目和提交动作。</p></header><section className={styles.missingPanel}><header><b>未填写项目 · {publication.missing.length}</b><span>发布必填 {publication.ready ? "全部完成" : "尚未完成"}</span></header>{publication.missing.map((missing) => <button type="button" key={missing.id} onClick={() => locate(missing.id)}><span>{missing.module} · {missing.scope}</span><b>{missing.label}</b></button>)}</section><div className={styles.submitCard}><div><h3>{!hasDraftEditCapability ? "当前为只读，取得编辑权后才能提交" : recoveryPending ? "请先处理本地恢复副本" : submitted ? `提交成功 · V${model.submissionCount}` : publication.ready ? saveMachine.status === "SAVED" || saveMachine.status === "CLEAN" ? "可以提交并更新案例" : "最新修改尚未完成服务器保存" : "发布条件尚未满足"}</h3><p>{recoveryPending ? RECOVERY_SUBMIT_BLOCKED_MESSAGE : "提交会先串行保存最新修改，再创建不可变版本；保存失败时绝不会提交。"}</p><span className={styles.inlineSaveStatus} role="status" aria-live="polite">{visibleSaveLabel}</span>{actionError && <p className={styles.inlineActionError} role="alert">{actionError}</p>}</div><button {...submitActionProps}>提交并更新案例</button></div>{model.viewerCapabilities.canExpertReview && model.latestSubmission && <section className={styles.gradeSection}><label>专家优选 · {model.expertPreference ? `当前绑定 V${model.expertPreference.submissionNumber}；选择下方等级将改选 V${model.latestSubmission.submissionNumber}` : `选择等级并精确绑定 V${model.latestSubmission.submissionNumber}`}</label><div>{(["S", "A", "B", "C"] as const).map((grade) => <button type="button" key={grade} disabled={!canEdit} className={model.expertPreference?.submissionId === model.latestSubmission?.id && model.expertPreference?.grade === grade ? styles.isSelected : ""} onClick={() => { void setExpertPreference(grade); }}>{grade}</button>)}{model.expertPreference && <button type="button" disabled={!canEdit} onClick={() => { void withdrawExpertPreference(); }}>撤回优选</button>}</div></section>}</section>
        </div>
      </div>
    </div>
    <V04VideoPlayer caseId={item.id} title={item.title} surface="workspace" media={item.media ?? null} />
    <div className={styles.workspaceTools}><button onClick={() => setAi(true)}>✦ AI 建议</button><button onClick={() => setComments(true)}>● 批注任务</button></div>
    <V04HistoryDrawer videoId={item.id} open={history} onClose={() => setHistory(false)} onRestore={canEdit ? restoreVersion : undefined} />
    <V04CommentDrawer videoId={item.id} open={comments} onClose={() => setComments(false)} onLocate={locate} draft={draft} readOnly={!canEdit} composeTarget={commentTarget} />
    <V04AiAssistPanel open={ai} onClose={() => setAi(false)} />
  </main>;
}
