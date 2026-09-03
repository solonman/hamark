"use client";

import { useMemo, useState } from "react";
import ReportDeck from "@/components/report/studio/deck/ReportDeck";
import { ReportMindMapButton } from "@/components/report/studio/deck/ReportMindMap";
import { ReportReaderButton } from "@/components/report/studio/deck/ReportReader";
import { deckSummary } from "@/components/report/studio/deck/deck-view";
import { emptyReportAnnotation, type ReportAnnotation, type ReportDeckKey } from "@/lib/report-structure";
import { isCaseReviewer, type CaseReviewComment } from "@/lib/case-review";
import { deriveReportFinalTraceModel, type ReportFinalTraceModel } from "@/lib/report-final-trace";
import type { ReportFinalTraceIntake } from "@/lib/report-final-version";
import type { ReportPageView } from "@/lib/report-model";
import v04styles from "@/components/v04/V04Surface.module.css";

/**
 * 本地开发用的最小外壳：不接版本链/保存/评审 API，annotation 与评论都只在
 * 浏览器内存里，用来单独测 `ReportDeck` 本身的交互。评审身份判定直接复用
 * 视频侧 `lib/case-review.ts` 的 `isCaseReviewer`（"老孙才能评审"，同一套
 * 显示名口径，报告侧没有另立一套评审身份规则）。包一层 `v04styles.surface`——
 * `ReportSelect`/`ReportCombobox`（外壳交付，见 `../../../components/report/
 * studio/ReportSelect.tsx`）的样式吃 `--v04-*` 变量，真正的工作台由
 * `ReportStudioClient` 包这一层，这个预览页自己不包就会看到下拉控件没有
 * 边框/背景色（变量取不到值）。
 */

/** 一段小的起始结构（2 模块、含嵌套子单元、留一段自由页），比空白报告更方便测嵌套/拖边界/退回未归入。 */
function seedAnnotation(pageNumbers: number[]): ReportAnnotation {
  const base = emptyReportAnnotation(pageNumbers);
  const has = (n: number) => pageNumbers.includes(n);
  if (!has(1) || pageNumbers.length < 20) return base; // 页数不够就别硬凑，直接给空结构

  const modules = [
    { id: "M1", name: "营销命题", rel: "推导", role: "示例模块：用于测试拖动改边界与浮层。" },
    { id: "M2", name: "", rel: "推导", role: "" },
  ];
  const units = [
    { id: "U1", mid: "M1", pid: null as string | null, name: "单元一", rel: "并列", task: "", role: "", psy: "", concl: "" },
    { id: "U2", mid: "M1", pid: null as string | null, name: "单元二", rel: "转折", task: "", role: "", psy: "", concl: "" },
    { id: "U2a", mid: "M1", pid: "U2" as string | null, name: "子单元", rel: "展开", task: "", role: "", psy: "", concl: "" },
  ];
  const unitOf = (n: number): string | null => {
    if (n >= 1 && n <= 5) return "U1";
    if (n >= 6 && n <= 7) return "U2";
    if (n >= 8 && n <= 10) return "U2a";
    return null;
  };
  const pages = base.pages.map((p) => {
    if (p.n >= 1 && p.n <= 10) return { ...p, mid: "M1", uid: unitOf(p.n) };
    if (p.n >= 11 && p.n <= 20) return { ...p, mid: "M2" };
    return p;
  });
  return { ...base, modules, units, pages };
}

// 预览页没有真的版本链，用一个固定 id 充当"当前正在看的版本"——评论口径
// 跟 ReportPartOne/V19StudioDocument 一致（按 targetKey 存这个条目在所有
// 版本上的评论列表），这里就只会有这一个版本在写。
const DEV_VERSION_ID = "dev-preview";
const DEV_VERSION_LABEL = "预览版";

/**
 * 溯源自测：一批假的"写法记录"，喂给真实的 `deriveReportFinalTraceModel`
 * 推出模型——不是手搭 `ReportFinalTraceModel` 的既定形状，走跟生产一样的
 * 归并/分流路径，更接近真实自测。覆盖模块 1 的"策略作用"（一条已采用历史 +
 * 一条未纳入）、讲述单元 1-1 的划分来源（同样一条历史 + 一条未纳入）、外加
 * 一条"新增单元"未纳入结构变更（横幅那一类，deck 自己不渲染横幅，但
 * `structurePending` 字段要有数据才测得出 `finalTrace` 整体没漏东西）。
 * 值特意跟 `seedAnnotation` 现在的实际内容对上（M1 的 role、U1 的页范围），
 * 这样"当前采用"那行不会看着像瞎编的。
 */
