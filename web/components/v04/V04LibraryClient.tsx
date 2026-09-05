"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import type { VideoItem } from "@/lib/types";
import type { V04ServerCardModel, V04UiCase } from "@/lib/v04-ui-model";
import { v04CardToUiCase } from "@/lib/v04-ui-model";
import { matchesV04LibraryQuery } from "@/lib/v04-ui-client-state";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import { v04MetadataQueue } from "@/lib/v04-media-loading";
import {
  CASE_BALLOT_EXHAUSTED_MESSAGE,
  CASE_FAVORITE_BALLOT,
  ballotHint,
  deriveWeekKey,
  emptyCaseEngagement,
  formatStars,
  applyFrozenWeeklyOrder,
  groupByWeek,
  pickTopCaseRating,
  remainingBallots,
  snapshotWeeklyOrder,
  viewerBallotsByWeek,
  type CaseEngagement,
  type CaseFavoriteToggleResult,
} from "@/lib/case-engagement";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import UploadDialog from "@/app/components/UploadDialog";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import ReportLibrary from "@/components/report/library/ReportLibrary";
import ReportUploadDialog from "@/components/report/library/ReportUploadDialog";
import type { ReportReplaceTarget } from "@/lib/report-library-view";
import styles from "./V04Surface.module.css";

/** 卡片上的时间只需要「哪天几点」，精确到秒反而挤占版面。 */
function formatV19CardTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type V04LibraryCase = { item: V04UiCase; video: VideoItem };

/** 本站现在有两条逆向工程线：片子和报告。首页先分库，再谈单个案例。 */
type LibraryTab = "VIDEO" | "REPORT";

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const rounded = Math.round(seconds);
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function VideoDuration({ videoId }: { videoId: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [duration, setDuration] = useState("--:--");
  useEffect(() => {
    const node = anchor.current;
    if (!node) return;
    let disposed = false;
    let requested = false;
    let cancel: (() => void) | null = null;
    const load = () => {
      if (requested || disposed) return;
      requested = true;
      cancel = v04MetadataQueue.schedule((signal) => new Promise<void>((resolve) => {
        const media = document.createElement("video");
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          media.removeAttribute("src");
          media.load();
          resolve();
        };
        media.preload = "metadata";
        media.muted = true;
        media.src = `/api/videos/${encodeURIComponent(videoId)}/stream`;
        media.onloadedmetadata = () => {
          if (!disposed && !signal.aborted) setDuration(formatDuration(media.duration));
          finish();
        };
        media.onerror = () => {
          if (!disposed && !signal.aborted) setDuration("--:--");
          finish();
        };
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish(); else media.load();
      }));
    };
    const cardLink = node.closest("a");
    cardLink?.addEventListener("pointerenter", load, { once: true });
    cardLink?.addEventListener("focusin", load, { once: true });
    return () => {
      disposed = true;
      cardLink?.removeEventListener("pointerenter", load);
      cardLink?.removeEventListener("focusin", load);
      cancel?.();
    };
  }, [videoId]);
  return <span ref={anchor} className={styles.posterDuration} data-video-duration>{duration}</span>;
}

