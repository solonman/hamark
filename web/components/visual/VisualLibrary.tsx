"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import { libraryCountLabel } from "@/lib/library-count";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import {
  applyFrozenWeeklyOrder,
  deriveWeekKey,
  groupByWeek,
  snapshotWeeklyOrder,
} from "@/lib/case-engagement";
import {
  applyFrozenFlatOrder,
  buildCaseNumberMap,
  filterBySubdomain,
  filterFavoritedOnly,
  freezeFlatOrder,
  hasPendingVisualWork,
  matchesVisualQuery,
  rankByFavorite,
  type VisualLibraryViewMode,
} from "@/lib/visual-ui";
import {
  VISUAL_SUBDOMAINS,
  VISUAL_SUBDOMAIN_SPECS,
  type VisualCaseListItem,
  type VisualFavoriteResponse,
  type VisualSubdomain,
} from "@/lib/visual-contract";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Visual.module.css";
import VisualCard from "./VisualCard";

/** 与报告库同一节奏：有还没上传完／还在生成预览的案例时才轮询，标签页在后台时跳过。 */
const POLL_INTERVAL_MS = 10_000;

async function fetchVisualCases(signal: AbortSignal): Promise<VisualCaseListItem[]> {
  const response = await fetch("/api/visual-cases", { cache: "no-store", signal });
  const data = await readJsonResponse<{ cases?: VisualCaseListItem[]; error?: string }>(response, "公共视觉库读取");
  if (!response.ok) throw new Error(data.error || "公共视觉库读取失败");
  return data.cases ?? [];
}

const SUBDOMAIN_OPTIONS: Array<{ key: VisualSubdomain | "ALL"; label: string }> = [
  { key: "ALL", label: "全部" },
  ...VISUAL_SUBDOMAINS.map((key) => ({ key, label: VISUAL_SUBDOMAIN_SPECS[key].label })),
];

