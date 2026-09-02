"use client";

import { useState } from "react";
import { deckSummary, guideStepIndex } from "./deck-view";
import styles from "./ReportDeck.module.css";
import type { ReportAnnotation } from "@/lib/report-structure";

/**
 * 分步引导：三步只展开当前步的空态大版，有结构后缩成一条进度条，随时能关。
 * 关闭状态可以由外壳受控（`guideOff`/`onGuideOffChange`，对应 demo 里 PART 03
 * 标题栏那个"引导"重开按钮——demo 第 775～777 行，`modHead` 的 `extra` 位）：
 * 关掉之后 deck 这边不渲染任何东西，重开入口在外壳的标题栏，不在这个组件
 * 里画第二个。没传这两个 prop 时退回内部 state 自己记账，且此时没有任何重
 * 开入口——只给没有外壳标题栏的独立预览场景兜底，不是常规用法。措辞照抄
 * demo 的 `GUIDE_STEPS`（`docs/demos/2026-09-01-报告拆解工作台demo-V2.html`
 * 约 916 行）——它已经是"从页图外面按住拉框选中连续页"的准确描述，没有"按住
 * 一页拖到另一页"那种会跟"拖页搬运"混淆的说法。
 */

type GuideStep = { title: string; body: React.ReactNode; tip: string; doneLabel: (a: ReportAnnotation) => string };

const GUIDE_STEPS: GuideStep[] = [
  {
    title: "划模块",
    body: (
      <>在左边<b>从页图外面按住、拉一个框</b>罩住一段连续的页（或者点一页、再 Shift＋点另一页），会浮出「设为模块 1」，点它。</>
    ),
    tip: "按在页图上拖是搬运，不是选；要选就从页图外面起手。一个模块＝报告里连续的一大段，名字可选可写。",
    doneLabel: (a) => `${a.modules.length} 个模块已划好`,
  },
  {
    title: "划单元",
    body: (
      <>在模块框里<b>用同样的方法</b>选一段页，浮出「设为单元 1-1」。要再拆细，就在单元框里再选一段，成为子单元。</>
    ),
    tip: "托盘里变灰的页＝已收进下级；把页拖到别的框上可以改归属。",
    doneLabel: (a) => `${a.units.length} 个单元已划好`,
  },
  {
    title: "标注",
    body: (
      <>点收纳框标题栏的「标注」填这一段的条目；<b>双击任意一页</b>（或 hover 出现的「标注」）打开页面与组块的标注窗，用 ←→ 翻页。</>
    ),
    tip: "左列和导航条上打勾的页＝已填完。填到哪算哪，随时能回来。",
    doneLabel: (a) => {
      const s = deckSummary(a);
      return `已填完 ${s.donePages}/${s.totalPages} 页`;
    },
  },
];

export type ReportGuideProps = {
  annotation: ReportAnnotation;
  guideOff?: boolean;
  onGuideOffChange?: (off: boolean) => void;
};

export default function ReportGuide({ annotation, guideOff, onGuideOffChange }: ReportGuideProps) {
  const [internalDismissed, setInternalDismissed] = useState(false);
  const dismissed = guideOff ?? internalDismissed;
  const setDismissed = onGuideOffChange ?? setInternalDismissed;
  const cur = guideStepIndex(annotation);

  if (dismissed) {
    // 重开入口在外壳的 PART 03 标题栏（demo 第 775～777 行的 `guideBtn`），
    // 不在这里画第二个；没受控（没传 onGuideOffChange）时纯粹是独立预览
    // 场景的兜底，关掉之后确实没有任何重开入口，这不算 bug。
    return null;
  }

  if (cur === 0) {
    return (
      <div className={`${styles.guide} ${styles.guideBig}`}>
        <div className={styles.ghead}>
          <small>怎么拆</small>
          <h3>三步：划模块 → 划单元 → 标注</h3>
          <button type="button" className={styles.gx} title="关掉引导" onClick={() => setDismissed(true)}>×</button>
        </div>
        <ol className={styles.gsteps}>
          {GUIDE_STEPS.map((step, index) => {
            const state = index < cur ? styles.gstepDone : index === cur ? styles.gstepCur : "";
            return (
              <li key={step.title} className={`${styles.gstep} ${state}`.trim()}>
                <b>{index < cur ? "✓" : index + 1}</b>
                <div>
                  <h4>{step.title}</h4>
                  {index === cur ? (
                    <>
                      <p>{step.body}</p>
                      <p className={styles.gstepTip}>{step.tip}</p>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  const step = GUIDE_STEPS[cur];
  return (
    <div className={`${styles.guide} ${styles.guideBar}`}>
      <ol className={styles.gbar}>
        {GUIDE_STEPS.map((s, index) => (
          <li key={s.title} className={index < cur ? styles.gbarDone : index === cur ? styles.gbarCur : undefined}
            title={index < cur ? s.doneLabel(annotation) : s.title}>
            <b>{index < cur ? "✓" : index + 1}</b>{s.title}
            {index < 2 ? <i className={styles.gbarSep} /> : null}
          </li>
        ))}
      </ol>
      <p><b>第 {cur + 1} 步</b>　{step.body}</p>
      <button type="button" className={styles.gx} title="关掉引导" onClick={() => setDismissed(true)}>×</button>
    </div>
  );
}
