"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { V04UiCase } from "@/lib/v04-ui-model";
import { V04_UI_STATE_LABELS } from "@/lib/v04-ui-model";
import { matchesV04LibraryQuery } from "@/lib/v04-ui-client-state";
import styles from "./V04Surface.module.css";

export default function V04LibraryClient({ cases, viewerName }: { cases: V04UiCase[]; viewerName: string }) {
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [committedQuery, setCommittedQuery] = useState("");
  const visible = useMemo(() => cases.filter((item) => matchesV04LibraryQuery(item, composing ? committedQuery : query)), [cases, committedQuery, composing, query]);
  return (
    <main className={styles.surface} data-v04-page="library">
      <header className={styles.productHeader}><Link href="/v04-shadow" className={styles.wordmark}>RE:VERSE <small>V0.4 SHADOW</small></Link><div><span>{viewerName}</span><b>可交互审核稿 · Fixture</b></div></header>
      <section className={styles.libraryHero}><p>VIDEO CREATIVE REVERSE ENGINEERING</p><h1>案例库</h1><span>发现作品、查看最新成果，或进入同一份公共工作稿继续维护。</span></section>
      <section className={styles.libraryToolbar}>
        <label>搜索案例<input value={query} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); setCommittedQuery(event.currentTarget.value); }} onChange={(event) => { setQuery(event.target.value); if (!composing) setCommittedQuery(event.target.value); }} placeholder="作品、品牌、标签" /></label>
        <span>{visible.length} 个案例</span>
      </section>
      {visible.length ? <section className={styles.caseGrid}>{visible.map((item) => (
        <article className={styles.caseCard} key={item.id} data-case-id={item.id}>
          <Link href={`/v04-shadow/videos/${item.id}`} className={styles.poster} aria-label={`查看 ${item.title} 最新成果`}><span>{item.brand}</span><b>▶</b><small>{item.duration}</small></Link>
          <div className={styles.caseBody}>
            <div className={styles.caseTitleLine}><h2>{item.title}</h2><span className={styles.workStatus}>{V04_UI_STATE_LABELS[item.workState]}</span>{item.expertGrade && <span className={styles.expertGrade}>专家优选 {item.expertGrade}</span>}</div>
            <p>{item.description}</p><div className={styles.tags}>{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className={styles.caseActions}><Link href={`/v04-shadow/videos/${item.id}`}>{item.submissions.length ? "查看最新成果" : "查看案例"}</Link><Link href={`/v04-shadow/videos/${item.id}/workspace`}>{item.workState === "NOT_STARTED" ? "开始公共工作稿" : "编辑工作稿"}</Link></div>
          </div>
        </article>
      ))}</section> : <section className={styles.emptyState}><h2>没有找到匹配案例</h2><p>页面外壳保持可用，可以继续修改或清空搜索。</p><button onClick={() => { setQuery(""); setCommittedQuery(""); }}>清空搜索</button></section>}
    </main>
  );
}
