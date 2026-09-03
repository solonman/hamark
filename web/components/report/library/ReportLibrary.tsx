"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { emptyCaseEngagement, type CaseEngagement } from "@/lib/case-engagement";
import { readJsonResponse } from "@/lib/http-json";
import {
  applyFrozenReportOrder,
  filterReports,
  freezeReportOrder,
  hasPendingConversion,
  reportEngagementFallback,
  reportWeeklyGroups,
  REPORT_FAVORITE_BALLOT,
  type ReportFavoriteToggleResult,
  type ReportListItemView,
  type ReportReplaceTarget,
} from "@/lib/report-library-view";
import v04 from "../../v04/V04Surface.module.css";
import ReportCard from "./ReportCard";
import { ReportToastStack, useReportToast } from "./ReportToast";

/** 只要列表里还有没转完的报告，就每 10 秒悄悄拉一次；比案例库那种一次性加载更频繁，
    因为转换是后台脚本异步在跑，用户在等它从「排队中」变成「可拆解」。 */
const POLL_INTERVAL_MS = 10_000;

async function fetchReports(signal: AbortSignal): Promise<ReportListItemView[]> {
  const response = await fetch("/api/reports", { cache: "no-store", signal });
  const data = await readJsonResponse<{ reports?: ReportListItemView[]; error?: string }>(response, "报告库读取");
  if (!response.ok) throw new Error(data.error || "报告库读取失败");
  return data.reports ?? [];
}

/** 收藏与评级读不出来不该拖垮整个报告库，读失败就当作还没有人收藏，与视频库的 loadEngagement 同一策略。 */
async function fetchReportEngagement(
  reportIds: string[],
  signal: AbortSignal,
): Promise<Record<string, CaseEngagement>> {
  if (!reportIds.length) return {};
  const search = new URLSearchParams(reportIds.map((id) => ["reportId", id]));
  try {
    const response = await fetch(`/api/report-engagement?${search}`, { cache: "no-store", signal });
    if (!response.ok) return {};
    const data = await readJsonResponse<{ engagement?: Record<string, CaseEngagement> }>(response, "报告互动读取");
    return data.engagement ?? {};
  } catch {
    return {};
  }
}

