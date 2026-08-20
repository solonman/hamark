"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { V04_VOCABULARY_VERSION, type V04ChoiceValue, type V04ShotFieldKey } from "@/lib/v04-contract";
import type { V04UiCase, V04UiDraft, V04UiShotGroup } from "@/lib/v04-ui-model";
import { cloneV04UiDraft, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { blankV04Shot, evaluateV04FixturePublication, locateV04Target, moveV04Shot, nextV04Timecode, numberedV04Shots, v04GroupPrimaryRoleTargetId, v04GroupTitleTargetId, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04_UI_BRIDGE_OPTIONS, V04_UI_MECHANISM_OPTIONS, V04_UI_PATHS, V04_UI_STORY_OPTIONS } from "@/lib/v04-ui-fixture";
import { useV04VideoSession } from "./V04VideoSessionProvider";
import V04VideoPlayer from "./V04VideoPlayer";
import V04WorkspaceNavigation from "./V04WorkspaceNavigation";
import V04ShotEditor from "./V04ShotEditor";
import V04ChoiceField from "./V04ChoiceField";
import V04HistoryDrawer from "./V04HistoryDrawer";
import V04CommentDrawer from "./V04CommentDrawer";
import V04AiAssistPanel from "./V04AiAssistPanel";
import styles from "./V04Surface.module.css";

type SaveState = "saved" | "dirty" | "saving" | "failed";
const pathLabels = Object.fromEntries(V04_UI_PATHS.map((item) => [item.id, item.label]));

function Field({ id, label, value, disabled, tall = false, required = true, onChange }: { id: string; label: string; value: string; disabled: boolean; tall?: boolean; required?: boolean; onChange: (value: string) => void }) {
  const controlId = `${id}-control`;
  return <label className={styles.formField} id={id} htmlFor={controlId}><span>{label}{required && <em>发布必填</em>}</span>{tall ? <textarea id={controlId} data-v04-primary-focus value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /> : <input id={controlId} data-v04-primary-focus value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />}</label>;
}

export default function V04WorkspaceClient({ item, viewerName }: { item: V04UiCase; viewerName: string }) {
  const session = useV04VideoSession();
  const [draft, setDraftState] = useState(() => cloneV04UiDraft(session.drafts[item.id] ?? item.draft));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState(item.lastSavedAt);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState(false);
  const [comments, setComments] = useState(false);
  const [ai, setAi] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [draggedShotId, setDraggedShotId] = useState<string | null>(null);
  const saveToken = useRef(0);
  const focusContext = useRef<{ element: HTMLElement; scrollY: number } | null>(null);
  const canEdit = !item.activeEditor || item.activeEditor === viewerName;
  const publication = useMemo(() => evaluateV04FixturePublication(draft), [draft]);
  const numbers = useMemo(() => new Map(numberedV04Shots(draft.shotGroups).map((entry) => [entry.stableId, entry.displayNumber])), [draft.shotGroups]);
  const allShots = draft.shotGroups.flatMap((group) => group.shots);

  const commitSave = useCallback((nextDraft: V04UiDraft, token: number) => {
    setSaveState("saving");
    window.setTimeout(() => {
      if (saveToken.current !== token) return;
      session.setDraft(item.id, nextDraft);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setSaveState("saved");
    }, 260);
  }, [item.id, session]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const token = saveToken.current;
    const timer = window.setTimeout(() => commitSave(cloneV04UiDraft(draft), token), 520);
    return () => window.clearTimeout(timer);
  }, [commitSave, draft, saveState]);

  const updateDraft = (mutate: (next: V04UiDraft) => void) => {
    setDraftState((current) => { const next = cloneV04UiDraft(current); mutate(next); return next; });
    saveToken.current += 1;
    setSaveState("dirty");
    setSubmitted(false);
  };

  const manualSave = () => {
    const active = document.activeElement as HTMLElement | null;
    const context = focusContext.current?.element === active
      ? focusContext.current
      : active?.matches("input,textarea")
        ? { element: active, scrollY: window.scrollY }
        : focusContext.current ?? { element: active ?? document.body, scrollY: window.scrollY };
    const token = ++saveToken.current;
    commitSave(cloneV04UiDraft(draft), token);
    const restore = () => {
      window.scrollTo({ top: context.scrollY, behavior: "auto" });
      if (context.element.isConnected && context.element !== document.body) context.element.focus({ preventScroll: true });
    };
    restore();
    requestAnimationFrame(() => requestAnimationFrame(restore));
    window.setTimeout(restore, 320);
    window.setTimeout(restore, 720);
  };

  const updateGroup = (groupId: string, updater: (group: V04UiShotGroup) => void) => updateDraft((next) => { const group = next.shotGroups.find((entry) => entry.id === groupId); if (group) updater(group); });
  const updateChoice = (field: "primaryMechanism" | "auxiliaryMechanism" | "storyReference", value: V04ChoiceValue) => updateDraft((next) => { next[field] = value; });
  const locate = (id: string) => { void locateV04Target(id); };
  const addShot = (groupId: string) => updateGroup(groupId, (group) => { const previous = draft.shotGroups.flatMap((entry) => entry.shots).at(-1); const next = blankV04Shot(`shot-fixture-${Date.now()}`); next.startTime = nextV04Timecode(previous?.endTime ?? ""); group.shots.push(next); window.setTimeout(() => locate(`shot-${next.id}`), 0); });
  const addGroupAfter = (groupId: string) => updateDraft((next) => { const index = next.shotGroups.findIndex((group) => group.id === groupId); const id = `bridge-fixture-${Date.now()}`; next.shotGroups.splice(index + 1, 0, { id, title: "", primaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION }, auxiliaryRole: { selectedOptionIds: [], customText: "", vocabularyVersion: V04_VOCABULARY_VERSION }, creativeDescription: "", shots: [blankV04Shot(`shot-${id}-01`)] }); window.setTimeout(() => locate(v04GroupTitleTargetId(id)), 0); });
  const moveShotBy = (shotId: string, delta: number) => updateDraft((next) => { const group = next.shotGroups.find((entry) => entry.shots.some((shot) => shot.id === shotId)); if (!group) return; const index = group.shots.findIndex((shot) => shot.id === shotId); next.shotGroups = moveV04Shot(next.shotGroups, shotId, group.id, index + delta); window.setTimeout(() => locate(`shot-${shotId}`), 0); });
  const moveShotTo = (shotId: string, groupId: string) => updateDraft((next) => { const target = next.shotGroups.find((group) => group.id === groupId); if (!target) return; next.shotGroups = moveV04Shot(next.shotGroups, shotId, groupId, target.shots.length); window.setTimeout(() => locate(`shot-${shotId}`), 0); });
  const toggleModule = (number: number) => setCollapsed((current) => { const next = new Set(current); if (next.has(number)) next.delete(number); else next.add(number); return next; });
  const saveLabel = saveState === "dirty" ? "有未保存修改" : saveState === "saving" ? "正在保存…" : saveState === "failed" ? "保存失败，可重试" : `已保存${savedAt ? ` · ${savedAt}` : ""}`;

  return <main className={styles.surface} data-v04-page="workspace">
    <header className={styles.productHeader} data-v04-fixed-header><Link href="/v04-shadow" className={styles.wordmark}>← 案例库</Link><nav><Link href={`/v04-shadow/videos/${item.id}`}>只读成果</Link><Link href={`/v04-shadow/videos/${item.id}/workspace`}>编辑工作稿</Link><button onClick={() => setHistory(true)}>历史</button></nav><div className={styles.saveCluster}><span>{saveLabel}</span><button onPointerDown={(event) => event.preventDefault()} onClick={manualSave} disabled={!canEdit || saveState === "saving"}>保存</button></div></header>
    <section className={styles.workspaceStatus}><div><b>{canEdit ? `${viewerName} 正在编辑公共工作稿` : `只读旁观 · ${item.activeEditor} 正在编辑`}</b><span>Fixture 会话内保存；不连接生产，不释放编辑权。</span></div><strong>{V04_UI_STATE_LABELS[item.workState]}</strong></section>
    <section className={styles.workspaceTitle}><p>PUBLIC WORKING DRAFT</p><h1>{item.title}</h1><span>四模块 · 逐镜 12 项 · 固定值与自定义值分源保留</span></section>
    <div className={styles.workspaceGrid}>
      <V04WorkspaceNavigation draft={draft} />
      <div className={styles.editorColumn}>
        <fieldset disabled={!canEdit} className={styles.editorFieldset} onFocusCapture={(event) => {
          const element = event.target as HTMLElement;
          if (!element.matches("input,textarea")) return;
          focusContext.current = { element, scrollY: window.scrollY };
          window.setTimeout(() => {
            if (document.activeElement === element) focusContext.current = { element, scrollY: window.scrollY };
          }, 80);
        }}>
          <section className={styles.editorModule} id="module-1"><header><small>第一模块</small><h2>第一模块｜脚本反写</h2><p>先按桥段组织，再逐镜还原；每个镜头保持 12 项独立科目。</p></header>
            {draft.shotGroups.map((group, groupIndex) => <article className={`${styles.bridgeCard} ${draggedShotId ? styles.isDropTarget : ""}`} key={group.id} id={`group-${group.id}`} onDragOver={(event) => { if (!draggedShotId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); if (!draggedShotId) return; moveShotTo(draggedShotId, group.id); setDraggedShotId(null); }}>
              <header className={styles.bridgeHeader}><b>桥段 {String(groupIndex + 1).padStart(2, "0")}</b><input id={v04GroupTitleTargetId(group.id)} data-v04-primary-focus aria-label="桥段名称" value={group.title} onChange={(event) => updateGroup(group.id, (next) => { next.title = event.target.value; })} placeholder="桥段名称" /></header>
              <div className={styles.bridgeChoices}><V04ChoiceField targetId={v04GroupPrimaryRoleTargetId(group.id)} label="桥段主创意作用" value={group.primaryRole} options={V04_UI_BRIDGE_OPTIONS} customLabel="自定义主创意作用" disabled={!canEdit} onChange={(value) => updateGroup(group.id, (next) => { next.primaryRole = value; })} /><V04ChoiceField label="桥段辅助创意作用" value={group.auxiliaryRole} options={V04_UI_BRIDGE_OPTIONS} customLabel="自定义辅助创意作用" multiple disabled={!canEdit} onChange={(value) => updateGroup(group.id, (next) => { next.auxiliaryRole = value; })} /></div>
              <Field id={`field-${group.id}-description`} label="本桥段关键创意描述" value={group.creativeDescription} disabled={!canEdit} tall required={false} onChange={(value) => updateGroup(group.id, (next) => { next.creativeDescription = value; })} />
              {group.shots.map((shot) => { const globalIndex = allShots.findIndex((entry) => entry.id === shot.id); return <V04ShotEditor key={shot.id} shot={shot} number={numbers.get(shot.id) ?? 0} groupId={group.id} groupTargets={draft.shotGroups.map((target, index) => ({ id: target.id, label: `桥段 ${String(index + 1).padStart(2, "0")} · ${target.title || "未命名"}` }))} previousShot={globalIndex > 0 ? allShots[globalIndex - 1] : null} disabled={!canEdit} onChange={(key: V04ShotFieldKey, value) => updateGroup(group.id, (next) => { const current = next.shots.find((entry) => entry.id === shot.id); if (current) current[key] = value; })} onMoveUp={() => moveShotBy(shot.id, -1)} onMoveDown={() => moveShotBy(shot.id, 1)} onMoveTo={(targetGroupId) => moveShotTo(shot.id, targetGroupId)} onDragStart={() => setDraggedShotId(shot.id)} onDragEnd={() => setDraggedShotId(null)} />; })}
              <footer className={styles.bridgeActions}><button type="button" onClick={() => addShot(group.id)}>＋ 新增镜头</button><button type="button" onClick={() => addGroupAfter(group.id)}>＋ 在此桥段后新增桥段</button></footer>
            </article>)}
          </section>
          <section className={`${styles.editorModule} ${collapsed.has(2) ? styles.collapsed : ""}`} id="module-2"><header><small>第二模块</small><h2>第二模块｜全片事实与核心判断</h2><button type="button" onClick={() => toggleModule(2)}>{collapsed.has(2) ? "展开" : "收起"}</button></header>{!collapsed.has(2) && <>
            <div className={styles.fieldGrid}><Field id="field-commercialIntent" label="商业意图" value={draft.commercialIntent} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.commercialIntent = value; })} /><Field id="field-storySummary" label="故事梗概" value={draft.storySummary} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.storySummary = value; })} /><Field id="field-creativeMotif" label="创意母题" value={draft.creativeMotif} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.creativeMotif = value; })} /><Field id="field-tensionButton" label="张力按钮" value={draft.tensionButton} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.tensionButton = value; })} /></div>
            <V04ChoiceField targetId={V04_WORKSPACE_TARGETS.primaryMechanism} advancedTargetId={V04_WORKSPACE_TARGETS.primaryMechanismAdvanced} label="创意主导手法及机制" value={draft.primaryMechanism} options={V04_UI_MECHANISM_OPTIONS} customLabel="自定义通用机制" showAdvanced={draft.primaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM")} disabled={!canEdit} onChange={(value) => updateChoice("primaryMechanism", value)} />
            <V04ChoiceField label="创意辅助手法及机制" value={draft.auxiliaryMechanism} options={V04_UI_MECHANISM_OPTIONS.filter((option) => !draft.primaryMechanism.selectedOptionIds.includes(option.optionId))} customLabel="自定义辅助机制" multiple showAdvanced={draft.auxiliaryMechanism.selectedOptionIds.includes("PENDING_NEW_MECHANISM")} disabled={!canEdit} onChange={(value) => updateChoice("auxiliaryMechanism", value)} />
            <Field id="field-creativeThinkingChain" label="创意思维链" value={draft.creativeThinkingChain} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.creativeThinkingChain = value; })} />
            <div className={styles.fieldGrid}><div id="field-storyReference"><V04ChoiceField label="故事参照类型" value={draft.storyReference} options={V04_UI_STORY_OPTIONS} customLabel="自定义故事参照类型" disabled={!canEdit} onChange={(value) => updateChoice("storyReference", value)} /></div><section className={styles.inlineChoices} id="field-carriers"><label>创意承重载体</label>{["故事", "文案", "视听规则"].map((carrier) => <button type="button" key={carrier} className={draft.carriers.includes(carrier) ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.carriers = next.carriers.includes(carrier) ? next.carriers.filter((item) => item !== carrier) : [...next.carriers, carrier]; })}>{carrier}</button>)}</section></div>
            <Field id="field-carrierExplanation" label="创意承重载体具体说明" value={draft.carrierExplanation} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.carrierExplanation = value; })} /><Field id="field-creativeContract" label="创意成立契约（隐含情理）" value={draft.creativeContract} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.creativeContract = value; })} />
            <section className={styles.gradeSection} id="field-overallGrade"><label>整体创意评价 <em>发布必填</em></label><div>{(["S", "A", "B", "C"] as const).map((grade) => <button type="button" key={grade} className={draft.overallGrade === grade ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.overallGrade = grade; })}>{grade}</button>)}</div></section><Field id="field-gradeReason" label="评价理由" value={draft.gradeReason} disabled={!canEdit} tall onChange={(value) => updateDraft((next) => { next.gradeReason = value; })} />
          </>}</section>
          <section className={`${styles.editorModule} ${collapsed.has(3) ? styles.collapsed : ""}`} id="module-3"><header><small>第三模块</small><h2>第三模块｜主导感知类型发生路径</h2><button type="button" onClick={() => toggleModule(3)}>{collapsed.has(3) ? "展开" : "收起"}</button></header>{!collapsed.has(3) && <><div className={styles.pathSelector}>{V04_UI_PATHS.map((path) => <button type="button" key={path.id} className={draft.primaryPath === path.id ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.primaryPath = path.id; next.auxiliaryPaths = next.auxiliaryPaths.filter((item) => item !== path.id); })}><b>{path.label}</b><span>点击显示 5 项条件</span></button>)}</div><div className={styles.fieldGrid}>{V04_UI_PATHS.find((path) => path.id === draft.primaryPath)?.fields.map((label, index) => <Field key={label} id={`field-path-${index}`} label={label} value={draft.primaryPathAnswers[draft.primaryPath][index]} disabled={!canEdit} onChange={(value) => updateDraft((next) => { next.primaryPathAnswers[next.primaryPath][index] = value; })} />)}</div><section className={styles.inlineChoices}><label>辅助路径 · 与主导互斥</label>{V04_UI_PATHS.filter((path) => path.id !== draft.primaryPath).map((path) => <button type="button" key={path.id} className={draft.auxiliaryPaths.includes(path.id) ? styles.isSelected : ""} onClick={() => updateDraft((next) => { next.auxiliaryPaths = next.auxiliaryPaths.includes(path.id) ? next.auxiliaryPaths.filter((item) => item !== path.id) : [...next.auxiliaryPaths, path.id].slice(0, 2); if (!next.auxiliaryPathDetails[path.id]) next.auxiliaryPathDetails[path.id] = { description: "", role: "" }; })}>{pathLabels[path.id]}</button>)}</section>{draft.auxiliaryPaths.map((path) => <div className={styles.fieldGrid} key={path}><Field id={`field-aux-${path}-description`} label={`${pathLabels[path]}｜辅助路径说明`} value={draft.auxiliaryPathDetails[path]?.description ?? ""} disabled={!canEdit} onChange={(value) => updateDraft((next) => { next.auxiliaryPathDetails[path] = { description: value, role: next.auxiliaryPathDetails[path]?.role ?? "" }; })} /><Field id={`field-aux-${path}-role`} label={`${pathLabels[path]}｜创意作用`} value={draft.auxiliaryPathDetails[path]?.role ?? ""} disabled={!canEdit} onChange={(value) => updateDraft((next) => { next.auxiliaryPathDetails[path] = { description: next.auxiliaryPathDetails[path]?.description ?? "", role: value }; })} /></div>)}</>}</section>
          <section className={styles.editorModule} id="module-4"><header><small>第四模块</small><h2>第四模块｜提交</h2><p>只显示发布完整度、未填写项目和提交动作。</p></header><section className={styles.missingPanel}><header><b>未填写项目 · {publication.missing.length}</b><span>发布必填 {publication.ready ? "全部完成" : "尚未完成"}</span></header>{publication.missing.map((missing) => <button type="button" key={missing.id} onClick={() => locate(missing.id)}><span>{missing.module} · {missing.scope}</span><b>{missing.label}</b></button>)}</section><div className={styles.submitCard}><div><h3>{submitted ? "已生成演示提交快照" : publication.ready ? "可以提交并更新案例" : "发布条件尚未满足"}</h3><p>P1 仅演示界面，不创建生产数据或不可变业务快照。</p></div><button type="button" disabled={!canEdit || !publication.ready || saveState === "saving"} onClick={() => { manualSave(); setSubmitted(true); }}>提交并更新案例（演示）</button></div></section>
        </fieldset>
      </div>
    </div>
    <V04VideoPlayer caseId={item.id} title={item.title} surface="workspace" />
    <div className={styles.workspaceTools}><button onClick={() => setAi(true)}>✦ AI 建议</button><button onClick={() => setComments(true)}>● 批注任务</button></div>
    <V04HistoryDrawer item={item} open={history} onClose={() => setHistory(false)} />
    <V04CommentDrawer open={comments} onClose={() => setComments(false)} />
    <V04AiAssistPanel open={ai} onClose={() => setAi(false)} />
  </main>;
}