function seedFinalIntakes(): ReportFinalTraceIntake[] {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  return [
    {
      id: "fake-role-1", seq: 1, kind: "FIELD", targetKey: "module:M1:role", targetLabel: "模块 1·策略作用",
      value: "早期草稿：先讲区位优势。", source: "VERSION", sourceVersionNumber: 1, actorName: "赵雅诗",
      applied: true, createdAt: day(6),
    },
    {
      id: "fake-role-2", seq: 2, kind: "FIELD", targetKey: "module:M1:role", targetLabel: "模块 1·策略作用",
      value: "示例模块：用于测试拖动改边界与浮层。", source: "VERSION", sourceVersionNumber: 2, actorName: "老王",
      applied: true, createdAt: day(3),
    },
    {
      id: "fake-role-3", seq: 3, kind: "FIELD", targetKey: "module:M1:role", targetLabel: "模块 1·策略作用",
      value: "改成强调稀缺性的说法。", source: "VERSION", sourceVersionNumber: 3, actorName: "老李",
      applied: false, createdAt: day(1),
    },
    {
      id: "fake-span-1", seq: 4, kind: "SPAN", targetKey: "unit:U1", targetLabel: "讲述单元 1-1",
      value: { pageNumbers: [1, 2, 3, 4] }, source: "VERSION", sourceVersionNumber: 1, actorName: "赵雅诗",
      applied: true, createdAt: day(6),
    },
    {
      id: "fake-span-2", seq: 5, kind: "SPAN", targetKey: "unit:U1", targetLabel: "讲述单元 1-1",
      value: { pageNumbers: [1, 2, 3, 4, 5] }, source: "VERSION", sourceVersionNumber: 2, actorName: "老王",
      applied: true, createdAt: day(3),
    },
    {
      id: "fake-span-3", seq: 6, kind: "SPAN", targetKey: "unit:U1", targetLabel: "讲述单元 1-1",
      value: { pageNumbers: [1, 2, 3, 4, 5, 6] }, source: "VERSION", sourceVersionNumber: 3, actorName: "老李",
      applied: false, createdAt: day(1),
    },
    {
      id: "fake-insert-1", seq: 7, kind: "INSERT_UNIT", targetKey: "unit:fake-new", targetLabel: "新增单元「候选新单元」",
      value: {}, source: "VERSION", sourceVersionNumber: 3, actorName: "老李",
      applied: false, createdAt: day(1),
    },
  ];
}

