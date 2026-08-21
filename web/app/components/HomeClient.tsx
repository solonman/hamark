"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatShortDate } from "@/lib/date-format";
import { readJsonResponse } from "@/lib/http-json";
import type { ScoreRankingItem } from "@/lib/score-ranking";
import type { VideoItem } from "@/lib/types";
import type { V04ServerCardModel } from "@/lib/v04-ui-model";
import { V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import v04Styles from "@/components/v04/V04Surface.module.css";
import ScoreRankingDialog from "./ScoreRankingDialog";
import UploadDialog from "./UploadDialog";
import UserMenu, { type UserMenuUser } from "./UserMenu";

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function V04CardProjection({
  videoId,
  projection,
  defaultMode,
}: {
  videoId: string;
  projection?: V04ServerCardModel;
  defaultMode: boolean;
}) {
  if (!projection) return null;
  const encodedId = encodeURIComponent(videoId);
  return (
    <div className={v04Styles.existingCardProjection} data-v04-card-projection={videoId}>
      <div>
        <span className={v04Styles.existingWorkStatus}>{V04_UI_STATE_LABELS[projection.state]}</span>
        {projection.expertPreference ? (
          <span className={v04Styles.existingExpertGrade}>
            专家优选 {projection.expertPreference.grade}
          </span>
        ) : null}
      </div>
      {!defaultMode ? <div className={v04Styles.existingCardActions}>
        <Link href={`/videos/${encodedId}#v04-analysis`}>
          {projection.submissionCount > 0 ? "查看 V0.4 成果" : "查看 V0.4"}
        </Link>
        <Link href={`/videos/${encodedId}/practice?taxonomy=V0.4`}>
          {projection.state === "NOT_STARTED" ? "开始 V0.4 逆向工程" : "继续 V0.4 逆向工程"}
        </Link>
      </div> : null}
    </div>
  );
}

export default function HomeClient({
  user,
  isAdmin,
  v04LibraryEnabled = false,
  v04DefaultEnabled = false,
}: {
  user: UserMenuUser;
  isAdmin: boolean;
  v04LibraryEnabled?: boolean;
  v04DefaultEnabled?: boolean;
}) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [v04Projections, setV04Projections] = useState<Record<string, V04ServerCardModel>>({});
  const [v04ProjectionError, setV04ProjectionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [rankingStartDate, setRankingStartDate] = useState("");
  const [rankingEndDate, setRankingEndDate] = useState("");
  const [rankingItems, setRankingItems] = useState<ScoreRankingItem[]>([]);
  const [rankingError, setRankingError] = useState("");
  const [rankingLoading, setRankingLoading] = useState(false);
  const [showRanking, setShowRanking] = useState(false);
  const rankingRequestId = useRef(0);
  const v04TabToken = useRef(`v04-existing-library-${crypto.randomUUID()}`);

  useEffect(() => {
    let active = true;
    fetch("/api/videos", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          if (active) {
            setLoginRequired(true);
            setError("登录状态已失效，请重新登录。");
          }
          return;
        }
        const data = await readJsonResponse<{
          videos?: VideoItem[];
          error?: string;
        }>(response, "片库读取");
        if (!response.ok) throw new Error(data.error || "片库读取失败");
        const nextVideos = data.videos ?? [];
        if (active) {
          setVideos(nextVideos);
          setError("");
          setLoginRequired(false);
        }
        if (v04LibraryEnabled && nextVideos.length) {
          try {
            const { projections } = await v04UiApi.cards(
              nextVideos.map((video) => video.id),
              v04TabToken.current,
            );
            if (active) {
              setV04Projections(Object.fromEntries(
                (projections as V04ServerCardModel[]).map((projection) => [projection.videoId, projection]),
              ));
              setV04ProjectionError("");
            }
          } catch (reason) {
            if (active) {
              setV04Projections({});
              setV04ProjectionError(
                reason instanceof V04UiApiError
                  ? reason.message
                  : "V0.4 状态暂时无法读取，片库仍可正常使用。",
              );
            }
          }
        } else if (active) {
          setV04Projections({});
          setV04ProjectionError("");
        }
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "片库读取失败");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey, v04LibraryEnabled]);

  const filteredVideos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return videos;
    return videos.filter((video) =>
      [
        video.title,
        video.brand,
        video.createdByName,
        video.description,
        ...video.tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [query, videos]);

  const readyCount = videos.filter((video) => video.status === "READY").length;

  const openScoreRanking = async () => {
    if (!rankingStartDate || !rankingEndDate) {
      setRankingError("请选择起止日期。");
      return;
    }
    if (rankingStartDate > rankingEndDate) {
      setRankingError("起始日期不能晚于结束日期。");
      return;
    }
    const requestId = rankingRequestId.current + 1;
    rankingRequestId.current = requestId;
    setRankingLoading(true);
    setRankingError("");
    try {
      const response = await fetch(
        `/api/admin/video-score-ranking?${new URLSearchParams({ startDate: rankingStartDate, endDate: rankingEndDate })}`,
        { cache: "no-store" },
      );
      const data = await readJsonResponse<{ items?: ScoreRankingItem[]; error?: string }>(
        response,
        "评分排行读取",
      );
      if (!response.ok) throw new Error(data.error || "评分排行读取失败");
      if (rankingRequestId.current === requestId) {
        setRankingItems(data.items ?? []);
        setShowRanking(true);
      }
    } catch (reason) {
      if (rankingRequestId.current === requestId) {
        setRankingError(reason instanceof Error ? reason.message : "评分排行读取失败");
      }
    } finally {
      if (rankingRequestId.current === requestId) setRankingLoading(false);
    }
  };

  return (
    <main className="site-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="RE:VERSE 首页">
          <span className="wordmark-mark">R:</span>
          <span>RE:VERSE</span>
          <small>反写</small>
        </Link>
        <nav className="header-actions" aria-label="主导航">
          {isAdmin ? (
            <div className="score-ranking-controls">
              <Link className="ranking-button" href="/admin/v02-v03-batch-mapping">
                数据操作
              </Link>
              <label>
                <span className="sr-only">评分排行起始日期</span>
                <input type="date" value={rankingStartDate} onClick={(event) => event.currentTarget.showPicker?.()} onChange={(event) => setRankingStartDate(event.target.value)} disabled={rankingLoading} />
              </label>
              <span aria-hidden="true">—</span>
              <label>
                <span className="sr-only">评分排行结束日期</span>
                <input type="date" value={rankingEndDate} onClick={(event) => event.currentTarget.showPicker?.()} onChange={(event) => setRankingEndDate(event.target.value)} disabled={rankingLoading} />
              </label>
              <button type="button" className="ranking-button" onClick={openScoreRanking} disabled={rankingLoading}>
                {rankingLoading ? "读取中…" : "查看评分"}
              </button>
              {rankingError ? <span className="score-ranking-error" role="alert">{rankingError}</span> : null}
            </div>
          ) : null}
          <label className="search-field">
            <span className="sr-only">搜索片名、标签或作者</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索片名 / 标签 / 作者"
            />
            <span aria-hidden="true">⌕</span>
          </label>
          <button className="button button-dark" onClick={() => setShowUpload(true)}>
            <span aria-hidden="true">＋</span>
            上传作品
          </button>
          <UserMenu user={user} />
        </nav>
      </header>

      <section className="hero">
        <div className="hero-kicker">
          <span className="live-dot" />
          团队创意训练场
        </div>
        <h1>
          看完一支片，
          <br />
          把创意重新拆开。
        </h1>
        <div className="hero-foot">
          <p>
            看片、还原逐镜脚本、完成专业标注。
            <br />
            让优秀作品成为团队共同的创意教材。
          </p>
          <div
            className="demo-meter"
            aria-label={`闭环演示样片 ${Math.min(readyCount, 1)} / 1`}
          >
            <div className="demo-meter-head">
              <span>闭环演示样片</span>
              <strong>{Math.min(readyCount, 1)} / 1</strong>
            </div>
            <div className="meter-track">
              <span style={{ width: `${Math.min(100, readyCount * 100)}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className="library-section" aria-labelledby="library-title">
        <div className="section-head">
          <div>
            <p className="eyebrow">CREATIVE LIBRARY</p>
            <h2 id="library-title">全部作品</h2>
          </div>
          <p className="result-count">
            {filteredVideos.length.toString().padStart(2, "0")} 部影片
          </p>
        </div>

        {loading ? (
          <div className="state-panel">正在打开片库…</div>
        ) : error ? (
          <div className="state-panel state-error">
            <p>{error}</p>
            {loginRequired ? (
              <Link className="text-button" href="/login?return_to=/">
                重新登录
              </Link>
            ) : (
              <button
                className="text-button"
                onClick={() => {
                  setLoading(true);
                  setRefreshKey((value) => value + 1);
                }}
              >
                重新读取
              </button>
            )}
          </div>
        ) : filteredVideos.length === 0 && videos.length > 0 ? (
          <div className="state-panel">
            <p>没有找到与“{query}”匹配的作品。</p>
            <button className="text-button" onClick={() => setQuery("")}>
              清空搜索
            </button>
          </div>
        ) : videos.length === 0 ? (
          <button className="empty-library" onClick={() => setShowUpload(true)}>
            <span className="empty-number">01</span>
            <span>
              <strong>上传第一支作品</strong>
              <small>把值得反复拆解的片子放进团队片库</small>
            </span>
            <span className="circle-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
        ) : (
          <>
          {v04LibraryEnabled && v04ProjectionError ? (
            <div className="review-notice" role="status">{v04ProjectionError}</div>
          ) : null}
          <div className="video-grid">
            {filteredVideos.map((video, index) => (
              <article className="video-card" key={video.id}>
                <Link className="video-poster" href={`/videos/${video.id}`}>
                  {video.status === "READY" && video.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Signed COS thumbnails should stay a direct browser request.
                    <img
                      src={video.thumbnailUrl}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className="poster-placeholder">
                      {video.status === "READY"
                        ? "封面生成中"
                        : video.status === "UPLOADING"
                          ? "正在入库"
                          : "上传失败"}
                    </div>
                  )}
                  <span className="poster-index">
                    {(index + 1).toString().padStart(2, "0")}
                  </span>
                  <span className="play-disc" aria-hidden="true">
                    ▶
                  </span>
                </Link>
                <div className="video-meta">
                  <div className="video-title-row">
                    <div>
                      <p>{video.brand || "未标注品牌"}</p>
                      <h3>
                        <Link href={`/videos/${video.id}`}>{video.title}</Link>
                      </h3>
                    </div>
                    <span className="date-badge">{formatShortDate(video.createdAt)}</span>
                  </div>
                  <div className="tag-list">
                    {video.tags.slice(0, 4).map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                  <div className="card-foot">
                    <span>
                      {video.createdByName} · {formatBytes(video.fileSize)}
                    </span>
                    <span>{video.annotationCount} 份分析</span>
                  </div>
                  <div className="card-actions">
                    <Link href={`/videos/${video.id}`}>看片与分析</Link>
                    <Link href={v04DefaultEnabled
                      ? `/videos/${video.id}/practice`
                      : `/videos/${video.id}/practice?taxonomy=V0.3-PILOT`}>
                      {v04DefaultEnabled
                        ? (!v04Projections[video.id]
                            ? "进入 V1.9 逆向工程"
                            : v04Projections[video.id].state === "NOT_STARTED"
                              ? "开始 V1.9 逆向工程"
                              : "继续 V1.9 逆向工程")
                        : (video.hasV03Content
                            ? "继续 V0.3 逆向工程"
                            : "开始 V0.3 逆向工程")} <span aria-hidden="true">↗</span>
                    </Link>
                    {v04DefaultEnabled ? (
                      <Link href={`/videos/${video.id}/practice?taxonomy=V0.3-PILOT`}>
                        V0.3 兼容入口
                      </Link>
                    ) : null}
                  </div>
                  {v04LibraryEnabled ? (
                    <V04CardProjection
                      videoId={video.id}
                      projection={v04Projections[video.id]}
                      defaultMode={v04DefaultEnabled}
                    />
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          </>
        )}
      </section>

      <footer className="site-footer">
        <div>
          <span className="footer-mark">R:</span>
          <p>优秀创意，不只用来观看。</p>
        </div>
        <p>AD VIDEO DOMAIN · 标注体系 V0.2</p>
      </footer>

      {showUpload ? (
        <UploadDialog
          onClose={() => setShowUpload(false)}
          onUploaded={async (videoId) => {
            setShowUpload(false);
            window.location.href = `/videos/${videoId}`;
          }}
        />
      ) : null}

      {showRanking ? (
        <ScoreRankingDialog
          startDate={rankingStartDate}
          endDate={rankingEndDate}
          items={rankingItems}
          onClose={() => setShowRanking(false)}
        />
      ) : null}
    </main>
  );
}
