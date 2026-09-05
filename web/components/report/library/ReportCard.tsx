"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CASE_BALLOT_EXHAUSTED_MESSAGE,
  ballotHint,
  formatStars,
  pickTopCaseRating,
  remainingBallots,
  type CaseEngagement,
} from "@/lib/case-engagement";
import {
  REPORT_FAVORITE_BALLOT,
  reportEnterLabel,
  reportFormatBadgeLabel,
  reportProcessingPercent,
  reportStatusLabel,
  reportVersionSummaryLabel,
  type ReportListItemView,
} from "@/lib/report-library-view";
import v04 from "../../v04/V04Surface.module.css";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import styles from "./ReportLibrary.module.css";

/** 老孙给作业版本的评级，卡片上只读；未就绪的报告谈不上评级，调用方不渲染这个组件。
    与 V04LibraryClient 里的 CaseRating 同一交互，报告卡片单独拷一份，两边各自维护互不牵连。 */
function ReportRating({ engagement }: { engagement: CaseEngagement }) {
  const [showAll, setShowAll] = useState(false);
  const anchorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!showAll) return;
    const close = (event: Event) => {
      if (!anchorRef.current?.contains(event.target as Node)) setShowAll(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setShowAll(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showAll]);

  const top = pickTopCaseRating(engagement.ratings);
  if (!top) {
    return (
      <p className={`${v04.caseRating} ${v04.caseRatingEmpty}`} title="老孙尚未给这份报告的作业评级">
        <i aria-hidden>{formatStars(0)}</i>
        <span>待评级</span>
      </p>
    );
  }
  const others = engagement.ratings.filter((rating) => rating.versionNumber !== top.versionNumber);
  return (
    <p
      ref={anchorRef}
      className={v04.caseRating}
      title={`老孙的作业评级：${engagement.ratings.map((rating) => `v${rating.versionNumber} ${rating.stars} 星`).join("，")}`}
    >
      <span aria-label={`最高评级 v${top.versionNumber} ${top.stars} 星`}>
        <b aria-hidden>v{top.versionNumber}</b>
        <i aria-hidden>{formatStars(top.stars)}</i>
      </span>
      {others.length ? (
        <button
          type="button"
          className={v04.caseRatingMore}
          aria-expanded={showAll}
          title={`另有 ${others.length} 个版本的评级`}
          onClick={() => setShowAll((current) => !current)}
        >
          更多
        </button>
      ) : null}
      {showAll && others.length ? (
        <span className={v04.caseRatingPanel} role="note">
          <b>其余版本评级</b>
          {[...others].sort((left, right) => left.versionNumber - right.versionNumber).map((rating) => (
            <span key={rating.versionNumber}>
              <b aria-hidden>v{rating.versionNumber}</b>
              <i aria-hidden>{formatStars(rating.stars)}</i>
              <em>{rating.ownerName}</em>
            </span>
          ))}
        </span>
      ) : null}
    </p>
  );
}

/** demo 里点击未就绪的东西弹的那句提示（demo 第 251 行 data-enter 的委托处理）。 */
const NOT_READY_TOAST = "页图还没生成好，先等一下。";

