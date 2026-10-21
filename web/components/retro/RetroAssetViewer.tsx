"use client";

import { useEffect, useRef, useState, type JSX } from "react";
import { formatRetroClock, type RetroAssetView, type RetroDocPageView } from "@/lib/retro-model";
import { buildClientTranscript, docFormatLabel } from "@/lib/retro-ui";
import RetroAudioPanel, { type RetroAudioSeekRequest } from "./RetroAudioPanel";
import RetroZoomImage from "./RetroZoomImage";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

/** 弹层眉头的类型名。 */
export function retroViewerKindLabel(asset: Pick<RetroAssetView, "type" | "docFormat">): string {
  if (asset.type === "IMAGE") return "图片";
  if (asset.type === "VIDEO") return "视频";
  if (asset.type === "AUDIO") return "客户录音";
  switch (asset.docFormat) {
    case "PDF": return "PDF";
    case "WORD": return "Word";
    case "EXCEL": return "Excel";
    case "PPT": return "PPT";
    default: return docFormatLabel(asset.docFormat);
  }
}

/**
 * 附件的站内弹层（docs/26 4.3「全部在站内弹层预览」）：案例页上只有这一个，点任何附件格都开它。
 * 外框是报告工作台的 .ov 一组（眉头：类型、同一处同类附件里的序号「2 / 5」、文件名、「关闭 esc」；不提供下载，同视频库、报告库）：
 * - 图片：大图，←→ 在同一处（需求凭证或同一回合）的图片间翻；
 * - 视频：<video controls>，截帧作 poster；关闭（卸载）即停止播放；
 * - 客户录音：录音条 + 文字稿（RetroAudioPanel）；转写中、失败照旧显示，失败可重试；
 * - 文档：逐页大图，←→／按钮翻页，到首尾不回绕（同报告库 ReportPageModal），底部缩略条；
 *   转换中显示「正在生成预览」（案例页按 4 秒轮询刷新），失败显示原因。
 * 键盘监听在组件挂载时只挂一次（按 ref 读当前状态）；打开时锁 body 滚动；点遮罩关闭。
 */
