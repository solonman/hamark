"use client";

import type { JSX } from "react";
import type { RetroMonthView } from "@/lib/retro-model";
import {
  formatRetroTime,
  retroJobSteps,
  retroLiveJob,
  retroPreconditionItems,
} from "@/lib/retro-ui";
import { AudioReviewIcon } from "../v04/V19AudioReviewParts";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

/**
 * 月份页 hero 右侧的老孙操作区（规格 10.5，只有老孙能看到）。五态：
 * 未整理（前提清单 + 生成按钮）／整理中（三步进度）／失败（原因、重试、放弃）／待审阅（草稿说明，操作在吸底栏）／已发布（修订、重新生成）。
 * 只管渲染和把点击交出去；确认框、接口调用在 RetroMonthClient 里。
 */
export default function RetroSunPanel({
  view,
  busy,
  draftSavedAt,
  onGenerate,
  onRetry,
  onAbandonJob,
  onRevise,
}: {
  view: RetroMonthView;
  busy: boolean;
  draftSavedAt: string;
  onGenerate: () => void;
  onRetry: () => void;
  onAbandonJob: () => void;
  onRevise: () => void;
}): JSX.Element {
  const job = retroLiveJob(view);
  const pre = view.preconditions;
  const latest = view.latestPublication;
  const unrecorded = view.cases.filter((row) => row.recording.state === "NONE").map((row) => row.number);
  let body: JSX.Element;

  if (job && job.status !== "PENDING_REVIEW") {
    const failed = job.status === "FAILED";
    const progress = retroJobSteps(job);
    body = (
      <>
        <h3>{failed ? "整理失败" : "正在整理"}</h3>
        <span className={`${styles.procChip} ${failed ? styles.failed : ""}`.trim()} style={{ justifySelf: "start" }}>
          {failed ? <AudioReviewIcon name="mic" /> : <span className={v04.reviewSpin} aria-hidden="true" />}
          {failed ? "整理失败" : `整理中 · ${progress.currentLabel}`}
        </span>
        <ol className={v04.reviewSteps}>
          {progress.steps.map((step, index) => {
            const cls = step.state === "done" ? v04.reviewStepDone : step.state === "doing" ? v04.reviewStepDoing : step.state === "fail" ? v04.reviewStepFail : undefined;
            const label = step.key === "EXTRACT" ? "逐案提炼" : step.key === "SUMMARIZE" ? "汇总纪要" : "汇总方法";
            return (
              <li key={step.key} className={cls}>
                <i>{step.state === "done" ? "✓" : step.state === "fail" ? "!" : ""}</i>
                {label}
                {index === 0 ? <small>{progress.extractLabel}</small> : null}
              </li>
            );
          })}
        </ol>
        {failed ? (
          <>
            <p className={styles.warnLine}>{job.failReason || "整理没有完成，原因未知。"}</p>
            <div className={styles.sunActs}>
              <button type="button" className={v04.reviewPrimaryButton} disabled={busy} onClick={onRetry}>重试</button>
              <button type="button" className={`${v04.reviewGhostButton} ${v04.reviewDangerButton}`} disabled={busy} onClick={onAbandonJob}>放弃</button>
            </div>
          </>
        ) : (
          <p>每一步只做一次模型调用，做完一步自己接着推进下一步，可以关掉页面；一般要 10–15 分钟，回来也接得上。</p>
        )}
      </>
    );
  } else if (job && job.status === "PENDING_REVIEW") {
    body = (
      <>
        <h3>草稿已生成 · 等你审阅</h3>
        <p>
          草稿只有你看得到。每一条悬停可以「改」「删」，各节末尾可以「＋ 补充一条」；改动失焦自动保存。
          {job.revisingFromVersion ? `这份草稿复制自 v${job.revisingFromVersion}，没有调模型。` : ""}
        </p>
        <p>{draftSavedAt ? `已保存 ${draftSavedAt}` : "还没有改动"}</p>
        <p>发布、放弃、重新生成在页面底部的吸底栏。</p>
      </>
    );
  } else if (latest) {
    body = (
      <>
        <h3>已发布 v{latest.versionNumber} · {formatRetroTime(latest.publishedAt)} {latest.publishedByName}</h3>
        {view.changedSincePublish > 0
          ? <p className={styles.warnLine}>发布后有 {view.changedSincePublish} 段录音变动，可以重新生成。</p>
          : <p>全员可见。发现错字用「修订已发布内容」：复制成新草稿（不调模型），改完再发布成 v{latest.versionNumber + 1}。</p>}
        <div className={styles.sunActs}>
          <button type="button" className={v04.reviewGhostButton} disabled={busy} onClick={onRevise}>修订已发布内容</button>
          <button type="button" className={v04.reviewGhostButton} disabled={busy || !pre.canGenerate} onClick={onGenerate}>重新生成</button>
        </div>
        {pre.canGenerate ? null : <p>{pre.blockedReason ?? "有录音还在转写，完成后才能重新生成。"}</p>}
      </>
    );
  } else {
    body = (
      <>
        <h3>整理本月成果</h3>
        <ul className={styles.preList}>
          {retroPreconditionItems(pre, unrecorded).map((item) => (
            <li key={item.text} data-ok={item.ok}>
              <i>{item.ok === "yes" ? "✓" : item.ok === "no" ? "×" : "!"}</i>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
        <button type="button" className={`${v04.reviewPrimaryButton} ${styles.startBtn}`} disabled={busy || !pre.canGenerate} onClick={onGenerate}>
          生成本月纪要与方法记录
        </button>
        {pre.canGenerate
          ? <p>AI 先逐个案例提炼，再汇总成教学纪要和方法提取记录；你审阅、修改、确认后才发布。</p>
          : <p className={styles.warnLine}>{pre.blockedReason ?? "至少要有一个案例的点评录音转写完成。"}</p>}
      </>
    );
  }

  return (
    <aside className={styles.sunPanel} aria-label="老孙的操作区">
      <small>老孙的操作区 · 只有你看得到</small>
      {body}
    </aside>
  );
}