/** 封面：READY 是缩略图 + 页数角标；其余四态是占位图 + 状态条（进度／排队／上传未完成／失败原因）。 */
function ReportCover({ report, notify }: { report: ReportListItemView; notify: (message: string) => void }) {
  const ready = report.status === "READY";
  const picture = report.coverUrl
    ? <img className={styles.coverImage} src={report.coverUrl} alt="" loading="lazy" />
    : <div className={styles.coverPlaceholder}>{report.status === "FAILED" ? "没有页图" : "等待生成页图"}</div>;

  let state: React.ReactNode = null;
  if (report.status === "PROCESSING") {
    const percent = reportProcessingPercent(report.pagesDone, report.pageCount);
    state = (
      <div className={styles.coverState}>
        <b>正在生成页图 {report.pagesDone} / {report.pageCount}</b>
        <small>PPT → PDF 已完成，逐页渲染中，完成后自动就绪</small>
        <div className={styles.coverBar}><i className={styles.coverBarFill} style={{ width: `${percent}%` }} /></div>
      </div>
    );
  } else if (report.status === "QUEUED") {
    state = (
      <div className={styles.coverState}>
        <b>{reportStatusLabel(report.status)}</b>
        <small>上传完成，等待转换</small>
        <div className={styles.coverBar}><i className={styles.coverBarFill} style={{ width: "3%" }} /></div>
      </div>
    );
  } else if (report.status === "UPLOADING") {
    // 浏览器直传中途失败、complete 从未被调用时会卡在这一态：文件根本没传完，
    // 压根没进排队/转换的队列，不该再配一条暗示「正在推进」的进度条——删除后
    // 重新上传是唯一出路，跟 QUEUED（已经传完、只是在等转换）分开呈现。
    state = (
      <div className={styles.coverState}>
        <b>{reportStatusLabel(report.status)}</b>
        <small>文件没有传完，删除后重新上传即可</small>
      </div>
    );
  } else if (report.status === "FAILED") {
    state = (
      <div className={`${styles.coverState} ${styles.coverStateFailed}`}>
        <b>转换失败</b>
        {report.failReason ? <small>{report.failReason}</small> : null}
        <div className={styles.coverBar}><i className={`${styles.coverBarFill} ${styles.coverBarError}`} style={{ width: "100%" }} /></div>
      </div>
    );
  }

  const body = (
    <>
      {picture}
      <span className={styles.coverFormat}>{reportFormatBadgeLabel(report.sourceFormat)}</span>
      {ready ? <span className={styles.coverPages}>{report.pageCount} 页</span> : null}
      {state}
    </>
  );

  if (ready) {
    return (
      <Link href={`/reports/${encodeURIComponent(report.id)}`} className={styles.cover} aria-label={`进入《${report.title}》拆解工作台`}>
        {body}
      </Link>
    );
  }
  // demo 的封面在未就绪时仍是一个真链接（href="#"，data-enter），点了会弹 toast（demo 第 181、251
  // 行）——这里用真正的 <button> 而不是一个静态 <div>，鼠标点击/键盘 Enter 都能触发同一句提示。
  return (
    <button
      type="button"
      className={`${styles.cover} ${styles.busy}`}
      aria-label={`《${report.title}》${reportStatusLabel(report.status)}，点击查看`}
      onClick={() => notify(NOT_READY_TOAST)}
    >
      {body}
    </button>
  );
}

