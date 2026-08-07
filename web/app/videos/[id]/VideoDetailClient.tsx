"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import DraggableVideoPlayer from "@/app/components/DraggableVideoPlayer";
import { formatLongDate } from "@/lib/date-format";
import type {
  MyAnalysisStatus,
  SubmittedAnalysis,
  VideoItem,
} from "@/lib/types";
import ReviewPanel from "./ReviewPanel";
import DeleteVideoDialog from "./DeleteVideoDialog";
import EditVideoDialog, { type EditableVideoInfo } from "./EditVideoDialog";
import ReplaceVideoDialog, {
  type ReplacedVideoFile,
} from "./ReplaceVideoDialog";
import SubmittedAnalysisContent from "./SubmittedAnalysisContent";
import AnalysisComments from "./AnalysisComments";

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
  const [myAnalysis, setMyAnalysis] = useState<MyAnalysisStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [playerDocked, setPlayerDocked] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [canDeletePermanently, setCanDeletePermanently] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [replaceNotice, setReplaceNotice] = useState("");
  const [playerRevision, setPlayerRevision] = useState(0);
  const [versionLoading, setVersionLoading] = useState<string | null>(null);
  const [versionNotice, setVersionNotice] = useState("");
  const playerSlotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/videos/${videoId}`, { cache: "no-store" })
      .then(async (response) => {
        if (redirectOnUnauthorized(response)) return;
        const data = (await response.json()) as {
          video?: VideoItem;
          analyses?: SubmittedAnalysis[];
          myAnalysis?: MyAnalysisStatus | null;
          canManage?: boolean;
          canDeletePermanently?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "作品读取失败");
        if (active) {
          setVideo(data.video ?? null);
          setAnalyses(data.analyses ?? []);
          setMyAnalysis(data.myAnalysis ?? null);
          setCanManage(Boolean(data.canManage));
          setCanDeletePermanently(Boolean(data.canDeletePermanently));
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
            playbackUrl: replacement.playbackUrl,
            thumbnailUrl: replacement.thumbnailUrl,
            status: replacement.status,
          }
        : current,
    );
    setPlayerRevision(Date.now());
    setReplaceNotice("原视频已经替换；逐镜脚本、作业和评分均保持不变。");
    setReplaceOpen(false);
  }

  function handleVideoSaved(updated: EditableVideoInfo) {
    setVideo((current) => (current ? { ...current, ...updated } : current));
    setEditOpen(false);
  }

  const myAnalysisLabel =
    myAnalysis?.status === "SUBMITTED"
      ? "继续修订我的作业 ↗"
      : myAnalysis?.status === "DRAFT"
        ? "继续编辑我的分析 ↗"
        : "写下我的分析 ↗";

  async function showAnalysisVersion(index: number, snapshotId: string) {
    if (analyses[index]?.id === snapshotId) return;
    setVersionLoading(snapshotId);
    setVersionNotice("");
    setActiveReviewId(null);
    try {
      const response = await fetch(`/api/analyses/${snapshotId}`, {
        cache: "no-store",
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        analysis?: SubmittedAnalysis;
        error?: string;
      };
      if (!response.ok || !data.analysis) {
        throw new Error(data.error || "作业版本读取失败");
      }
      setAnalyses((current) =>
        current.map((analysis, currentIndex) =>
          currentIndex === index ? data.analysis! : analysis,
        ),
      );
    } catch (reason) {
      setVersionNotice(
        reason instanceof Error ? reason.message : "作业版本读取失败",
      );
    } finally {
      setVersionLoading(null);
    }
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
          {canManage ? (
            <div className="video-management-actions">
              <span>管理作品</span>
              <button
                type="button"
                className="replace-video-button"
                onClick={() => setEditOpen(true)}
              >
                编辑信息
              </button>
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
              {canDeletePermanently ? (
                <button
                  type="button"
                  className="replace-video-button delete-video-button"
                  onClick={() => setDeleteOpen(true)}
                >
                  永久删除
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {replaceNotice ? <p className="replace-video-notice">{replaceNotice}</p> : null}

      <div className="player-stage-slot" ref={playerSlotRef}>
        <DraggableVideoPlayer enabled={Boolean(playerDocked || activeReviewId)}>
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
                poster={video.thumbnailUrl ?? undefined}
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
        </DraggableVideoPlayer>
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
            {myAnalysisLabel}
          </Link>
        </div>

        {versionNotice ? (
          <div className="review-notice error">{versionNotice}</div>
        ) : null}

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
                        {analysis.authorName} · {analysis.taxonomyVersion} · 公开版本 V
                        {analysis.versionNumber}
                      </p>
                      <h3>{analysis.payload.analysisTitle}</h3>
                    </div>
                    <div className="analysis-card-actions">
                      <time>{formatLongDate(analysis.createdAt)}</time>
                      {analysis.versions.length > 1 ? (
                        <label className="analysis-version-select">
                          <span>查看历史版本</span>
                          <select
                            value={analysis.id}
                            disabled={Boolean(versionLoading)}
                            onChange={(event) =>
                              void showAnalysisVersion(index, event.target.value)
                            }
                          >
                            {[...analysis.versions].reverse().map((version) => (
                              <option value={version.id} key={version.id}>
                                V{version.versionNumber} · {formatLongDate(version.createdAt)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <span className="analysis-version-only">公开版本 V1</span>
                      )}
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
                      <AnalysisComments snapshotId={analysis.id}>
                        {content}
                      </AnalysisComments>
                    </ReviewPanel>
                  ) : (
                    <AnalysisComments snapshotId={analysis.id}>
                      {content}
                    </AnalysisComments>
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
      {editOpen ? (
        <EditVideoDialog
          videoId={video.id}
          video={video}
          onClose={() => setEditOpen(false)}
          onSaved={handleVideoSaved}
        />
      ) : null}
      {deleteOpen ? (
        <DeleteVideoDialog
          videoId={video.id}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => window.location.assign("/")}
        />
      ) : null}
    </main>
  );
}
