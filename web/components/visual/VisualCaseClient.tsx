"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import ThemeSwitcher from "@/components/shared/ThemeSwitcher";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import { LibraryToastStack, useLibraryToast } from "@/components/shared/LibraryToast";
import {
  VISUAL_LIBRARY_HREF,
  VISUAL_SUBDOMAIN_SPECS,
  visualCarrierLabel,
  type VisualAssetView,
  type VisualCaseDetail,
  type VisualFavoriteResponse,
} from "@/lib/visual-contract";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Visual.module.css";
import VisualUploadDialog, { type VisualUploadDialogMode } from "./VisualUploadDialog";

function fmtDur(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(Math.round(seconds) % 60)}`;
}

function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fetchDetail(caseId: string, signal: AbortSignal): Promise<{ case: VisualCaseDetail } | { notFound: true }> {
  const response = await fetch(`/api/visual-cases/${encodeURIComponent(caseId)}`, { cache: "no-store", signal });
  if (response.status === 404) return { notFound: true };
  const data = await readJsonResponse<{ case?: VisualCaseDetail; error?: string }>(response, "案例详情读取");
  if (!response.ok || !data.case) throw new Error(data.error || "案例详情读取失败。");
  return { case: data.case };
}

export default function VisualCaseClient({ caseId, viewerName, user }: {
  caseId: string;
  viewerName: string;
  user?: UserMenuUser;
}) {
  const [detail, setDetail] = useState<VisualCaseDetail | null>(null);
  const [notFoundState, setNotFoundState] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [stageIndex, setStageIndex] = useState(0);
  const [viewerOverlay, setViewerOverlay] = useState<{ index: number } | null>(null);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [trashError, setTrashError] = useState("");
  const [dialogMode, setDialogMode] = useState<VisualUploadDialogMode | null>(null);
  const favoriteInFlight = useRef(false);
  const [favoritePending, setFavoritePending] = useState(false);
  const { toasts, notify } = useLibraryToast();
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerReturnFocusRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const load = useCallback((signal: AbortSignal) => fetchDetail(caseId, signal), [caseId]);

  const refreshDetail = useCallback(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if ("notFound" in result) { setNotFoundState(true); return; }
        setDetail(result.case);
        setLoadError("");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(reason instanceof Error ? reason.message : "案例详情读取失败。");
      });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    return refreshDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时读一次
  }, []);

  const readyAssets = useMemo(() => {
    if (!detail) return [] as VisualAssetView[];
    return detail.assets.filter((asset) => asset.uploadStatus === "READY").sort((a, b) => a.position - b.position);
  }, [detail]);
  const imageAssets = useMemo(() => readyAssets.filter((asset) => asset.type === "IMAGE"), [readyAssets]);

  // 素材数量可能因为编辑而变化（比如去掉了原来选中的那一个）；用派生值夹在合法范围内，
  // 而不是另开一个 effect 回写 state——省一次多余的渲染，也不用在 setState-in-effect 上找理由。
  const safeStageIndex = readyAssets.length ? Math.min(stageIndex, readyAssets.length - 1) : 0;
  const currentAsset = readyAssets[safeStageIndex] ?? null;

  // 键盘切换时焦点要跟到新选中的那一格（roving tabindex）。等 React 把新的 aria-selected
  // 提交到 DOM 之后再挪，requestAnimationFrame 有可能早于提交（页签在后台时还会被暂停）。
  const focusStripAfterCommit = useRef(false);
  useEffect(() => {
    if (!focusStripAfterCommit.current) return;
    focusStripAfterCommit.current = false;
    stripRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [safeStageIndex]);

  function stageGo(nextIndex: number, focusStrip = false) {
    const clamped = Math.max(0, Math.min(readyAssets.length - 1, nextIndex));
    if (clamped === safeStageIndex) return;
    focusStripAfterCommit.current = focusStrip;
    setStageIndex(clamped);
  }

  function openViewer(imageIndex: number) {
    viewerReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setViewerOverlay({ index: Math.max(0, Math.min(imageAssets.length - 1, imageIndex)) });
  }
  function closeViewer() {
    setViewerOverlay(null);
    viewerReturnFocusRef.current?.focus?.();
  }
  function viewerStep(step: number) {
    setViewerOverlay((current) => {
      if (!current) return current;
      const next = current.index + step;
      if (next < 0 || next >= imageAssets.length) return current;
      return { index: next };
    });
  }

  // 大图查看：锁 body 滚动、打开时焦点落在关闭按钮、键盘监听用 effect 挂/摘，不叠加。
  useEffect(() => {
    if (!viewerOverlay) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    viewerCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowLeft") viewerStep(-1);
      else if (event.key === "ArrowRight") viewerStep(1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewerStep/closeViewer 只依赖 imageAssets.length，随 overlay 打开时重挂即可
  }, [viewerOverlay !== null, imageAssets.length]);

  // 素材条 roving tabindex：焦点在条上时 ←→ 切换，不抢页面其他地方的方向键。
  function onStripKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.matches(`.${styles.mediaThumb}`)) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); stageGo(safeStageIndex - 1, true); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stageGo(safeStageIndex + 1, true); }
  }

  async function toggleFavorite() {
    if (!detail || favoriteInFlight.current || detail.status !== "READY") return;
    favoriteInFlight.current = true;
    setFavoritePending(true);
    const wasFavorited = detail.viewerFavorited;
    setDetail((current) => (current ? {
      ...current,
      viewerFavorited: !wasFavorited,
      favoriteCount: Math.max(0, current.favoriteCount + (wasFavorited ? -1 : 1)),
    } : current));
    try {
      const response = await fetch(`/api/visual-cases/${encodeURIComponent(caseId)}/favorite`, { method: "POST", cache: "no-store" });
      const result = await readJsonResponse<VisualFavoriteResponse & { error?: string }>(response, "收藏");
      if (!response.ok) throw new Error(result.error || "收藏失败，请稍后重试。");
      setDetail((current) => (current ? { ...current, viewerFavorited: result.favorited, favoriteCount: result.favoriteCount } : current));
    } catch (reason) {
      setDetail((current) => (current ? {
        ...current,
        viewerFavorited: wasFavorited,
        favoriteCount: Math.max(0, current.favoriteCount + (wasFavorited ? 1 : -1)),
      } : current));
      notify(reason instanceof Error ? reason.message : "收藏失败，请稍后重试。", "warn");
    } finally {
      favoriteInFlight.current = false;
      setFavoritePending(false);
    }
  }

  async function confirmTrash() {
    setTrashing(true);
    setTrashError("");
    try {
      const response = await fetch(`/api/visual-cases/${encodeURIComponent(caseId)}/trash`, { method: "POST", cache: "no-store" });
      const result = await readJsonResponse<{ error?: string }>(response, "删除");
      if (!response.ok) throw new Error(result.error || "删除未完成，案例未发生变化，可重试。");
      window.location.assign(VISUAL_LIBRARY_HREF);
    } catch (reason) {
      setTrashError(reason instanceof Error ? reason.message : "删除未完成，案例未发生变化，可重试。");
      setTrashing(false);
    }
  }

  if (notFoundState) {
    return (
      <main className={v04.surface} data-v04-page="detail">
        <section className={v04.emptyState}>
          <h2>案例不存在或已移入回收站</h2>
          <p>回收站里的案例由上传者或系统管理员恢复。</p>
          <Link href={VISUAL_LIBRARY_HREF}>返回公共视觉库</Link>
        </section>
      </main>
    );
  }
  if (loadError) {
    return (
      <main className={v04.surface} data-v04-page="detail">
        <section className={v04.emptyState}><h2>案例详情读取失败</h2><p>{loadError}</p></section>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className={v04.surface} data-v04-page="detail">
        <section className={v04.emptyState}><h2>正在读取案例…</h2></section>
      </main>
    );
  }

  const subSpec = VISUAL_SUBDOMAIN_SPECS[detail.subdomain];
  const eyebrow = [subSpec.label, detail.location, detail.occurredAt].filter(Boolean).join(" · ");
  const carrier = visualCarrierLabel(detail.counts);
  const infoRows: Array<[string, React.ReactNode]> = [
    ["采集地点", detail.location],
    ["创作方／品牌", detail.creator],
    ["投放／落成时间", detail.occurredAt],
    ["来源", detail.sourceUrl ? <a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">{detail.sourceUrl}</a> : ""],
    ["版权／拍摄说明", detail.rightsNote],
    ...subSpec.fields.map((field): [string, string] => {
      const value = detail.metadata[field.key];
      return [field.label, Array.isArray(value) ? value.join("、") : (value ?? "")];
    }),
  ];

  return (
    <main className={`${v04.surface} ${styles.root}`.trim()} data-v04-page="detail">
      <header className={v04.siteHeader}>
        <Link href={VISUAL_LIBRARY_HREF} className={v04.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
        <nav className={v04.siteNav} aria-label="站点导航">
          <span className={v04.headerCaseTitle} title={detail.title}>{detail.title}</span>
          <Link href={VISUAL_LIBRARY_HREF}>公共视觉库</Link>
        </nav>
        <div className={v04.siteUtilities}>
          <ThemeSwitcher />
          {user ? <UserMenu user={user} /> : <span>{viewerName}</span>}
        </div>
      </header>

      <section className={v04.detailHero}>
        <p className={v04.breadcrumb}><Link href={VISUAL_LIBRARY_HREF}>公共视觉库</Link><span>/</span><b>案例</b></p>
        <p className={v04.detailEyebrow}>{eyebrow}</p>
        <h1>{detail.title}</h1>
        {detail.summary ? <p className={v04.detailSummary}>{detail.summary}</p> : null}
        <div className={v04.detailTags}>
          <span className={styles.subdomainTag} data-sub={detail.subdomain}>{subSpec.label}</span>
          {carrier ? <span>{carrier}</span> : null}
          {detail.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          <span>上传者 {detail.createdByName || "未知"} · {fmtTime(detail.createdAt)}</span>
        </div>
        <div className={styles.detailActions}>
          <button
            type="button"
            className={`${v04.caseFavorite} ${detail.viewerFavorited ? v04.caseFavoriteOn : ""}`.trim()}
            aria-pressed={detail.viewerFavorited}
            aria-label={`${detail.viewerFavorited ? "取消收藏" : "收藏"}《${detail.title}》，当前 ${detail.favoriteCount} 人收藏`}
            title={detail.status !== "READY" ? "案例还没上传完，暂时不能收藏" : detail.viewerFavorited ? "已收藏，再点一次取消" : "收藏（不限数量，只是给自己留档）"}
            disabled={detail.status !== "READY" || favoritePending}
            onClick={() => void toggleFavorite()}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M8 13.7 3.2 9.1a3.1 3.1 0 0 1 0-4.5 3.3 3.3 0 0 1 4.6 0L8 4.8l.2-.2a3.3 3.3 0 0 1 4.6 0 3.1 3.1 0 0 1 0 4.5L8 13.7Z"
                fill={detail.viewerFavorited ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <b>{detail.favoriteCount}</b>
          </button>
          {detail.viewerCapabilities.canEdit && detail.missingCount > 0 ? (
            <button type="button" className={styles.toolButton} onClick={() => setDialogMode("resume")}>
              有 {detail.missingCount} 个新素材没传完 · 继续上传
            </button>
          ) : null}
          {detail.viewerCapabilities.canEdit ? (
            <button type="button" className={styles.toolButton} onClick={() => setDialogMode("edit")}>编辑信息与素材</button>
          ) : null}
          {detail.viewerCapabilities.canTrash ? (
            <button type="button" className={`${styles.toolButton} ${styles.toolButtonDanger}`.trim()} onClick={() => { setTrashError(""); setConfirmingTrash(true); }}>
              删除案例
            </button>
          ) : null}
        </div>
      </section>

      {readyAssets.length ? (
        <section className={styles.mediaSlot} aria-label="素材">
          <div className={v04.videoShell} data-v04-scheme="dark">
            <div className={styles.stageView}>
              {currentAsset ? <StageMedia asset={currentAsset} onOpenViewer={openViewer} imageAssets={imageAssets} /> : null}
              {readyAssets.length > 1 ? (
                <>
                  <button type="button" className={`${styles.stageNav} ${styles.prev}`} aria-label="上一个素材" disabled={safeStageIndex === 0} onClick={() => stageGo(safeStageIndex - 1)}>‹</button>
                  <button type="button" className={`${styles.stageNav} ${styles.next}`} aria-label="下一个素材" disabled={safeStageIndex === readyAssets.length - 1} onClick={() => stageGo(safeStageIndex + 1)}>›</button>
                </>
              ) : null}
            </div>
            {currentAsset ? (
              <div className={styles.stageCaption}>
                <span>
                  <b>{String(safeStageIndex + 1).padStart(2, "0")} / {String(readyAssets.length).padStart(2, "0")}</b>
                  {" · "}
                  {currentAsset.type === "VIDEO"
                    ? `视频 · ${currentAsset.originalName} · ${fmtDur(currentAsset.durationSeconds)}`
                    : `图片`}
                </span>
                {readyAssets.length > 1 ? <span>点缩略图切换，焦点在缩略图上时可用 ← →</span> : null}
              </div>
            ) : null}
            {readyAssets.length > 1 ? (
              <div className={styles.mediaStrip} ref={stripRef} role="tablist" aria-label="全部素材（按上传顺序）" onKeyDown={onStripKeyDown}>
                {readyAssets.map((asset, index) => (
                  <button
                    key={asset.id}
                    type="button"
                    className={styles.mediaThumb}
                    role="tab"
                    aria-selected={index === safeStageIndex}
                    tabIndex={index === safeStageIndex ? 0 : -1}
                    aria-label={`第 ${index + 1} 个素材：${asset.type === "VIDEO" ? `视频 ${asset.originalName}` : "图片"}`}
                    onClick={() => stageGo(index)}
                  >
                    {asset.thumbnailUrl ? <img className={styles.mediaThumbArt} src={asset.thumbnailUrl} alt="" /> : <span className={styles.thumbPending}>{asset.derivativeStatus === "FAILED" ? "无预览" : "生成中"}</span>}
                    <i>{String(index + 1).padStart(2, "0")}</i>
                    {asset.type === "VIDEO" ? <b>▶ {fmtDur(asset.durationSeconds)}</b> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className={v04.readingBody}>
        {detail.textBody.trim() ? (
          <section className={v04.readingModule}>
            <header><div><small>BRIEF</small><h2>案例简介</h2></div></header>
            <p className={styles.prose}>{detail.textBody}</p>
          </section>
        ) : null}
        <section className={v04.readingModule}>
          <header><div><small>DETAILS</small><h2>案例信息</h2></div></header>
          <div className={v04.readingCore}>
            {infoRows.filter(([, value]) => (typeof value === "string" ? value.trim() : Boolean(value))).map(([label, value]) => (
              <div key={label}><small>{label}</small><p>{value}</p></div>
            ))}
          </div>
          <p className={styles.readingNote}>仅公司内部学习使用，不对外公开分享。图片先看 480w 缩略图与 1600w 展示图，「查看原图」才读取原始文件。</p>
        </section>
      </div>

      <DeleteConfirmDialog
        open={confirmingTrash}
        heading="删除案例"
        title={detail.title}
        lines={[
          "案例会从公共视觉库中移除，保留 90 天，可由上传者或系统管理员恢复；原始素材文件不会被清理。",
          "收藏关系一并保留，恢复后原样回来。",
        ]}
        error={trashError}
        pending={trashing}
        onConfirm={() => void confirmTrash()}
        onCancel={() => setConfirmingTrash(false)}
      />

      {viewerOverlay ? (
        <div className={styles.root}>
          <div className={styles.ov} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeViewer(); }}>
            <div className={styles.ovbox} role="dialog" aria-modal="true" aria-label={`查看图片：${detail.title}`}>
              <div className={styles.ovhead}>
                <b>图片 {String(viewerOverlay.index + 1).padStart(2, "0")} / {String(imageAssets.length).padStart(2, "0")}</b>
                <span className={styles.ovheadT}>{detail.title}</span>
                <button type="button" className={styles.smBtn} disabled={viewerOverlay.index === 0} onClick={() => viewerStep(-1)}>← 上一张</button>
                <button type="button" className={styles.smBtn} disabled={viewerOverlay.index === imageAssets.length - 1} onClick={() => viewerStep(1)}>下一张 →</button>
                {imageAssets[viewerOverlay.index]?.originalPath ? (
                  <a className={styles.smBtn} href={imageAssets[viewerOverlay.index]!.originalPath!} target="_blank" rel="noopener noreferrer">查看原图</a>
                ) : null}
                <button type="button" className={styles.smBtn} ref={viewerCloseRef} onClick={closeViewer}>关闭 esc</button>
              </div>
              <div className={styles.viewerBody} data-v04-scheme="dark">
                {(() => {
                  const asset = imageAssets[viewerOverlay.index];
                  if (!asset) return null;
                  if (asset.derivativeStatus === "READY" && asset.displayUrl) {
                    return <div className={styles.viewerImage}><img src={asset.displayUrl} alt="" /></div>;
                  }
                  return (
                    <div className={styles.viewerImage}>
                      <div className={`${styles.stagePlaceholder} ${asset.derivativeStatus === "FAILED" ? styles.failed : ""}`.trim()}>
                        <b>{asset.derivativeStatus === "FAILED" ? "预览生成失败" : "正在生成预览"}</b>
                        <small>{asset.derivativeStatus === "FAILED" ? (asset.derivativeError || "处理失败；可以查看原图") : "稍后再看"}</small>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {dialogMode ? (
        <VisualUploadDialog
          mode={dialogMode}
          caseId={caseId}
          initialDetail={detail}
          notify={notify}
          onClose={() => setDialogMode(null)}
          onCreated={() => setDialogMode(null)}
          onSaved={(_savedCaseId, addedImage) => {
            setDialogMode(null);
            notify(addedImage ? "已保存，新图片的预览生成后自动出现" : "已保存");
            refreshDetail();
          }}
        />
      ) : null}

      <LibraryToastStack toasts={toasts} />
    </main>
  );
}

function StageMedia({ asset, onOpenViewer, imageAssets }: {
  asset: VisualAssetView;
  onOpenViewer: (imageIndex: number) => void;
  imageAssets: VisualAssetView[];
}) {
  if (asset.type === "VIDEO") {
    return (
      <video
        className={styles.stageArt}
        controls
        preload="metadata"
        poster={asset.thumbnailUrl ?? undefined}
        src={asset.streamPath ?? undefined}
      />
    );
  }
  if (asset.derivativeStatus === "PENDING") {
    return (
      <div className={styles.stagePlaceholder}>
        <b>正在生成预览</b>
        <small>上传已完成，展示图生成后自动出现</small>
      </div>
    );
  }
  if (asset.derivativeStatus === "FAILED") {
    return (
      <div className={`${styles.stagePlaceholder} ${styles.failed}`}>
        <b>预览生成失败</b>
        <small>{asset.derivativeError || "处理失败；可以查看原图"}</small>
        <div className={styles.stageTools}>
          {asset.originalPath ? <a href={asset.originalPath} target="_blank" rel="noopener noreferrer">查看原图</a> : null}
        </div>
      </div>
    );
  }
  const imageIndex = imageAssets.findIndex((item) => item.id === asset.id);
  return (
    <>
      {asset.displayUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- 展示图来自本地对象存储签名 URL，不走 next/image 的远程域名白名单
        <img
          className={`${styles.stageArt} ${styles.clickable}`}
          src={asset.displayUrl}
          alt=""
          title="全屏查看"
          onClick={() => onOpenViewer(imageIndex)}
        />
      ) : null}
      <div className={styles.stageTools}>
        <button type="button" onClick={() => onOpenViewer(imageIndex)}>全屏查看</button>
        {asset.originalPath ? <a href={asset.originalPath} target="_blank" rel="noopener noreferrer">查看原图</a> : null}
      </div>
    </>
  );
}
