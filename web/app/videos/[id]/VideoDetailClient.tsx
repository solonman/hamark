"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import DraggableVideoPlayer from "@/app/components/DraggableVideoPlayer";
import { formatLongDate } from "@/lib/date-format";
import type {
  ApprovedAnalysisRelease,
  SubmittedAnalysis,
  VideoItem,
} from "@/lib/types";
import DeleteVideoDialog from "./DeleteVideoDialog";
import EditVideoDialog, { type EditableVideoInfo } from "./EditVideoDialog";
import ReplaceVideoDialog, {
  type ReplacedVideoFile,
} from "./ReplaceVideoDialog";
import SubmittedAnalysisContent from "./SubmittedAnalysisContent";
import AnalysisComments from "./AnalysisComments";
import V03ReviewDecisionBar from "./V03ReviewDecisionBar";
import { resolveReviewEntry } from "@/lib/review-entry";
import StandardRevisionHistory from "./StandardRevisionHistory";
import SharedRevisionHistory from "./SharedRevisionHistory";

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
  const [approvedStandards, setApprovedStandards] = useState<ApprovedAnalysisRelease[]>([]);
  const [approvedStandardHistory, setApprovedStandardHistory] = useState<ApprovedAnalysisRelease[]>([]);
  const [currentPublicV03, setCurrentPublicV03] = useState<SubmittedAnalysis | null>(null);
  const [collaboration, setCollaboration] = useState<{
    streamId: string;
    initialBaselineId: string;
    roundId: string;
    roundNumber: number;
    roundStatus: string;
    sourceAuthorName: string;
    currentSnapshotId: string | null;
    candidateSnapshotId: string | null;
    activeReleaseNumber: number | null;
    lastEditorName: string | null;
    lastEditedAt: string | null;
  } | null>(null);
  const [canFinalizeSharedV03, setCanFinalizeSharedV03] = useState(false);
  const [sharedV03MutableAvailable, setSharedV03MutableAvailable] = useState(false);
  const [sharedV03DisplaySource, setSharedV03DisplaySource] = useState<string | null>(null);
  const [sharedV03PendingBackfill, setSharedV03PendingBackfill] = useState(false);
  const [sharedV03SourceAuthorName, setSharedV03SourceAuthorName] = useState<string | null>(null);
  const [initialBaseline, setInitialBaseline] = useState<SubmittedAnalysis | null>(null);
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
  const [loadedStandardHistory, setLoadedStandardHistory] = useState<Record<string, ApprovedAnalysisRelease>>({});
  const [sourceAnalyses, setSourceAnalyses] = useState<Record<string, SubmittedAnalysis>>({});
  const playerSlotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/videos/${videoId}`, { cache: "no-store" })
      .then(async (response) => {
        if (redirectOnUnauthorized(response)) return;
        const data = (await response.json()) as {
          video?: VideoItem;
          analyses?: SubmittedAnalysis[];
          approvedStandards?: ApprovedAnalysisRelease[];
          approvedStandardHistory?: ApprovedAnalysisRelease[];
          currentPublicV03?: SubmittedAnalysis | null;
          collaboration?: typeof collaboration;
          canFinalizeSharedV03?: boolean;
          sharedV03MutableAvailable?: boolean;
          sharedV03DisplaySource?: string | null;
          sharedV03PendingBackfill?: boolean;
          sharedV03SourceAuthorName?: string | null;
          canManage?: boolean;
          canDeletePermanently?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "作品读取失败");
        if (active) {
          setVideo(data.video ?? null);
          setAnalyses(data.analyses ?? []);
          setApprovedStandards(data.approvedStandards ?? []);
          setApprovedStandardHistory(data.approvedStandardHistory ?? []);
          setCurrentPublicV03(data.currentPublicV03 ?? null);
          setCollaboration(data.collaboration ?? null);
          setCanFinalizeSharedV03(Boolean(data.canFinalizeSharedV03));
          setSharedV03MutableAvailable(Boolean(data.sharedV03MutableAvailable));
          setSharedV03DisplaySource(data.sharedV03DisplaySource ?? null);
          setSharedV03PendingBackfill(Boolean(data.sharedV03PendingBackfill));
          setSharedV03SourceAuthorName(data.sharedV03SourceAuthorName ?? null);
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

  async function loadHistoricalStandard(releaseId: string) {
    if (loadedStandardHistory[releaseId]) return;
    setVersionLoading(releaseId);
    setVersionNotice("");
    try {
      const response = await fetch(`/api/approved-standards/${releaseId}`, { cache: "no-store" });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { release?: ApprovedAnalysisRelease; error?: string };
      if (!response.ok || !data.release?.payload) {
        throw new Error(data.error || "历史标准版读取失败");
      }
      setLoadedStandardHistory((current) => ({ ...current, [releaseId]: data.release! }));
    } catch (reason) {
      setVersionNotice(reason instanceof Error ? reason.message : "历史标准版读取失败");
    } finally {
      setVersionLoading(null);
    }
  }

  async function loadSourceAnalysis(snapshotId: string) {
    if (sourceAnalyses[snapshotId]) return;
    setVersionLoading(snapshotId);
    setVersionNotice("");
    try {
      const response = await fetch(`/api/analyses/${snapshotId}`, { cache: "no-store" });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { analysis?: SubmittedAnalysis; error?: string };
      if (!response.ok || !data.analysis) throw new Error(data.error || "来源作业读取失败");
      setSourceAnalyses((current) => ({ ...current, [snapshotId]: data.analysis! }));
    } catch (reason) {
      setVersionNotice(reason instanceof Error ? reason.message : "来源作业读取失败");
    } finally {
      setVersionLoading(null);
    }
  }

  async function restoreHistoricalRelease(releaseId: string, releaseNumber: number) {
    if (!window.confirm(`确认从永久批准版 R${releaseNumber} 创建新的共享恢复轮？历史版本不会被覆盖。`)) return;
    setVersionLoading(releaseId);
    setVersionNotice("");
    try {
      const response = await fetch(`/api/approved-standards/${releaseId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "RESTORE_AS_NEW_ROUND",
          confirmation: "确认从历史批准版创建新的共享恢复轮",
        }),
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "恢复轮创建失败");
      window.location.reload();
    } catch (reason) {
      setVersionNotice(reason instanceof Error ? reason.message : "恢复轮创建失败");
    } finally {
      setVersionLoading(null);
    }
  }

  async function loadInitialBaseline() {
    if (!collaboration || initialBaseline) return;
    setVersionLoading(collaboration.streamId);
    setVersionNotice("");
    try {
      const response = await fetch(`/api/v03-baselines/${collaboration.initialBaselineId}`, { cache: "no-store" });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        baseline?: {
          id: string;
          payload: SubmittedAnalysis["payload"];
          contentHash: string;
          sourceAuthorName: string;
          createdAt: string;
        };
        error?: string;
      };
      if (!response.ok || !data.baseline) throw new Error(data.error || "初始基线读取失败");
      setInitialBaseline({
        id: data.baseline.id,
        authorName: data.baseline.sourceAuthorName,
        taxonomyVersion: "V0.3-PILOT",
        revision: data.baseline.payload.revision,
        versionNumber: 0,
        createdAt: data.baseline.createdAt,
        contentHash: data.baseline.contentHash,
        payload: data.baseline.payload,
        versions: [],
        versionIdentity: "HISTORICAL_STANDARD",
      });
    } catch (reason) {
      setVersionNotice(reason instanceof Error ? reason.message : "初始基线读取失败");
    } finally {
      setVersionLoading(null);
    }
  }

  async function restoreInitialBaseline() {
    if (!collaboration) return;
    if (!window.confirm("确认从永久保留的公共初始基线创建新的共享恢复轮？历史版本不会被覆盖。")) return;
    setVersionLoading(collaboration.initialBaselineId);
    setVersionNotice("");
    try {
      const response = await fetch(`/api/v03-baselines/${collaboration.initialBaselineId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "RESTORE_BASELINE_AS_NEW_ROUND",
          confirmation: "确认从公共初始基线创建新的共享恢复轮",
        }),
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "初始基线恢复失败");
      window.location.reload();
    } catch (reason) {
      setVersionNotice(reason instanceof Error ? reason.message : "初始基线恢复失败");
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
          <Link className="button button-accent" href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}>
            {currentPublicV03 ? "继续 V0.3 逆向工程" : "开始 V0.3 逆向工程"}
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
          <div className="analysis-entry-actions">
            <Link
              className="text-button"
              href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}
            >
              {currentPublicV03 ? "继续 V0.3 逆向工程 ↗" : "开始 V0.3 逆向工程 ↗"}
            </Link>
            <Link className="text-button muted" href={`/videos/${videoId}/practice?taxonomy=V0.2`}>
              历史体系 V0.2 · 只读查看
            </Link>
          </div>
        </div>

        {versionNotice ? (
          <div className="review-notice error">{versionNotice}</div>
        ) : null}

        {currentPublicV03 ? (
          <article className="analysis-card reading-surface shared-v03-card">
            <div className="analysis-card-head">
              <span className="analysis-index">V03</span>
              <div>
                <p>
                  {collaboration
                    ? `当前公共 V0.3 · 共享修订轮 ${collaboration.roundNumber} · 工作稿 rev ${currentPublicV03.revision}`
                    : `既有 V0.3 · 待接入共享主线 · rev ${currentPublicV03.revision}`}
                </p>
                <h3>{currentPublicV03.payload.analysisTitle || "未命名公共分析"}</h3>
                <small>
                  来源署名 {collaboration?.sourceAuthorName ?? sharedV03SourceAuthorName ?? currentPublicV03.authorName}
                  {collaboration?.lastEditorName
                    ? ` · 最近由 ${collaboration.lastEditorName} 修订`
                    : ""}
                </small>
              </div>
              <div className="analysis-card-actions">
                <span className="analysis-version-only">
                  {sharedV03MutableAvailable && collaboration
                    ? collaboration.roundStatus
                    : sharedV03PendingBackfill
                      ? "既有内容 · 兼容只读"
                      : `只读恢复显示 · ${sharedV03DisplaySource}`}
                </span>
                {sharedV03MutableAvailable ? (
                  <Link
                    className="button button-accent compact"
                    href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}
                  >
                    编辑公共 V0.3 · 进入共享修订
                  </Link>
                ) : null}
              </div>
            </div>
            {collaboration && canFinalizeSharedV03 &&
            collaboration.candidateSnapshotId === currentPublicV03.id ? (
              <V03ReviewDecisionBar snapshotId={currentPublicV03.id} mode="review" />
            ) : collaboration?.candidateSnapshotId === currentPublicV03.id ? (
              <p className="review-notice">
                当前工作稿已提交为专家定稿候选；继续修订会使本候选失效，但不会丢失候选快照。
              </p>
            ) : null}
            {collaboration ? <AnalysisComments
              snapshotId={currentPublicV03.id}
              taxonomyVersion="V0.3-PILOT"
              analysis={currentPublicV03}
              reviewMode={sharedV03MutableAvailable}
              collaborationMode={sharedV03MutableAvailable}
            >
              <SubmittedAnalysisContent analysis={currentPublicV03} forceOpen />
            </AnalysisComments> : <>
              <p className="review-notice">
                这份既有 V0.3 正在通过兼容读取保留显示；内容不会消失，也不会创建个人空白稿。
              </p>
              <SubmittedAnalysisContent analysis={currentPublicV03} forceOpen />
            </>}
            {collaboration ? <SharedRevisionHistory videoId={videoId} /> : null}
            {collaboration ? <details className="standard-history shared-baseline-history">
              <summary>公共 V0.3 初始基线 · 永久保留</summary>
              {canFinalizeSharedV03 ? (
                <button
                  type="button"
                  className="button button-accent compact standard-history-loader"
                  disabled={versionLoading === collaboration.initialBaselineId}
                  onClick={() => void restoreInitialBaseline()}
                >
                  从初始基线创建恢复轮
                </button>
              ) : null}
              {!initialBaseline ? (
                <button
                  type="button"
                  className="button button-ghost compact standard-history-loader"
                  disabled={versionLoading === collaboration.streamId}
                  onClick={() => void loadInitialBaseline()}
                >
                  {versionLoading === collaboration.streamId ? "读取中…" : "查看公共初始基线"}
                </button>
              ) : (
                <SubmittedAnalysisContent analysis={initialBaseline} forceOpen={false} />
              )}
            </details> : null}
          </article>
        ) : (
          <div className="no-analysis">
            <span>尚未开始 V0.3 逆向工程</span>
            <p>打开完整空白工作区即可开始填写；读取页面不写数据，第一次保存时才建立唯一的公共工作稿。</p>
            <Link className="button button-accent compact" href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}>
              开始 V0.3 逆向工程
            </Link>
          </div>
        )}

        {approvedStandards.length ? (
          <div className="standard-case-list">
            {approvedStandards.map((release) => {
              if (!release.payload) return null;
              const cleanAnalysis: SubmittedAnalysis = {
                id: release.approvedSnapshotId,
                authorName: release.payload.authorName,
                taxonomyVersion: release.payload.taxonomyVersion,
                revision: release.payload.revision,
                versionNumber: release.releaseNumber,
                createdAt: release.approvedAt,
                contentHash: release.contentHash,
                payload: release.payload,
                versions: [],
                versionIdentity: "ACTIVE_STANDARD",
              };
              const sourceAnalysis = sourceAnalyses[release.sourceSnapshotId];
              return (
                <details className="standard-case-card" key={release.id} open>
                  <summary>
                    <span>活动标准版 R{release.releaseNumber}</span>
                    <strong>专家创意等级 {release.expertCreativeGrade}</strong>
                    <small>{release.approvedByName} 终审 · 干净批准快照</small>
                  </summary>
                  <div className="standard-lineage-bar">
                    <span>来源：{release.sourceAuthorName ?? release.payload.authorName} 的公开作业</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={versionLoading === release.sourceSnapshotId}
                      onClick={() => void loadSourceAnalysis(release.sourceSnapshotId)}
                    >
                      {sourceAnalysis ? "已加载来源" : versionLoading === release.sourceSnapshotId ? "读取中…" : "查看来源作业"}
                    </button>
                    <span className="analysis-version-only">永久只读批准版</span>
                  </div>
                  {sourceAnalysis ? (
                    <details className="standard-source-card">
                      <summary>来源公开作业 V{sourceAnalysis.versionNumber} · {sourceAnalysis.authorName}</summary>
                      <div className="reading-surface">
                        <SubmittedAnalysisContent analysis={sourceAnalysis} forceOpen={false} />
                      </div>
                    </details>
                  ) : null}
                  <div className="reading-surface">
                    <SubmittedAnalysisContent analysis={cleanAnalysis} forceOpen={false} />
                  </div>
                  <StandardRevisionHistory releaseId={release.id} />
                </details>
              );
            })}
          </div>
        ) : null}

        {approvedStandardHistory.some((release) => release.status !== "ACTIVE") ? (
          <details className="standard-history">
            <summary>
              历史批准版本
              <span>{approvedStandardHistory.filter((release) => release.status !== "ACTIVE").length} 个</span>
            </summary>
            <div>
              {approvedStandardHistory
                .filter((release) => release.status !== "ACTIVE")
                .map((release) => {
                  const loaded = loadedStandardHistory[release.id];
                  const historical: SubmittedAnalysis | null = loaded?.payload ? {
                    id: loaded.approvedSnapshotId,
                    authorName: loaded.payload.authorName,
                    taxonomyVersion: loaded.payload.taxonomyVersion,
                    revision: loaded.payload.revision,
                    versionNumber: loaded.releaseNumber,
                    createdAt: loaded.approvedAt,
                    contentHash: loaded.contentHash,
                    payload: loaded.payload,
                    versions: [],
                    versionIdentity: "HISTORICAL_STANDARD",
                  } : null;
                  return (
                    <details className="standard-case-card historical" key={release.id}>
                      <summary>
                        <span>标准案例 R{release.releaseNumber}</span>
                        <strong>已由后续版本替代</strong>
                        <small>{release.approvedByName} 终审</small>
                      </summary>
                      {!historical ? (
                        <div className="standard-lineage-bar">
                          <button
                            type="button"
                            className="button button-ghost compact standard-history-loader"
                            disabled={versionLoading === release.id}
                            onClick={() => void loadHistoricalStandard(release.id)}
                          >
                            {versionLoading === release.id ? "读取中…" : "按需读取历史正文"}
                          </button>
                          {canFinalizeSharedV03 ? (
                            <button
                              type="button"
                              className="button button-accent compact"
                              disabled={versionLoading === release.id}
                              onClick={() => void restoreHistoricalRelease(release.id, release.releaseNumber)}
                            >
                              从 R{release.releaseNumber} 创建恢复轮
                            </button>
                          ) : null}
                        </div>
                      ) : <>
                        {canFinalizeSharedV03 ? (
                          <div className="standard-lineage-bar">
                            <span>恢复不会覆盖任何中间版本</span>
                            <button
                              type="button"
                              className="button button-accent compact"
                              disabled={versionLoading === release.id}
                              onClick={() => void restoreHistoricalRelease(release.id, release.releaseNumber)}
                            >
                              从 R{release.releaseNumber} 创建恢复轮
                            </button>
                          </div>
                        ) : null}
                        <div className="reading-surface">
                          <SubmittedAnalysisContent analysis={historical} forceOpen={false} />
                        </div>
                        <StandardRevisionHistory releaseId={release.id} />
                      </>}
                    </details>
                  );
                })}
            </div>
          </details>
        ) : null}

        {!currentPublicV03 && analyses.length === 0 ? (
          <div className="no-analysis">
            <span>还没有人交作业</span>
            <p>第一份公开分析，可以从你开始。</p>
            <Link className="button button-dark" href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}>
              查看公共 V0.3
            </Link>
          </div>
        ) : analyses.length ? (
          <div className="analysis-list">
            {analyses.map((analysis, index) => {
              const reviewActive = activeReviewId === analysis.id;
              const reviewContext = analysis.reviewContext;
              const entryState = resolveReviewEntry({
                taxonomyVersion: analysis.taxonomyVersion,
                workflowStatus: analysis.payload.reviewStatus,
                review: reviewContext,
                versionIdentity: analysis.versionIdentity,
              });
              const canEnterReview = entryState === "ENTER_REVIEW";
              const authorNeedsAction = entryState === "AUTHOR_EDIT";
              const content = (
                <SubmittedAnalysisContent
                  analysis={analysis}
                  forceOpen={reviewActive}
                />
              );
              return (
                <article className="analysis-card reading-surface" key={analysis.id}>
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
                      {analysis.taxonomyVersion === "V0.2" ? (
                        <span className="analysis-version-only">历史体系 · 只读</span>
                      ) : canEnterReview ? (
                        <button
                          type="button"
                          className="button button-accent compact"
                          onClick={() =>
                            setActiveReviewId((current) =>
                              current === analysis.id ? null : analysis.id,
                            )
                          }
                        >
                          {reviewActive ? "退出终审模式" : "进入终审模式"}
                        </button>
                      ) : authorNeedsAction ? (
                        <Link className="button button-accent compact" href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}>
                          开始修改
                        </Link>
                      ) : entryState === "AUTHOR_NEW_ROUND" ? (
                        <Link className="button button-ghost compact" href={`/videos/${videoId}/practice?taxonomy=V0.3-PILOT`}>
                          查看当前公共修订轮
                        </Link>
                      ) : (
                        <span className="analysis-version-only">
                          {entryState === "APPROVED_READ_ONLY"
                            ? "已批准 · 只读"
                            : entryState === "WAITING_AUTHOR"
                              ? "等待共享候选"
                              : entryState === "WAITING_REVIEW"
                                ? "等待终审"
                                : "公开作业 · 只读"}
                        </span>
                      )}
                    </div>
                  </div>

                  {reviewActive && analysis.taxonomyVersion === "V0.3-PILOT" ? (
                    <>
                      <V03ReviewDecisionBar snapshotId={analysis.id} initialReview={reviewContext} mode="review" />
                      <AnalysisComments snapshotId={analysis.id} taxonomyVersion={analysis.taxonomyVersion} analysis={analysis} reviewMode>
                        {content}
                      </AnalysisComments>
                    </>
                  ) : (
                    <>
                      {reviewContext?.isAuthor && reviewContext.canWithdraw ? (
                        <V03ReviewDecisionBar snapshotId={analysis.id} initialReview={reviewContext} mode="author" />
                      ) : null}
                      <AnalysisComments snapshotId={analysis.id} taxonomyVersion={analysis.taxonomyVersion} analysis={analysis}>
                        {content}
                      </AnalysisComments>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        ) : null}
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
