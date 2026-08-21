"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { V04ChoiceValue } from "@/lib/v04-contract";
import type { V04ServerDetailModel, V04UiDraft, V04UiShot } from "@/lib/v04-ui-model";
import { v04DetailToUiCase, v04PayloadToUiDraft, V04_UI_SHOT_FIELDS, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { numberedV04Shots, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import { V04_UI_BRIDGE_OPTIONS, V04_UI_MECHANISM_OPTIONS, V04_UI_PATHS, V04_UI_STORY_OPTIONS } from "@/lib/v04-ui-fixture";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import V04VideoPlayer from "./V04VideoPlayer";
import V04HistoryDrawer from "./V04HistoryDrawer";
import V04CommentDrawer from "./V04CommentDrawer";
import styles from "./V04Surface.module.css";

const shotGroups: Array<{ className: "readingThree" | "readingTwo" | "readingOne"; keys: Array<keyof V04UiShot> }> = [
  { className: "readingThree", keys: ["startTime", "endTime", "shotScale"] },
  { className: "readingTwo", keys: ["cameraAngle", "cameraMovement"] },
  { className: "readingOne", keys: ["visualContent"] },
  { className: "readingTwo", keys: ["screenCopy", "subtitleEffect"] },
  { className: "readingTwo", keys: ["dialogue", "voiceOver"] },
  { className: "readingTwo", keys: ["soundEffect", "music"] },
];
const shotLabels = Object.fromEntries(V04_UI_SHOT_FIELDS.map((item) => [item.key, item.label]));
const bridgeLabels = Object.fromEntries(V04_UI_BRIDGE_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const mechanismLabels = Object.fromEntries(V04_UI_MECHANISM_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const storyLabels = Object.fromEntries(V04_UI_STORY_OPTIONS.map((item) => [item.optionId, item.labelZhCn]));
const pathLabels = Object.fromEntries(V04_UI_PATHS.map((item) => [item.id, item.label]));

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const rounded = Math.round(seconds);
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function choiceParts(value: V04ChoiceValue, labels: Record<string, string>) {
  const fixed = value.selectedOptionIds.map((id) => labels[id] ?? id);
  return [fixed.length ? `固定：${fixed.join("、")}` : "", value.customText.trim() ? `自定义：${value.customText.trim()}` : "", value.advancedText?.trim() ? `进阶：${value.advancedText.trim()}` : ""].filter(Boolean);
}

function choiceText(value: V04ChoiceValue, labels: Record<string, string>) {
  return choiceParts(value, labels).join(" ｜ ") || "—";
}

function ReadonlyShots({ draft }: { draft: V04UiDraft }) {
  const numbers = new Map(numberedV04Shots(draft.shotGroups).map((item) => [item.stableId, item.displayNumber]));
  return <>{draft.shotGroups.map((group, groupIndex) => {
    const roles = [...choiceParts(group.primaryRole, bridgeLabels).map((part) => `主作用 · ${part}`), ...choiceParts(group.auxiliaryRole, bridgeLabels).map((part) => `辅助作用 · ${part}`)];
    return <section className={styles.readingGroup} key={group.id} data-v04-bridge={group.id}>
      <header><span>桥段 {String(groupIndex + 1).padStart(2, "0")}</span><div><small>桥段名称</small><h3>{group.title || "未命名桥段"}</h3></div></header>
      <div className={styles.readingBridgeMeta}><div><small>桥段创意作用</small><p>{roles.join(" ｜ ") || "—"}</p></div><div><small>本桥段关键创意描述</small><p>{group.creativeDescription || "—"}</p></div></div>
      {group.shots.map((shot) => <article className={styles.readingShot} key={shot.id} data-readonly-shot={shot.id}>
        <h4>桥段{String(groupIndex + 1).padStart(2, "0")}－镜头{String(numbers.get(shot.id) ?? 0).padStart(2, "0")}</h4>
        {shotGroups.map(({ keys, className }) => <div className={`${styles.readingShotBlock} ${styles[className]}`} data-readonly-shot-group={keys.length} key={keys.join("-")}>{keys.map((key) => <div key={key}><small>{shotLabels[key]}</small><p>{shot[key] || "—"}</p></div>)}</div>)}
      </article>)}
    </section>;
  })}</>;
}

function ReadonlyCore({ draft }: { draft: V04UiDraft }) {
  const rows: Array<[string, string, string]> = [
    [V04_WORKSPACE_TARGETS.commercialIntent, "商业意图", draft.commercialIntent], [V04_WORKSPACE_TARGETS.storySummary, "故事梗概", draft.storySummary], [V04_WORKSPACE_TARGETS.creativeMotif, "创意母题", draft.creativeMotif], [V04_WORKSPACE_TARGETS.tensionButton, "张力按钮", draft.tensionButton],
    [V04_WORKSPACE_TARGETS.primaryMechanism, "创意主导手法及机制", choiceText(draft.primaryMechanism, mechanismLabels)], [V04_WORKSPACE_TARGETS.auxiliaryMechanism, "创意辅助手法及机制", choiceText(draft.auxiliaryMechanism, mechanismLabels)], [V04_WORKSPACE_TARGETS.creativeThinkingChain, "创意思维链", draft.creativeThinkingChain], [V04_WORKSPACE_TARGETS.storyReference, "故事参照类型", choiceText(draft.storyReference, storyLabels)],
    [V04_WORKSPACE_TARGETS.carriers, "创意承重载体", draft.carriers.join("、")], [V04_WORKSPACE_TARGETS.carrierExplanation, "创意承重载体具体说明", draft.carrierExplanation], [V04_WORKSPACE_TARGETS.creativeContract, "创意成立契约（隐含情理）", draft.creativeContract], [V04_WORKSPACE_TARGETS.overallGrade, "整体创意评价", draft.overallGrade], [V04_WORKSPACE_TARGETS.gradeReason, "评价理由", draft.gradeReason],
  ];
  return <div className={styles.readingCore}>{rows.map(([id, label, value]) => <div key={id} id={id}><small>{label}</small><p>{value || "—"}</p></div>)}</div>;
}

export type V04DetailNavigation = { libraryHref: string; detailHref: string; workspaceHref: string; detailLabel?: string; workspaceLabel?: string; compatibilityLinks?: Array<{ href: string; label: string }>; managementHref?: string };
const shadowNavigation = (videoId: string): V04DetailNavigation => ({ libraryHref: "/v04-shadow", detailHref: `/v04-shadow/videos/${encodeURIComponent(videoId)}`, workspaceHref: `/v04-shadow/videos/${encodeURIComponent(videoId)}/workspace`, detailLabel: "只读成果", workspaceLabel: "编辑工作稿" });

export default function V04DetailClient({ videoId, viewerName, embedded = false, showVideo = true, navigation = shadowNavigation(videoId) }: { videoId: string; viewerName: string; embedded?: boolean; showVideo?: boolean; navigation?: V04DetailNavigation }) {
  const tabToken = useRef(`v04-detail-${crypto.randomUUID()}`);
  const [model, setModel] = useState<V04ServerDetailModel | null>(null);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState("--:--");
  const [versionView, setVersionView] = useState<"LATEST" | "EXPERT">("LATEST");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState(false);
  const [comments, setComments] = useState(false);
  useEffect(() => {
    if (!embedded) window.scrollTo({ top: 0, behavior: "auto" });
  }, [embedded]);
  useEffect(() => {
    const controller = new AbortController();
    void v04UiApi.detail<V04ServerDetailModel>(videoId, tabToken.current, controller.signal).then((value) => { setModel(value); setError(""); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof V04UiApiError ? reason.message : "成果暂时无法读取，请稍后重试。"); });
    return () => controller.abort();
  }, [videoId]);
  const item = useMemo(() => model ? v04DetailToUiCase(model) : null, [model]);
  const selectedSubmission = versionView === "EXPERT" && model?.expertPreferredSubmission ? model.expertPreferredSubmission : model?.latestSubmission;
  const draft = selectedSubmission ? v04PayloadToUiDraft(selectedSubmission.payload) : null;
  const toggle = (number: number) => setCollapsed((current) => { const next = new Set(current); if (next.has(number)) next.delete(number); else next.add(number); return next; });
  const shell = `${styles.surface} ${embedded ? styles.embeddedSurface : ""}`.trim();
  if (error) return <section className={shell} data-v04-page="detail"><section className={styles.emptyState}><h2>成果读取失败</h2><p>{error}</p><Link href={navigation.libraryHref}>返回案例库</Link></section></section>;
  if (!item || !model) return <section className={shell} data-v04-page="detail"><section className={styles.emptyState}><h2>正在读取只读成果…</h2></section></section>;
  const content = <>
    {!embedded && <header className={styles.siteHeader} data-v04-fixed-header><Link href={navigation.libraryHref} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link><nav className={styles.siteNav}><span className={styles.headerCaseTitle} data-v04-case-title title={item.title}>{item.title}</span><Link href={navigation.libraryHref}>案例库</Link><Link href={navigation.detailHref} className={styles.activeNav}>{navigation.detailLabel ?? "只读成果"}</Link></nav><div className={styles.siteUtilities}><Link href={navigation.workspaceHref}>{draft ? "编辑工作稿" : "开始公共工作稿"}</Link><button type="button" onClick={() => setHistory(true)}>历史版本</button>{navigation.managementHref ? <Link href={navigation.managementHref}>视频管理</Link> : null}<span>{viewerName}</span></div></header>}
    <section className={embedded ? styles.embeddedIntro : styles.detailHero}>{!embedded && <p className={styles.breadcrumb}><Link href={navigation.libraryHref}>案例库</Link><span>/</span><b>案例分析</b></p>}<p className={styles.detailEyebrow}>{item.brand || "未标注品牌"} · {duration}</p>{embedded ? <h2>当前 V0.4 成果</h2> : <h1>{item.title}</h1>}<p className={styles.detailSummary}>{item.description || "从提交成果中查看脚本结构、全片判断与感知路径。"}</p><div className={styles.detailTags}><span>{V04_UI_STATE_LABELS[item.workState]}</span>{item.expertGrade ? <b>◆ 专家优选 {item.expertGrade}</b> : null}{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>{!embedded && <div className={styles.detailCompatibility}><Link href={navigation.workspaceHref}>{draft ? "编辑公共工作稿" : "开始公共工作稿"}</Link>{navigation.compatibilityLinks?.map((link) => <Link href={link.href} key={link.href}>{link.label}</Link>)}</div>}</section>
    {showVideo ? <V04VideoPlayer caseId={item.id} title={item.title} surface="detail" media={item.media ?? null} onDuration={(seconds) => setDuration(formatDuration(seconds))} /> : null}
    <section className={styles.analysisToolbar}><div><p>CASE ANALYSIS</p><h2>案例分析</h2></div><div><button type="button" onClick={() => setHistory(true)}>版本历史</button><button type="button" onClick={() => setComments(true)}>批注任务</button></div></section>
    {model.latestSubmission ? <section className={styles.versionContext}><div><small>当前阅读</small><strong>{selectedSubmission ? `提交版 V${selectedSubmission.submissionNumber}` : "—"}</strong><span>{selectedSubmission ? `${selectedSubmission.submittedByName} · ${selectedSubmission.submittedAt}` : ""}</span></div>{model.expertPreferredSubmission && <div className={styles.versionSwitch}><button onClick={() => setVersionView("LATEST")} disabled={versionView === "LATEST"}>最新提交 V{model.latestSubmission.submissionNumber}</button><button onClick={() => setVersionView("EXPERT")} disabled={versionView === "EXPERT"}>专家优选 V{model.expertPreferredSubmission.submissionNumber}</button></div>}</section> : null}
    {!draft ? <section className={styles.emptyState}><p>NO SUBMITTED ANALYSIS</p><h2>尚无已提交成果</h2><p>这个案例还没有公开提交版。可以进入公共工作稿，从脚本反写开始填写。</p><Link href={navigation.workspaceHref}>开始公共工作稿</Link></section> : <div className={styles.readingBody} data-v04-readonly-layout="3-2-1-2-2-2">
      <section className={styles.readingModule}><header><div><small>MODULE 01</small><h2>第一模块｜脚本反写</h2></div><button onClick={() => toggle(1)}>{collapsed.has(1) ? "展开" : "收起"}</button></header>{!collapsed.has(1) && <ReadonlyShots draft={draft} />}</section>
      <section className={styles.readingModule}><header><div><small>MODULE 02</small><h2>第二模块｜全片事实与核心判断</h2></div><button onClick={() => toggle(2)}>{collapsed.has(2) ? "展开" : "收起"}</button></header>{!collapsed.has(2) && <ReadonlyCore draft={draft} />}</section>
      <section className={styles.readingModule}><header><div><small>MODULE 03</small><h2>第三模块｜主导感知类型发生路径</h2></div><button onClick={() => toggle(3)}>{collapsed.has(3) ? "展开" : "收起"}</button></header>{!collapsed.has(3) && <div className={styles.readingCore}><div><small>主导路径</small><p>{pathLabels[draft.primaryPath]}</p></div>{draft.primaryPathAnswers[draft.primaryPath].map((value, index) => <div key={index}><small>{V04_UI_PATHS.find((path) => path.id === draft.primaryPath)?.fields[index]}</small><p>{value || "—"}</p></div>)}{draft.auxiliaryPaths.map((path) => <div key={path}><small>辅助路径｜{pathLabels[path]}</small><p>{[draft.auxiliaryPathDetails[path]?.description, draft.auxiliaryPathDetails[path]?.role].filter(Boolean).join(" ｜ ") || "—"}</p></div>)}</div>}</section>
      <section className={styles.readingModule}><header><div><small>MODULE 04</small><h2>第四模块｜提交</h2></div></header><div className={styles.readingCore}><div><small>当前提交版</small><p>{selectedSubmission ? `V${selectedSubmission.submissionNumber} · ${selectedSubmission.submittedAt}` : "—"}</p></div><div><small>工作状态</small><p>{V04_UI_STATE_LABELS[item.workState]}</p></div></div></section>
    </div>}
    <V04HistoryDrawer videoId={item.id} open={history} onClose={() => setHistory(false)} /><V04CommentDrawer videoId={item.id} open={comments} onClose={() => setComments(false)} readOnly />
  </>;
  return embedded ? <section className={shell} data-v04-page="detail" data-v04-embedded>{content}</section> : <main className={shell} data-v04-page="detail">{content}</main>;
}
