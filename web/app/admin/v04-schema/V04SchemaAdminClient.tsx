"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { V04MigrationPreview } from "@/lib/v04-migration-preview";
import { V04_SCHEMA_APPLY_CONFIRMATION } from "@/lib/v04-schema-admin-contract";
import styles from "./page.module.css";

type PreviewResponse = {
  preview?: V04MigrationPreview;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
};

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) throw new Error(`服务器返回空响应（HTTP ${response.status}）。`);
  try {
    return JSON.parse(text) as PreviewResponse & { result?: { status?: string; operationId?: string } };
  } catch {
    throw new Error(`服务器返回了无法识别的响应（HTTP ${response.status}）。`);
  }
}

function shortHash(value: string) {
  return value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value;
}

export default function V04SchemaAdminClient(props: {
  previewEnabled: boolean;
  applyEnabled: boolean;
}) {
  const [preview, setPreview] = useState<V04MigrationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const [backupReference, setBackupReference] = useState("");
  const [backupVerifiedAt, setBackupVerifiedAt] = useState("");

  const canApply = useMemo(() => Boolean(
    props.applyEnabled
    && preview?.ready
    && confirmation === V04_SCHEMA_APPLY_CONFIRMATION
    && approvalReference.trim().length >= 8
    && backupReference.trim().length >= 8
    && backupVerifiedAt,
  ), [props.applyEnabled, preview, confirmation, approvalReference, backupReference, backupVerifiedAt]);

  async function runPreview(token?: string) {
    setLoading(true);
    setError("");
    setResult("");
    try {
      const suffix = token ? `?previewToken=${encodeURIComponent(token)}` : "";
      const response = await fetch(`/api/admin/v04-migration/preview${suffix}`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await readJson(response);
      if (!response.ok || !data.preview) {
        throw new Error(data.error?.message || `PREVIEW 未完成（HTTP ${response.status}）。`);
      }
      setPreview(data.preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PREVIEW 未完成。");
    } finally {
      setLoading(false);
    }
  }

  async function applySchema() {
    if (!preview || !canApply) return;
    setApplying(true);
    setError("");
    setResult("");
    const idempotencyKey = `v04-schema-${crypto.randomUUID()}`;
    try {
      const response = await fetch("/api/admin/v04-migration/apply", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          action: "APPLY_SCHEMA",
          previewToken: preview.previewToken,
          targetCodeSha: preview.targetCodeSha,
          idempotencyKey,
          confirmation,
          approvalReference: approvalReference.trim(),
          backupReference: backupReference.trim(),
          backupVerifiedAt: new Date(backupVerifiedAt).toISOString(),
        }),
      });
      const data = await readJson(response);
      if (!response.ok || !data.result) {
        throw new Error(data.error?.message || `APPLY 未完成（HTTP ${response.status}）。`);
      }
      setResult(`操作 ${data.result.operationId ?? "—"}：${data.result.status ?? "已返回"}`);
      await runPreview();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "APPLY 未完成。");
    } finally {
      setApplying(false);
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>稳定 SYSTEM_ADMIN · 同源 · no-store</p>
          <h1>V0.4 schema 受控操作面</h1>
          <p>只展示脱敏计数、状态和 hash；页面加载、GET、构建与部署都不会执行 APPLY。</p>
        </div>
        <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
      </header>

      <section className={styles.switches} aria-label="生产开关状态">
        <span data-enabled={props.previewEnabled}>PREVIEW {props.previewEnabled ? "短期开启" : "关闭"}</span>
        <span data-enabled={props.applyEnabled}>APPLY {props.applyEnabled ? "短期开启" : "关闭"}</span>
        <span>合同激活关闭</span><span>V0.4 正式入口关闭</span>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.eyebrow}>只读门 P</p><h2>增强 PRE-APPLY PREVIEW</h2></div>
          <button type="button" onClick={() => void runPreview()} disabled={!props.previewEnabled || loading || applying}>
            {loading ? "正在只读核验…" : "运行只读 PREVIEW"}
          </button>
        </div>
        {!props.previewEnabled ? <p className={styles.notice}>PREVIEW 当前关闭。需使用独立短期部署提交开启，取得证据后立即关闭。</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {result ? <p className={styles.success} role="status">{result}</p> : null}
      </section>

      {preview ? (
        <>
          <section className={styles.summary}>
            <article><strong>{preview.ready ? "READY" : "STOP"}</strong><span>门状态</span></article>
            <article><strong>{preview.schemaState}</strong><span>schema 状态</span></article>
            <article><strong>{preview.contract.status}</strong><span>当前合同（预期 DRAFT）</span></article>
            <article><strong>{preview.zeroWrite.unchanged ? "UNCHANGED" : "CHANGED"}</strong><span>GET 前后指纹</span></article>
          </section>

          <section className={styles.panel}>
            <h2>绑定证据</h2>
            <dl className={styles.evidence}>
              <div><dt>目标代码 SHA</dt><dd>{preview.targetCodeSha}</dd></div>
              <div><dt>bundle hash</dt><dd title={preview.bundleHash}>{shortHash(preview.bundleHash)}</dd></div>
              <div><dt>catalog hash</dt><dd title={preview.schemaFingerprint}>{shortHash(preview.schemaFingerprint)}</dd></div>
              <div><dt>source hash</dt><dd title={preview.sourceHash}>{shortHash(preview.sourceHash)}</dd></div>
              <div><dt>target hash</dt><dd title={preview.targetHash}>{shortHash(preview.targetHash)}</dd></div>
              <div><dt>non-target hash</dt><dd title={preview.nonTargetHash}>{shortHash(preview.nonTargetHash)}</dd></div>
              <div><dt>token</dt><dd className={styles.wrap}>{preview.previewToken}</dd></div>
              <div><dt>有效期</dt><dd>{preview.generatedAt} → {preview.expiresAt}</dd></div>
            </dl>
            <button type="button" className={styles.secondaryButton} onClick={() => void runPreview(preview.previewToken)} disabled={loading || applying}>
              使用当前 token 再次零写核验
            </button>
          </section>

          <section className={styles.panel}>
            <h2>停止原因与 P01—P11</h2>
            {preview.stopReasons.length
              ? <ul className={styles.stopList}>{preview.stopReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              : <p className={styles.success}>没有阻断原因；仍须满足恢复点和受控 APPLY 开关门槛。</p>}
            <details><summary>P01—P11 脱敏事实</summary><pre>{JSON.stringify(preview.facts, null, 2)}</pre></details>
          </section>

          <section className={styles.panel}>
            <p className={styles.eyebrow}>写入门 T（默认关闭）</p>
            <h2>受控 schema APPLY</h2>
            <p>只安装 additive schema、DRAFT 合同及本次唯一稳定管理员 membership；不回填正文、不激活合同、不开放入口。</p>
            <label><span>审批引用</span><input value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)} autoComplete="off" /></label>
            <label><span>provider 恢复点引用</span><input value={backupReference} onChange={(event) => setBackupReference(event.target.value)} autoComplete="off" /></label>
            <label><span>恢复点验证时间</span><input type="datetime-local" value={backupVerifiedAt} onChange={(event) => setBackupVerifiedAt(event.target.value)} /></label>
            <p className={styles.confirmation}>{V04_SCHEMA_APPLY_CONFIRMATION}</p>
            <label><span>精确确认语句</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
            <button type="button" className={styles.dangerButton} disabled={!canApply || applying} onClick={() => void applySchema()}>
              {applying ? "受控事务执行中…" : "执行一次 schema APPLY"}
            </button>
            {!props.applyEnabled ? <p className={styles.notice}>APPLY 生产开关关闭；本轮只允许 TEST_ONLY 验收。</p> : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
