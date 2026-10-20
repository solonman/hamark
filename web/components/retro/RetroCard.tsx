"use client";

import Link from "next/link";
import type { JSX } from "react";
import type { RetroCaseCard } from "@/lib/retro-model";
import { formatRetroTime, retroCoverTrack, retroRecordingLabel } from "@/lib/retro-ui";
import { AudioReviewIcon } from "../v04/V19AudioReviewParts";
import report from "../report/library/ReportLibrary.module.css";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

/**
 * 库首页的案例卡片（规格 10.2）：骨架复用 V04 的 caseCard／caseQuickActions／caseEnterPill／caseNumber／caseInfoBand
 * 与报告库 4:3 的 .cover。有封面图（card.cover）时是图片封面：图上叠部门 chip、录音标记，底部渐变上写客户名和回合轨迹；
 * 没有可用的图片、视频截帧、文档页时退回文字封面：左上部门 chip、右上录音标记、中间客户名、底部回合轨迹。两种都是深色岛。
 */
export default function RetroCard({
  card,
  caseNumber,
  onRecord,
}: {
  card: RetroCaseCard;
  caseNumber: number;
  /** 案例还没有点评录音时的快捷入口，任何人都能传。 */
  onRecord: (caseId: string) => void;
}): JSX.Element {
  const href = `/retro/${encodeURIComponent(card.id)}`;
  const rec = retroRecordingLabel(card.recording);
  const track = retroCoverTrack(card);
  const recBadge = (
    <span className={styles.coverRec} data-rec={rec.tone}>
      {rec.tone === "busy" ? <span className={`${v04.reviewSpin} ${styles.spinSmall}`} aria-hidden="true" /> : <AudioReviewIcon name="mic" />}
      {rec.label}
    </span>
  );
  const trackList = (
    <ol className={styles.coverTrack} aria-label="回合轨迹">
      {track.map((node, index) => (
        <li
          key={`${index}-${node.label}`}
          data-kind={node.end ? "end" : undefined}
          data-fb={node.feedback ? "1" : undefined}
          data-empty={node.empty ? "1" : undefined}
        >
          <i /><span>{node.label}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <article className={v04.caseCard} data-case-id={card.id}>
      {card.cover ? (
        // 图片封面（规格 10.2）：第一张图片／视频截帧／文档第 1 页，部门 chip、录音标记叠在图上，底部写客户名和回合轨迹。
        <Link href={href} className={`${report.cover} ${styles.coverPhoto}`} data-v04-scheme="dark" data-cover-kind={card.cover.kind} aria-label={`查看《${card.title}》`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 封面来自对象存储签名 URL，不走 next/image 的远程域名白名单 */}
          <img className={report.coverImage} src={card.cover.url} alt="" loading="lazy" />
          <span className={report.coverFormat}>{card.department}</span>
          {recBadge}
          <p className={styles.coverPhotoClient}>{card.clientName}</p>
          {trackList}
        </Link>
      ) : (
        <Link href={href} className={`${report.cover} ${styles.coverText}`} data-v04-scheme="dark" aria-label={`查看《${card.title}》`}>
          <span className={report.coverFormat}>{card.department}</span>
          {recBadge}
          <p className={styles.coverClient}><small>CLIENT</small>{card.clientName}</p>
          {trackList}
        </Link>
      )}
      <div className={v04.caseBody}>
        <div className={v04.caseQuickActions}>
          <Link className={v04.caseEnterPill} href={href}>查看案例</Link>
          {card.recording.state === "NONE" ? (
            <button
              type="button"
              className={`${report.retryButton} ${styles.quickBtn}`}
              title="任何人都能给案例传点评录音"
              onClick={() => onRecord(card.id)}
            >
              传点评录音
            </button>
          ) : null}
        </div>
        <p className={v04.caseNumber}>CASE {String(caseNumber).padStart(2, "0")}</p>
        <div className={v04.caseTitleStatus}>
          <h2><small>{card.department} · {card.clientName}</small><span>{card.title}</span></h2>
        </div>
        {card.backgroundExcerpt.trim() ? <p className={styles.caseSummary}>{card.backgroundExcerpt}</p> : null}
        <div className={v04.caseInfoBand}>
          {card.sceneTags.map((tag) => <span className={v04.caseCategoryTag} key={tag}>#{tag}</span>)}
          <span>上传者 {card.createdByName || "未知"} · {formatRetroTime(card.createdAt)}</span>
          <span>{card.roundTrack.length} 回合</span>
        </div>
      </div>
    </article>
  );
}
