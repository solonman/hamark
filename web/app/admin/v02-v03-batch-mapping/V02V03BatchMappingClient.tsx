"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  V02_V03_BATCH_MAPPING_CONFIRMATION,
  type V02V03BatchMappingResult,
  type V02V03BatchPreview,
} from "@/lib/v02-v03-batch-mapping-contract";
import styles from "./page.module.css";

type PreviewResponse = { preview?: V02V03BatchPreview; error?: string };

const statusLabel = {
  READY: "可映射",
  BLOCKED: "阻断",
  SKIP_EXISTING: "已有 V0.3，跳过",
  COMPLETED: "已由批量工具完成",
} as const;

export default function V02V03BatchMappingClient() {
  const [preview, setPreview] = useState<V02V03BatchPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<V02V03BatchMappingResult[]>([]);
  const [failures, setFailures] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/v02-v03-batch-mapping", { cache: "no-store" });
      const data = await response.json() as PreviewResponse;
      if (!response.ok || !data.preview) throw new Error(data.error || "PREVIEW 读取失败。");
      setPreview(data.preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PREVIEW 读取失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/v02-v03-batch-mapping", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as PreviewResponse;
        if (!response.ok || !data.preview) throw new Error(data.error || "PREVIEW 读取失败。");
        if (active) setPreview(data.preview);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "PREVIEW 读取失败。");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const ready = useMemo(
    () => preview?.candidates.filter((candidate) => candidate.status === "READY") ?? [],
    [preview],
  );

  async function applyAll() {
    if (!ready.length || confirmation !== V02_V03_BATCH_MAPPING_CONFIRMATION) return;
    setApplying(true);
    setError("");
    setResults([]);
    setFailures([]);
    const completed: V02V03BatchMappingResult[] = [];
    const failed: string[] = [];
    for (const [index, candidate] of ready.entries()) {
      setProgress(`${index + 1} / ${ready.length} · ${candidate.video.title} · ${candidate.author.currentName}`);
      try {
        const response = await fetch("/api/admin/v02-v03-batch-mapping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "APPLY_CANDIDATE",
            confirmation,
            candidateKey: candidate.candidateKey,
            candidateToken: candidate.candidateToken,
          }),
        });
        const data = await response.json() as { result?: V02V03BatchMappingResult; error?: string };
        if (!response.ok || !data.result) throw new Error(data.error || "案例 APPLY 未完成。");
        completed.push(data.result);
        setResults([...completed]);
      } catch (reason) {
        failed.push(`${candidate.video.title}／${candidate.author.currentName}：${reason instanceof Error ? reason.message : "APPLY 未完成"}`);
        setFailures([...failed]);
      }
    }
    setConfirmation("");
    setProgress("");
    await refresh();
    setApplying(false);
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>管理员 · 通用受控数据操作</p>
          <h1>V0.2 最新公开版本 → 原作者 V0.3 新草稿</h1>
          <p>逐案例独立预检、事务、备份和审计；已有 V0.3 永不覆盖。</p>
        </div>
        <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
      </header>

      {loading ? <section className={styles.panel}>正在执行只读 PREVIEW…</section> : null}
      {error ? <section className={`${styles.panel} ${styles.error}`} role="alert">{error}</section> : null}

      {preview ? (
        <>
          <section className={styles.summary}>
            <article><strong>{preview.summary.sourcePairs}</strong><span>V0.2 作者／作品</span></article>
            <article data-tone="ready"><strong>{preview.summary.ready}</strong><span>可映射</span></article>
            <article data-tone="skip"><strong>{preview.summary.skippedExisting}</strong><span>已有 V0.3</span></article>
            <article data-tone="blocked"><strong>{preview.summary.blocked}</strong><span>阻断</span></article>
            <article><strong>{preview.summary.completed}</strong><span>批量完成</span></article>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.eyebrow}>PREVIEW 清单</p>
                <h2>每一行都是独立的数据边界</h2>
              </div>
              <button className={styles.secondaryButton} type="button" onClick={() => void refresh()} disabled={loading || applying}>
                重新预检
              </button>
            </div>
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>作品</th><th>原作者</th><th>来源</th><th>结构</th><th>状态</th></tr></thead>
                <tbody>
                  {preview.candidates.map((candidate) => (
                    <tr key={candidate.candidateKey} data-status={candidate.status}>
                      <td><strong>{candidate.video.title}</strong><small>{candidate.video.id}</small></td>
                      <td>{candidate.author.currentName ?? candidate.author.sourceName}{candidate.author.currentName && candidate.author.currentName !== candidate.author.sourceName ? <small>快照署名：{candidate.author.sourceName}</small> : null}</td>
                      <td>V{candidate.source.snapshotVersionNumber} · rev {candidate.source.snapshotRevision}</td>
                      <td>{candidate.source.groups} 桥段／{candidate.source.shots} 镜头／{candidate.source.legacyFields} 字段</td>
                      <td><span className={styles.status}>{statusLabel[candidate.status]}</span>{candidate.reasons.map((reason) => <small key={reason}>{reason}</small>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {results.length || failures.length ? (
            <section className={`${styles.panel} ${failures.length ? styles.warning : styles.success}`} role="status">
              已完成 {results.length} 个案例；失败 {failures.length} 个案例。
              {failures.length ? <ul>{failures.map((failure) => <li key={failure}>{failure}</li>)}</ul> : null}
            </section>
          ) : null}

          <section className={styles.panel}>
            <p className={styles.eyebrow}>批量 APPLY</p>
            <h2>执行当前 {ready.length} 个“可映射”案例</h2>
            <ul className={styles.rules}>
              <li>目标归属于 V0.2 原作者；已有 V0.3 自动跳过。</li>
              <li>迁移整体共通内容、桥段／镜头及 19 项旧体系参考字段。</li>
              <li>不猜测主导路径、机制、形成方式、等级等 V0.3 专属判断。</li>
              <li>单个案例失败不会回滚或污染其他案例。</li>
            </ul>
            <p className={styles.confirmationHint}>{V02_V03_BATCH_MAPPING_CONFIRMATION}</p>
            <label className={styles.confirmationField}>
              <span>确认口令</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={!ready.length || applying} autoComplete="off" />
            </label>
            <button
              className={styles.applyButton}
              type="button"
              disabled={!ready.length || applying || confirmation !== V02_V03_BATCH_MAPPING_CONFIRMATION}
              onClick={() => void applyAll()}
            >
              {applying ? `逐案例执行中 ${progress}` : `执行 ${ready.length} 个可映射案例`}
            </button>
          </section>
        </>
      ) : null}
    </main>
  );
}
