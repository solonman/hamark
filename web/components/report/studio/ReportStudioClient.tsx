"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReportAnnotation, ReportDeckKey } from "@/lib/report-structure";
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
  trashReport,
  ReportStudioApiError,
} from "./report-studio-api";
import ReportPartOne from "./ReportPartOne";
import ReportPartTwo from "./ReportPartTwo";
import ReportVersionBar from "./ReportVersionBar";
// 第三部分：deck 已交付并通过验收，直接接真组件。
import ReportDeck from "./deck/ReportDeck";
import { ReportMindMapButton } from "./deck/ReportMindMap";
import { deckSummary } from "./deck/deck-view";
import v04styles from "@/components/v04/V04Surface.module.css";
import styles from "./ReportStudio.module.css";

export type ReportStudioClientProps = {
  reportId: string;
  initialReport: ReportDetail;
  /** 顶栏末尾的身份文字——照抄 `V04StudioClient` 的做法（纯文本，不是可交互的用户菜单）。 */
  viewerName: string;
  /** 上传者或管理员——决定"删除报告"入口是否露出，跟当前看的是谁的版本无关（对齐视频侧 `viewerCapabilities.canTrash`）。 */
  canManage: boolean;
  navigation: { libraryHref: string };
};

/** 分步引导的关闭状态存本地，跟 deck 自己的列宽记忆（`DECK_COLUMN_WIDTH_STORAGE_KEY`）同一个前缀习惯。 */
const GUIDE_OFF_STORAGE_KEY = "report-deck:guide-off";

