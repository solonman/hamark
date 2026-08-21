"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import type { VideoItem } from "@/lib/types";
import type { V04ServerCardModel, V04UiCase } from "@/lib/v04-ui-model";
import { v04CardToUiCase, V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { matchesV04LibraryQuery } from "@/lib/v04-ui-client-state";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import UploadDialog from "@/app/components/UploadDialog";
import UserMenu, { type UserMenuUser } from "@/app/components/UserMenu";
import styles from "./V04Surface.module.css";

type V04LibraryCase = { item: V04UiCase; video: VideoItem };

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export default function V04LibraryClient({
  viewerName,
  formal = false,
  user,
  isAdmin = false,
}: {
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
      .then((nextCases) => {
        setCases(nextCases);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof V04UiApiError ? error.message : "案例库暂时无法读取，请稍后重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const detailHref = (videoId: string) => formal
    ? `/videos/${encodeURIComponent(videoId)}`
    : `/v04-shadow/videos/${encodeURIComponent(videoId)}`;
  const workspaceHref = (videoId: string) => formal
    ? `/videos/${encodeURIComponent(videoId)}/practice`
    : `/v04-shadow/videos/${encodeURIComponent(videoId)}/workspace`;
  return (
    <main className={styles.surface} data-v04-page="library">
      <header className={styles.productHeader} data-v04-formal-header={formal || undefined}>
        <Link href={formal ? "/" : "/v04-shadow"} className={styles.wordmark}>RE:VERSE <small>{formal ? "V1.9" : "V0.4 SHADOW"}</small></Link>
        {formal ? <nav aria-label="正式导航">
          <Link href="/">案例库</Link>
          {isAdmin ? <Link href="/admin/v02-v03-batch-mapping">数据操作</Link> : null}
          <button type="button" onClick={() => setShowUpload(true)}>上传作品</button>
        </nav> : null}
        {formal && user ? <UserMenu user={user} /> : <div><span>{viewerName}</span>{formal ? null : <b>可交互审核稿 · Fixture</b>}</div>}
      </header>
      <section className={styles.libraryHero}><p>VIDEO CREATIVE REVERSE ENGINEERING</p><h1>案例库</h1><span>发现作品、查看最新成果，或进入同一份公共工作稿继续维护。</span></section>
      <section className={styles.libraryToolbar}>
        <label>搜索案例<input value={query} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); setCommittedQuery(event.currentTarget.value); }} onChange={(event) => { setQuery(event.target.value); if (!composing) setCommittedQuery(event.target.value); }} placeholder="作品、品牌、标签" /></label>
        <span>{visible.length} 个案例</span>
      </section>
      {loading ? <section className={styles.emptyState}><h2>正在读取案例库…</h2></section> : loadError ? <section className={styles.emptyState}><h2>案例库读取失败</h2><p>{loadError}</p></section> : visible.length ? <section className={styles.caseGrid}>{visible.map(({ item, video }) => (
        <article className={styles.caseCard} key={item.id} data-case-id={item.id}>
          <Link href={detailHref(item.id)} className={styles.poster} aria-label={`查看 ${item.title} 最新成果`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- signed COS thumbnails remain direct browser requests */}
            {video.thumbnailUrl ? <img className={styles.posterImage} src={video.thumbnailUrl} alt="" loading="lazy" /> : null}
            <span>{item.brand || "未标注品牌"}</span><b>▶</b><small>{formatBytes(video.fileSize)}</small>
          </Link>
          <div className={styles.caseBody}>
            <div className={styles.caseTitleLine}><h2>{item.title}</h2><span className={styles.workStatus}>{V04_UI_STATE_LABELS[item.workState]}</span>{item.expertGrade && <span className={styles.expertGrade}>专家优选 {item.expertGrade}</span>}</div>
            <p>{item.description || `${video.createdByName} 上传`}</p><div className={styles.tags}>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className={styles.caseActions}><Link href={detailHref(item.id)}>{(item.submissionCount ?? item.submissions.length) > 0 ? "查看最新成果" : "查看案例"}</Link><Link href={workspaceHref(item.id)}>{item.workState === "NOT_STARTED" ? "开始公共工作稿" : "编辑工作稿"}</Link>{formal ? <Link href={`${workspaceHref(item.id)}?taxonomy=V0.3-PILOT`}>V0.3</Link> : null}</div>
          </div>
        </article>
      ))}</section> : <section className={styles.emptyState}><h2>没有找到匹配案例</h2><p>页面外壳保持可用，可以继续修改或清空搜索。</p><button onClick={() => { setQuery(""); setCommittedQuery(""); }}>清空搜索</button></section>}
      {showUpload ? <UploadDialog onClose={() => setShowUpload(false)} onUploaded={async (videoId) => { setShowUpload(false); window.location.href = detailHref(videoId); }} /> : null}
    </main>
  );
}
