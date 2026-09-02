"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReportAnnotation } from "@/lib/report-structure";
import type { ReportDetail } from "@/lib/report-model";
import type { ReportCurrentVersion, ReportVersionChain, ReportVersionRecord } from "@/lib/report-version-chain";
import { commentsByTarget, emptyCaseReview, type CaseReviewModel } from "@/lib/case-review";
import {
  describeReportSaveFailure,
  isReportDraftDirty,
  pushReportHistory,
  redoReportHistory,
  resetReportHistory,
  shouldWarnBeforeUnload,
  undoReportHistory,
  validateReportDraftLocally,
  REPORT_AUTOSAVE_DEBOUNCE_MS,
  type ReportHistoryState,
  type ReportSaveStatus,
} from "@/lib/report-studio-state";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import V19AssignmentRating from "@/components/v04/V19AssignmentRating";
import {
  commentOnVersion,
  createFileUpload,
  createVersionFrom,
  deleteFile,
  loadAnnotationChain,
  loadReportDetail,
  loadReview,
  putFileContent,
  rateVersion,
  saveAnnotation,
  ReportStudioApiError,
} from "./report-studio-api";
import ReportPartOne from "./ReportPartOne";
import ReportPartTwo from "./ReportPartTwo";
import ReportVersionBar from "./ReportVersionBar";
// 第三部分：deck 已交付并通过验收，直接接真组件。
import ReportDeck from "./deck/ReportDeck";
import { ReportMindMapButton } from "./deck/ReportMindMap";
import type { DeckReviewComment } from "./deck/deck-types";
import v04styles from "@/components/v04/V04Surface.module.css";
import styles from "./ReportStudio.module.css";

export type ReportStudioClientProps = {
  reportId: string;
  initialReport: ReportDetail;
  menuUser: UserMenuUser;
  navigation: { libraryHref: string };
};

type PartId = 1 | 2 | 3;

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 8);
}

/**
 * 把保存成功的结果并回本地的版本链状态：
 * - 之前还没有自己的版本（`id` 是 null 的虚拟占位）→ 用新生成的真实 id 顶替占位项；
 * - 已经有自己的版本 → 原地更新那一条（人数、时间、payload 都换成刚保存的）。
 * 不整链重新拉取——省一次网络请求，其他人版本条目的 `updatedAt` 顶多短暂不是最新，
 * 下次切版本/重新载入会自然刷新，不影响任何判断逻辑。
 */
function applySavedVersion(
  prev: ReportVersionChain,
  saved: ReportCurrentVersion,
): ReportVersionChain {
  const summary: ReportVersionRecord = {
    id: saved.id,
    number: saved.number,
    ownerUserId: saved.ownerUserId,
    ownerName: saved.ownerName,
    baseNumber: saved.baseNumber,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    isMine: true,
    isVirtual: false,
  };
  const hasEntry = prev.versions.some((version) => version.id === saved.id);
  const versions = hasEntry
    ? prev.versions.map((version) => (version.id === saved.id ? summary : version))
    : [...prev.versions.filter((version) => version.id !== null), summary];
  return {
    versions,
    current: saved,
    latestId: prev.latestId ?? saved.id,
    mineId: saved.id,
  };
}

