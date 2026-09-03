"use client";

import { useMemo, useState } from "react";
import ReportDeck from "@/components/report/studio/deck/ReportDeck";
import { ReportMindMapButton } from "@/components/report/studio/deck/ReportMindMap";
import { deckSummary } from "@/components/report/studio/deck/deck-view";
import { emptyReportAnnotation, type ReportAnnotation, type ReportDeckKey } from "@/lib/report-structure";
import { isCaseReviewer, type CaseReviewComment } from "@/lib/case-review";
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
