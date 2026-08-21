"use client";

import Link from "next/link";
import { useState } from "react";
import type { WelcomeHomeV19ConflictAudit } from "@/lib/welcome-home-v19-conflict-audit";
import styles from "../v04-schema/page.module.css";

type ApiResponse = {
  audit?: WelcomeHomeV19ConflictAudit;
  error?: { code?: string; message?: string; details?: { stage?: string; reason?: string } };
};

async function readJson(response: Response) {
  const body = await response.text();
  if (!body) throw new Error(`服务器返回空响应（HTTP ${response.status}）。`);
  try {
    return JSON.parse(body) as ApiResponse;
  } catch {
    throw new Error(`服务器返回无法识别的响应（HTTP ${response.status}）。`);
  }
}

const digest = (value: string) => value.slice(0, 20);

export default function WelcomeHomeV19ConflictAuditClient({ enabled }: { enabled: boolean }) {
  const [audit, setAudit] = useState<WelcomeHomeV19ConflictAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function runAudit() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/welcome-home-v19-conflict-audit", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await readJson(response);
      if (!response.ok || !data.audit) {
        const context = [data.error?.code, data.error?.details?.stage, data.error?.details?.reason]
          .filter(Boolean).join(" / ");
        throw new Error(`${data.error?.message || "只读审计未完成。"}${context ? `（诊断：${context}）` : ""}`);
      }
      setAudit(data.audit);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "只读审计未完成。");
    } finally {
      setLoading(false);
    }
  }

  return <main className={styles.shell} data-welcome-home-v19-conflict-audit>
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>稳定 SYSTEM_ADMIN · SAME-ORIGIN · GET ONLY</p>
        <h1>《欢迎回家》V1.9 映射冲突审计</h1>
        <p>固定 V0.3 共享轮 1／rev 153；仅比较 19 种、196 个直接映射实例，不返回正文。</p>
      </div>
      <div className={styles.switches}>
        <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
      </div>
    </header>

    <section className={styles.switches} aria-label="只读审计开关状态">
      <span data-enabled={enabled}>冲突审计 {enabled ? "短期开启" : "关闭"}</span>
      <span>无 PREVIEW／APPLY</span>
      <span>不会取得租约或创建版本</span>
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div><p className={styles.eyebrow}>零写审计</p><h2>读取权威源与当前目标聚合</h2></div>
        <button type="button" disabled={!enabled || loading} onClick={() => void runAudit()}>
          {loading ? "正在只读比较…" : "运行只读冲突审计"}
        </button>
      </div>
      {!enabled ? <p className={styles.notice}>独立开关关闭；页面加载不会查询审计事实。</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>

    {audit ? <>
      <section className={styles.summary}>
        <article><strong>{audit.ready ? "READY" : "STOP"}</strong><span>审计结论</span></article>
        <article><strong>{audit.totals.TARGET_EMPTY}</strong><span>目标空白候选</span></article>
        <article><strong>{audit.totals.TARGET_SAME}</strong><span>相同 no-op</span></article>
        <article><strong>{audit.totals.TARGET_DIFFERENT}</strong><span>不同，保留目标</span></article>
        <article><strong>{audit.totals.UNADDRESSABLE}</strong><span>不可定位</span></article>
      </section>

      <section className={styles.panel}>
        <h2>版本、结构与零写证据</h2>
        <dl className={styles.evidence}>
          <div><dt>合同</dt><dd>{audit.contract.version} · {digest(audit.contract.hash)}</dd></div>
          <div><dt>源版本</dt><dd>轮 {audit.source.roundNumber ?? "—"} · rev {audit.source.revision ?? "—"} · {audit.source.state}</dd></div>
          <div><dt>源摘要</dt><dd>{digest(audit.source.digest)}</dd></div>
          <div><dt>目标工作区</dt><dd>{audit.target.workspaceCount} · ACTIVE {audit.target.activeWorkspaceCount} · rev {audit.target.revision ?? "—"}</dd></div>
          <div><dt>提交／修订</dt><dd>{audit.target.submissionCount}／{audit.target.revisionEventCount}</dd></div>
          <div><dt>租约聚合</dt><dd>总计 {audit.target.lease.totalCount} · 活动 {audit.target.lease.activeCount} · 过期 {audit.target.lease.expiredCount}</dd></div>
          <div><dt>桥段／镜头</dt><dd>源 {audit.structure.sourceShotGroupCount}／{audit.structure.sourceShotCount} · 目标 {audit.structure.targetShotGroupCount}／{audit.structure.targetShotCount}</dd></div>
          <div><dt>稳定定位</dt><dd>{audit.structure.stableLocatorsAligned ? "一致" : "漂移"}</dd></div>
          <div><dt>目标摘要</dt><dd>{digest(audit.target.digest)}</dd></div>
          <div><dt>审计摘要</dt><dd>{digest(audit.previewDigest)}</dd></div>
          <div><dt>GET 前后指纹</dt><dd>{digest(audit.readFingerprint.before)}／{digest(audit.readFingerprint.after)} · {audit.readFingerprint.unchanged ? "不变" : "变化"}</dd></div>
        </dl>
        {audit.stopReasons.length
          ? <ul className={styles.stopList}>{audit.stopReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          : <p className={styles.success}>结构与定位可审计；差异项仅报告，不覆盖目标。</p>}
      </section>

      <section className={styles.panel}>
        <h2>19 种字段分类</h2>
        <div className={styles.tableWrap}><table><thead><tr>
          <th>字段类型</th><th>源实例</th><th>空白</th><th>相同</th><th>不同</th><th>不可定位</th>
        </tr></thead><tbody>{audit.fieldTypes.map((field) => <tr key={field.fieldKey}>
          <td>{field.label}</td><td>{field.sourceInstances}／{field.expectedInstances}</td>
          <td>{field.counts.TARGET_EMPTY}</td><td>{field.counts.TARGET_SAME}</td>
          <td>{field.counts.TARGET_DIFFERENT}</td><td>{field.counts.UNADDRESSABLE}</td>
        </tr>)}</tbody></table></div>
      </section>
    </> : null}
  </main>;
}
