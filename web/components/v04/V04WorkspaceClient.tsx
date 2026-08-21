"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { V04_VOCABULARY_VERSION, type V04ChoiceValue, type V04ShotFieldKey } from "@/lib/v04-contract";
import { V04_AUTOSAVE_DEBOUNCE_MS } from "@/lib/v04-draft-save-state";
import type { V04ServerWorkspaceModel, V04UiDraft, V04UiShotGroup } from "@/lib/v04-ui-model";
import { cloneV04UiDraft, emptyV04UiDraft, v04PayloadChanges, v04UiDraftToPayload, v04WorkspaceToUiCase, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { blankV04Shot, evaluateV04FixturePublication, locateV04Target, moveV04Shot, nextV04Timecode, numberedV04Shots, v04GroupPrimaryRoleTargetId, v04GroupTitleTargetId, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04_UI_BRIDGE_OPTIONS, V04_UI_MECHANISM_OPTIONS, V04_UI_PATHS, V04_UI_STORY_OPTIONS } from "@/lib/v04-ui-fixture";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import { useV04VideoSession } from "./V04VideoSessionProvider";
import V04VideoPlayer from "./V04VideoPlayer";
import V04WorkspaceNavigation from "./V04WorkspaceNavigation";
import V04ShotEditor from "./V04ShotEditor";
import V04ChoiceField from "./V04ChoiceField";
import V04HistoryDrawer from "./V04HistoryDrawer";
import V04CommentDrawer, { type V04CommentComposeTarget } from "./V04CommentDrawer";
import V04AiAssistPanel from "./V04AiAssistPanel";
import styles from "./V04Surface.module.css";

type SaveState = "saved" | "dirty" | "saving" | "failed";
type LeaseProof = { tabToken: string; leaseToken: string; leaseVersion: number };
type LeaseResult = { leaseId: string; leaseToken: string; leaseVersion: number; expiresAt: string; reused: boolean };
type SaveResult = { revision: number; contentHash: string; savedAt?: string; workflowState?: V04ServerWorkspaceModel["state"]; rebased?: boolean };
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
  const localIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const localIdSequence = useRef(0);
  const links = navigation ?? {
    libraryHref: "/v04-shadow",
    detailHref: `/v04-shadow/videos/${videoId}`,
    workspaceHref: `/v04-shadow/videos/${videoId}/workspace`,
  };
  const { getWorkspaceSession, setWorkspaceLeaseProof } = useV04VideoSession();
  const [workspaceSession] = useState(() => getWorkspaceSession(videoId));
  const tabToken = useRef(workspaceSession.tabToken);
  const leaseProof = useRef<LeaseProof | null>(workspaceSession.leaseProof);
  const modelRef = useRef<V04ServerWorkspaceModel | null>(null);
  const [model, setModelState] = useState<V04ServerWorkspaceModel | null>(null);
  const [draft, setDraftState] = useState<V04UiDraft>(() => emptyV04UiDraft());
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState(false);
  const [comments, setComments] = useState(false);
  const [commentTarget, setCommentTarget] = useState<V04CommentComposeTarget | null>(null);
  const [ai, setAi] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState("");
  const [draggedShotId, setDraggedShotId] = useState<string | null>(null);
  const [pendingLocateId, setPendingLocateId] = useState<string | null>(null);
  const saveToken = useRef(0);
  const focusContext = useRef<{ element: HTMLElement; scrollY: number } | null>(null);
  const item = useMemo(() => model ? v04WorkspaceToUiCase(model) : null, [model]);
  const canEdit = Boolean(model?.viewerCapabilities.canEdit || (model?.logicalEmpty && model.viewerCapabilities.canMaterialize));
  const publication = useMemo(() => evaluateV04FixturePublication(draft), [draft]);
  const numbers = useMemo(() => new Map(numberedV04Shots(draft.shotGroups).map((entry) => [entry.stableId, entry.displayNumber])), [draft.shotGroups]);
  const allShots = draft.shotGroups.flatMap((group) => group.shots);
  const openComment = (target: V04CommentComposeTarget) => { setCommentTarget(target); setComments(true); };

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const setModel = useCallback((next: V04ServerWorkspaceModel) => {
    modelRef.current = next;
    setModelState(next);
  }, []);

  const refreshWorkspace = useCallback(async () => {
    const next = await v04UiApi.workspace<V04ServerWorkspaceModel>(videoId, tabToken.current);
    setModel(next);
    return next;
  }, [setModel, videoId]);

  const acquireLease = useCallback(async (current: V04ServerWorkspaceModel) => {
    if (current.viewerCapabilities.canEdit && leaseProof.current) return leaseProof.current;
    if (current.logicalEmpty) {
      await v04UiApi.materialize(videoId, {}, `materialize-${videoId}-${crypto.randomUUID()}`);
      current = await refreshWorkspace();
    }
    const result = await v04UiApi.acquireLease<LeaseResult>(videoId, {
      tabToken: tabToken.current,
      existingLeaseToken: leaseProof.current?.leaseToken,
      existingLeaseVersion: leaseProof.current?.leaseVersion,
    });
    leaseProof.current = { tabToken: tabToken.current, leaseToken: result.leaseToken, leaseVersion: result.leaseVersion };
    setWorkspaceLeaseProof(videoId, leaseProof.current);
    await refreshWorkspace();
    return leaseProof.current;
  }, [refreshWorkspace, setWorkspaceLeaseProof, videoId]);

  useEffect(() => {
    let active = true;
    void refreshWorkspace().then(async (next) => {
      if (!active) return;
      setDraftState(v04WorkspaceToUiCase(next).draft);
      setSavedAt(next.lastSavedAt ?? "");
      setLoadError("");
      // A logical empty workspace is a read-only projection until the first
      // actual save. The save path materializes it atomically before leasing.
      if (next.viewerCapabilities.canAcquireLease && !next.logicalEmpty) {
        try { await acquireLease(next); } catch (reason) {
          if (reason instanceof V04UiApiError && reason.code === "LEASE_HELD_BY_OTHER") await refreshWorkspace();
        }
      }
    }).catch((reason: unknown) => {
      if (active) setLoadError(reason instanceof V04UiApiError ? reason.message : "公共工作稿暂时无法读取。");
    });
    return () => { active = false; };
  }, [acquireLease, refreshWorkspace]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!leaseProof.current) return;
      void v04UiApi.heartbeatLease(videoId, leaseProof.current).catch(() => setActionError("编辑权续租失败，请保存副本后刷新。"));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [videoId]);

  const commitSave = useCallback(async (nextDraft: V04UiDraft, token: number) => {
    const current = modelRef.current;
    if (!current) return false;
    setSaveState("saving");
    setActionError("");
    try {
      const proof = await acquireLease(current);
      const server = modelRef.current!;
      const nextPayload = v04UiDraftToPayload(nextDraft, server.payload);
      const changes = v04PayloadChanges(server.payload, nextPayload);
      if (!changes.length) {
        setSaveState(saveToken.current === token ? "saved" : "dirty");
        return true;
      }
      const result = await v04UiApi.save<SaveResult>(videoId, {
        expectedRevision: server.draftRevision,
        expectedHash: server.draftContentHash,
        changeSetId: `change-${videoId}-${crypto.randomUUID()}`,
        changes,
        lease: proof,
      }, tabToken.current);
      const updated = await refreshWorkspace();
      if (saveToken.current === token) setDraftState(v04WorkspaceToUiCase(updated).draft);
      setSavedAt(updated.lastSavedAt ?? result.savedAt ?? "");
      setSaveState(saveToken.current === token ? "saved" : "dirty");
      return true;
    } catch (reason) {
      const apiError = reason instanceof V04UiApiError ? reason : null;
      setActionError(apiError?.code === "REVISION_CONFLICT" ? "工作稿已被其他编辑更新；你的本地内容仍保留，请刷新比较后重试。" : apiError?.message ?? "保存失败，本地输入仍保留，可直接重试。");
      setSaveState("failed");
      return false;
    }
  }, [acquireLease, refreshWorkspace, videoId]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const token = saveToken.current;
    const timer = window.setTimeout(() => { void commitSave(cloneV04UiDraft(draft), token); }, V04_AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [commitSave, draft, saveState]);

  const updateDraft = (mutate: (next: V04UiDraft) => void) => {
    if (!canEdit) return;
    setDraftState((current) => { const next = cloneV04UiDraft(current); mutate(next); return next; });
    saveToken.current += 1;
    setSaveState("dirty");
    setSubmitted(false);
  };

  const manualSave = async () => {
    if (!canEdit) return;
    const active = document.activeElement as HTMLElement | null;
    const context = focusContext.current?.element === active
      ? focusContext.current
      : active?.matches("input,textarea")
        ? { element: active, scrollY: window.scrollY }
        : focusContext.current ?? { element: active ?? document.body, scrollY: window.scrollY };
    const token = ++saveToken.current;
    const saving = commitSave(cloneV04UiDraft(draft), token);
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
  const saveLabel = saveState === "dirty" ? "有未保存修改" : saveState === "saving" ? "正在保存…" : saveState === "failed" ? "保存失败，可重试" : `已保存${savedAt ? ` · ${savedAt}` : ""}`;

  const submitDraft = async () => {
    if (!canEdit) return;
    const token = saveToken.current;
    if (saveState !== "saved" && !await commitSave(cloneV04UiDraft(draft), token)) return;
    const current = modelRef.current;
    if (!current) return;
    try {
      const proof = await acquireLease(current);
      await v04UiApi.submit(videoId, {
        expectedDraftRevision: modelRef.current!.draftRevision,
        expectedDraftHash: modelRef.current!.draftContentHash,
        lease: proof,
      }, `submission-${videoId}-${crypto.randomUUID()}`, tabToken.current);
      const refreshed = await refreshWorkspace();
      setDraftState(v04WorkspaceToUiCase(refreshed).draft);
      setSubmitted(true);
      setActionError("");
    } catch (reason) {
      setActionError(reason instanceof V04UiApiError ? reason.message : "提交未完成，工作稿仍保留。 ");
    }
  };

  const restoreVersion = async (source: { sourceType: "BASELINE" | "WORKING" | "SUBMISSION"; sourceId: string }) => {
    if (!canEdit) return;
    const current = modelRef.current;
    if (!current) return;
    try {
      const proof = await acquireLease(current);
      await v04UiApi.restore(videoId, { ...source, reason: "从历史版本创建恢复稿", lease: proof }, `restore-${videoId}-${crypto.randomUUID()}`, tabToken.current);
      const refreshed = await refreshWorkspace();
      setDraftState(v04WorkspaceToUiCase(refreshed).draft);
      setSaveState("saved");
      setHistory(false);
    } catch (reason) {
      setActionError(reason instanceof V04UiApiError ? reason.message : "历史恢复未完成。");
    }
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

  if (loadError) return <main className={styles.surface} data-v04-page="workspace"><section className={styles.emptyState}><h2>公共工作稿读取失败</h2><p>{loadError}</p><Link href={links.libraryHref}>返回案例库</Link></section></main>;
  if (!item || !model) return <main className={styles.surface} data-v04-page="workspace"><section className={styles.emptyState}><h2>正在读取公共工作稿…</h2></section></main>;

  return <main className={styles.surface} data-v04-page="workspace">
    <header className={styles.siteHeader} data-v04-fixed-header><Link href={links.libraryHref} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link><nav className={styles.siteNav}><Link href={links.libraryHref}>案例库</Link><Link href={links.detailHref}>{links.detailLabel ?? "案例分析"}</Link><Link href={links.workspaceHref} className={styles.activeNav}>{links.workspaceLabel ?? "公共工作稿"}</Link></nav><div className={styles.saveCluster}><span>{saveLabel}</span><button onClick={() => setHistory(true)}>历史</button><button onPointerDown={(event) => event.preventDefault()} onClick={manualSave} disabled={!canEdit || saveState === "saving"}>保存</button></div></header>
    <section className={styles.workspaceStatus} data-viewer-user-id={viewerUserId}><div><b>{canEdit ? `${viewerName} 正在编辑公共工作稿` : `只读旁观 · ${item.activeEditor ?? "其他编辑端"} 正在编辑`}</b><span>保存写入当前公共工作稿；提交才创建不可变版本，提交不释放编辑权。</span></div><strong>{V04_UI_STATE_LABELS[item.workState]}</strong></section>
    {actionError && <section className={styles.emptyState} role="alert"><p>{actionError}</p></section>}
    <section className={styles.workspaceTitle}><p>PUBLIC WORKING DRAFT</p><h1>{item.title}</h1><span>四模块 · 逐镜 12 项 · 固定值与自定义值分源保留</span></section>
    <div className={styles.workspaceGrid}>
      <V04WorkspaceNavigation draft={draft} onLocate={locate} />
      <div className={styles.editorColumn}>
        <div aria-readonly={!canEdit} className={`${styles.editorFieldset} ${!canEdit ? styles.readOnlyEditor : ""}`} onFocusCapture={(event) => {
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
          <section className={styles.editorModule} id="module-4"><header><small>第四模块</small><h2>第四模块｜提交</h2><p>只显示发布完整度、未填写项目和提交动作。</p></header><section className={styles.missingPanel}><header><b>未填写项目 · {publication.missing.length}</b><span>发布必填 {publication.ready ? "全部完成" : "尚未完成"}</span></header>{publication.missing.map((missing) => <button type="button" key={missing.id} onClick={() => locate(missing.id)}><span>{missing.module} · {missing.scope}</span><b>{missing.label}</b></button>)}</section><div className={styles.submitCard}><div><h3>{submitted ? `提交成功 · V${model.submissionCount}` : publication.ready ? "可以提交并更新案例" : "发布条件尚未满足"}</h3><p>提交创建不可变版本；后续保存只进入当前工作稿。</p></div><button type="button" disabled={!canEdit || !publication.ready || saveState === "saving" || (saveState === "saved" && model.latestSubmission?.contentHash === model.draftContentHash)} onClick={() => { void submitDraft(); }}>提交并更新案例</button></div>{model.viewerCapabilities.canExpertReview && model.latestSubmission && <section className={styles.gradeSection}><label>专家优选 · {model.expertPreference ? `当前绑定 V${model.expertPreference.submissionNumber}；选择下方等级将改选 V${model.latestSubmission.submissionNumber}` : `选择等级并精确绑定 V${model.latestSubmission.submissionNumber}`}</label><div>{(["S", "A", "B", "C"] as const).map((grade) => <button type="button" key={grade} disabled={!canEdit} className={model.expertPreference?.submissionId === model.latestSubmission?.id && model.expertPreference?.grade === grade ? styles.isSelected : ""} onClick={() => { void setExpertPreference(grade); }}>{grade}</button>)}{model.expertPreference && <button type="button" disabled={!canEdit} onClick={() => { void withdrawExpertPreference(); }}>撤回优选</button>}</div></section>}</section>
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