export default function ReportStudioClient({
  reportId,
  initialReport,
  menuUser,
  navigation,
}: ReportStudioClientProps) {
  const [report, setReport] = useState(initialReport);
  const [chain, setChain] = useState<ReportVersionChain | null>(null);
  const [history, setHistory] = useState<ReportHistoryState | null>(null);
  const [review, setReview] = useState<CaseReviewModel>(() => emptyCaseReview());
  const [saveStatus, setSaveStatus] = useState<ReportSaveStatus>({ kind: "IDLE" });
  const [loadError, setLoadError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<PartId>>(() => new Set());

  // 给事件处理器／定时器用的"最新值"镜像：只在 effect 里写，渲染期间绝不写 ref
  // （React 编译器的 lint 规则不允许渲染期间改 ref），读的都是回调触发那一刻的最新值。
  const chainRef = useRef(chain);
  const historyRef = useRef(history);
  const saveStatusRef = useRef(saveStatus);
  useEffect(() => { chainRef.current = chain; }, [chain]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { saveStatusRef.current = saveStatus; }, [saveStatus]);

  const baselineRef = useRef<{ payload: ReportAnnotation; revision: number } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pageNumbers = useMemo(() => report.pages.map((page) => page.pageNo), [report.pages]);

  const clearSaveTimer = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  };

  // `loadChain` 在拿到响应之后才碰 state（第一条语句是 await），但它也被版本切换、
  // 创建版本、409 重新载入等好几处非 effect 的调用点复用，所以没有像
  // `V04LibraryClient` 的片库拉取那样把 fetch 链直接摊平写在 effect 里。
  const loadChain = useCallback(async (versionId?: string | null) => {
    try {
      const nextChain = await loadAnnotationChain(reportId, versionId);
      setChain(nextChain);
      setHistory(resetReportHistory(nextChain.current.payload));
      baselineRef.current = { payload: nextChain.current.payload, revision: nextChain.current.revision };
      setSaveStatus({ kind: "IDLE" });
      setLoadError("");
      const nextReview = await loadReview(reportId, nextChain.current.id).catch(() => emptyCaseReview());
      setReview(nextReview);
    } catch (reason) {
      setLoadError(reason instanceof ReportStudioApiError ? reason.message : "工作台暂时无法读取，请稍后重试。");
    }
  }, [reportId]);

  useEffect(() => {
    // 挂载/重试时读取工作台数据，setState 发生在 loadChain 内部 await 之后
    // （成功或失败分支），不是同步执行；复用同一个 loadChain 是为了让切版本/
    // 建版本/409 重新载入走同一套加载与出错处理，不摊平成单独一份 fetch 链。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChain();
  }, [loadChain, retryToken]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: "auto" }); }, []);

  const flushSave = useCallback(async (): Promise<void> => {
    clearSaveTimer();
    const currentChain = chainRef.current;
    const currentHistory = historyRef.current;
    const baseline = baselineRef.current;
    if (!currentChain || !currentHistory || !baseline) return;
    if (!currentChain.current.isMine) return; // 只读版本没什么好保存的
    if (!isReportDraftDirty(baseline.payload, currentHistory.present)) return;

    const errors = validateReportDraftLocally(currentHistory.present, pageNumbers);
    if (errors.length) {
      setSaveStatus({ kind: "INVALID", errors });
      return;
    }

    setSaveStatus({ kind: "SAVING" });
    try {
      const result = await saveAnnotation(reportId, {
        versionId: currentChain.current.id,
        baseVersionId: null,
        revision: baseline.revision,
        payload: currentHistory.present,
      });
      baselineRef.current = { payload: result.version.payload, revision: result.revision };
      setChain((prev) => (prev ? applySavedVersion(prev, result.version) : prev));
      setSaveStatus(
        result.changed
          ? { kind: "SAVED", at: new Date().toISOString() }
          : { kind: "UNCHANGED", at: new Date().toISOString() },
      );
    } catch (reason) {
      if (reason instanceof ReportStudioApiError) {
        setSaveStatus(describeReportSaveFailure({
          code: reason.code,
          message: reason.message,
          errors: reason.details.errors as string[] | undefined,
          serverRevision: reason.details.serverRevision as number | undefined,
        }));
      } else {
        setSaveStatus({ kind: "ERROR", message: "保存未完成，请稍后重试。" });
      }
    }
  }, [reportId, pageNumbers]);

  const scheduleSave = useCallback(() => {
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => { void flushSave(); }, REPORT_AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  const applyChange = useCallback((next: ReportAnnotation) => {
    if (!chainRef.current?.current.isMine) return;
    setHistory((current) => (current ? pushReportHistory(current, next) : current));
    scheduleSave();
  }, [scheduleSave]);

  const undo = useCallback(() => {
    if (!chainRef.current?.current.isMine) return;
    const current = historyRef.current;
    if (!current) return;
    const next = undoReportHistory(current);
    if (next === current) return;
    setHistory(next);
    scheduleSave();
  }, [scheduleSave]);

  const redo = useCallback(() => {
    if (!chainRef.current?.current.isMine) return;
    const current = historyRef.current;
    if (!current) return;
    const next = redoReportHistory(current);
    if (next === current) return;
    setHistory(next);
    scheduleSave();
  }, [scheduleSave]);

  // Cmd/Ctrl+Z 撤销、Shift+Cmd/Ctrl+Z 重做；焦点在输入框里时让浏览器自己的文本撤销接管。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  // 有没保存的改动、或者正在保存中，离开前拦一下。
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const baseline = baselineRef.current;
      const current = historyRef.current;
      const dirty = !!(baseline && current && isReportDraftDirty(baseline.payload, current.present));
      if (shouldWarnBeforeUnload(saveStatusRef.current, dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  const selectVersion = useCallback(async (versionId: string) => {
    if (chainRef.current?.current.id === versionId) return;
    setSwitching(true);
    try {
      await flushSave();
      await loadChain(versionId);
    } finally {
      setSwitching(false);
    }
  }, [flushSave, loadChain]);

  const createFromCurrent = useCallback(async () => {
    const current = chainRef.current;
    if (!current || !current.current.id) return;
    setSwitching(true);
    try {
      const result = await createVersionFrom(reportId, { fromVersionId: current.current.id });
      await loadChain(result.version.id ?? undefined);
    } catch (reason) {
      setLoadError(reason instanceof ReportStudioApiError ? reason.message : "创建版本失败，请稍后重试。");
    } finally {
      setSwitching(false);
    }
  }, [reportId, loadChain]);

  const reloadCurrent = useCallback(() => {
    void loadChain(chainRef.current?.current.id ?? undefined);
  }, [loadChain]);

  const rate = useCallback(async (stars: number) => {
    const versionId = chainRef.current?.current.id;
    if (!versionId) throw new Error("这一版还没有保存过内容，保存后才能评分。");
    const data = await rateVersion(reportId, versionId, stars);
    setReview((current) => ({ ...current, stars: data.stars }));
  }, [reportId]);

  const comment = useCallback(async (input: { targetKey: string; targetLabel: string; body: string }) => {
    const versionId = chainRef.current?.current.id;
    if (!versionId) throw new Error("这一版还没有保存过内容，保存后才能评论。");
    const data = await commentOnVersion(reportId, { versionId, ...input });
    setReview((current) => ({
      ...current,
      comments: data.comment
        ? [...current.comments.filter((item) => item.targetKey !== input.targetKey), data.comment]
        : current.comments.filter((item) => item.targetKey !== input.targetKey),
    }));
  }, [reportId]);

  const onDeckComment = useCallback(
    (targetKey: string, targetLabel: string, body: string) => comment({ targetKey, targetLabel, body }),
    [comment],
  );

  const uploadFiles = useCallback(async (fileList: FileList) => {
    setFilesBusy(true);
    setFilesError("");
    try {
      for (const file of Array.from(fileList)) {
        const { uploadUrl } = await createFileUpload(reportId, {
          originalName: file.name,
          contentType: file.type,
          fileSize: file.size,
        });
        await putFileContent(uploadUrl, file);
      }
      const { report: refreshed } = await loadReportDetail(reportId);
      setReport(refreshed);
    } catch (reason) {
      setFilesError(reason instanceof ReportStudioApiError ? reason.message : "上传相关资料失败，请稍后重试。");
    } finally {
      setFilesBusy(false);
    }
  }, [reportId]);

  const removeFile = useCallback(async (fileId: string) => {
    setFilesBusy(true);
    setFilesError("");
    try {
      await deleteFile(reportId, fileId);
      setReport((current) => ({ ...current, files: current.files.filter((file) => file.id !== fileId) }));
    } catch (reason) {
      setFilesError(reason instanceof ReportStudioApiError ? reason.message : "移除相关资料失败，请稍后重试。");
    } finally {
      setFilesBusy(false);
    }
  }, [reportId]);

  const toggleCollapsed = (part: PartId) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(part)) next.delete(part); else next.add(part);
      return next;
    });
  };

  if (loadError) {
    return (
      <main className={v04styles.surface} data-v04-page="report-studio">
        <section className={v04styles.emptyState}>
          <h2>工作台读取失败</h2>
          <p>{loadError}</p>
          <button type="button" onClick={() => setRetryToken((token) => token + 1)}>重新读取</button>
        </section>
      </main>
    );
  }
  if (!chain || !history) {
    return (
      <main className={v04styles.surface} data-v04-page="report-studio">
        <section className={v04styles.emptyState}><h2>正在读取工作台…</h2></section>
      </main>
    );
  }

  const readOnly = !chain.current.isMine;
  const reviewDisabled = !chain.current.id;
  const reviewComments = commentsByTarget(review.comments);
  const deckComments = review.comments.reduce<Record<string, DeckReviewComment>>((acc, item) => {
    acc[item.targetKey] = { body: item.body, authorName: item.authorName, updatedAt: item.updatedAt };
    return acc;
  }, {});
  const hasHistory = history.past.length > 0 || history.future.length > 0;
  const annotation = history.present;

  return (
    <main className={v04styles.surface} data-v04-page="report-studio">
      <header className={v04styles.siteHeader} data-v04-fixed-header>
        <div className={v04styles.studioIdentity}>
          <Link href={navigation.libraryHref} className={v04styles.brandWordmark}>
            <b>R:</b><span>RE:VERSE</span><small>反写</small>
          </Link>
        </div>
        <nav className={v04styles.siteNav}>
          <span className={v04styles.studioCaseTitle} title={report.title}>{report.title}</span>
          <span className={v04styles.studioCaseSource}>{report.originalName} · {report.pageCount} 页</span>
        </nav>
        <div className={v04styles.siteUtilities}>
          <div className={v04styles.versionSplit}>
            <ReportVersionBar
              chain={chain}
              busy={switching}
              onSelect={(versionId) => void selectVersion(versionId)}
              onCreateFromCurrent={() => void createFromCurrent()}
              onSwitchToMine={(versionId) => void selectVersion(versionId)}
            />
          </div>
          {!readOnly && hasHistory ? (
            <div className={v04styles.historyControl} role="group" aria-label="撤销与重做">
              <button type="button" onClick={undo} disabled={history.past.length === 0} title="撤销上一步（⌘/Ctrl+Z）">
                ↩ 撤销
              </button>
              <i className={v04styles.historyDivider} />
              <button type="button" onClick={redo} disabled={history.future.length === 0} title="重做（⇧⌘/Ctrl+Z）">
                ↪ 重做
              </button>
            </div>
          ) : null}
          <span
            className={[
              v04styles.saveChip,
              saveStatus.kind === "SAVING" ? v04styles.saveChipSaving : "",
              (saveStatus.kind === "SAVED" || saveStatus.kind === "UNCHANGED") ? v04styles.saveChipSaved : "",
            ].filter(Boolean).join(" ")}
          >
            <span className={v04styles.saveDot} />
            <span>
              {readOnly && "只读，看的是别人的版本"}
              {!readOnly && saveStatus.kind === "IDLE" && "已自动保存"}
              {!readOnly && saveStatus.kind === "SAVING" && "保存中…"}
              {!readOnly && saveStatus.kind === "SAVED" && `已自动保存 · ${formatClock(saveStatus.at)}`}
              {!readOnly && saveStatus.kind === "UNCHANGED" && "没有变化"}
              {!readOnly && saveStatus.kind === "INVALID" && "内容不符合规则，未保存"}
              {!readOnly && saveStatus.kind === "CONFLICT" && saveStatus.message}
              {!readOnly && saveStatus.kind === "ERROR" && saveStatus.message}
            </span>
            {!readOnly && (saveStatus.kind === "IDLE" || saveStatus.kind === "SAVED" || saveStatus.kind === "UNCHANGED") ? (
              <button type="button" onClick={() => void flushSave()}>保存</button>
            ) : null}
            {!readOnly && saveStatus.kind === "ERROR" ? (
              <button type="button" onClick={() => void flushSave()}>重试</button>
            ) : null}
          </span>
          <UserMenu user={menuUser} />
        </div>
      </header>

      <div className={styles.titleBand}>
        <h1 className={styles.titleBandTitle}>{report.title}</h1>
        <div className={styles.titleBandMeta}>
          <span className={`${styles.chip} ${styles.chipAccent}`}>{report.taskType || "未选择任务类型"}</span>
          {report.tags.map((tag) => (
            <span className={styles.chip} key={tag}>#{tag}</span>
          ))}
          <span className={styles.chip}>上传者 {report.createdByName}</span>
          <span className={styles.chip}>{report.pageCount} 页</span>
        </div>
      </div>

      {saveStatus.kind === "INVALID" ? (
        <div className={styles.saveBanner} role="alert">
          <div>
            <p>内容不符合规则，还没有保存：</p>
            <ul>
              {saveStatus.errors.map((message) => <li key={message}>{message}</li>)}
            </ul>
          </div>
        </div>
      ) : null}
      {saveStatus.kind === "CONFLICT" ? (
        <div className={styles.saveBanner} role="alert">
          <p>{saveStatus.message}</p>
          <button type="button" onClick={reloadCurrent}>重新载入</button>
        </div>
      ) : null}

      <div className={styles.main}>
        <section className={styles.mod}>
          <header className={styles.modHeader}>
            <div className={styles.modHeaderLeft}>
              <div>
                <small className={styles.modEyebrow}>PART 01</small>
                <h2 className={styles.modTitle}>第一部分｜案例背景与资料</h2>
              </div>
            </div>
            <div className={styles.modActions}>
              <button type="button" className={styles.sm} onClick={() => toggleCollapsed(1)}>
                {collapsed.has(1) ? "展开" : "收起"}
              </button>
            </div>
          </header>
          {!collapsed.has(1) ? (
            <ReportPartOne
              report={report}
              annotation={annotation}
              readOnly={readOnly}
              onChange={applyChange}
              review={{
                canReview: review.canReview,
                disabled: reviewDisabled,
                comments: reviewComments,
                onSave: comment,
              }}
              files={{
                items: report.files,
                canManage: !readOnly,
                busy: filesBusy,
                error: filesError,
                onUpload: (fileList) => void uploadFiles(fileList),
                onDelete: (fileId) => void removeFile(fileId),
              }}
            />
          ) : null}
        </section>

        <section className={styles.mod}>
          <header className={styles.modHeader}>
            <div className={styles.modHeaderLeft}>
              <div>
                <small className={styles.modEyebrow}>PART 02</small>
                <h2 className={styles.modTitle}>第二部分｜竞争与提报策略</h2>
              </div>
            </div>
            <div className={styles.modActions}>
              <button type="button" className={styles.sm} onClick={() => toggleCollapsed(2)}>
                {collapsed.has(2) ? "展开" : "收起"}
              </button>
            </div>
          </header>
          {!collapsed.has(2) ? (
            <ReportPartTwo
              annotation={annotation}
              readOnly={readOnly}
              onChange={applyChange}
              review={{
                canReview: review.canReview,
                disabled: reviewDisabled,
                comments: reviewComments,
                onSave: comment,
              }}
            />
          ) : null}
        </section>

        <section className={styles.mod}>
          <header className={styles.modHeader}>
            <div className={styles.modHeaderLeft}>
              <div>
                <small className={styles.modEyebrow}>PART 03</small>
                <h2 className={styles.modTitle}>第三部分｜报告详细拆解</h2>
              </div>
            </div>
            <div className={styles.modActions}>
              <ReportMindMapButton annotation={annotation} pages={report.pages} />
              <button type="button" className={styles.sm} onClick={() => toggleCollapsed(3)}>
                {collapsed.has(3) ? "展开" : "收起"}
              </button>
            </div>
          </header>
          {!collapsed.has(3) ? (
            <ReportDeck
              pages={report.pages}
              annotation={annotation}
              readOnly={readOnly}
              onChange={applyChange}
              review={{
                canReview: review.canReview,
                comments: deckComments,
                onComment: onDeckComment,
              }}
            />
          ) : null}
        </section>

        <V19AssignmentRating
          stars={review.stars}
          canReview={review.canReview}
          versionLabel={`v${chain.current.number} · ${chain.current.ownerName}`}
          disabled={reviewDisabled}
          onRate={rate}
        />
      </div>
    </main>
  );
}
