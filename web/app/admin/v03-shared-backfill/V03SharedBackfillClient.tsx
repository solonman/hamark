"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  V03_SHARED_BACKFILL_CONFIRMATION,
  V03_SHARED_SCHEMA_CONFIRMATION,
  type V03SharedBackfillPreview,
  type V03SharedBackfillResult,
} from "@/lib/v03-shared-backfill-contract";
import styles from "../v02-v03-batch-mapping/page.module.css";

export default function V03SharedBackfillClient() {
  const [preview, setPreview] = useState<V03SharedBackfillPreview | null>(null);
  const [schemaReady, setSchemaReady] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/v03-shared-backfill", { cache: "no-store" });
      const data = (await response.json()) as {
        preview?: V03SharedBackfillPreview | null;
        schemaReady?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "PREVIEW 失败");
      setSchemaReady(Boolean(data.schemaReady));
      setPreview(data.preview ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PREVIEW 失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/v03-shared-backfill", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as {
          preview?: V03SharedBackfillPreview | null;
          schemaReady?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "PREVIEW 失败");
        if (active) {
          setSchemaReady(Boolean(data.schemaReady));
          setPreview(data.preview ?? null);
        }
      })
      .catch((error: unknown) => {
        if (active) setNotice(error instanceof Error ? error.message : "PREVIEW 失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const ready = useMemo(
    () => preview?.candidates.filter((candidate) => candidate.status === "READY") ?? [],
    [preview],
  );

  async function installSchema() {
    if (confirmation !== V03_SHARED_SCHEMA_CONFIRMATION) return;
    setApplying(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/v03-shared-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "INSTALL_SCHEMA", confirmation }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "数据结构安装失败");
      setNotice("共享协作数据结构已安全就绪；未回填任何业务正文。");
      setConfirmation("");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "数据结构安装失败");
    } finally {
      setApplying(false);
    }
  }

  async function applyAll() {
    if (!ready.length || confirmation !== V03_SHARED_BACKFILL_CONFIRMATION) return;
    setApplying(true);
    setNotice("");
    const results: V03SharedBackfillResult[] = [];
    try {
      for (const candidate of ready) {
        const response = await fetch("/api/admin/v03-shared-backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "APPLY_CANDIDATE",
            confirmation,
            candidateKey: candidate.candidateKey,
            previewToken: candidate.previewToken,
          }),
        });
        const data = (await response.json()) as { result?: V03SharedBackfillResult; error?: string };
        if (!response.ok || !data.result) throw new Error(`${candidate.videoTitle}：${data.error || "接入失败"}`);
        results.push(data.result);
      }
      setNotice(`已安全接入 ${results.length} 个作品；正文和历史数据未改变。`);
      setConfirmation("");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "接入失败");
    } finally {
      setApplying(false);
    }
  }

  async function applyOne(candidate: NonNullable<typeof preview>["candidates"][number]) {
    if (candidate.status !== "READY" || !candidate.previewToken || confirmation !== V03_SHARED_BACKFILL_CONFIRMATION) return;
    setApplyingKey(candidate.candidateKey);
    setNotice("");
    try {
      const response = await fetch("/api/admin/v03-shared-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "APPLY_CANDIDATE",
          confirmation,
          candidateKey: candidate.candidateKey,
          previewToken: candidate.previewToken,
        }),
      });
      const data = (await response.json()) as { result?: V03SharedBackfillResult; error?: string };
      if (!response.ok || !data.result) throw new Error(data.error || "接入失败");
      setNotice(`${candidate.videoTitle} 已安全接入；正文和历史数据未改变。`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "接入失败");
    } finally {
      setApplyingKey(null);
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>管理员 · 受控业务接线</p>
          <h1>现有 V0.3 → 公司共享协作主线</h1>
          <p>只新增公共寻址、初始基线和活动轮；不搬移、不覆盖任何现有正文或历史。</p>
        </div>
        <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
      </header>
      {loading ? <section className={styles.panel}>正在执行只读 PREVIEW…</section> : null}
      {notice ? <section className={styles.panel} role="status">{notice}</section> : null}
      {!loading && !schemaReady ? <section className={styles.panel}>
        <h2>步骤 1｜安装增量数据结构</h2>
        <p>只新增共享主线、基线、轮次和修订事件表/字段；不回填、不覆盖任何业务正文。</p>
        <p className={styles.confirmationHint}>{V03_SHARED_SCHEMA_CONFIRMATION}</p>
        <label className={styles.confirmationField}><span>确认口令</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className={styles.applyButton} type="button" disabled={applying || confirmation !== V03_SHARED_SCHEMA_CONFIRMATION} onClick={() => void installSchema()}>
          {applying ? "安装与校验中…" : "安装数据结构"}
        </button>
      </section> : null}
      {preview ? <>
        <section className={styles.summary}>
          <article><strong>{preview.summary.videosWithV03}</strong><span>含 V0.3 的作品</span></article>
          <article data-tone="ready"><strong>{preview.summary.ready}</strong><span>待接入</span></article>
          <article data-tone="skip"><strong>{preview.summary.completed}</strong><span>已接入</span></article>
          <article data-tone="blocked"><strong>{preview.summary.blocked}</strong><span>阻断</span></article>
          <article><strong>{preview.summary.batchMapped} / {preview.summary.singleCaseMapped} / {preview.summary.existingV03}</strong><span>批量映射 / 单例映射 / 既有</span></article>
        </section>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>PREVIEW 清单</h2>
            <button className={styles.secondaryButton} type="button" onClick={() => void refresh()}>重新预检</button>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>作品</th><th>公共来源</th><th>结构/历史</th><th>状态 / 操作</th></tr></thead>
              <tbody>{preview.candidates.map((candidate) => (
                <tr key={candidate.candidateKey} data-status={candidate.status}>
                  <td><strong>{candidate.videoTitle}</strong><small>{candidate.videoId}</small></td>
                  <td>{candidate.sourceAuthorName}<small>{candidate.sourceType} · {candidate.mappingKind === "BATCH" ? "V0.2 批量映射" : candidate.mappingKind === "SINGLE_CASE" ? "V0.2 单案例映射" : "原有 V0.3"} · rev {candidate.currentRevision}</small></td>
                  <td>{candidate.counts.groups} 桥段 / {candidate.counts.shots} 镜头 / {candidate.counts.fields} 字段<small>{candidate.counts.snapshots} 快照 / {candidate.counts.releases} 批准版</small></td>
                  <td>{candidate.status}{candidate.reasons.map((reason) => <small key={reason}>{reason}</small>)}
                    {candidate.status === "READY" ? <button
                      className={styles.secondaryButton}
                      type="button"
                      disabled={applying || applyingKey !== null || confirmation !== V03_SHARED_BACKFILL_CONFIRMATION}
                      onClick={() => void applyOne(candidate)}
                    >{applyingKey === candidate.candidateKey ? "接入中…" : "仅接入此作品"}</button> : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <section className={styles.panel}>
          <h2>步骤 2｜接入 {ready.length} 个已通过预检的作品</h2>
          <ul className={styles.rules}>
            <li>活动批准版所属 annotation 优先成为公共正文，其次为已有公开 V0.3，再次为映射稿。</li>
            <li>现有个人线全部保留为来源记录，不删除、不合并、不改写。</li>
            <li>每个作品独立事务；写后核对正文哈希及历史数量。</li>
          </ul>
          <p className={styles.confirmationHint}>{V03_SHARED_BACKFILL_CONFIRMATION}</p>
          <label className={styles.confirmationField}><span>确认口令</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <button className={styles.applyButton} type="button" disabled={applying || !ready.length || confirmation !== V03_SHARED_BACKFILL_CONFIRMATION} onClick={() => void applyAll()}>
            {applying ? "逐案例接入中…" : `执行 ${ready.length} 个案例`}
          </button>
        </section>
      </> : null}
    </main>
  );
}
