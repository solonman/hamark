"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatStars, pickTopCaseRating, type CaseEngagement } from "@/lib/case-engagement";
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

/** 封面：READY 是缩略图 + 页数角标；其余三态是占位图 + 状态条（进度／排队／失败原因）。 */
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
  } else if (report.status === "QUEUED" || report.status === "UPLOADING") {
    state = (
      <div className={styles.coverState}>
        <b>{reportStatusLabel(report.status)}</b>
        <small>上传完成，等待转换</small>
        <div className={styles.coverBar}><i className={styles.coverBarFill} style={{ width: "3%" }} /></div>
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
  favoritePending,
  onToggleFavorite,
  retryPending,
  onRetry,
  deletePending,
  onDelete,
  onReplaceWithPdf,
  notify,
}: {
  report: ReportListItemView;
  caseNumber: number;
  engagement: CaseEngagement;
  favoritePending: boolean;
  onToggleFavorite: (reportId: string) => void;
  retryPending: boolean;
  onRetry: (reportId: string) => void;
  deletePending: boolean;
  onDelete: (reportId: string) => void;
  onReplaceWithPdf: (target: { reportId: string; title: string; taskType: string; tags: string[] }) => void;
  /** 点击未就绪的封面/主按钮时弹的提示，状态由 ReportLibrary 的 useReportToast 统一管理。 */
  notify: (message: string) => void;
}) {
  const ready = report.status === "READY";
  const versionText = reportVersionSummaryLabel(report.status, report.versionSummary);

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
                onClick={() => {
                  if (window.confirm(`确认删除《${report.title}》？删除后不可恢复。`)) onDelete(report.id);
                }}
              >
                {deletePending ? "删除中…" : "删除"}
              </button>
            </span>
          ) : (
            // demo：<a class="enter" aria-disabled="true"> + pointer-events:none，鼠标点不动，
            // 键盘 Tab+Enter 还能触发（demo 第 118、189、251 行）；这里用真 <button> 复刻同样的手感。
            <button
              type="button"
              className={styles.enterPillDisabled}
              aria-disabled="true"
              onClick={() => notify(NOT_READY_TOAST)}
            >
              {reportEnterLabel(report.status)}
            </button>
          )}
          <div className={v04.caseCardMetrics}>
            <button
              type="button"
              className={`${v04.caseFavorite} ${engagement.viewerFavorited ? v04.caseFavoriteOn : ""}`.trim()}
              aria-pressed={engagement.viewerFavorited}
              aria-label={`${engagement.viewerFavorited ? "取消收藏" : "收藏"}《${report.title}》，${REPORT_FAVORITE_BALLOT}，当前 ${engagement.favoriteCount} 人收藏`}
              title={!ready
                ? "报告还没就绪，暂时不能收藏"
                : engagement.viewerFavorited
                  ? `本周这一票投给了这份报告（${REPORT_FAVORITE_BALLOT}），再点一次撤回`
                  : `把本周这一票投给这份报告（${REPORT_FAVORITE_BALLOT}）`}
              disabled={!ready || favoritePending}
              onClick={() => onToggleFavorite(report.id)}
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
