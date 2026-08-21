"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import type { VideoItem } from "@/lib/types";
import type { V04ServerCardModel, V04UiCase } from "@/lib/v04-ui-model";
import { v04CardToUiCase, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { matchesV04LibraryQuery } from "@/lib/v04-ui-client-state";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import { v04MetadataQueue } from "@/lib/v04-media-loading";
import UploadDialog from "@/app/components/UploadDialog";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import styles from "./V04Surface.module.css";

type V04LibraryCase = { item: V04UiCase; video: VideoItem };

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

export default function V04LibraryClient({ viewerName, formal = false, user, isAdmin = false }: {
  viewerName: string;
  formal?: boolean;
  user?: UserMenuUser;
  isAdmin?: boolean;
}) {
  const tabToken = useRef(`v04-library-${crypto.randomUUID()}`);
  const [cases, setCases] = useState<V04LibraryCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const visible = useMemo(() => {
    const nextQuery = composing ? committedQuery : query;
    const normalized = nextQuery.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
    return cases.filter(({ item, video }) => matchesV04LibraryQuery(item, nextQuery)
      || Boolean(normalized && video.createdByName.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(normalized)));
  }, [cases, committedQuery, composing, query]);
  const caseIndexById = useMemo(() => new Map(cases.map(({ item }, index) => [item.id, index + 1])), [cases]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/videos", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const catalog = await readJsonResponse<{ videos?: VideoItem[]; error?: string }>(response, "片库读取");
        if (!response.ok) throw new Error(catalog.error || "片库读取失败");
        const videos = catalog.videos ?? [];
        const { projections } = await v04UiApi.cards(videos.map((video) => video.id), tabToken.current, controller.signal);
        const projectionById = new Map((projections as V04ServerCardModel[]).map((item) => [item.videoId, item]));
        return videos.flatMap((video) => {
          const projection = projectionById.get(video.id);
          return projection ? [{ item: v04CardToUiCase(video, projection), video }] : [];
        });
      })
      .then((nextCases) => { setCases(nextCases); setLoadError(""); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof V04UiApiError ? error.message : "案例库暂时无法读取，请稍后重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const detailHref = (videoId: string) => formal ? `/videos/${encodeURIComponent(videoId)}` : `/v04-shadow/videos/${encodeURIComponent(videoId)}`;
  const workspaceHref = (videoId: string) => formal ? `/videos/${encodeURIComponent(videoId)}/practice` : `/v04-shadow/videos/${encodeURIComponent(videoId)}/workspace`;

  return <main className={styles.surface} data-v04-page="library" data-v04-layout="two-column-banner">
    <header className={styles.siteHeader} data-v04-formal-header={formal || undefined}>
      <Link href={formal ? "/" : "/v04-shadow"} className={styles.brandWordmark}><b>R:</b><span>RE:VERSE</span><small>反写</small></Link>
      <nav className={styles.siteNav} aria-label="案例库导航"><Link href={formal ? "/" : "/v04-shadow"} className={styles.activeNav}>案例库</Link>{formal ? null : <span>UI PROTOTYPE</span>}</nav>
      <div className={styles.siteUtilities}>{formal && isAdmin ? <Link href="/admin/v02-v03-batch-mapping">数据操作</Link> : null}{formal ? <button type="button" onClick={() => setShowUpload(true)}>上传作品</button> : null}{formal && user ? <UserMenu user={user} /> : <span>{viewerName}</span>}</div>
    </header>
    <section className={styles.libraryHero}><p>CREATIVE REVERSE-ENGINEERING LIBRARY</p><h1>从好作品里，<br />练出看见创意的能力。</h1></section>
    <section className={styles.libraryToolbar}><div><p>CASE LIBRARY</p><h2>案例库</h2></div><label className={styles.librarySearch}><span aria-hidden>⌕</span><input aria-label="搜索案例" value={query} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); setCommittedQuery(event.currentTarget.value); }} onChange={(event) => { setQuery(event.target.value); if (!composing) setCommittedQuery(event.target.value); }} placeholder="搜索片名、品牌或标签" /></label></section>
    {loading ? <section className={styles.emptyState}><h2>正在读取案例库…</h2></section> : loadError ? <section className={styles.emptyState}><h2>案例库读取失败</h2><p>{loadError}</p></section> : visible.length ? <section className={styles.caseGrid} aria-label="案例列表">{visible.map(({ item, video }) => {
      const detail = detailHref(item.id);
      const workspace = workspaceHref(item.id);
      const submissionCount = item.submissionCount ?? item.submissions.length;
      return <article className={styles.caseCard} key={item.id} data-case-id={item.id}>
        <Link href={detail} className={styles.poster} aria-label={`查看 ${item.title} 的只读成果`}>{video.thumbnailUrl ? <img className={styles.posterImage} src={video.thumbnailUrl} alt="" loading="lazy" /> : <span className={styles.posterFallback} />}<span className={styles.posterBrand}>{item.brand || "未标注品牌"}</span><span className={styles.playButton} aria-hidden>▶</span><VideoDuration videoId={item.id} /></Link>
        <div className={styles.caseBody}><div className={styles.caseQuickActions}><Link className={styles.primaryPill} href={detail}>{submissionCount > 0 ? "查看最新成果" : "查看成果状态"}</Link><Link className={styles.ghostPill} href={workspace}>{item.workState === "NOT_STARTED" ? "开始公共工作稿" : "编辑工作稿"}</Link></div><p className={styles.caseNumber}>CASE {String(caseIndexById.get(item.id) ?? 0).padStart(2, "0")}</p><div className={styles.caseTitleStatus}><h2><small>{item.brand || "未标注品牌"}</small><span>{item.title}</span></h2><div><span className={styles.workStatus}>{V04_UI_STATE_LABELS[item.workState]}</span>{item.expertGrade ? <span className={styles.expertGrade}>◆ 专家优选 {item.expertGrade}</span> : null}</div></div><div className={styles.caseInfoBand}><span>{submissionCount > 0 ? `提交版 V${submissionCount}` : "尚无提交版"}</span><span>{item.activeEditor ? `${item.activeEditor} 编辑中` : "当前无人编辑"}</span>{item.tags.map((tag) => <span className={styles.caseCategoryTag} key={tag}>#{tag}</span>)}{formal ? <Link href={`${workspace}?taxonomy=V0.3-PILOT`}>V0.3 历史</Link> : null}</div></div>
      </article>;
    })}</section> : <section className={styles.emptyState}><span>⌕</span><h2>没有找到对应案例</h2><p>可以换一个片名、品牌或标签继续搜索。</p><button onClick={() => { setQuery(""); setCommittedQuery(""); }}>清空搜索</button></section>}
    {showUpload ? <UploadDialog onClose={() => setShowUpload(false)} onUploaded={async (videoId) => { setShowUpload(false); window.location.href = detailHref(videoId); }} /> : null}
  </main>;
}
