"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { V04ServerDetailModel, V04UiDraft, V04UiShot } from "@/lib/v04-ui-model";
import { v04DetailToUiCase, v04PayloadToUiDraft, V04_UI_SHOT_FIELDS, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { numberedV04Shots, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04_UI_BRIDGE_OPTIONS, V04_UI_MECHANISM_OPTIONS, V04_UI_PATHS, V04_UI_STORY_OPTIONS } from "@/lib/v04-ui-fixture";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import V04VideoPlayer from "./V04VideoPlayer";
import V04HistoryDrawer from "./V04HistoryDrawer";
import V04CommentDrawer from "./V04CommentDrawer";
import styles from "./V04Surface.module.css";

const groups: Array<Array<keyof V04UiShot>> = [
  ["startTime", "endTime", "shotScale"], ["cameraAngle", "cameraMovement"], ["visualContent"],
  ["screenCopy", "subtitleEffect"], ["dialogue", "voiceOver"], ["soundEffect", "music"],
];

const fieldLabel = Object.fromEntries(V04_UI_SHOT_FIELDS.map((item) => [item.key, item.label]));
const bridgeLabel = Object.fromEntries(V04_UI_BRIDGE_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const mechanismLabel = Object.fromEntries(V04_UI_MECHANISM_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const storyLabel = Object.fromEntries(V04_UI_STORY_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const pathLabel = Object.fromEntries(V04_UI_PATHS.map((item) => [item.id, item.label]));

function choiceText(ids: string[], labels: Record<string, string>, customText: string) {
  return [...ids.map((id) => labels[id] ?? id), customText].filter(Boolean).join("、") || "—";
}

function ReadonlyShots({ draft }: { draft: V04UiDraft }) {
  const numbers = new Map(numberedV04Shots(draft.shotGroups).map((item) => [item.stableId, item.displayNumber]));
  return <>{draft.shotGroups.map((group, groupIndex) => <section className={styles.readingGroup} key={group.id}><header><span>桥段 {String(groupIndex + 1).padStart(2, "0")}</span><div><small>桥段名称</small><h3>{group.title || "未命名桥段"}</h3></div></header><div className={styles.readingBridgeMeta}><div><small>桥段主创意作用</small><p>{choiceText(group.primaryRole.selectedOptionIds, bridgeLabel, group.primaryRole.customText)}</p></div><div><small>桥段辅助创意作用</small><p>{choiceText(group.auxiliaryRole.selectedOptionIds, bridgeLabel, group.auxiliaryRole.customText)}</p></div><div><small>本桥段关键创意描述</small><p>{group.creativeDescription || "—"}</p></div></div>{group.shots.map((shot) => <article className={styles.readingShot} key={shot.id} data-readonly-shot={shot.id}><h4>镜头 {String(numbers.get(shot.id) ?? 0).padStart(2, "0")}</h4>{groups.map((keys, index) => <div className={`${styles.readingShotBlock} ${index === 0 ? styles.readingThree : index === 2 ? styles.readingOne : styles.readingTwo}`} key={keys.join("-")}>{keys.map((key) => <div key={key}><small>{fieldLabel[key]}</small><p>{shot[key] || "—"}</p></div>)}</div>)}</article>)}</section>)}</>;
}

function ReadonlyCore({ draft }: { draft: V04UiDraft }) {
  return <div className={styles.readingCore}>{[
    [V04_WORKSPACE_TARGETS.commercialIntent, "商业意图", draft.commercialIntent], [V04_WORKSPACE_TARGETS.storySummary, "故事梗概", draft.storySummary], [V04_WORKSPACE_TARGETS.creativeMotif, "创意母题", draft.creativeMotif], [V04_WORKSPACE_TARGETS.tensionButton, "张力按钮", draft.tensionButton],
    [V04_WORKSPACE_TARGETS.primaryMechanism, "创意主导手法及机制", choiceText(draft.primaryMechanism.selectedOptionIds, mechanismLabel, draft.primaryMechanism.customText)], ["field-auxiliaryMechanism", "创意辅助手法及机制", choiceText(draft.auxiliaryMechanism.selectedOptionIds, mechanismLabel, draft.auxiliaryMechanism.customText)], [V04_WORKSPACE_TARGETS.creativeThinkingChain, "创意思维链", draft.creativeThinkingChain], [V04_WORKSPACE_TARGETS.storyReference, "故事参照类型", choiceText(draft.storyReference.selectedOptionIds, storyLabel, draft.storyReference.customText)], [V04_WORKSPACE_TARGETS.carriers, "创意承重载体", draft.carriers.join("、")], [V04_WORKSPACE_TARGETS.carrierExplanation, "创意承重载体具体说明", draft.carrierExplanation], [V04_WORKSPACE_TARGETS.creativeContract, "创意成立契约", draft.creativeContract], [V04_WORKSPACE_TARGETS.overallGrade, "整体创意评价", draft.overallGrade], [V04_WORKSPACE_TARGETS.gradeReason, "评价理由", draft.gradeReason],
  ].map(([id, label, value]) => <div key={id} id={id}><small>{label}</small><p>{value || "—"}</p></div>)}</div>;
}

export default function V04DetailClient({ videoId, viewerName }: { videoId: string; viewerName: string }) {
  const tabToken = useRef(`v04-detail-${crypto.randomUUID()}`);
  const [model, setModel] = useState<V04ServerDetailModel | null>(null);
  const [error, setError] = useState("");
  const [versionView, setVersionView] = useState<"LATEST" | "EXPERT">("LATEST");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState(false);
  const [comments, setComments] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void v04UiApi.detail<V04ServerDetailModel>(videoId, tabToken.current, controller.signal)
      .then((value) => { setModel(value); setError(""); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof V04UiApiError ? reason.message : "成果暂时无法读取，请稍后重试。");
      });
    return () => controller.abort();
  }, [videoId]);
  const item = useMemo(() => model ? v04DetailToUiCase(model) : null, [model]);
  const selectedSubmission = versionView === "EXPERT" && model?.expertPreferredSubmission
    ? model.expertPreferredSubmission
    : model?.latestSubmission;
  const draft = selectedSubmission ? v04PayloadToUiDraft(selectedSubmission.payload) : null;
  const toggle = (number: number) => setCollapsed((current) => { const next = new Set(current); if (next.has(number)) next.delete(number); else next.add(number); return next; });
  if (error) return <main className={styles.surface} data-v04-page="detail"><section className={styles.emptyState}><h2>成果读取失败</h2><p>{error}</p><Link href="/v04-shadow">返回案例库</Link></section></main>;
  if (!item || !model) return <main className={styles.surface} data-v04-page="detail"><section className={styles.emptyState}><h2>正在读取案例成果…</h2></section></main>;
  return <main className={styles.surface} data-v04-page="detail">
    <header className={styles.productHeader} data-v04-fixed-header><Link href="/v04-shadow" className={styles.wordmark}>← 案例库</Link><nav><Link href={`/v04-shadow/videos/${item.id}`}>只读成果</Link><Link href={`/v04-shadow/videos/${item.id}/workspace`}>编辑工作稿</Link><button onClick={() => setHistory(true)}>历史版本</button></nav><span>{viewerName}</span></header>
    <section className={styles.detailIntro}><p>案例分析</p><h1>{item.title}</h1><div><span>{item.brand}</span><span>{item.duration}</span><span>{V04_UI_STATE_LABELS[item.workState]}</span>{item.expertGrade && <b>专家优选 {item.expertGrade}</b>}</div><p>{item.description}</p>{model.expertPreferredSubmission && model.latestSubmission && <div><button type="button" onClick={() => setVersionView("LATEST")} disabled={versionView === "LATEST"}>最新提交 V{model.latestSubmission.submissionNumber}</button><button type="button" onClick={() => setVersionView("EXPERT")} disabled={versionView === "EXPERT"}>专家优选 V{model.expertPreferredSubmission.submissionNumber}</button></div>}</section>
    <V04VideoPlayer caseId={item.id} title={item.title} surface="detail" media={item.media ?? null} />
    {!draft ? <section className={styles.emptyState}><h2>尚无已提交成果</h2><p>此页仅查看提交成果，不展示填写控件、固定选项或条件交互。</p><Link href={`/v04-shadow/videos/${item.id}/workspace`}>开始公共工作稿</Link></section> : <div className={styles.readingBody}>
      <section className={styles.readingModule}><header><h2>第一模块｜脚本反写</h2></header><ReadonlyShots draft={draft} /></section>
      <section className={styles.readingModule}><header><h2>第二模块｜全片事实与核心判断</h2><button onClick={() => toggle(2)}>{collapsed.has(2) ? "展开" : "收起"}</button></header>{!collapsed.has(2) && <ReadonlyCore draft={draft} />}</section>
      <section className={styles.readingModule}><header><h2>第三模块｜主导感知类型发生路径</h2><button onClick={() => toggle(3)}>{collapsed.has(3) ? "展开" : "收起"}</button></header>{!collapsed.has(3) && <div className={styles.readingCore}><div><small>主导路径</small><p>{pathLabel[draft.primaryPath]}</p></div>{draft.primaryPathAnswers[draft.primaryPath].map((value, index) => <div key={index}><small>{V04_UI_PATHS.find((path) => path.id === draft.primaryPath)?.fields[index] ?? `条件判断 ${index + 1}`}</small><p>{value || "—"}</p></div>)}{draft.auxiliaryPaths.map((path) => <div key={path}><small>辅助路径｜{pathLabel[path]}</small><p>{[draft.auxiliaryPathDetails[path]?.description, draft.auxiliaryPathDetails[path]?.role].filter(Boolean).join("｜") || "—"}</p></div>)}</div>}</section>
      <section className={styles.readingModule}><header><h2>第四模块｜提交</h2></header><div className={styles.readingCore}><div><small>当前提交版</small><p>{selectedSubmission ? `V${selectedSubmission.submissionNumber} · ${selectedSubmission.submittedAt} · ${selectedSubmission.submittedByName}` : "尚无已提交成果"}</p></div><div><small>工作状态</small><p>{V04_UI_STATE_LABELS[item.workState]}</p></div></div></section>
    </div>}
    <button className={styles.cornerTool} onClick={() => setComments(true)}>批注任务</button>
    <V04HistoryDrawer videoId={item.id} open={history} onClose={() => setHistory(false)} />
    <V04CommentDrawer videoId={item.id} open={comments} onClose={() => setComments(false)} readOnly />
  </main>;
}
