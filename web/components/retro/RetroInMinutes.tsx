"use client";

import Link from "next/link";
import { useMemo, type JSX } from "react";
import { RETRO_DIMENSION_LABELS, RETRO_KIND_LABELS, type RetroCaseDetail } from "@/lib/retro-model";
import { formatRetroTime, type RetroSourceContext } from "@/lib/retro-ui";
import { RetroSourceMarks, type RetroListenHandler, type RetroRoundJumpHandler } from "./RetroSourceMarks";
import { RetroCaseReviewGrid, type RetroMinutesCtx } from "./RetroMinutesParts";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

/**
 * 案例页底部的「在本月纪要里」（规格 10.3-5）：只在这个案例包含在已发布版本里时出现（`inMinutes` 非空才渲染，按发布时冻结的案例清单判断）。
 * 内容是这个案例的回顾（经过、争议、老孙指出的问题、改进建议），加上引用了这个案例的方法候选，每条都带出处标记；底部是「看本月完整纪要 →」。
 */
export default function RetroInMinutes({
  detail,
  onListen,
  onRoundJump,
}: {
  detail: RetroCaseDetail;
  onListen: RetroListenHandler;
  onRoundJump: RetroRoundJumpHandler;
}): JSX.Element | null {
  const minutes = detail.inMinutes;
  const ctx = useMemo<RetroMinutesCtx | null>(() => {
    if (!minutes) return null;
    // 回合标记的标题：本案例现有的回合优先（改过名取最新），已删除的回合用服务端冻结的那份。
    const roundRefs: RetroSourceContext["roundRefs"] = { ...(minutes.roundRefs ?? {}) };
    for (const round of detail.rounds) roundRefs[round.id] = { caseId: detail.id, title: round.title };
    return {
      source: {
        monthKey: detail.monthKey,
        quotedSegments: minutes.quotedSegments,
        recordingRefs: minutes.recordingRefs,
        caseNumbers: { [detail.id]: minutes.caseNumber },
        roundRefs,
        caseLabels: { [detail.id]: { client: detail.clientName, title: detail.title } },
      },
      caseInfo: (caseId) => caseId === detail.id
        ? { number: minutes.caseNumber, client: detail.clientName, title: detail.title, department: detail.department, deleted: false }
        : null,
      onListen,
      onRoundJump,
    };
  }, [detail, minutes, onListen, onRoundJump]);

  if (!minutes || !ctx) return null;
  return (
    <section className={`${v04.readingModule} ${styles.inMinutes}`}>
      <header>
        <div>
          <small>IN THIS MONTH&apos;S MINUTES · v{minutes.publicationVersion} · {formatRetroTime(minutes.publishedAt)} {minutes.publishedByName}发布</small>
          <h2>在本月纪要里</h2>
        </div>
      </header>
      {minutes.review === null
        ? <p className={styles.minSkip}>这个案例没有录音，列在纪要的案例清单里，不参与提炼。</p>
        : minutes.review.empty
          ? <p className={styles.minSkip}>这个案例没有提炼出有依据的内容。</p>
          : <RetroCaseReviewGrid review={minutes.review} ctx={ctx} />}
      {minutes.methods.length ? (
        <>
          <p className={styles.secLabel}>引用了这个案例的方法候选</p>
          <ul className={styles.citeList}>
            {minutes.methods.map((candidate) => (
              <li key={candidate.id}>
                <span className={styles.dimChip}>{RETRO_DIMENSION_LABELS[candidate.dimension]}</span>
                <span className={styles.kindMark} data-kind={candidate.kind}><i />{RETRO_KIND_LABELS[candidate.kind]}</span>
                <b>{candidate.title}</b>
                <RetroSourceMarks sources={candidate.sources} ctx={ctx.source} onListen={onListen} onRoundJump={onRoundJump} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className={styles.moduleFoot}>
        <Link href={`/retro/months/${encodeURIComponent(detail.monthKey)}?tab=MINUTES`}>看本月完整纪要 →</Link>
      </div>
    </section>
  );
}
