"use client";

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { audioReviewApi, formatAudioClock, type AudioReviewView } from "@/lib/audio-review-model";
import { audioReviewOpinionQuotes, groupAudioReviewOpinions } from "@/lib/audio-review-ui";
import { V04UiApiError } from "@/lib/v04-ui-api-client";
import {
  AudioReviewCorrectedText,
  AudioReviewKindTag,
  useAudioReviewPlayback,
  V19AudioReviewAudioBar,
  V19AudioReviewTranscript,
} from "./V19AudioReviewParts";
import styles from "./V04Surface.module.css";

/**
 * 确认点评改动（docs/25 二、4，七、3）：右侧抽屉，按「意见」组织。录音条、摘要、
 * 意见卡（总体／具体、原话＋时间点、落实说明、「原 → 改」逐处勾选、整条勾选含半选）、
 * 没落到条目的话、完整文字稿；底部是已选处数和三个动作。抽屉自己读一次完整任务；
 * 放弃、重新上传、生成都交给外壳（要改 model、切版本、弹 toast）。
 */
export default function V19AudioReviewDrawer({
  open,
  videoId,
  reviewId,
  baseLabel,
  nextVersionNumber,
  busy,
  covered = false,
  onClose,
  onConfirm,
  onAbandon,
  onReupload,
}: {
  open: boolean;
  videoId: string;
  reviewId: string | null;
  /** 「v1 刘梦娜」 */
  baseLabel: string;
  /** 预告「确认后生成点评版 vN」。 */
  nextVersionNumber: number;
  busy: boolean;
  /** 上面压着「放弃这次点评」确认弹窗：这时 Esc 与点遮罩都归弹窗处理，抽屉不跟着关。 */
  covered?: boolean;
  onClose: () => void;
  onConfirm: (view: AudioReviewView, selectedChangeIds: string[]) => void;
  onAbandon: () => void;
  onReupload: () => void;
}): JSX.Element | null {
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [loaded, setLoaded] = useState<{ id: string; view: AudioReviewView } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const view = loaded && loaded.id === reviewId ? loaded.view : null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playback = useAudioReviewPlayback(audioRef, view?.audio.durationMs ?? null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记已在浏览器挂载，SSR 时没有 document（同 DeleteConfirmDialog）
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open || !reviewId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { review } = await audioReviewApi.get(videoId, reviewId, controller.signal);
        if (controller.signal.aborted) return;
        setLoaded({ id: reviewId, view: review });
        setSelected(new Set(review.proposal?.changes.map((change) => change.id) ?? []));
        setLoadError("");
      } catch (reason) {
        if (controller.signal.aborted) return;
        setLoadError(reason instanceof V04UiApiError ? reason.message : "拟定的改动暂时读不出来，请重试。");
      }
    })();
    return () => controller.abort();
  }, [open, videoId, reviewId, reloadToken]);

  // 锁滚动只跟着开合走：别的依赖（busy、onClose 每次渲染都是新函数）一变就解锁再上锁，
  // 会和压在上面的确认弹窗各自记下的「原值」交错，最后把页面锁死。
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy && !covered) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, covered, onClose]);

  const groups = useMemo(() => (view ? groupAudioReviewOpinions(view) : []), [view]);
  const segments = view?.transcript?.segments ?? [];
  const marks = useMemo(() => {
    if (!view?.proposal) return [];
    const list = view.transcript?.segments ?? [];
    return view.proposal.opinions.flatMap((opinion) =>
      audioReviewOpinionQuotes(list, opinion.segmentIds).map((segment) => ({ ms: segment.startMs, title: `意见 ${opinion.number}` })));
  }, [view]);

  if (!open || !mounted) return null;

  const proposal = view?.proposal ?? null;
  const totalChanges = proposal?.changes.length ?? 0;
  const generalCount = proposal?.opinions.filter((opinion) => opinion.kind === "GENERAL").length ?? 0;
  const opinionCount = proposal?.opinions.length ?? 0;
  const unaddressed = proposal?.unaddressed ?? [];
  const selectedCount = proposal ? proposal.changes.filter((change) => selected.has(change.id)).length : 0;

  const toggleChange = (changeId: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(changeId); else next.delete(changeId);
      return next;
    });
  };
  const toggleOpinion = (changeIds: string[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of changeIds) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  };

  return createPortal(
    <div className={styles.surface} style={{ display: "contents" }}>
      <div className={styles.reviewScrim} role="presentation" onMouseDown={() => { if (!busy && !covered) onClose(); }} />
      <aside className={styles.reviewDrawer} role="dialog" aria-modal="true" aria-labelledby={titleId} data-v19-audio-review-drawer>
        <header className={styles.reviewDrawerHead}>
          <div>
            <h3 id={titleId}>确认点评改动</h3>
            <small>据{view?.reviewerName ?? "老孙"}录音点评改写 {baseLabel} · 确认后生成点评版 v{nextVersionNumber}</small>
          </div>
          <button type="button" className={styles.reviewDrawerClose} onClick={onClose} disabled={busy} aria-label="关闭确认面板">✕</button>
        </header>

        <div className={styles.reviewDrawerBody}>
          {!view && !loadError && <p className={styles.reviewDrawerState}>正在读取拟定的改动…</p>}
          {!view && loadError && (
            <div className={styles.reviewDrawerState}>
              <p>{loadError}</p>
              <button type="button" className={styles.reviewGhostButton} onClick={() => { setLoadError(""); setReloadToken((token) => token + 1); }}>
                重新读取
              </button>
            </div>
          )}
          {view && (
            <>
              <V19AudioReviewAudioBar
                audioRef={audioRef}
                src={audioReviewApi.audioUrl(videoId, view.id)}
                fileName={view.audio.fileName}
                playback={playback}
                marks={marks}
              />
              <p className={styles.reviewSummary}>
                听出 <b>{opinionCount} 条意见</b>（{generalCount} 条总体、{opinionCount - generalCount} 条具体），落实为 <b>{totalChanges} 处改动</b>
                {unaddressed.length > 0 ? `；另有 ${unaddressed.length} 段话没有落到条目，列在最后。` : "。"}
              </p>
              <p className={styles.reviewHint}>逐处核对“原 → 改”。理解错了的取消勾选即可；改写措辞不满意，也可以先生成，再在点评版里直接改。</p>

              {groups.map(({ opinion, changes, listedUnder }) => {
                const ids = changes.map((item) => item.change.id);
                const onCount = ids.filter((id) => selected.has(id)).length;
                const all = ids.length > 0 && onCount === ids.length;
                const partial = onCount > 0 && !all;
                const quotes = audioReviewOpinionQuotes(segments, opinion.segmentIds);
                return (
                  <article key={opinion.id} className={`${styles.reviewOp} ${ids.length > 0 && onCount === 0 ? styles.reviewOpOff : ""}`.trim()}
                    id={`audio-review-opinion-${opinion.number}`}>
                    <div className={styles.reviewOpHead}>
                      <span>{opinion.number}</span>
                      <h4><AudioReviewKindTag kind={opinion.kind} long />{opinion.summary}</h4>
                      {ids.length > 0 && (
                        <label className={styles.reviewOpToggle}>
                          <input
                            type="checkbox"
                            checked={all}
                            ref={(node) => { if (node) node.indeterminate = partial; }}
                            aria-checked={partial ? "mixed" : all}
                            onChange={(event) => toggleOpinion(ids, event.target.checked)}
                          />
                          落实 {onCount}/{ids.length} 处
                        </label>
                      )}
                    </div>
                    {quotes.length > 0 && (
                      <div className={styles.reviewQuotes}>
                        {quotes.map((segment) => (
                          <div key={segment.id} className={styles.reviewQuote}>
                            <button type="button" className={styles.reviewTime} onClick={() => playback.seek(segment.startMs)}
                              title="跳到录音这里播放">
                              {formatAudioClock(segment.startMs)}
                            </button>
                            {!segment.isReviewer && `${segment.speaker}：`}
                            <AudioReviewCorrectedText text={segment.text} corrections={segment.corrections} />
                          </div>
                        ))}
                      </div>
                    )}
                    {opinion.rationale && <p className={styles.reviewOpWhy}>{opinion.rationale}</p>}
                    {changes.length > 0 ? (
                      <div className={styles.reviewChanges}>
                        {changes.map(({ change, alsoNumbers }) => {
                          const on = selected.has(change.id);
                          return (
                            <label key={change.id} className={`${styles.reviewChange} ${on ? "" : styles.reviewChangeOff}`.trim()}>
                              <input type="checkbox" checked={on} onChange={(event) => toggleChange(change.id, event.target.checked)} />
                              <span className={styles.reviewChangeWhere}>
                                {change.label}
                                {alsoNumbers.length > 0 && (
                                  <span className={styles.reviewChangeAlso}>同时依据 意见 {alsoNumbers.join("、")}</span>
                                )}
                              </span>
                              <span className={styles.reviewChangeBefore}><i>原</i><span>{change.beforeText || "—"}</span></span>
                              <span className={styles.reviewChangeAfter}><i>改</i><span>{change.afterText || "—"}</span></span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className={styles.reviewOpEmpty}>
                        {listedUnder.length > 0
                          ? `这条意见的改动与意见 ${listedUnder.join("、")} 改到同一处，列在那里。`
                          : "这条意见听到了，但不需要改动条目。"}
                      </p>
                    )}
                  </article>
                );
              })}

              {unaddressed.length > 0 && (
                <details className={styles.reviewUnaddressed}>
                  <summary>没有落到条目的话（{unaddressed.length} 段）</summary>
                  <ul>
                    {unaddressed.map((item, index) => (
                      <li key={`${item.startMs}-${index}`}>
                        <button type="button" className={styles.reviewTime} onClick={() => playback.seek(item.startMs)}>
                          {formatAudioClock(item.startMs)}
                        </button>
                        {item.speaker}：{item.text}
                        <em>{item.reason}</em>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <V19AudioReviewTranscript segments={segments} playback={playback} />
            </>
          )}
        </div>

        <footer className={styles.reviewDrawerFoot}>
          <span className={styles.reviewDrawerCount}>已选 <b>{selectedCount}</b> / {totalChanges} 处</span>
          <button type="button" className={`${styles.reviewGhostButton} ${styles.reviewDangerButton}`} disabled={busy} onClick={onAbandon}>
            放弃这次点评
          </button>
          <button type="button" className={styles.reviewGhostButton} disabled={busy} onClick={onReupload}>重新上传</button>
          <button
            type="button"
            className={styles.reviewPrimaryButton}
            disabled={busy || !view || selectedCount === 0}
            onClick={() => {
              if (!view?.proposal) return;
              playback.pause();
              onConfirm(view, view.proposal.changes.filter((change) => selected.has(change.id)).map((change) => change.id));
            }}
          >
            {busy ? "正在生成…" : "生成点评版"}
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
