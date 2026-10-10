"use client";

import { useMemo, useRef, type JSX } from "react";
import { audioReviewApi, formatAudioClock, type AudioReviewView } from "@/lib/audio-review-model";
import { audioReviewOpinionLanded, audioReviewOpinionQuotes } from "@/lib/audio-review-ui";
import { formatShortDateTime } from "@/lib/date-format";
import {
  AudioReviewKindTag,
  AudioReviewVersionTag,
  useAudioReviewPlayback,
  V19AudioReviewAudioBar,
  V19AudioReviewTranscript,
} from "./V19AudioReviewParts";
import styles from "./V04Surface.module.css";

export const V19_AUDIO_REVIEW_CARD_ID = "audio-review-card";

/**
 * 点评版顶部的录音卡（docs/25 二、5，七、4）：录音播放、意见清单（每条落实了几处，
 * 点「落实 N 处 ↓」打开比较并跳到第一处）、完整文字稿（播放时高亮当前句）。
 * 全站可见。数据由外壳按 `current.audioReviewId` 读好传进来。
 */
export default function V19AudioReviewCard({
  videoId,
  review,
  loadError,
  baseVersionNumber,
  onRetry,
  onJumpToOpinion,
}: {
  videoId: string;
  review: AudioReviewView | null;
  loadError: string;
  baseVersionNumber: number | null;
  onRetry: () => void;
  onJumpToOpinion: (opinionNumber: number) => void;
}): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playback = useAudioReviewPlayback(audioRef, review?.audio.durationMs ?? null);
  const segments = review?.transcript?.segments ?? [];
  const opinions = useMemo(
    () => [...(review?.proposal?.opinions ?? [])].sort((left, right) => left.number - right.number),
    [review],
  );
  const marks = useMemo(() => opinions.flatMap((opinion) =>
    audioReviewOpinionQuotes(review?.transcript?.segments ?? [], opinion.segmentIds)
      .map((segment) => ({ ms: segment.startMs, title: `意见 ${opinion.number}` }))), [opinions, review]);
  const baseLabel = `v${review?.baseVersionNumber ?? baseVersionNumber ?? "?"}`;
  const reviewer = review?.reviewerName || "老孙";
  const meta = review ? [
    review.audio.fileName,
    review.audio.durationMs ? formatAudioClock(review.audio.durationMs) : "",
    review.confirmedAt ? `${reviewer} ${formatShortDateTime(review.confirmedAt)} 确认生成` : "",
  ].filter(Boolean).join(" · ") : "";

  return (
    <section className={styles.reviewCard} id={V19_AUDIO_REVIEW_CARD_ID} data-v19-audio-review-card>
      <header className={styles.reviewCardHead}>
        <AudioReviewVersionTag />
        <h2>{reviewer}的录音点评</h2>
        {meta && <small>{meta}</small>}
      </header>
      <div className={styles.reviewCardBody}>
        {!review && !loadError && <p className={styles.reviewCardNote}>正在读取录音点评…</p>}
        {!review && loadError && (
          <p className={styles.reviewCardNote}>
            {loadError}{" "}
            <button type="button" className={styles.reviewJump} onClick={onRetry}>重新读取</button>
          </p>
        )}
        {review && (
          <>
            <V19AudioReviewAudioBar
              audioRef={audioRef}
              src={audioReviewApi.audioUrl(videoId, review.id)}
              fileName={review.audio.fileName}
              playback={playback}
              marks={marks}
            />
            {opinions.length > 0 && (
              <ol className={styles.reviewOpinionList}>
                {opinions.map((opinion) => {
                  const landed = audioReviewOpinionLanded(review, opinion);
                  return (
                    <li key={opinion.id}>
                      <span className={styles.reviewOpinionNumber}>意见 {opinion.number}</span>
                      <span><AudioReviewKindTag kind={opinion.kind} />{opinion.summary}</span>
                      {landed > 0 ? (
                        <button type="button" className={styles.reviewJump} onClick={() => onJumpToOpinion(opinion.number)}
                          title="打开比较，跳到这条意见改的第一处">
                          落实 {landed} 处 ↓
                        </button>
                      ) : (
                        <span className={styles.reviewCardNote}>{opinion.changeIds.length > 0 ? "未采用" : "无需改动"}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <V19AudioReviewTranscript segments={segments} playback={playback} />
          </>
        )}
        <p className={styles.reviewCardNote}>
          这一版是据点评改写 {baseLabel} 得到的；{baseLabel} 本身保持原样。点评版不汇入集成版，{reviewer}可在集成版溯源里逐条采纳。
        </p>
      </div>
    </section>
  );
}