export default function ReportCard({
  report,
  caseNumber,
  engagement,
  ballotsUsed,
  onToggleFavorite,
  retryPending,
  onRetry,
  deletePending,
  deleteError,
  onDelete,
  onReplaceWithPdf,
  notify,
}: {
  report: ReportListItemView;
  caseNumber: number;
  engagement: CaseEngagement;
  /** 这份报告所属那一周，本人已经投掉几票——决定还能不能再投，以及按钮上那句「还剩几票」。 */
  ballotsUsed: number;
  onToggleFavorite: (reportId: string, weekKey: string, favorited: boolean) => void;
  retryPending: boolean;
  onRetry: (reportId: string) => void;
  deletePending: boolean;
  /** 最近一次删除失败的原因（ReportLibrary 统一管的一个字符串，同一时间只有一个删除请求在途，
      所以哪张卡片的确认条开着，这条错误就该算它的）；没出错时是空字符串。 */
  deleteError: string;
  onDelete: (reportId: string) => void;
  onReplaceWithPdf: (target: { reportId: string; title: string; taskType: string; tags: string[] }) => void;
  /** 点击未就绪的封面/主按钮时弹的提示，状态由 ReportLibrary 的 useLibraryToast 统一管理。 */
  notify: (message: string) => void;
}) {
  const ready = report.status === "READY";
  const versionText = reportVersionSummaryLabel(report.status, report.versionSummary);
  // 删除是不可逆的破坏性操作，不能用浏览器原生 confirm()（挡不住、样式不可控、不适合无头/自动化
  // 测试）——改成跟工作台删除同一个弹出式确认对话框（components/shared/DeleteConfirmDialog.tsx，
  // components/report/studio/ReportStudioClient.tsx 同一组件），只在点了「删除」的这张卡片上打开。
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <article className={v04.caseCard} data-report-id={report.id} data-report-status={report.status}>
      <ReportCover report={report} notify={notify} />
      <div className={v04.caseBody}>
        <div className={v04.caseQuickActions}>
          {ready ? (
            <Link className={v04.caseEnterPill} href={`/reports/${encodeURIComponent(report.id)}`}>进入工作台</Link>
          ) : report.status === "FAILED" && report.canManage ? (
            <span className={styles.retryGroup}>
              <button
                type="button"
                className={styles.retryButton}
                disabled={retryPending || deletePending}
                onClick={() => onRetry(report.id)}
              >
                {retryPending ? "重试中…" : "重试"}
              </button>
              <button
                type="button"
                className={styles.retryButton}
                disabled={retryPending || deletePending}
                title="打开上传对话框，换一份 PDF 重新走一遍转换；成功后会自动删掉这份失败的记录"
                onClick={() => onReplaceWithPdf({
                  reportId: report.id,
                  title: report.title,
                  taskType: report.taskType,
                  tags: report.tags,
                })}
              >
                改传 PDF
              </button>
              <button
                type="button"
                className={`${styles.retryButton} ${styles.retryButtonDanger}`.trim()}
                disabled={retryPending || deletePending}
                onClick={() => setConfirmingDelete(true)}
              >
                {deletePending ? "删除中…" : "删除"}
              </button>
            </span>
          ) : (
            // 排队中／转换中／上传未完成（以及不是自己上传、点不动重试的失败报告）走这一支。
            // demo：<a class="enter" aria-disabled="true"> + pointer-events:none，鼠标点不动，
            // 键盘 Tab+Enter 还能触发（demo 第 118、189、251 行）；这里用真 <button> 复刻同样的手感。
            // 就绪之前工作台进不去，删除入口只能开在库首页——canManage 的人这几态都能删，
            // 不必等到转换失败才有退路；就绪之后不再显示（就绪报告改在工作台里删）。
            <span className={styles.retryGroup}>
              <button
                type="button"
                className={styles.enterPillDisabled}
                aria-disabled="true"
                onClick={() => notify(NOT_READY_TOAST)}
              >
                {reportEnterLabel(report.status)}
              </button>
              {report.canManage ? (
                <button
                  type="button"
                  className={`${styles.retryButton} ${styles.retryButtonDanger}`.trim()}
                  disabled={deletePending}
                  onClick={() => setConfirmingDelete(true)}
                >
                  {deletePending ? "删除中…" : "删除"}
                </button>
              ) : null}
            </span>
          )}
          <div className={v04.caseCardMetrics}>
            <button
              type="button"
              className={`${v04.caseFavorite} ${engagement.viewerFavorited ? v04.caseFavoriteOn : ""}`.trim()}
              aria-pressed={engagement.viewerFavorited}
              aria-label={`${engagement.viewerFavorited ? "取消收藏" : "收藏"}《${report.title}》，${REPORT_FAVORITE_BALLOT}，${ballotHint(ballotsUsed)}，当前 ${engagement.favoriteCount} 人收藏`}
              title={!ready
                ? "报告还没就绪，暂时不能收藏"
                : engagement.viewerFavorited
                  ? `这份报告占着你本周的一票（${REPORT_FAVORITE_BALLOT}，${ballotHint(ballotsUsed)}），再点一次撤回`
                  : remainingBallots(ballotsUsed)
                    ? `把本周的一票投给这份报告（${REPORT_FAVORITE_BALLOT}，${ballotHint(ballotsUsed)}）`
                    : CASE_BALLOT_EXHAUSTED_MESSAGE}
              disabled={!ready}
              onClick={() => onToggleFavorite(report.id, engagement.weekKey, engagement.viewerFavorited)}
            >
              {/* ♡ 与 ♥ 是两个字形，字体给的宽高并不一致；同一段路径只切换填充，描边和实心才是同一颗心。 */}
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M8 13.7 3.2 9.1a3.1 3.1 0 0 1 0-4.5 3.3 3.3 0 0 1 4.6 0L8 4.8l.2-.2a3.3 3.3 0 0 1 4.6 0 3.1 3.1 0 0 1 0 4.5L8 13.7Z"
                  fill={engagement.viewerFavorited ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <b>{engagement.favoriteCount}</b>
            </button>
            {ready ? <ReportRating engagement={engagement} /> : null}
          </div>
        </div>
        {/* 弹出式确认对话框（components/shared/DeleteConfirmDialog.tsx），不是浏览器原生
            confirm()，也不是页内确认条——组件本身用 `open` 控制显隐、portal 到 document.body，
            只在点了「删除」的这张卡片上打开，不影响列表里其它卡片。 */}
        <DeleteConfirmDialog
          open={confirmingDelete}
          heading="删除报告"
          title={report.title}
          lines={["报告会从报告库中移除，保留 90 天，可由上传者或系统管理员恢复；原始报告文件不会被清理。"]}
          error={deleteError}
          pending={deletePending}
          onConfirm={() => onDelete(report.id)}
          onCancel={() => setConfirmingDelete(false)}
        />
        <p className={v04.caseNumber}>CASE {String(caseNumber).padStart(2, "0")}</p>
        <div className={v04.caseTitleStatus}>
          <h2><small>{report.originalName}</small><span>{report.title}</span></h2>
        </div>
        <div className={v04.caseInfoBand}>
          <span className={`${v04.caseCategoryTag} ${styles.taskTypeTag}`.trim()}>{report.taskType || "未选任务类型"}</span>
          <span>上传者 {report.createdByName || "未知"}</span>
          <span>{versionText}</span>
          {report.tags.map((tag) => <span className={v04.caseCategoryTag} key={tag}>#{tag}</span>)}
        </div>
      </div>
    </article>
  );
}
