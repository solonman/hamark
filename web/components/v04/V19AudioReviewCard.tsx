"use client";

import { useMemo, useRef, useState, type JSX } from "react";
import { AUDIO_REVIEW_CRITIC_NAME } from "@/lib/audio-review/access";
import { audioReviewApi, type AudioReviewView } from "@/lib/audio-review-model";
import { audioReviewOpinionLanded, audioReviewOpinionQuotes, audioReviewSourceMeta } from "@/lib/audio-review-ui";
import {
  AudioReviewKindTag,
  AudioReviewVersionTag,
  useAudioReviewPlayback,
  V19AudioReviewAudioBar,
  V19AudioReviewDocumentText,
  V19AudioReviewTranscript,
} from "./V19AudioReviewParts";
import styles from "./V04Surface.module.css";

export const V19_AUDIO_REVIEW_CARD_ID = "audio-review-card";

/**
 * 点评版顶部的「老孙的点评」卡（docs/25 二、5，二之二、3，七、4）：标题下写明来源
 * （录音「录音 · 文件名 · 时长 · X 确认生成」；文档「文档 · 文件名 · X 确认生成」，
 * 文件名可下载原文件）。录音来源有录音播放与完整文字稿（播放时高亮当前句）；文档来源
 * 没有录音条，原文区叫「点评原文（N 段）」，默认折叠。中间是意见清单（每条落实了几处，
 * 点「落实 N 处 ↓」打开比较并跳到第一处）。全站可见。数据由外壳按 `current.audioReviewId`
 * 读好传进来。
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
  const [documentOpen, setDocumentOpen] = useState(false);
  const segments = review?.transcript?.segments ?? [];
  // 老后端的任务不带来源时按录音（文字点评上线前只有录音）。
  const isDocument = (review?.sourceKind ?? "AUDIO") === "DOCUMENT";
  const opinions = useMemo(
    () => [...(review?.proposal?.opinions ?? [])].sort((left, right) => left.number - right.number),
    [review],
  );
  const marks = useMemo(() => opinions.flatMap((opinion) =>
    audioReviewOpinionQuotes(review?.transcript?.segments ?? [], opinion.segmentIds)
      .map((segment) => ({ ms: segment.startMs, title: `意见 ${opinion.number}` }))), [opinions, review]);
  const baseLabel = `v${review?.baseVersionNumber ?? baseVersionNumber ?? "?"}`;
  const reviewer = review?.reviewerName || AUDIO_REVIEW_CRITIC_NAME;
  const meta = review ? audioReviewSourceMeta({ ...review, sourceKind: review.sourceKind ?? "AUDIO" }) : null;
  const fileUrl = review ? audioReviewApi.audioUrl(videoId, review.id) : "";

  return (
    <section className={styles.reviewCard} id={V19_AUDIO_REVIEW_CARD_ID} data-v19-audio-review-card>
      <header className={styles.reviewCardHead}>
        <AudioReviewVersionTag />
        <h2>{AUDIO_REVIEW_CRITIC_NAME}的点评</h2>
        {meta && (
          <small className={styles.reviewCardMeta} data-v19-audio-review-source={isDocument ? "DOCUMENT" : "AUDIO"}>
            {meta.kindLabel}
            {" · "}
            {meta.downloadable ? (
              <a href={fileUrl} download={meta.fileName} target="_blank" rel="noopener noreferrer"
                className={styles.reviewFileLink} title={`下载原文件「${meta.fileName}」`}>
                {meta.fileName}
              </a>
            ) : (
              <span>{meta.fileName}</span>
            )}
            {meta.after.map((item) => ` · ${item}`).join("")}
          </small>
        )}
      </header>
      <div className={styles.reviewCardBody}>
        {!review && !loadError && <p className={styles.reviewCardNote}>正在读取点评…</p>}
        {!review && loadError && (
          <p className={styles.reviewCardNote}>
            {loadError}{" "}
            <button type="button" className={styles.reviewJump} onClick={onRetry}>重新读取</button>
          </p>
        )}
        {review && (
          <>
            {!isDocument && (
              <V19AudioReviewAudioBar
                audioRef={audioRef}
                src={fileUrl}
                fileName={review.audio.fileName}
                playback={playback}
                marks={marks}
              />
            )}
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
            {isDocument ? (
              <V19AudioReviewDocumentText segments={segments} open={documentOpen} onToggle={setDocumentOpen} />
            ) : (
              <V19AudioReviewTranscript segments={segments} playback={playback} />
            )}
          </>
        )}
        <p className={styles.reviewCardNote}>
          这一版是据点评改写 {baseLabel} 得到的；{baseLabel} 本身保持原样。点评版不汇入集成版，{reviewer}可在集成版溯源里逐条采纳。
        </p>
      </div>
    </section>
  );
}
