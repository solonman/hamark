"use client";

import Link from "next/link";
import { useState } from "react";
import {
  VISUAL_SUBDOMAIN_SPECS,
  visualCarrierLabel,
  visualDetailHref,
  type VisualCaseListItem,
} from "@/lib/visual-contract";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import v04 from "../v04/V04Surface.module.css";
import report from "../report/library/ReportLibrary.module.css";
import styles from "./Visual.module.css";

/** 卡片上的时间只需要「哪天几点」，同 V04LibraryClient 的 formatV19CardTime。 */
function formatCardTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(Math.round(seconds) % 60)}`;
}

const NOT_READY_TOAST = "这条案例还没上传完，完成后才能查看。";

/** 封面：正常（图片/视频缩略图）、预览生成中、预览失败、上传未完成，四态，深色岛。 */
function VisualCover({ item, notify }: { item: VisualCaseListItem; notify: (message: string) => void }) {
  const ready = item.status === "READY";
  const badge = visualCarrierLabel(item.counts);
  const cover = item.cover;

  let picture: React.ReactNode;
  let state: React.ReactNode = null;
  if (!ready) {
    picture = cover?.thumbnailUrl
      ? <img className={report.coverImage} src={cover.thumbnailUrl} alt="" loading="lazy" />
      : <div className={report.coverPlaceholder}>没有预览</div>;
    const total = item.counts.videos + item.counts.images;
    state = (
      <div className={report.coverState}>
        <b>上传未完成</b>
        {item.canManage ? (
          <small>{total} 个文件里有 {item.missingCount} 个没传完，点「继续上传」补传或去掉</small>
        ) : (
          <small>上传完成后才能查看</small>
        )}
      </div>
    );
  } else if (!cover) {
    picture = <div className={report.coverPlaceholder}>没有预览</div>;
  } else if (cover.derivativeStatus === "PENDING") {
    picture = <div className={report.coverPlaceholder}>等待生成预览</div>;
    state = (
      <div className={report.coverState}>
        <b>正在生成预览</b>
        <small>上传已完成，缩略图生成后自动出现</small>
        <div className={report.coverBar}><i className={report.coverBarFill} style={{ width: "40%" }} /></div>
      </div>
    );
  } else if (cover.derivativeStatus === "FAILED") {
    picture = <div className={report.coverPlaceholder}>没有预览</div>;
    state = (
      <div className={`${report.coverState} ${report.coverStateFailed}`}>
        <b>预览生成失败</b>
        <small>{cover.derivativeError || "处理失败；可以查看原图"}</small>
      </div>
    );
  } else {
    picture = <img className={report.coverImage} src={cover.thumbnailUrl ?? undefined} alt="" loading="lazy" />;
  }

  const body = (
    <>
      {picture}
      {badge ? <span className={report.coverFormat}>{badge}</span> : null}
      {ready && cover && cover.derivativeStatus === "READY" && cover.type === "VIDEO" ? (
        <>
          <span className={v04.playButton} aria-hidden>▶</span>
          <span className={report.coverPages}>{formatDuration(cover.durationSeconds)}</span>
        </>
      ) : null}
      {state}
    </>
  );

  if (ready) {
    return (
      <Link href={visualDetailHref(item.id)} className={report.cover} data-v04-scheme="dark" aria-label={`查看《${item.title}》`}>
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={`${report.cover} ${report.busy}`}
      data-v04-scheme="dark"
      aria-label={`《${item.title}》上传未完成`}
      onClick={() => notify(NOT_READY_TOAST)}
    >
      {body}
    </button>
  );
}

export default function VisualCard({
  item,
  caseNumber,
  favoritePending,
  onToggleFavorite,
  onResume,
  deletePending,
  deleteError,
  onDelete,
  notify,
}: {
  item: VisualCaseListItem;
  caseNumber: number;
  favoritePending: boolean;
  onToggleFavorite: (caseId: string, favorited: boolean) => void;
  onResume: (caseId: string) => void;
  /** 这条案例的删除请求是否在途（同一时间全库只有一个删除请求在跑，见 VisualLibrary）。 */
  deletePending: boolean;
  /** 最近一次删除失败的原因；只在这张卡片自己打开确认框时才是它的。 */
  deleteError: string;
  onDelete: (caseId: string) => void;
  notify: (message: string, tone?: "plain" | "warn") => void;
}) {
  const ready = item.status === "READY";
  const subSpec = VISUAL_SUBDOMAIN_SPECS[item.subdomain];
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  let actions: React.ReactNode;
  if (ready) {
    actions = <Link className={v04.caseEnterPill} href={visualDetailHref(item.id)}>查看案例</Link>;
  } else if (item.canManage) {
    actions = (
      <span className={report.retryGroup}>
        <button type="button" className={report.retryButton} onClick={() => onResume(item.id)}>继续上传</button>
        <button
          type="button"
          className={`${report.retryButton} ${report.retryButtonDanger}`.trim()}
          disabled={deletePending}
          onClick={() => setConfirmingDelete(true)}
        >
          {deletePending ? "删除中…" : "删除"}
        </button>
      </span>
    );
  } else {
    actions = (
      <button
        type="button"
        className={report.enterPillDisabled}
        aria-disabled="true"
        onClick={() => notify(NOT_READY_TOAST)}
      >
        上传未完成
      </button>
    );
  }

  return (
    <article className={v04.caseCard} data-case-id={item.id} data-case-status={item.status}>
      <VisualCover item={item} notify={notify} />
      <div className={v04.caseBody}>
        <div className={v04.caseQuickActions}>
          {actions}
          <div className={v04.caseCardMetrics}>
            <button
              type="button"
              className={`${v04.caseFavorite} ${item.viewerFavorited ? v04.caseFavoriteOn : ""}`.trim()}
              aria-pressed={item.viewerFavorited}
              aria-label={`${item.viewerFavorited ? "取消收藏" : "收藏"}《${item.title}》，当前 ${item.favoriteCount} 人收藏`}
              title={!ready ? "案例还没上传完，暂时不能收藏" : item.viewerFavorited ? "已收藏，再点一次取消" : "收藏（不限数量，只是给自己留档）"}
              disabled={!ready || favoritePending}
              onClick={() => onToggleFavorite(item.id, item.viewerFavorited)}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M8 13.7 3.2 9.1a3.1 3.1 0 0 1 0-4.5 3.3 3.3 0 0 1 4.6 0L8 4.8l.2-.2a3.3 3.3 0 0 1 4.6 0 3.1 3.1 0 0 1 0 4.5L8 13.7Z"
                  fill={item.viewerFavorited ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <b>{item.favoriteCount}</b>
            </button>
          </div>
        </div>
        <DeleteConfirmDialog
          open={confirmingDelete}
          heading="删除案例"
          title={item.title}
          lines={[
            "案例会从公共视觉库中移除，保留 90 天，可由上传者或系统管理员恢复；原始素材文件不会被清理。",
            "收藏关系一并保留，恢复后原样回来。",
          ]}
          error={confirmingDelete ? deleteError : ""}
          pending={deletePending}
          onConfirm={() => onDelete(item.id)}
          onCancel={() => setConfirmingDelete(false)}
        />
        <p className={v04.caseNumber}>CASE {String(caseNumber).padStart(2, "0")}</p>
        <div className={v04.caseTitleStatus}>
          <h2><small>{item.creator || "未标注创作方"}</small><span>{item.title}</span></h2>
        </div>
        {item.summary ? <p className={styles.caseSummary}>{item.summary}</p> : null}
        <div className={v04.caseInfoBand}>
          <span className={`${v04.caseCategoryTag} ${styles.subdomainTag}`.trim()} data-sub={item.subdomain}>{subSpec.label}</span>
          <span>上传者 {item.createdByName || "未知"} · {formatCardTime(item.createdAt)}</span>
          {item.location ? <span>{item.location}</span> : null}
          {item.tags.map((tag) => <span className={v04.caseCategoryTag} key={tag}>#{tag}</span>)}
        </div>
      </div>
    </article>
  );
}