function readStoredGuideOff(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_OFF_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
function storeGuideOff(off: boolean) {
  try {
    window.localStorage.setItem(GUIDE_OFF_STORAGE_KEY, off ? "1" : "0");
  } catch { /* ignore */ }
}

/** 第三部分标题栏右侧的统计 chip 文案，逐字照 demo `module3()`（约 773 行）。 */
function formatDeckSummary(annotation: ReportAnnotation): string {
  const s = deckSummary(annotation);
  const going = s.inProgressPages ? `（在标 ${s.inProgressPages}）` : "";
  return `${s.moduleCount} 模块 · ${s.unitCount} 单元 · ${s.blockCount} 组块 ｜ 已填完 ${s.donePages}/${s.totalPages} 页${going}`;
}

type PartId = 1 | 2 | 3;

/** HH:MM，照 demo 的 `S.saveAt`（`pad(d.getHours())+":"+pad(d.getMinutes())`，约 549 行）。 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 5);
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
  viewerName,
  canManage,
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
  // 上传者删除入口：做法与视频只读成果页（`V04DetailClient`）逐字对应——先弹确认条，
  // 确认后调用同一套软删接口，成功跳回报告库；显示只看 canManage，跟正看着谁的版本无关。
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [trashError, setTrashError] = useState("");
  // 分步引导整体开关：demo 里"引导"重开按钮在 PART 03 标题栏（约 775～777 行），
  // 关闭状态由外壳持有并存本地，deck 收到 `guideOff` 就不再自己渲染引导。
  const [guideOff, setGuideOff] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 从 localStorage 读初始值，SSR 期间不存在更早的时机
    setGuideOff(readStoredGuideOff());
  }, []);
  const updateGuideOff = useCallback((off: boolean) => {
    setGuideOff(off);
    storeGuideOff(off);
  }, []);

  // "定位"高亮当前指向哪个收纳框：脑图点节点（`ReportMindMapButton`，跟
  // deck 平级、不共享内部 state）与 deck 点收纳框标题栏背景都要能改它，
  // 所以提到外壳受控，对应 demo 第 1230～1234 行 `S.focus=key`。不持久化，
  // 纯会话内状态（demo 里也是内存变量，刷新即丢）。
  const [focusKey, setFocusKey] = useState<ReportDeckKey | null>(null);

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
    // 一个条目现在可能挂着好几个版本各写的一条评论，所以按 (versionId, targetKey)
    // 替换，不能再只按 targetKey——那会把别的版本写的那条也顶掉
    // （对齐 V04StudioClient.tsx 的 saveReviewComment）。
    setReview((current) => {
      const others = current.comments.filter(
        (item) => !(item.targetKey === input.targetKey && item.versionId === versionId),
      );
      return { ...current, comments: data.comment ? [...others, data.comment] : others };
    });
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
      <main className={`${v04styles.surface} ${styles.studio}`} data-v04-page="report-studio">
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
      <main className={`${v04styles.surface} ${styles.studio}`} data-v04-page="report-studio">
        <section className={v04styles.emptyState}><h2>正在读取工作台…</h2></section>
      </main>
    );
  }

  const readOnly = !chain.current.isMine;
  const reviewDisabled = !chain.current.id;
  // 评论现在按条目汇总这份报告所有版本上写的那些（对齐视频侧 loadCaseReview，
  // 见 lib/report-review-server.ts 顶部注释），第一、二部分原样把整份列表往下传,
  // 由 V19ReviewComment 自己按 currentVersionId 挑出哪一条是「本版」。
  const reviewComments = commentsByTarget(review.comments);
  // deck（第三部分）现在也是「跨版本汇总、标本版」口径，跟第一、二部分同一套
  // （见 docs/20 一之 A、deck-types.ts 的 review.comments 注释）——直接把
  // `reviewComments`（Map）转成 deck 要的 Record，不用再单独挑出当前版本那条。
  const deckComments = Object.fromEntries(reviewComments);
  const annotation = history.present;

  return (
    <main className={`${v04styles.surface} ${styles.studio}`} data-v04-page="report-studio">
      <header className={v04styles.siteHeader} data-v04-fixed-header>
        <div className={v04styles.studioIdentity}>
          <Link href={navigation.libraryHref} className={v04styles.brandWordmark}>
            <b>R:</b><span>RE:VERSE</span><small>反写</small>
          </Link>
        </div>
        <nav className={`${v04styles.siteNav} ${styles.studioNav}`}>
          <span className={v04styles.studioCaseTitle} title={report.title}>{report.title}</span>
          <span className={v04styles.studioCaseSource}>{report.originalName} · {report.pageCount} 页</span>
        </nav>
        <div className={`${v04styles.siteUtilities} ${styles.studioUtilities}`}>
          {canManage ? (
            <button
              type="button"
              className={styles.trashButton}
              disabled={trashing}
              onClick={() => { setTrashError(""); setConfirmingTrash(true); }}
            >
              删除报告
            </button>
          ) : null}
          <div className={v04styles.versionSplit}>
            <ReportVersionBar
              chain={chain}
              busy={switching}
              onSelect={(versionId) => void selectVersion(versionId)}
              onCreateFromCurrent={() => void createFromCurrent()}
              onSwitchToMine={(versionId) => void selectVersion(versionId)}
            />
          </div>
          {/* 与视频工作台的撤销/重做完全一样（`V04StudioClient.tsx` 约 1356～1374
              行）：同一个 `v04styles.historyControl`/`historyDivider`、同一套 svg 图标、
              文案、title、快捷键提示、disabled 逻辑，逐字复制而不是抽共享组件——
              `V04StudioClient` 那段 JSX 直接耦合它自己的 `historyDepth`/`undoEdit`/
              `redoEdit`，抽出来牵动视频侧渲染与其测试的风险，跟"两边体验一致"这个
              目标比不成正比；这里只把变量换成报告侧自己的 `history`/`undo`/`redo`，
              类名、结构、文案一律不动。 */}
          {!readOnly && (history.past.length > 0 || history.future.length > 0) && (
            <div className={v04styles.historyControl} role="group" aria-label="撤销与重做">
              <button type="button" onClick={undo} disabled={history.past.length === 0}
                title="撤销上一步（⌘/Ctrl+Z）" aria-label="撤销上一步">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.2 6.6h6.3a3.3 3.3 0 0 1 0 6.6H6.1" /><path d="M5.8 3.6 3 6.6l2.8 3" />
                </svg>
                <span>撤销</span>
              </button>
              <i className={v04styles.historyDivider} />
              <button type="button" onClick={redo} disabled={history.future.length === 0}
                title="重做（⌘/Ctrl+Shift+Z）" aria-label="重做">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12.8 6.6H6.5a3.3 3.3 0 0 0 0 6.6h3.4" /><path d="M10.2 3.6 13 6.6l-2.8 3" />
                </svg>
                <span>重做</span>
              </button>
            </div>
          )}
          <span
            className={[
              v04styles.saveChip,
              // 报告工作台头部比视频侧多一个「删除报告」按钮，1280 宽时 saveChip 默认的
              // flex:0 1 auto（v04 侧 .saveChip 未设置 flex 时的浏览器初始值，≤1200px
              // 媒体查询里还显式再设了一遍）会先被压缩，"已保存 23:53" 截成"已保存 23"。
              // styles.studioSaveChip 用 span.studioSaveChip 复合选择器把特异性提到比
              // v04 侧单类选择器 .saveChip 更高，不论落在哪个断点都固定 flex:none——
              // 不改共享的 V04Surface.module.css，纯叠加，视频工作台不受影响。
              styles.studioSaveChip,
              saveStatus.kind === "SAVING" ? v04styles.saveChipSaving : "",
              (saveStatus.kind === "SAVED" || saveStatus.kind === "UNCHANGED") ? v04styles.saveChipSaved : "",
            ].filter(Boolean).join(" ")}
          >
            <span className={v04styles.saveDot} />
            <span>
              {readOnly && "只读，看的是别人的版本"}
              {!readOnly && saveStatus.kind === "IDLE" && `已保存 ${formatClock(chain.current.updatedAt)}`}
              {!readOnly && saveStatus.kind === "SAVING" && "保存中…"}
              {!readOnly && saveStatus.kind === "SAVED" && `已保存 ${formatClock(saveStatus.at)}`}
              {!readOnly && saveStatus.kind === "UNCHANGED" && "没有变化"}
              {!readOnly && saveStatus.kind === "INVALID" && "内容不符合规则，未保存"}
              {!readOnly && saveStatus.kind === "CONFLICT" && saveStatus.message}
              {!readOnly && saveStatus.kind === "ERROR" && saveStatus.message}
            </span>
            {!readOnly && saveStatus.kind === "ERROR" ? (
              <button type="button" onClick={() => void flushSave()}>重试</button>
            ) : null}
          </span>
          <span>{viewerName}</span>
        </div>
      </header>

      {confirmingTrash ? (
        <section className={v04styles.recoveryBanner} role="alertdialog" aria-label="删除报告">
          <div>
            <b>把《{report.title}》移入回收站？</b>
            <span>报告会从报告库中移除，保留 90 天，可由上传者或系统管理员恢复；原始报告文件不会被清理。</span>
            <span>已有的拆解版本、评分和评论都会一并保留，不会被删除。</span>
            {trashError ? <p role="alert">{trashError}</p> : null}
          </div>
          <div>
            <button
              type="button"
              disabled={trashing}
              onClick={() => {
                void (async () => {
                  setTrashing(true);
                  setTrashError("");
                  try {
                    await trashReport(reportId);
                    window.location.assign(navigation.libraryHref);
                  } catch (reason) {
                    setTrashError(reason instanceof ReportStudioApiError ? reason.message : "删除未完成，报告未发生变化，可重试。");
                    setTrashing(false);
                  }
                })();
              }}
            >
              {trashing ? "正在移入回收站…" : "确认移入回收站"}
            </button>
            <button type="button" disabled={trashing} onClick={() => setConfirmingTrash(false)}>取消</button>
          </div>
        </section>
      ) : null}

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
                currentVersionId: chain.current.id,
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
                currentVersionId: chain.current.id,
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
              {/* 用户定案：脑图按钮挪到标题栏右侧这一组的最前面，顺序
                  [引导（仅引导关闭时）] [◎ 查看脑图] [统计 chip] [收起]；
                  样式与"有模块时才显示"的条件都不变，只是从贴着标题挪过来。 */}
              {!collapsed.has(3) ? (
                <>
                  {guideOff ? (
                    <button
                      type="button"
                      className={styles.sm}
                      title="重新显示分步引导"
                      onClick={() => updateGuideOff(false)}
                    >
                      引导
                    </button>
                  ) : null}
                  <ReportMindMapButton
                    annotation={annotation}
                    pages={report.pages}
                    reportTitle={report.title}
                    onGoTo={(key) => setFocusKey(key as ReportDeckKey)}
                  />
                  <span className={styles.chip}>{formatDeckSummary(annotation)}</span>
                </>
              ) : null}
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
              guideOff={guideOff}
              onGuideOffChange={updateGuideOff}
              focusKey={focusKey}
              onFocusKeyChange={setFocusKey}
              review={{
                canReview: review.canReview,
                currentVersionId: chain.current.id ?? "",
                comments: deckComments,
                onComment: onDeckComment,
              }}
            />
          ) : null}
        </section>

        {/* 报告没有集成版，`canRate` 在这里基本等价于"当前版本已经落库"，
            但仍然照抄视频侧口径由 `review.canRate` 把关（见
            lib/report-review-server.ts 顶部注释），不是自己另起一套判断。 */}
        {review.canRate && (
          <V19AssignmentRating
            stars={review.stars}
            canReview={review.canReview}
            versionLabel={`v${chain.current.number} · ${chain.current.ownerName}`}
            disabled={reviewDisabled}
            onRate={rate}
          />
        )}
      </div>
    </main>
  );
}