/** 老孙给作业版本的评级，卡片上只读：星星说明作业到了什么水平，点它不做任何事。 */
function CaseRating({ engagement }: { engagement: CaseEngagement }) {
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
      <p className={`${styles.caseRating} ${styles.caseRatingEmpty}`} title="老孙尚未给这个案例的作业评级">
        <i aria-hidden>{formatStars(0)}</i>
        <span>待评级</span>
      </p>
    );
  }
  const others = engagement.ratings.filter((rating) => rating.versionNumber !== top.versionNumber);
  return (
    <p
      ref={anchorRef}
      className={styles.caseRating}
      title={`老孙的作业评级：${engagement.ratings.map((rating) => `v${rating.versionNumber} ${rating.stars} 星`).join("，")}`}
    >
      <span aria-label={`最高评级 v${top.versionNumber} ${top.stars} 星`}>
        <b aria-hidden>v{top.versionNumber}</b>
        <i aria-hidden>{formatStars(top.stars)}</i>
      </span>
      {others.length ? (
        <button
          type="button"
          className={styles.caseRatingMore}
          aria-expanded={showAll}
          title={`另有 ${others.length} 个版本的评级`}
          onClick={() => setShowAll((current) => !current)}
        >
          更多
        </button>
      ) : null}
      {showAll && others.length ? (
        <span className={styles.caseRatingPanel} role="note">
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

export default function V04LibraryClient({ viewerName, formal = false, user, reportLibraryEnabled = false }: {
  viewerName: string;
  formal?: boolean;
  user?: UserMenuUser;
  /** 报告库的总开关（REPORT_LIBRARY_UI_ENABLED）。关闭时 REPORT 页签保持占位空态，一个像素都不该变。 */
  reportLibraryEnabled?: boolean;
}) {
  const tabToken = useRef(`v04-library-${crypto.randomUUID()}`);
  const [cases, setCases] = useState<V04LibraryCase[]>([]);
  const [engagement, setEngagement] = useState<Record<string, CaseEngagement>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [libraryState, setLibraryState] = useState<LibraryTab>("VIDEO");
  const library = libraryState;
  // null = 对话框关着；非 null 时打开，replacing 非空代表这是从一份失败报告发起的「改传 PDF」。
  const [reportUploadRequest, setReportUploadRequest] = useState<{ replacing: ReportReplaceTarget | null } | null>(null);
  const [reportRefreshToken, setReportRefreshToken] = useState(0);
  const [weeklyView, setWeeklyView] = useState(false);
  const [favoritePendingId, setFavoritePendingId] = useState("");
  // 收藏这类「这一下没生效」的话要弹在眼前：用户是在页面深处点的卡片，
  // 页面顶部的提示条在屏幕外，等于没说。
  const { toasts, notify } = useLibraryToast();
  // 按周视图里的名次是冻结的：投票只改票数，不让卡片从鼠标底下窜走。
  const [frozenOrder, setFrozenOrder] = useState<ReadonlyMap<string, number> | null>(null);
  const visible = useMemo(() => {
    const nextQuery = composing ? committedQuery : query;
    const normalized = nextQuery.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
    return cases.filter(({ item, video }) => matchesV04LibraryQuery(item, nextQuery)
      || Boolean(normalized && video.createdByName.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(normalized)));
  }, [cases, committedQuery, composing, query]);
  const caseIndexById = useMemo(() => new Map(cases.map(({ item }, index) => [item.id, index + 1])), [cases]);
  // 收藏数据没读到时不该让整页失去分组能力，所以周次退回按上传时间现算。
  const engagementOf = useCallback(
    (entry: V04LibraryCase) => engagement[entry.item.id] ?? emptyCaseEngagement(deriveWeekKey(entry.video.createdAt)),
    [engagement],
  );
  // 我这一周投掉几票，按整份列表数——搜索过滤掉的那些片子，票一样占着票位。
  const ballotsByWeek = useMemo(
    () => viewerBallotsByWeek(cases.map((entry) => engagementOf(entry))),
    [cases, engagementOf],
  );
  const ballotsUsedIn = useCallback(
    (weekKey: string) => ballotsByWeek.get(weekKey) ?? 0,
    [ballotsByWeek],
  );
  const rankedGroups = useMemo(() => groupByWeek(visible, (entry) => {
    const current = engagementOf(entry);
    return {
      weekKey: current.weekKey,
      favoriteCount: current.favoriteCount,
      createdAt: entry.video.createdAt,
    };
  }), [engagementOf, visible]);
  const { groups: weeklyGroups, stale: orderStale } = useMemo(
    () => applyFrozenWeeklyOrder(rankedGroups, (entry) => entry.item.id, frozenOrder),
    [frozenOrder, rankedGroups],
  );

  /** 按当下的真实名次重新拍一张快照。进入按周视图和点「重新排序」时各拍一次。 */
  const freezeCurrentOrder = () => setFrozenOrder(
    snapshotWeeklyOrder(rankedGroups, (entry) => entry.item.id),
  );

  // 切页签时把 ?library=REPORT 写回地址栏（不刷新页面），工作台的「返回报告库」链接会带这个参数回来。
  const setLibrary = useCallback((next: LibraryTab) => {
    setLibraryState(next);
    const url = new URL(window.location.href);
    if (next === "REPORT") url.searchParams.set("library", "REPORT");
    else url.searchParams.delete("library");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  // 初始页签跟着 URL 走：SSR 阶段读不到 window，只能先按 VIDEO 渲染（避免直接在 useState
  // 初始化里读 window 造成水合不一致），挂载后再读一次 URL 纠正。之后页签切换全部由
  // setLibrary 自己维护 URL，这里只在挂载时跑一次，是本页仅有的一次同步 setState。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("library") === "REPORT") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 从 URL 读初始页签，SSR 期间不存在更早的时机
      setLibraryState("REPORT");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/videos", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const catalog = await readJsonResponse<{ videos?: VideoItem[]; error?: string }>(response, "片库读取");
        if (!response.ok) throw new Error(catalog.error || "片库读取失败");
        const videos = catalog.videos ?? [];
        const videoIds = videos.map((video) => video.id);
        // 收藏与评级和 V0.4 投影互不依赖，一起发出去，少一个来回。
        const [{ projections }, engagementResult] = await Promise.all([
          v04UiApi.cards(videoIds, tabToken.current, controller.signal),
          loadEngagement(videoIds, controller.signal),
        ]);
        const projectionById = new Map((projections as V04ServerCardModel[]).map((item) => [item.videoId, item]));
        return {
          engagement: engagementResult,
          cases: videos.flatMap((video) => {
            const projection = projectionById.get(video.id);
            return projection ? [{ item: v04CardToUiCase(video, projection), video }] : [];
          }),
        };
      })
      .then((next) => {
        if (controller.signal.aborted) return;
        setCases(next.cases);
        setEngagement(next.engagement);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof V04UiApiError ? error.message : "案例库暂时无法读取，请稍后重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const toggleFavorite = async (videoId: string, weekKey: string, favorited: boolean) => {
    if (favoritePendingId) return;
    // 票投完了服务端也会拒，但那要等一个来回；本地已经知道答案就当场说。
    if (!favorited && !remainingBallots(ballotsUsedIn(weekKey))) {
      notify(CASE_BALLOT_EXHAUSTED_MESSAGE, "warn");
      return;
    }
    setFavoritePendingId(videoId);
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/favorite`, {
        method: "POST",
        cache: "no-store",
      });
      const result = await readJsonResponse<CaseFavoriteToggleResult & { error?: string }>(response, "收藏");
      if (!response.ok) throw new Error(result.error || "收藏失败，请稍后重试。");
      setEngagement((current) => {
        const next = { ...current };
        const target = next[result.videoId] ?? emptyCaseEngagement(result.weekKey);
        next[result.videoId] = {
          ...target,
          weekKey: result.weekKey,
          favoriteCount: result.favoriteCount,
          viewerFavorited: result.favorited,
        };
        return next;
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "收藏失败，请稍后重试。", "warn");
    } finally {
      setFavoritePendingId("");
    }
  };

  const detailHref = (videoId: string) => formal ? `/videos/${encodeURIComponent(videoId)}` : `/v04-shadow/videos/${encodeURIComponent(videoId)}`;
  const workspaceHref = (videoId: string) => formal ? `/videos/${encodeURIComponent(videoId)}/practice` : `/v04-shadow/videos/${encodeURIComponent(videoId)}/workspace`;

  const renderCase = ({ item, video }: V04LibraryCase) => {
    const detail = detailHref(item.id);
    const workspace = workspaceHref(item.id);
    const engaged = engagementOf({ item, video });
    const usedBallots = ballotsUsedIn(engaged.weekKey);
    return <article className={styles.caseCard} key={item.id} data-case-id={item.id}>
      <Link href={detail} className={styles.poster} aria-label={`查看 ${item.title} 的只读成果`}>{video.thumbnailUrl ? <img className={styles.posterImage} src={video.thumbnailUrl} alt="" loading="lazy" /> : <span className={styles.posterFallback} />}<span className={styles.posterBrand}>{item.brand || "未标注品牌"}</span><span className={styles.playButton} aria-hidden>▶</span><VideoDuration videoId={item.id} /></Link>
      <div className={styles.caseBody}>
        <div className={styles.caseQuickActions}>
          <Link className={styles.caseEnterPill} href={detail}>进入工作台</Link>
          <div className={styles.caseCardMetrics}>
            <button
              type="button"
              className={`${styles.caseFavorite} ${engaged.viewerFavorited ? styles.caseFavoriteOn : ""}`.trim()}
              aria-pressed={engaged.viewerFavorited}
              aria-label={`${engaged.viewerFavorited ? "取消收藏" : "收藏"}《${item.title}》，${CASE_FAVORITE_BALLOT}，${ballotHint(usedBallots)}，当前 ${engaged.favoriteCount} 人收藏`}
              title={engaged.viewerFavorited
                ? `这部片占着你本周的一票（${CASE_FAVORITE_BALLOT}，${ballotHint(usedBallots)}），再点一次撤回`
                : remainingBallots(usedBallots)
                  ? `把本周的一票投给这部片（${CASE_FAVORITE_BALLOT}，${ballotHint(usedBallots)}）`
                  : CASE_BALLOT_EXHAUSTED_MESSAGE}
              disabled={favoritePendingId === item.id}
              onClick={() => void toggleFavorite(item.id, engaged.weekKey, engaged.viewerFavorited)}
            >
              {/* ♡ 与 ♥ 是两个字形，字体给的宽高并不一致，并排就看得出大小差。
                  同一段路径只切换填充，描边和实心才是同一颗心。 */}
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path
                  d="M8 13.7 3.2 9.1a3.1 3.1 0 0 1 0-4.5 3.3 3.3 0 0 1 4.6 0L8 4.8l.2-.2a3.3 3.3 0 0 1 4.6 0 3.1 3.1 0 0 1 0 4.5L8 13.7Z"
                  fill={engaged.viewerFavorited ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <b>{engaged.favoriteCount}</b>
            </button>
            <CaseRating engagement={engaged} />
          </div>
        </div>
        <p className={styles.caseNumber}>CASE {String(caseIndexById.get(item.id) ?? 0).padStart(2, "0")}</p>
        <div className={styles.caseTitleStatus}><h2><small>{item.brand || "未标注品牌"}</small><span>{item.title}</span></h2><div>{item.expertGrade ? <span className={styles.expertGrade}>◆ 专家优选 {item.expertGrade}</span> : null}</div></div>
        <div className={styles.caseInfoBand}><span>上传者 {video.createdByName || "未知"}</span><span>{item.versionSummary ? `${item.versionSummary.count} 个版本 · 最近 ${item.versionSummary.latestOwnerName} ${formatV19CardTime(item.versionSummary.latestUpdatedAt)}` : "尚未开始反写"}</span>{item.tags.map((tag) => <span className={styles.caseCategoryTag} key={tag}>#{tag}</span>)}{formal ? <Link href={`${workspace}?taxonomy=V0.3-PILOT`}>V0.3 历史</Link> : null}</div>
      </div>
    </article>;
  };

  return <main className={styles.surface} data-v04-page="library" data-v04-layout="two-column-banner" data-library-tab={library}>
    <header className={styles.siteHeader} data-v04-formal-header={formal || undefined}>
      <Link href={formal ? "/" : "/v04-shadow"} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
      <nav className={styles.siteNav} aria-label="站点导航">
        <button type="button" className={library === "VIDEO" ? styles.activeNav : ""} aria-current={library === "VIDEO" ? "page" : undefined} onClick={() => setLibrary("VIDEO")}>视频库</button>
        <button type="button" className={library === "REPORT" ? styles.activeNav : ""} aria-current={library === "REPORT" ? "page" : undefined} onClick={() => setLibrary("REPORT")}>报告库</button>
        {formal ? null : <span>UI PROTOTYPE</span>}
      </nav>
      {/* 上传按钮跟着当前库走：站里现在有两种可反写的东西，「上传作品」说不清是哪一种。
          报告库开关关着的时候按钮在，但按不动——它说明的是形状，不是承诺。 */}
      <div className={styles.siteUtilities}>{formal ? (library === "VIDEO"
        ? <button type="button" onClick={() => setShowUpload(true)}>上传视频</button>
        : reportLibraryEnabled
          ? <button type="button" onClick={() => setReportUploadRequest({ replacing: null })}>上传报告</button>
          : <button type="button" disabled title="报告逆向工程建设中，暂不能上传报告">上传报告</button>
      ) : null}{formal && user ? <UserMenu user={user} /> : <span>{viewerName}</span>}</div>
    </header>
    {library === "REPORT" ? (reportLibraryEnabled ? (
      <ReportLibrary
        refreshToken={reportRefreshToken}
        onRequestUpload={(replacing) => setReportUploadRequest({ replacing: replacing ?? null })}
      />
    ) : <>
      <section className={styles.libraryHero}><p>REPORT REVERSE-ENGINEERING LIBRARY</p><h1>把一份提报，<br />拆回它的判断。</h1></section>
      <section className={styles.emptyState}>
        <span>◫</span>
        <h2>报告逆向工程建设中</h2>
        <p>报告库和视频库并列，用同一套逆向工程方法拆解报告。等报告的字段与流程定下来，这里会列出可反写的报告。</p>
        <button type="button" onClick={() => setLibrary("VIDEO")}>先去视频库</button>
      </section>
    </>) : <>
      <section className={styles.libraryHero}><p>CREATIVE REVERSE-ENGINEERING LIBRARY</p><h1>从好作品里，<br />练出看见创意的能力。</h1></section>
      <section className={styles.libraryToolbar}>
        <div><p>VIDEO LIBRARY</p><h2>视频库</h2></div>
        <div className={styles.libraryToolbarControls}>
          <button
            type="button"
            className={`${styles.weekToggle} ${weeklyView ? styles.weekToggleOn : ""}`.trim()}
            aria-pressed={weeklyView}
            title={`按上传周分组，周内按收藏数排序（${CASE_FAVORITE_BALLOT}）`}
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
          {/* 投票后名次变了不自动换位置——先说一声，换不换由用户决定。 */}
          {weeklyView && orderStale ? (
            <button
              type="button"
              className={styles.reorderChip}
              title="收藏数已变化，点此按新的收藏数重新排序"
              onClick={freezeCurrentOrder}
            >
              顺序已变 · 重新排序
            </button>
          ) : null}
          <label className={styles.librarySearch}><span aria-hidden>⌕</span><input aria-label="搜索案例" value={query} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); setCommittedQuery(event.currentTarget.value); }} onChange={(event) => { setQuery(event.target.value); if (!composing) setCommittedQuery(event.target.value); }} placeholder="搜索片名、品牌或标签" /></label>
        </div>
      </section>
      {loading ? <section className={styles.emptyState}><h2>正在读取案例库…</h2></section>
        : loadError ? <section className={styles.emptyState}><h2>案例库读取失败</h2><p>{loadError}</p></section>
        : !visible.length ? <section className={styles.emptyState}><span>⌕</span><h2>没有找到对应案例</h2><p>可以换一个片名、品牌或标签继续搜索。</p><button onClick={() => { setQuery(""); setCommittedQuery(""); }}>清空搜索</button></section>
        : weeklyView ? weeklyGroups.map((group) => (
          <section className={styles.weekSection} key={group.weekKey || "unknown"} aria-label={`${group.title} 的案例`}>
            <div className={styles.weekHeading}>
              <h3>{group.title}</h3>
              {group.rangeLabel ? <span>{group.rangeLabel}</span> : null}
              {/* 「还剩几票」跟着周走：票位是按案例上传的那一周分的，不是按当下这一周。 */}
              <b>{group.items.length} 部 · 按收藏数排序{group.weekKey ? ` · ${ballotHint(ballotsUsedIn(group.weekKey))}` : ""}</b>
            </div>
            <div className={styles.caseGrid}>{group.items.map(renderCase)}</div>
          </section>
        ))
        : <section className={styles.caseGrid} aria-label="案例列表">{visible.map(renderCase)}</section>}
    </>}
    <LibraryToastStack toasts={toasts} />
    {showUpload ? <UploadDialog onClose={() => setShowUpload(false)} onUploaded={async (videoId) => { setShowUpload(false); window.location.href = detailHref(videoId); }} /> : null}
    {reportUploadRequest ? (
      <ReportUploadDialog
        replacing={reportUploadRequest.replacing ?? undefined}
        onClose={() => setReportUploadRequest(null)}
        onUploaded={() => {
          setReportUploadRequest(null);
          // 新报告已经建好并进入转换队列（改传 PDF 的话，旧的失败记录也已经删掉）；重新拉一次
          // 列表就能看到它以「排队中」出现在最前面。
          setReportRefreshToken((token) => token + 1);
        }}
      />
    ) : null}
  </main>;
}

/** 收藏与评级读不出来不该拖垮整个案例库，读失败就当作还没有人收藏。 */
async function loadEngagement(videoIds: string[], signal: AbortSignal) {
  if (!videoIds.length) return {} as Record<string, CaseEngagement>;
  const search = new URLSearchParams(videoIds.map((videoId) => ["videoId", videoId]));
  try {
    const response = await fetch(`/api/case-engagement?${search}`, { cache: "no-store", signal });
    if (!response.ok) return {} as Record<string, CaseEngagement>;
    const data = await readJsonResponse<{ engagement?: Record<string, CaseEngagement> }>(response, "收藏与评级读取");
    return data.engagement ?? {};
  } catch {
    return {} as Record<string, CaseEngagement>;
  }
}
