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
 * 与报告库 4:3 的 .cover；封面是文字封面（深色岛）：左上部门 chip、右上录音标记、中间客户名、底部回合轨迹。
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

  return (
    <article className={v04.caseCard} data-case-id={card.id}>
      <Link href={href} className={`${report.cover} ${styles.coverText}`} data-v04-scheme="dark" aria-label={`查看《${card.title}》`}>
        <span className={report.coverFormat}>{card.department}</span>
        <span className={styles.coverRec} data-rec={rec.tone}>
          {rec.tone === "busy" ? <span className={`${v04.reviewSpin} ${styles.spinSmall}`} aria-hidden="true" /> : <AudioReviewIcon name="mic" />}
          {rec.label}
        </span>
        <p className={styles.coverClient}><small>CLIENT</small>{card.clientName}</p>
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
      </Link>
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
