"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ReportDetail } from "@/lib/report-model";
import { loadReportDetail, retryReport, ReportStudioApiError } from "./report-studio-api";
import v04styles from "@/components/v04/V04Surface.module.css";
import styles from "./ReportStudio.module.css";

/**
 * 报告还没有 READY（排队中／生成页图中／转换失败）时渲染这个，代替工作台。
 * 排队中／生成中每 10 秒刷新一次进度；转为 READY 后用 `router.refresh()`
 * 让服务端组件重新判定分支，自动切到工作台，不需要整页刷新。
 */

const STATUS_COPY: Record<string, { eyebrow: string; title: string }> = {
  UPLOADING: { eyebrow: "STATUS", title: "原件上传中" },
  QUEUED: { eyebrow: "STATUS", title: "排队等待生成页图" },
  PROCESSING: { eyebrow: "STATUS", title: "正在生成页图" },
  FAILED: { eyebrow: "STATUS", title: "转换失败" },
};

export type ReportStatusPageProps = {
  reportId: string;
  initialReport: ReportDetail;
  /** 原上传者或管理员才能看到「重试」——判定与规格 `canManageReport` 一致，服务端算好直接传下来。 */
  canManage: boolean;
  libraryHref: string;
};

export default function ReportStatusPage({ reportId, initialReport, canManage, libraryHref }: ReportStatusPageProps) {
  const router = useRouter();
  const [report, setReport] = useState(initialReport);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (report.status === "READY") return;
    const shouldPoll = report.status === "QUEUED" || report.status === "PROCESSING" || report.status === "UPLOADING";
    if (!shouldPoll) return;
    pollingRef.current = setInterval(() => {
      void loadReportDetail(reportId)
        .then(({ report: next }) => {
          setReport(next);
          if (next.status === "READY") router.refresh();
        })
        .catch(() => {
          // 轮询失败不打扰用户，等下一次 tick 再试。
        });
    }, 10_000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [report.status, reportId, router]);

  const copy = STATUS_COPY[report.status] ?? STATUS_COPY.QUEUED;

  const retry = async () => {
    setRetrying(true);
    setRetryError("");
    try {
      await retryReport(reportId);
      router.refresh();
    } catch (reason) {
      setRetryError(reason instanceof ReportStudioApiError ? reason.message : "重试失败，请稍后再试。");
    } finally {
      setRetrying(false);
    }
  };

  const progress = report.pageCount > 0 ? Math.min(100, Math.round((report.pagesDone / report.pageCount) * 100)) : 0;

  return (
    <main className={v04styles.surface} data-v04-page="report-status">
      <header className={v04styles.siteHeader}>
        <Link href={libraryHref} className={v04styles.brandWordmark}>
          <b>R:</b>
          <span>RE:VERSE</span>
          <small>反写</small>
        </Link>
        <nav className={v04styles.siteNav}>
          <span className={v04styles.studioCaseTitle} title={report.title}>{report.title}</span>
        </nav>
        <div className={v04styles.siteUtilities}>
          <Link href={libraryHref}>返回报告库</Link>
        </div>
      </header>
      <section className={v04styles.emptyState}>
        <span>{report.status === "FAILED" ? "⚠" : "◫"}</span>
        <p className={styles.statusEyebrow}>{copy.eyebrow}</p>
        <h2>{copy.title}</h2>
        {report.status === "FAILED" ? (
          <p>{report.failReason || "转换过程中出现问题，具体原因暂未记录。"}</p>
        ) : (
          <p>
            报告正在生成页图，生成完成后会自动进入工作台
            {report.pageCount ? `（${report.pagesDone}/${report.pageCount}）` : ""}。
          </p>
        )}
        {report.status !== "FAILED" && report.pageCount > 0 ? (
          <div className={styles.statusProgress}>
            <div className={styles.statusProgressFill} style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {report.status === "FAILED" && canManage ? (
          <button type="button" onClick={() => void retry()} disabled={retrying}>
            {retrying ? "正在重试…" : "重试"}
          </button>
        ) : (
          <Link href={libraryHref}>先回报告库</Link>
        )}
        {retryError ? <p className={styles.fieldError}>{retryError}</p> : null}
      </section>
    </main>
  );
}