export default function RetroAssetViewer({
  group,
  assetId,
  canEdit,
  audioSeek,
  onNavigate,
  onClose,
  onRetryTranscript,
}: {
  /** 这个附件所在那一处（需求凭证或某一回合）的全部已传完附件，按位置排好。null = 弹层关着。 */
  group: readonly RetroAssetView[] | null;
  assetId: string | null;
  canEdit: boolean;
  /** 「去听原声」／?audio= 带来的跳转。 */
  audioSeek: RetroAudioSeekRequest | null;
  onNavigate: (assetId: string) => void;
  onClose: () => void;
  onRetryTranscript: (asset: RetroAssetView) => void;
}): JSX.Element | null {
  const asset = group && assetId ? group.find((item) => item.id === assetId) ?? null : null;
  const open = asset !== null;
  const siblings = asset && group ? group.filter((item) => item.type === asset.type) : [];
  const index = asset ? siblings.findIndex((item) => item.id === asset.id) : -1;

  const pages: readonly RetroDocPageView[] = asset?.type === "DOC" && asset.derivativeStatus === "READY" ? asset.pages ?? [] : [];
  const [pageState, setPageState] = useState<{ assetId: string | null; index: number }>({ assetId: null, index: 0 });
  // 换了一份文档就回到第 1 页（不用 effect，渲染时按 assetId 判断）。
  const pageIndex = pageState.assetId === assetId ? Math.min(pageState.index, Math.max(0, pages.length - 1)) : 0;
  const setPageIndex = (next: number) => setPageState({ assetId, index: next });
  const stripRef = useRef<HTMLDivElement | null>(null);

  // ---- 键盘：全页只挂一次，按 ref 读当前状态 ----
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const handleKey = (event: KeyboardEvent) => {
    if (!asset) return;
    if (event.key === "Escape") { onClose(); return; }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "VIDEO" || tag === "AUDIO") return;
    const step = event.key === "ArrowLeft" ? -1 : 1;
    if (asset.type === "DOC") {
      const next = pageIndex + step;
      if (next >= 0 && next < pages.length) { event.preventDefault(); setPageIndex(next); }
    } else if (asset.type === "IMAGE") {
      const next = siblings[index + step];
      if (next) { event.preventDefault(); onNavigate(next.id); }
    }
  };
  useEffect(() => { keyRef.current = handleKey; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ---- 打开时锁 body 滚动 ----
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // 当前页的缩略图滚进可视范围（instant：隐藏标签页里平滑滚动不走）。
  useEffect(() => {
    const cell = stripRef.current?.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [pageIndex, assetId]);

  if (!asset) return null;

  const kind = retroViewerKindLabel(asset);

  let body: JSX.Element;
  let foot: JSX.Element | null = null;
  if (asset.type === "IMAGE") {
    const prev = siblings[index - 1];
    const next = siblings[index + 1];
    body = (
      <div className={styles.viewerBody} data-v04-scheme="dark">
        <div className={styles.viewerImage}>
          {asset.derivativeStatus === "READY" && asset.displayUrl ? (
            <RetroZoomImage src={asset.displayUrl} alt={asset.originalName} resetKey={asset.id} />
          ) : (
            <div className={styles.viewerNote}>
              <b>{asset.derivativeStatus === "FAILED" ? "预览生成失败" : "正在生成预览"}</b>
              <small>{asset.derivativeStatus === "FAILED" ? (asset.derivativeError || "这张图片没能生成预览。") : "稍后再看。"}</small>
            </div>
          )}
        </div>
        {siblings.length > 1 ? (
          <>
            <button type="button" className={styles.viewerNav} data-dir="prev" aria-label="上一张" disabled={!prev} onClick={() => prev && onNavigate(prev.id)}>‹</button>
            <button type="button" className={styles.viewerNav} data-dir="next" aria-label="下一张" disabled={!next} onClick={() => next && onNavigate(next.id)}>›</button>
          </>
        ) : null}
      </div>
    );
  } else if (asset.type === "VIDEO") {
    body = (
      <div className={styles.viewerBody} data-v04-scheme="dark">
        <div className={styles.viewerImage}>
          {/* key：换一段视频就换一个元素，上一段立刻停；弹层关闭时元素卸载，播放随之停止。 */}
          <video key={asset.id} controls autoPlay playsInline preload="metadata" poster={asset.thumbnailUrl ?? undefined} src={asset.streamUrl ?? undefined} />
        </div>
      </div>
    );
  } else if (asset.type === "AUDIO") {
    body = (
      <div className={styles.viewerAudio} data-retro-audio-panel={asset.id}>
        <ViewerAudio key={asset.id} asset={asset} seek={audioSeek} canEdit={canEdit} onRetry={() => onRetryTranscript(asset)} />
      </div>
    );
  } else {
    const page = pages[pageIndex] ?? null;
    let stage: JSX.Element;
    if (asset.derivativeStatus === "PENDING") {
      stage = (
        <div className={styles.viewerNote}>
          <b><span className={`${v04.reviewSpin} ${styles.spinSmall}`} aria-hidden="true" /> 正在生成预览</b>
          <small>文档正在转成逐页图片，完成后自动出现在这里。</small>
        </div>
      );
    } else if (asset.derivativeStatus === "FAILED") {
      stage = (
        <div className={styles.viewerNote}>
          <b>预览生成失败</b>
          <small>{asset.derivativeError || "这份文档没能转成逐页图片。"}</small>
        </div>
      );
    } else if (!page) {
      stage = (
        <div className={styles.viewerNote}>
          <b>这份文档没有可预览的页面</b>
          <small>数据万象没有转换出页面。</small>
        </div>
      );
    } else if (!page.ok || !page.largeUrl) {
      stage = (
        <div className={styles.viewerNote}>
          <b>第 {page.pageNo} 页转换失败</b>
          <small>其它页可以照常翻看。</small>
        </div>
      );
    } else {
      stage = <RetroZoomImage src={page.largeUrl} alt={`${asset.originalName} 第 ${page.pageNo} 页`} resetKey={`${asset.id}:${page.pageNo}`} />;
    }
    body = (
      <div className={styles.viewerBody} data-v04-scheme="dark">
        <div className={styles.viewerPage}>{stage}</div>
        {pages.length > 1 ? (
          <>
            <button type="button" className={styles.viewerNav} data-dir="prev" aria-label="上一页" disabled={pageIndex <= 0} onClick={() => setPageIndex(pageIndex - 1)}>‹</button>
            <button type="button" className={styles.viewerNav} data-dir="next" aria-label="下一页" disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex(pageIndex + 1)}>›</button>
          </>
        ) : null}
      </div>
    );
    if (pages.length) {
      const last = pages.length - 1;
      foot = (
        <div className={styles.ovfoot}>
          <span className={styles.ovfootNav}>
            <button type="button" className={styles.smBtn} disabled={pageIndex <= 0} title="回到第 1 页" onClick={() => setPageIndex(0)}>首页</button>
            <button type="button" className={styles.smBtn} disabled={pageIndex <= 0} onClick={() => setPageIndex(pageIndex - 1)}>← 上一页</button>
            <span className={styles.ovfootCnt}>p{String(pages[pageIndex]?.pageNo ?? pageIndex + 1).padStart(2, "0")} / {pages.length}</span>
            <button type="button" className={styles.smBtn} disabled={pageIndex >= last} onClick={() => setPageIndex(pageIndex + 1)}>下一页 →</button>
            <button type="button" className={styles.smBtn} disabled={pageIndex >= last} title="跳到最后一页" onClick={() => setPageIndex(last)}>尾页</button>
          </span>
          {pages.length > 1 ? (
            <div className={styles.pageStrip} ref={stripRef} data-v04-scheme="dark" aria-label="页面缩略条">
              {pages.map((item, at) => (
                <button
                  key={item.pageNo}
                  type="button"
                  className={styles.pageCell}
                  data-page-index={at}
                  data-on={at === pageIndex ? "1" : undefined}
                  aria-label={`第 ${item.pageNo} 页`}
                  aria-current={at === pageIndex ? "page" : undefined}
                  onClick={() => setPageIndex(at)}
                >
                  {item.ok && item.thumbUrl
                    // eslint-disable-next-line @next/next/no-img-element -- 页缩略图来自对象存储签名 URL
                    ? <img src={item.thumbUrl} alt="" loading="lazy" />
                    : <span>{item.pageNo}</span>}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
  }

  return (
    <div className={styles.ov} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.ovbox} role="dialog" aria-modal="true" aria-label={`${kind}：${asset.originalName}`} data-retro-viewer={asset.type}>
        <div className={styles.ovhead}>
          <b>{kind}</b>
          {siblings.length > 1 ? <span className={styles.ovCount}>{index + 1} / {siblings.length}</span> : null}
          <span className={styles.ovheadT} title={asset.originalName}>{asset.originalName}</span>
          <button type="button" className={styles.smBtn} autoFocus onClick={onClose}>关闭 esc</button>
        </div>
        {body}
        {foot}
      </div>
    </div>
  );
}

/** 弹层里的客户录音：录音条随时能播；文字稿转写完才有，转写中、失败给一句说明，失败时有编辑权的人可以重试。 */
function ViewerAudio({ asset, seek, canEdit, onRetry }: {
  asset: RetroAssetView;
  seek: RetroAudioSeekRequest | null;
  canEdit: boolean;
  onRetry: () => void;
}): JSX.Element {
  const t = asset.transcribe;
  const ready = t?.status === "READY" && t.segments;
  const lines = ready ? buildClientTranscript(asset.id, t.segments!) : [];
  const durationMs = t?.durationMs ?? (asset.durationSeconds ? asset.durationSeconds * 1000 : null);
  const status = t?.status === "FAILED" ? (
    <p className={styles.recNote}>
      这段客户录音转写失败{t.failReason ? `（${t.failReason}）` : ""}，没有文字稿，也不会进入 AI 提炼。
      {canEdit ? <> <button type="button" className={v04.reviewGhostButton} onClick={onRetry}>重试转写</button></> : null}
    </p>
  ) : !ready ? (
    <p className={styles.recNote}>
      <span className={`${v04.reviewSpin} ${styles.spinSmall}`} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
      转写中，完成后文字稿出现在这里；录音可以先听。
    </p>
  ) : null;
  return (
    <>
      <RetroAudioPanel
        ownerId={asset.id}
        src={asset.streamUrl ?? ""}
        fileName={asset.originalName}
        durationMs={durationMs}
        lines={lines}
        summary={`文字稿（${lines.length} 句 · 说话人自动区分 · 全员可见）`}
        seekRequest={seek}
        extra={(
          <div className={styles.recParts}>
            <span className={styles.recMeta}>
              客户录音 · {ready ? "转写完成" : t?.status === "FAILED" ? "转写失败" : "转写中"}
              {durationMs ? ` · ${formatRetroClock(durationMs)}` : ""}
            </span>
          </div>
        )}
      />
      {status}
    </>
  );
}
