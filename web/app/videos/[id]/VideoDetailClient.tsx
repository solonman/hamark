"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatLongDate } from "@/lib/date-format";
import type { SubmittedAnalysis, VideoItem } from "@/lib/types";
import ReviewPanel from "./ReviewPanel";
import ReplaceVideoDialog, {
  type ReplacedVideoFile,
} from "./ReplaceVideoDialog";
import SubmittedAnalysisContent from "./SubmittedAnalysisContent";

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

export default function VideoDetailClient({ videoId }: { videoId: string }) {
  const [video, setVideo] = useState<VideoItem | null>(null);
  const [analyses, setAnalyses] = useState<SubmittedAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [playerDocked, setPlayerDocked] = useState(false);
  const [canReplaceOriginal, setCanReplaceOriginal] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceNotice, setReplaceNotice] = useState("");
  const [playerRevision, setPlayerRevision] = useState(0);
  const playerSlotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/videos/${videoId}`, { cache: "no-store" })
      .then(async (response) => {
        if (redirectOnUnauthorized(response)) return;
        const data = (await response.json()) as {
          video?: VideoItem;
          analyses?: SubmittedAnalysis[];
          canReplaceOriginal?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "作品读取失败");
        if (active) {
          setVideo(data.video ?? null);
          setAnalyses(data.analyses ?? []);
          setCanReplaceOriginal(Boolean(data.canReplaceOriginal));
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "作品读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [videoId]);

  useEffect(() => {
    const slot = playerSlotRef.current;
    if (!slot || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setPlayerDocked(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      },
      { threshold: 0.05 },
    );
    observer.observe(slot);
    return () => observer.disconnect();
  }, [video?.id]);

  function handleVideoReplaced(replacement: ReplacedVideoFile) {
    setVideo((current) =>
      current
        ? {
            ...current,
            originalName: replacement.originalName,
            contentType: replacement.contentType,
            fileSize: replacement.fileSize,
            status: replacement.status,
          }
        : current,
    );
    setPlayerRevision(Date.now());
    setReplaceNotice("原视频已经替换；逐镜脚本、作业和评分均保持不变。");
    setReplaceOpen(false);
  }

  if (loading) return <main className="detail-state">正在打开作品…</main>;

  if (error || !video) {
    return (
      <main className="detail-state">
        <p>{error || "作品不存在。"}</p>
        <Link className="text-button" href="/">
          返回片库
        </Link>
      </main>
    );
  }

  return (
    <main
      className={`detail-shell ${activeReviewId ? "review-mode-active" : ""}`}
    >
      <header className="detail-header">
        <Link className="wordmark" href="/">
          <span className="wordmark-mark">R:</span>
          <span>RE:VERSE</span>
          <small>反写</small>
        </Link>
        <div className="detail-header-actions">
          <span>{analyses.length} 份公开分析</span>
          <Link className="button button-accent" href={`/videos/${videoId}/practice`}>
            练习 / 交作业
          </Link>
        </div>
      </header>

      <section className="film-heading">
        <Link className="back-link" href="/">
          ← 返回全部作品
        </Link>
        <div>
          <p>{video.brand || "未标注品牌"}</p>
          <h1>{video.title}</h1>
        </div>
        <div className="film-facts">
          <span>上传者 {video.createdByName}</span>
          <span>{formatBytes(video.fileSize)}</span>
          <span>{formatLongDate(video.createdAt)}</span>
          {canReplaceOriginal ? (
            <button
              type="button"
              className="replace-video-button"
              onClick={() => {
                setReplaceNotice("");
                setReplaceOpen(true);
              }}
            >
              替换原视频
            </button>
          ) : null}
        </div>
      </section>

      {replaceNotice ? <p className="replace-video-notice">{replaceNotice}</p> : null}

      <div className="player-stage-slot" ref={playerSlotRef}>
        <section
          className={`player-stage ${
            playerDocked || activeReviewId ? "is-docked" : ""
          }`}
        >
          <span className="player-float-label">对照视频 · 随页面悬浮</span>
          {video.status === "READY" && video.playbackUrl ? (
            <video
              key={playerRevision}
              controls
              playsInline
              preload="metadata"
              src={video.playbackUrl}
            />
          ) : (
            <div className="player-unavailable">
              <strong>
                {video.status === "UPLOADING"
                  ? "视频正在入库"
                  : video.status === "READY"
                    ? "播放链接暂不可用"
                    : "视频上传失败"}
              </strong>
              <p>
                {video.status === "READY"
                  ? "请刷新页面后重新获取播放链接。"
                  : "原始条目已保留，可以返回片库后重新上传。"}
              </p>
            </div>
          )}
        </section>
      </div>

      <section className="film-info">
        <div>
          <p className="eyebrow">ABOUT THIS FILM</p>
          <p className="film-description">
            {video.description || "上传者暂未留下作品说明。"}
          </p>
        </div>
        <div>
          <p className="eyebrow">TAGS</p>
          <div className="detail-tags">
            {video.tags.length ? (
              video.tags.map((tag) => <span key={tag}>#{tag}</span>)
            ) : (
              <span>暂无标签</span>
            )}
          </div>
          <p className="stream-access-note">仅限公司内部在线播放 · 不提供原片下载</p>
        </div>
      </section>

      <section className="analysis-section" aria-labelledby="analysis-title">
        <div className="section-head">
          <div>
            <p className="eyebrow">SCRIPT & CREATIVE ANALYSIS</p>
            <h2 id="analysis-title">脚本及创意分析</h2>
          </div>
          <Link className="text-button" href={`/videos/${videoId}/practice`}>
            写下我的分析 ↗
          </Link>
        </div>

        {analyses.length === 0 ? (
          <div className="no-analysis">
            <span>还没有人交作业</span>
            <p>第一份公开分析，可以从你开始。</p>
            <Link className="button button-dark" href={`/videos/${videoId}/practice`}>
              开始逆向
            </Link>
          </div>
        ) : (
          <div className="analysis-list">
            {analyses.map((analysis, index) => {
              const reviewActive = activeReviewId === analysis.id;
              const content = (
                <SubmittedAnalysisContent
                  analysis={analysis}
                  forceOpen={reviewActive}
                />
              );
              return (
                <article className="analysis-card" key={analysis.id}>
                  <div className="analysis-card-head">
                    <span className="analysis-index">
                      {(index + 1).toString().padStart(2, "0")}
                    </span>
                    <div>
                      <p>
                        {analysis.authorName} · {analysis.taxonomyVersion} · 修订{" "}
                        {analysis.revision}
                      </p>
                      <h3>{analysis.payload.analysisTitle}</h3>
                    </div>
                    <div className="analysis-card-actions">
                      <time>{formatLongDate(analysis.createdAt)}</time>
                      <button
                        type="button"
                        className="button button-accent compact"
                        onClick={() =>
                          setActiveReviewId((current) =>
                            current === analysis.id ? null : analysis.id,
                          )
                        }
                      >
                        {reviewActive ? "退出原位批改" : "原位批改 · 100分"}
                      </button>
                    </div>
                  </div>

                  {reviewActive ? (
                    <ReviewPanel
                      snapshotId={analysis.id}
                      onClose={() => setActiveReviewId(null)}
                    >
                      {content}
                    </ReviewPanel>
                  ) : (
                    content
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {replaceOpen ? (
        <ReplaceVideoDialog
          videoId={video.id}
          currentName={video.originalName}
          onClose={() => setReplaceOpen(false)}
          onReplaced={handleVideoReplaced}
        />
      ) : null}
    </main>
  );
}
