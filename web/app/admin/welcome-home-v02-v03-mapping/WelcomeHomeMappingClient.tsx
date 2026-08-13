"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  WELCOME_HOME_MAPPING_CONFIRMATION,
  type WelcomeHomeMappingPreview,
  type WelcomeHomeMappingResult,
} from "@/lib/welcome-home-mapping-contract";
import styles from "./page.module.css";

type PreviewResponse = { preview?: WelcomeHomeMappingPreview; error?: string };

export default function WelcomeHomeMappingClient() {
  const [preview, setPreview] = useState<WelcomeHomeMappingPreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WelcomeHomeMappingResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/welcome-home-v02-v03-mapping", {
        cache: "no-store",
      });
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
    fetch("/api/admin/welcome-home-v02-v03-mapping", { cache: "no-store" })
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

  const apply = async () => {
    if (!preview?.ready || !preview.previewToken) return;
    setApplying(true);
    setError("");
    try {
      const response = await fetch("/api/admin/welcome-home-v02-v03-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "APPLY",
          confirmation,
          previewToken: preview.previewToken,
        }),
      });
      const data = await response.json() as { result?: WelcomeHomeMappingResult; error?: string };
      if (!response.ok || !data.result) throw new Error(data.error || "APPLY 未完成。");
      setResult(data.result);
      setConfirmation("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "APPLY 未完成，事务已回滚。");
      await refresh();
    } finally {
      setApplying(false);
    }
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>管理员 · 一次性受控数据操作</p>
          <h1>《欢迎回家》V0.2 → V0.3 正式映射</h1>
          <p>先只读预检，再按冻结方案执行一次；完成后入口永久转为只读。</p>
        </div>
        <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
      </header>

      {loading ? <section className={styles.panel}>正在执行只读 PREVIEW…</section> : null}
      {error ? <section className={`${styles.panel} ${styles.error}`} role="alert">{error}</section> : null}

      {preview ? (
        <>
          <section className={styles.statusPanel} data-ready={preview.ready} data-applied={preview.applied}>
            <div>
              <p className={styles.eyebrow}>PREVIEW 状态</p>
              <h2>{preview.applied ? "已执行并永久锁定" : preview.ready ? "READY · 可安全触发" : "NOT READY · 禁止执行"}</h2>
            </div>
            <button className={styles.secondaryButton} type="button" onClick={() => void refresh()} disabled={loading || applying}>
              重新预检
            </button>
          </section>

          <section className={styles.grid}>
            <article className={styles.panel}>
              <p className={styles.eyebrow}>线上识别结果</p>
              <h2>{preview.case.title}</h2>
              <dl className={styles.facts}>
                <div><dt>固定案例</dt><dd>{preview.case.videoId}</dd></div>
                <div><dt>来源记录</dt><dd>{preview.source.authorName} · V0.2 · rev {preview.source.workingRevision}</dd></div>
                <div><dt>不可变来源</dt><dd>公开版本 V{preview.source.submittedSnapshotVersionNumber ?? "—"} · rev {preview.source.submittedSnapshotRevision ?? "—"}</dd></div>
                <div><dt>目标</dt><dd>{preview.target.authorName} · 新建 V0.3 草稿 · rev {preview.target.nextRevision}</dd></div>
                <div><dt>现有目标</dt><dd>{preview.target.exists ? "已存在，禁止覆盖" : "不存在，符合新建条件"}</dd></div>
              </dl>
            </article>
            <article className={styles.panel}>
              <p className={styles.eyebrow}>将修改</p>
              <ul className={styles.list}>
                <li>只为“老孙”新建一份 V0.3 可变工作稿</li>
                <li>{preview.mapping.groups} 个桥段、{preview.mapping.shots} 个镜头</li>
                <li>{preview.mapping.legacyFields} 项 A/B 字段，标记 SYSTEM_MAPPED</li>
                <li>主路径 LOVE；B2/B3 确定性映射</li>
                <li>目标成为可继续维护的 DRAFT rev {preview.target.nextRevision}</li>
              </ul>
            </article>
            <article className={styles.panel}>
              <p className={styles.eyebrow}>明确不会修改</p>
              <ul className={styles.list}>
                <li>全部既有公开版本与批准版本</li>
                <li>{preview.preserved.snapshots} 个历史快照</li>
                <li>{preview.preserved.reviewRounds} 个审核轮次、{preview.preserved.comments} 条批注</li>
                <li>{preview.preserved.revisionEvents} 个修订事件及其他案例</li>
                <li>不提交、不审批、不发布新标准版；L3 解释字段保持空白</li>
              </ul>
            </article>
          </section>

          {preview.reasons.length ? (
            <section className={`${styles.panel} ${styles.warning}`}>
              <p className={styles.eyebrow}>阻断原因</p>
              <ul className={styles.list}>{preview.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </section>
          ) : null}

          {result ? (
            <section className={`${styles.panel} ${styles.success}`} role="status">
              已完成：已新建 DRAFT rev {result.target.revision}，23 镜头／7 桥段／19 字段；既有版本与非目标业务数据未变。
            </section>
          ) : null}

          {!preview.applied ? (
            <section className={styles.panel}>
              <p className={styles.eyebrow}>一次性 APPLY</p>
              <h2>输入完整确认口令后才能执行</h2>
              <p className={styles.confirmationHint}>{WELCOME_HOME_MAPPING_CONFIRMATION}</p>
              <label className={styles.confirmationField}>
                <span>确认口令</span>
                <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={!preview.ready || applying} autoComplete="off" />
              </label>
              <button
                className={styles.applyButton}
                type="button"
                disabled={!preview.ready || applying || confirmation !== WELCOME_HOME_MAPPING_CONFIRMATION}
                onClick={() => void apply()}
              >
                {applying ? "事务执行与复核中…" : "执行一次性映射"}
              </button>
              <p className={styles.muted}>执行时会再次锁行并核验 PREVIEW 指纹；任何条件变化都会整体回滚。</p>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