export default function DevReportDeckClient({
  pages, reportTitle, viewerName,
}: { pages: ReportPageView[]; reportTitle: string; viewerName: string }) {
  const initial = useMemo(() => seedAnnotation(pages.map((p) => p.pageNo)), [pages]);
  const [annotation, setAnnotation] = useState<ReportAnnotation>(initial);
  const [comments, setComments] = useState<Record<string, CaseReviewComment[]>>({});
  const [guideOff, setGuideOff] = useState(false);
  // 脑图节点点击要点亮左列（demo 第 1230～1234 行 `S.focus=key`），"定位"
  // state 受控化之后由持有它的人（这里是预览页自己，真实工作台是
  // `ReportStudioClient`）在 `ReportDeck` 和 `ReportMindMapButton` 之间接线。
  const [focusKey, setFocusKey] = useState<ReportDeckKey | null>(null);
  const canReview = isCaseReviewer(viewerName);
  const summary = deckSummary(annotation);

  // 溯源开关＋假数据自测（docs/21 一之 D、五、18/19）。`finalIntakes` 放
  // state 而不是每次渲染现算——「采纳这一版」要能把某条从未纳入挪进历史，
  // 这个开关本身也得测得出效果，不能是一份写死拿不动的样例。
  const [traceMode, setTraceMode] = useState(false);
  const [finalIntakes, setFinalIntakes] = useState<ReportFinalTraceIntake[]>(seedFinalIntakes);
  const finalTraceOrigin = useMemo(() => emptyReportAnnotation(pages.map((p) => p.pageNo)), [pages]);
  const finalTrace: ReportFinalTraceModel = useMemo(
    () => deriveReportFinalTraceModel(finalTraceOrigin, finalIntakes, annotation),
    [finalTraceOrigin, finalIntakes, annotation],
  );
  const handleAdopt = async (intakeIds: string[]) => {
    setFinalIntakes((current) => current.map((intake) => (
      intakeIds.includes(intake.id) ? { ...intake, applied: true } : intake
    )));
  };

  return (
    <div className={v04styles.surface} style={{ padding: "18px 20px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <h1 style={{ color: "#e6e7df", fontSize: 15, margin: 0, fontFamily: "ui-monospace,monospace" }}>
          ReportDeck 预览 · {reportTitle}
        </h1>
        <span style={{ color: "#92958b", fontSize: 11 }}>身份：{viewerName}{canReview ? "（可评审）" : "（只读评审）"}</span>
        {/* 这三样都是 demo PART 03 标题栏（modHead 的 extra/leftExtra 位）的
            内容，deck 自己不画：统计栏（stat chip）与"引导"重开按钮由外壳用
            `deckSummary`/`guideOff` 拼出来，脑图入口是 `ReportMindMapButton`。
            这个预览页没有外壳的标题栏，所以在这里补一份，三个功能才都测得到。 */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #2a2c26", borderRadius: 999, padding: "5px 10px", fontSize: 10, color: "#92958b", whiteSpace: "nowrap" }}>
          {summary.moduleCount} 模块 · {summary.unitCount} 单元 · {summary.blockCount} 组块 ｜ 已填完 {summary.donePages}/{summary.totalPages} 页
          {summary.inProgressPages ? `（在标 ${summary.inProgressPages}）` : ""}
        </span>
        {guideOff ? (
          <button
            type="button"
            title="重新显示分步引导"
            onClick={() => setGuideOff(false)}
            style={{ border: "1px solid #2a2c26", borderRadius: 999, padding: "4px 11px", fontSize: 10.5, color: "#92958b", background: "transparent", cursor: "pointer" }}
          >
            引导
          </button>
        ) : null}
        {/* 真实工作台是顶栏"默认 | 溯源"分段开关（规格五、14，外壳负责画），
            这里只是自测用的一个开关按钮，够切换 traceMode 就行，不用照抄
            分段开关的视觉。 */}
        <button
          type="button"
          onClick={() => setTraceMode((current) => !current)}
          style={{
            border: `1px solid ${traceMode ? "#dfff4f" : "#2a2c26"}`, borderRadius: 999, padding: "4px 11px",
            fontSize: 10.5, color: traceMode ? "#dfff4f" : "#92958b",
            background: traceMode ? "rgba(223,255,79,.1)" : "transparent", cursor: "pointer",
          }}
        >
          溯源：{traceMode ? "开" : "关"}
        </button>
        {/* 真实工作台的顺序是"查看报告 → 查看脑图 → 统计 → 收起"（外壳把这
            两个按钮摆进 PART 03 标题栏最前面）；"统计"/"收起"在这个预览页里
            分别是上面那条统计条 span 和 `guideOff` 重开按钮，位置摆在这两个
            之前就够贴近真实顺序，不用为了严格对齐再重排整条标题行。 */}
        <ReportReaderButton pages={pages} reportTitle={reportTitle} />
        <ReportMindMapButton
          annotation={annotation} pages={pages} reportTitle={reportTitle}
          onGoTo={(key) => setFocusKey(key as ReportDeckKey)}
        />
        <button
          type="button"
          onClick={() => setAnnotation(emptyReportAnnotation(pages.map((p) => p.pageNo)))}
          style={{ border: "1px solid #444", borderRadius: 999, padding: "5px 12px", fontSize: 11, color: "#e6e7df", background: "#171815", cursor: "pointer" }}
        >
          重置为空结构（测引导）
        </button>
        <button
          type="button"
          onClick={() => setAnnotation(seedAnnotation(pages.map((p) => p.pageNo)))}
          style={{ border: "1px solid #444", borderRadius: 999, padding: "5px 12px", fontSize: 11, color: "#e6e7df", background: "#171815", cursor: "pointer" }}
        >
          重置为示例结构
        </button>
      </div>
      <ReportDeck
        pages={pages}
        annotation={annotation}
        readOnly={false}
        onChange={setAnnotation}
        guideOff={guideOff}
        onGuideOffChange={setGuideOff}
        focusKey={focusKey}
        onFocusKeyChange={setFocusKey}
        traceMode={traceMode}
        finalTrace={finalTrace}
        onAdopt={handleAdopt}
        review={{
          canReview,
          currentVersionId: DEV_VERSION_ID,
          comments,
          onComment: async (targetKey, targetLabel, body) => {
            setComments((current) => {
              const rest = (current[targetKey] ?? []).filter((item) => item.versionId !== DEV_VERSION_ID);
              if (!body.trim()) return { ...current, [targetKey]: rest };
              const mine: CaseReviewComment = {
                targetKey, targetLabel, body, authorName: viewerName,
                updatedAt: new Date().toISOString(), versionId: DEV_VERSION_ID, versionLabel: DEV_VERSION_LABEL,
              };
              return { ...current, [targetKey]: [...rest, mine].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) };
            });
          },
        }}
      />
    </div>
  );
}