export default function VisualLibrary({
  refreshToken,
  onRequestUpload,
  onRequestResume,
  revealCaseId,
  onRevealed,
}: {
  /** 每次变化都触发一次完整重新加载；上传对话框成功后由上层把它加一（照报告库）。 */
  refreshToken: number;
  onRequestUpload: () => void;
  onRequestResume: (caseId: string) => void;
  /**
   * 刚上传成功的案例 id：加载到这条案例之后，如果它被当前筛选挡住了（子领域／只看我收藏的／
   * 搜索词），就清掉筛选，并把工具栏滚回视口（demo 第 1601-1605 行）。处理完调用 onRevealed
   * 把它清空，避免下一次筛选变化时重复触发。
   */
  revealCaseId?: string | null;
  onRevealed?: () => void;
}) {
  const [cases, setCases] = useState<VisualCaseListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState("");
  const [subdomain, setSubdomain] = useState<VisualSubdomain | "ALL">("ALL");
  const [view, setView] = useState<VisualLibraryViewMode>("NEW");
  const [onlyMine, setOnlyMine] = useState(false);
  const [frozenWeekly, setFrozenWeekly] = useState<ReadonlyMap<string, number> | null>(null);
  const [frozenFlat, setFrozenFlat] = useState<ReadonlyMap<string, number> | null>(null);
  const favoriteInFlight = useRef(new Set<string>());
  const [favoritePendingIds, setFavoritePendingIds] = useState<ReadonlySet<string>>(new Set());
  const [deletePendingId, setDeletePendingId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const { toasts, notify } = useLibraryToast();

  const load = useCallback((signal: AbortSignal) => fetchVisualCases(signal), []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setCases(list);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "公共视觉库暂时无法读取，请稍后重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, refreshToken]);

  // 轮询只在还有 UPLOADING 或封面还在 PENDING 的案例时开；标签页切到后台时跳过（同报告库）。
  useEffect(() => {
    if (!hasPendingVisualWork(cases)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void load(controller.signal)
        .then((list) => { if (!controller.signal.aborted) setCases(list); })
        .catch(() => { /* 轮询失败静默重试，不打断已经展示的列表 */ });
    }, POLL_INTERVAL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [cases, load]);

  // CASE 编号按完整列表（不受筛选/搜索/排序影响），与视频库、报告库同一做法。
  const caseNumberById = useMemo(() => buildCaseNumberMap(cases), [cases]);

  const effectiveQuery = composing ? committedQuery : query;

  const searched = useMemo(() => {
    let list = filterBySubdomain(cases, subdomain);
    list = filterFavoritedOnly(list, onlyMine);
    return list.filter((item) => matchesVisualQuery(item, effectiveQuery));
  }, [cases, subdomain, onlyMine, effectiveQuery]);

  // 按周显示：机制复用 lib/case-engagement.ts（已经测过），本域只提供「怎么喂给它」的读法。
  const rankedGroups = useMemo(() => groupByWeek(searched, (item) => ({
    weekKey: deriveWeekKey(item.createdAt),
    favoriteCount: item.favoriteCount,
    createdAt: item.createdAt,
  })), [searched]);
  const { groups: weeklyGroups, stale: weeklyStale } = useMemo(
    () => applyFrozenWeeklyOrder(rankedGroups, (item) => item.id, frozenWeekly),
    [rankedGroups, frozenWeekly],
  );

  // 按收藏排序：不分周，本域独有的一种视图。
  const rankedFlat = useMemo(
    () => rankByFavorite(searched, (item) => item.favoriteCount, (item) => item.createdAt),
    [searched],
  );
  const { items: flatItems, stale: flatStale } = useMemo(
    () => applyFrozenFlatOrder(rankedFlat, (item) => item.id, frozenFlat),
    [rankedFlat, frozenFlat],
  );

  const stale = view === "WEEK" ? weeklyStale : view === "FAV" ? flatStale : false;

  /** 按当下的真实名次重新拍一张快照（进入某个视图、或点「重新排序」时各拍一次）。 */
  const freezeCurrentOrder = useCallback(() => {
    if (view === "WEEK") setFrozenWeekly(snapshotWeeklyOrder(rankedGroups, (item) => item.id));
    else if (view === "FAV") setFrozenFlat(freezeFlatOrder(rankedFlat, (item) => item.id));
  }, [view, rankedGroups, rankedFlat]);

  // 按周显示、按收藏排序互斥：点亮一个，另一个熄灭；再点一次亮着的那个，回到按上传时间。
  const setViewMode = (next: "WEEK" | "FAV") => {
    const nextView = view === next ? "NEW" : next;
    setView(nextView);
    setFrozenWeekly(nextView === "WEEK" ? snapshotWeeklyOrder(rankedGroups, (item) => item.id) : null);
    setFrozenFlat(nextView === "FAV" ? freezeFlatOrder(rankedFlat, (item) => item.id) : null);
  };

  const clearFilters = () => {
    setSubdomain("ALL");
    setOnlyMine(false);
    setQuery("");
    setCommittedQuery("");
  };

  // 新卡片被当前筛选挡住时清掉筛选，并把工具栏滚回视口（demo finishUpload 的非详情页分支）。
  const toolbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!revealCaseId) return;
    if (!cases.some((item) => item.id === revealCaseId)) return; // 还没加载到，等下一次 cases 更新
    // 响应上层（V04LibraryClient）在一次异步上传成功之后传入的信号，不是从当前渲染的
    // props/state 派生出的值——effect 是正确的地方；清筛选、滚动都只在这一刻做一次。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 见上：响应外部的上传完成信号，不是渲染期可以算出的派生状态
    if (!searched.some((item) => item.id === revealCaseId)) clearFilters();
    onRevealed?.();
    const toolbar = toolbarRef.current;
    if (toolbar) window.scrollTo({ top: Math.max(0, toolbar.offsetTop - 90), behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 revealCaseId／cases 变化时判定一次，clearFilters/onRevealed 不需要触发重跑
  }, [revealCaseId, cases]);

  /**
   * 收藏：不限数量的纯收藏（规格 3.7）。心先跳，请求在后台跑；同一张卡片在途不重发；
   * 失败退回原状并弹 warn 浮层；成功不弹提示——与视频库、报告库的心形完全一致。
   */
  const toggleFavorite = async (caseId: string, favorited: boolean) => {
    if (favoriteInFlight.current.has(caseId)) return;
    favoriteInFlight.current.add(caseId);
    setFavoritePendingIds(new Set(favoriteInFlight.current));
    setCases((current) => current.map((item) => (
      item.id === caseId
        ? { ...item, viewerFavorited: !favorited, favoriteCount: Math.max(0, item.favoriteCount + (favorited ? -1 : 1)) }
        : item
    )));
    try {
      const response = await fetch(`/api/visual-cases/${encodeURIComponent(caseId)}/favorite`, {
        method: "POST",
        cache: "no-store",
      });
      const result = await readJsonResponse<VisualFavoriteResponse & { error?: string }>(response, "收藏");
      if (!response.ok) throw new Error(result.error || "收藏失败，请稍后重试。");
      setCases((current) => current.map((item) => (
        item.id === result.caseId
          ? { ...item, viewerFavorited: result.favorited, favoriteCount: result.favoriteCount }
          : item
      )));
    } catch (error) {
      setCases((current) => current.map((item) => (
        item.id === caseId
          ? { ...item, viewerFavorited: favorited, favoriteCount: Math.max(0, item.favoriteCount + (favorited ? 1 : -1)) }
          : item
      )));
      notify(error instanceof Error ? error.message : "收藏失败，请稍后重试。", "warn");
    } finally {
      favoriteInFlight.current.delete(caseId);
      setFavoritePendingIds(new Set(favoriteInFlight.current));
    }
  };

  const deleteCase = async (caseId: string) => {
    if (deletePendingId) return;
    setDeletePendingId(caseId);
    setDeleteError("");
    try {
      const response = await fetch(`/api/visual-cases/${encodeURIComponent(caseId)}/trash`, {
        method: "POST",
        cache: "no-store",
      });
      const result = await readJsonResponse<{ error?: string }>(response, "删除");
      if (!response.ok) throw new Error(result.error || "删除未完成，案例未发生变化，可重试。");
      setCases((current) => current.filter((item) => item.id !== caseId));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除未完成，案例未发生变化，可重试。");
    } finally {
      setDeletePendingId("");
    }
  };

  const renderCard = (item: VisualCaseListItem) => (
    <VisualCard
      key={item.id}
      item={item}
      caseNumber={caseNumberById.get(item.id) ?? 0}
      favoritePending={favoritePendingIds.has(item.id)}
      onToggleFavorite={toggleFavorite}
      onResume={onRequestResume}
      deletePending={deletePendingId === item.id}
      deleteError={deleteError}
      onDelete={deleteCase}
      notify={notify}
    />
  );

  return (
    <>
      <section className={v04.libraryHero}>
        <p>PUBLIC VISUAL COLLECTION</p>
        <h1>把街上值得被记住的，<br />收进来。</h1>
        <span>户外广告、公共艺术、商业展陈。</span>
      </section>
      <section className={v04.libraryToolbar} ref={toolbarRef}>
        <div className={styles.toolbarTitle}>
          <p>PUBLIC VISUAL LIBRARY{loading || loadError ? null : (
            <span className={v04.libraryCount}> · {libraryCountLabel(searched.length, cases.length, "条")}</span>
          )}</p>
          <h2>公共视觉库</h2>
        </div>
        <div className={`${v04.libraryToolbarControls} ${styles.toolbarControls}`}>
          <div className={styles.filterGroup} role="radiogroup" aria-label="子领域">
            {SUBDOMAIN_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`${v04.weekToggle} ${subdomain === option.key ? v04.weekToggleOn : ""}`.trim()}
                role="radio"
                aria-checked={subdomain === option.key}
                disabled={loading}
                onClick={() => setSubdomain(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`${v04.weekToggle} ${view === "WEEK" ? v04.weekToggleOn : ""}`.trim()}
            aria-pressed={view === "WEEK"}
            title="按上传周分组，周内按收藏数排序；打开那一刻的名次会冻结，点心形不会让卡片挪位"
            disabled={loading}
            onClick={() => setViewMode("WEEK")}
          >
            按周显示
          </button>
          <button
            type="button"
            className={`${v04.weekToggle} ${view === "FAV" ? v04.weekToggleOn : ""}`.trim()}
            aria-pressed={view === "FAV"}
            title="不分周，全部按收藏数从多到少；打开那一刻的名次会冻结"
            disabled={loading}
            onClick={() => setViewMode("FAV")}
          >
            按收藏排序
          </button>
          {stale ? (
            <button
              type="button"
              className={v04.reorderChip}
              title="收藏数已变化，点此按新的收藏数重新排序"
              onClick={freezeCurrentOrder}
            >
              顺序已变 · 重新排序
            </button>
          ) : null}
          <button
            type="button"
            className={`${v04.weekToggle} ${onlyMine ? v04.weekToggleOn : ""}`.trim()}
            aria-pressed={onlyMine}
            title="只看我收藏过的案例"
            disabled={loading}
            onClick={() => setOnlyMine((current) => !current)}
          >
            只看我收藏的
          </button>
          <label className={`${v04.librarySearch} ${styles.toolbarSearch}`}>
            <span aria-hidden>⌕</span>
            <input
              aria-label="搜索案例"
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
              placeholder="搜索标题、地点、创作方或标签"
            />
          </label>
        </div>
      </section>
      {loading ? (
        <section className={v04.emptyState}><h2>正在读取公共视觉库…</h2></section>
      ) : loadError ? (
        <section className={v04.emptyState}><h2>公共视觉库读取失败</h2><p>{loadError}</p></section>
      ) : !cases.length ? (
        // demo 的种子数据从来不是空的，没有对应分支；这里照报告库「还没有报告」的先例补上，
        // 免得库刚上线、一条案例都没有时，落进下面「没有找到对应案例」那个搜索语境的分支。
        <section className={v04.emptyState}>
          <span>◫</span>
          <h2>还没有案例</h2>
          <p>上传第一条公共视觉案例，把值得被记住的收进来。</p>
          <button type="button" onClick={onRequestUpload}>上传案例</button>
        </section>
      ) : !searched.length && onlyMine && subdomain === "ALL" && !effectiveQuery.trim() ? (
        <section className={v04.emptyState}>
          <span>♡</span>
          <h2>你还没有收藏案例</h2>
          <p>在卡片上点心形就能收藏，不限数量，只给自己留档。</p>
          <button type="button" onClick={() => setOnlyMine(false)}>看全部案例</button>
        </section>
      ) : !searched.length ? (
        <section className={v04.emptyState}>
          <span>⌕</span>
          <h2>没有找到对应案例</h2>
          <p>换一个标题、地点、创作方或标签，或者清掉子领域筛选。</p>
          <button type="button" onClick={clearFilters}>清空搜索和筛选</button>
        </section>
      ) : view === "WEEK" ? (
        weeklyGroups.map((group) => (
          <section className={v04.weekSection} key={group.weekKey || "unknown"} aria-label={`${group.title} 的案例`}>
            <div className={v04.weekHeading}>
              <h3>{group.title}</h3>
              {group.rangeLabel ? <span>{group.rangeLabel}</span> : null}
              <b>{group.items.length} 条 · 按收藏数排序</b>
            </div>
            <div className={v04.caseGrid}>{group.items.map(renderCard)}</div>
          </section>
        ))
      ) : view === "FAV" ? (
        <section className={v04.caseGrid} aria-label="案例列表">{flatItems.map(renderCard)}</section>
      ) : (
        <section className={v04.caseGrid} aria-label="案例列表">{searched.map(renderCard)}</section>
      )}
      <LibraryToastStack toasts={toasts} />
    </>
  );
}