export default function ReportLibrary({
  refreshToken,
  onRequestUpload,
}: {
  /** 每次变化都触发一次完整重新加载；上传对话框成功后由上层把它加一，让新报告出现在列表里。 */
  refreshToken: number;
  /** 不传 replacing 就是普通新建；「改传 PDF」会带上旧报告的预填信息，交给上层决定怎么打开对话框。 */
  onRequestUpload: (replacing?: ReportReplaceTarget) => void;
}) {
  const [reports, setReports] = useState<ReportListItemView[]>([]);
  const [engagement, setEngagement] = useState<Record<string, CaseEngagement>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState("");
  const [weeklyView, setWeeklyView] = useState(false);
  // 按周视图里的名次是冻结的：投票只改票数，不让卡片从鼠标底下窜走（做法与视频库一致）。
  const [frozenOrder, setFrozenOrder] = useState<ReadonlyMap<string, number> | null>(null);
  const [favoritePendingId, setFavoritePendingId] = useState("");
  const [favoriteError, setFavoriteError] = useState("");
  const [retryPendingId, setRetryPendingId] = useState("");
  const [retryError, setRetryError] = useState("");
  const [deletePendingId, setDeletePendingId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const { toasts, notify } = useReportToast();

  const load = useCallback(async (signal: AbortSignal) => {
    const list = await fetchReports(signal);
    const engagementResult = await fetchReportEngagement(list.map((item) => item.id), signal);
    return { list, engagementResult };
  }, []);

  useEffect(() => {
    // 只有第一次加载会走这里的「正在读取」大状态（loading 初始就是 true）；refreshToken
    // 之后的重新加载不再把 loading 拨回 true，免得上传完一份新报告，整张列表先被清成一句提示再刷回来。
    const controller = new AbortController();
    load(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setReports(next.list);
        setEngagement(next.engagementResult);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "报告库暂时无法读取，请稍后重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, refreshToken]);

  // 轮询只在还有 QUEUED/PROCESSING 的报告时开；标签页切到后台（document.hidden）的那一拍直接跳过。
  useEffect(() => {
    if (!hasPendingConversion(reports)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void load(controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setReports(next.list);
          setEngagement((current) => ({ ...current, ...next.engagementResult }));
        })
        .catch(() => { /* 轮询失败静默重试，不打断已经展示的列表 */ });
    }, POLL_INTERVAL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [reports, load]);

  const engagementOf = useCallback(
    (report: ReportListItemView) => engagement[report.id] ?? reportEngagementFallback(report),
    [engagement],
  );

  // CASE 编号按完整列表（不受搜索/按周影响）的顺序派生，和视频库的 caseIndexById 同一做法。
  const reportIndexById = useMemo(
    () => new Map(reports.map((report, index) => [report.id, index + 1])),
    [reports],
  );

  const visible = useMemo(() => {
    const nextQuery = composing ? committedQuery : query;
    return filterReports(reports, nextQuery);
  }, [reports, committedQuery, composing, query]);

  const rankedGroups = useMemo(() => reportWeeklyGroups(visible, engagementOf), [visible, engagementOf]);
  const { groups: weeklyGroups, stale: orderStale } = useMemo(
    () => applyFrozenReportOrder(rankedGroups, frozenOrder),
    [frozenOrder, rankedGroups],
  );

  /** 按当下的真实名次重新拍一张快照。进入按周视图和点「重新排序」时各拍一次。 */
  const freezeCurrentOrder = () => setFrozenOrder(freezeReportOrder(rankedGroups));

  const toggleFavorite = async (reportId: string) => {
    if (favoritePendingId) return;
    setFavoritePendingId(reportId);
    setFavoriteError("");
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/favorite`, {
        method: "POST",
        cache: "no-store",
      });
      const result = await readJsonResponse<ReportFavoriteToggleResult & { error?: string }>(response, "收藏");
      if (!response.ok) throw new Error(result.error || "收藏失败，请稍后重试。");
      setEngagement((current) => {
        const next = { ...current };
        const target = next[result.reportId] ?? emptyCaseEngagement(result.weekKey);
        next[result.reportId] = {
          ...target,
          weekKey: result.weekKey,
          favoriteCount: result.favoriteCount,
          viewerFavorited: result.favorited,
        };
        // 改投时那一票是从另一份报告挪过来的，原来那份要同时掉下去。
        if (result.releasedReportId) {
          const released = next[result.releasedReportId];
          if (released) {
            next[result.releasedReportId] = {
              ...released,
              favoriteCount: result.releasedFavoriteCount,
              viewerFavorited: false,
            };
          }
        }
        return next;
      });
    } catch (error) {
      setFavoriteError(error instanceof Error ? error.message : "收藏失败，请稍后重试。");
    } finally {
      setFavoritePendingId("");
    }
  };

  const retryReport = async (reportId: string) => {
    if (retryPendingId) return;
    setRetryPendingId(reportId);
    setRetryError("");
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/retry`, {
        method: "POST",
        cache: "no-store",
      });
      const result = await readJsonResponse<{ error?: string }>(response, "重试");
      if (!response.ok) throw new Error(result.error || "重试失败，请稍后重试。");
      // 服务端已经把状态推回 QUEUED；这里先把卡片翻过去，后续进度交给上面那个轮询 effect 追。
      setReports((current) => current.map((item): ReportListItemView => (
        item.id === reportId ? { ...item, status: "QUEUED", failReason: null, pagesDone: 0 } : item
      )));
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "重试失败，请稍后重试。");
    } finally {
      setRetryPendingId("");
    }
  };

  const deleteReport = async (reportId: string) => {
    if (deletePendingId) return;
    setDeletePendingId(reportId);
    setDeleteError("");
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/trash`, {
        method: "POST",
        cache: "no-store",
      });
      const result = await readJsonResponse<{ error?: string }>(response, "删除");
      // 兜底文案跟工作台删除报告（ReportStudioClient.tsx）、只读成果页删案例
      // （V04DetailClient.tsx）同一句——报告没删掉、状态没变，不是「删除失败」那种模糊说法。
      if (!response.ok) throw new Error(result.error || "删除未完成，报告未发生变化，可重试。");
      // 软删除成功，卡片直接从列表里摘掉，不用等下一次轮询/刷新。
      setReports((current) => current.filter((item) => item.id !== reportId));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除未完成，报告未发生变化，可重试。");
    } finally {
      setDeletePendingId("");
    }
  };

  const renderCard = (report: ReportListItemView) => (
    <ReportCard
      key={report.id}
      report={report}
      caseNumber={reportIndexById.get(report.id) ?? 0}
      engagement={engagementOf(report)}
      favoritePending={favoritePendingId === report.id}
      onToggleFavorite={toggleFavorite}
      retryPending={retryPendingId === report.id}
      onRetry={retryReport}
      deletePending={deletePendingId === report.id}
      deleteError={deleteError}
      onDelete={deleteReport}
      onReplaceWithPdf={(target) => onRequestUpload(target)}
      notify={notify}
    />
  );

  return (
    <>
      <section className={v04.libraryHero}>
        <p>REPORT REVERSE-ENGINEERING LIBRARY</p>
        <h1>把一份提报，<br />拆回它的判断。</h1>
        <span>沿真实页序，按「模块 → 单元 → 页 → 组块」把一份策略报告拆开，看清它是怎么被讲成立的。</span>
      </section>
      <section className={v04.libraryToolbar}>
        <div><p>REPORT LIBRARY</p><h2>报告库</h2></div>
        <div className={v04.libraryToolbarControls}>
          <button
            type="button"
            className={`${v04.weekToggle} ${weeklyView ? v04.weekToggleOn : ""}`.trim()}
            aria-pressed={weeklyView}
            title={`按上传周分组，周内按收藏数排序（${REPORT_FAVORITE_BALLOT}）`}
            disabled={loading}
            onClick={() => {
              const next = !weeklyView;
              setWeeklyView(next);
              // 开的那一刻按真实名次冻结；关掉就把快照丢掉，下次进来重新拍。
              if (next) freezeCurrentOrder(); else setFrozenOrder(null);
            }}
          >
            按周显示
          </button>
          {weeklyView && orderStale ? (
            <button
              type="button"
              className={v04.reorderChip}
              title="收藏数已变化，点此按新的收藏数重新排序"
              onClick={freezeCurrentOrder}
            >
              顺序已变 · 重新排序
            </button>
          ) : null}
          <label className={v04.librarySearch}>
            <span aria-hidden>⌕</span>
            <input
              aria-label="搜索报告"
              value={query}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => {
                setComposing(false);
                setQuery(event.currentTarget.value);
                setCommittedQuery(event.currentTarget.value);
              }}
              onChange={(event) => {
                setQuery(event.target.value);
                if (!composing) setCommittedQuery(event.target.value);
              }}
              placeholder="搜索报告名、上传者或标签"
            />
          </label>
        </div>
      </section>
      {favoriteError ? <p className={v04.libraryNotice} role="alert">{favoriteError}</p> : null}
      {retryError ? <p className={v04.libraryNotice} role="alert">{retryError}</p> : null}
      {/* 删除失败的原因现在显示在触发删除的那张卡片自己弹出的确认对话框里（ReportCard 用的
          ReportDeleteDialog，跟工作台删除同一个组件），这里不用再重复挂一条全局提示。 */}
      {loading ? (
        <section className={v04.emptyState}><h2>正在读取报告库…</h2></section>
      ) : loadError ? (
        <section className={v04.emptyState}><h2>报告库读取失败</h2><p>{loadError}</p></section>
      ) : !reports.length ? (
        <section className={v04.emptyState}>
          <span>◫</span>
          <h2>还没有报告</h2>
          <p>上传第一份报告，看看能拆出它的判断。</p>
          {/* 不能直接把 onClick 处理函数当 onRequestUpload 传：click 事件对象会顶替 replacing 参数，
              让这个「普通新建」按钮被当成带着一堆垃圾数据的「改传 PDF」请求。 */}
          <button type="button" onClick={() => onRequestUpload()}>上传报告</button>
        </section>
      ) : !visible.length ? (
        // 与 demo 第 203 行一致：没有找到对应报告时只给一句提示，不带图标也不带「清空搜索」按钮
        // （demo 从没建模过真正的空库，这一支只对应「有报告但搜索命中为零」）。
        <section className={v04.emptyState}>
          <h2>没有找到对应报告</h2>
          <p>换一个报告名、上传者、任务类型或标签试试。</p>
        </section>
      ) : weeklyView ? (
        weeklyGroups.map((group) => (
          <section className={v04.weekSection} key={group.weekKey || "unknown"} aria-label={`${group.title} 的报告`}>
            <div className={v04.weekHeading}>
              <h3>{group.title}</h3>
              {group.rangeLabel ? <span>{group.rangeLabel}</span> : null}
              <b>{group.items.length} 份 · 按收藏数排序</b>
            </div>
            <div className={v04.caseGrid}>{group.items.map(renderCard)}</div>
          </section>
        ))
      ) : (
        <section className={v04.caseGrid} aria-label="报告列表">{visible.map(renderCard)}</section>
      )}
      {/* demo 的 #toast 是 #app 的固定兄弟节点，不随当前视图状态换掉（demo 第 149 行）。 */}
      <ReportToastStack toasts={toasts} />
    </>
  );
}
