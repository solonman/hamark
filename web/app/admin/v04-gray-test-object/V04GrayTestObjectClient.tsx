"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  V04_GRAY_TEST_OBJECT_CONFIRMATION,
  normalizeV04GrayTestObjectReasonClass,
  type V04GrayTestObjectApplyResult,
  type V04GrayTestObjectPreview,
} from "@/lib/v04-gray-test-object-contract";
import styles from "../v04-schema/page.module.css";

type ApiResponse = {
  preview?: V04GrayTestObjectPreview;
  result?: V04GrayTestObjectApplyResult;
  error?: { code?: string; message?: string; details?: { stage?: string; reasonClass?: unknown } };
};

function diagnosticError(error: ApiResponse["error"], fallback: string) {
  const message = error?.message || fallback;
  const reasonClass = normalizeV04GrayTestObjectReasonClass(error?.details?.reasonClass);
  const context = [error?.code, error?.details?.stage, reasonClass].filter(Boolean).join(" / ");
  return context ? `${message}（诊断：${context}）` : message;
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) throw new Error(`服务器返回空响应（HTTP ${response.status}）。`);
  try {
    return JSON.parse(text) as ApiResponse;
  } catch {
    throw new Error(`服务器返回无法识别的响应（HTTP ${response.status}）。`);
  }
}

export default function V04GrayTestObjectClient({ enabled }: { enabled: boolean }) {
  // The full operation token only lives in this in-memory state. It is never rendered,
  // persisted, added to a URL or written to browser logging.
  const [preview, setPreview] = useState<V04GrayTestObjectPreview | null>(null);
  const [approvalReference, setApprovalReference] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<V04GrayTestObjectApplyResult | null>(null);
  const canApply = useMemo(() => Boolean(enabled && preview?.ready && !preview.alreadyApplied
    && approvalReference.trim().length >= 12
    && confirmation === V04_GRAY_TEST_OBJECT_CONFIRMATION),
  [enabled, preview, approvalReference, confirmation]);

  async function runPreview() {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/admin/v04-gray-test-object/preview", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await readJson(response);
      if (!response.ok || !data.preview) throw new Error(diagnosticError(data.error, "PREVIEW 未完成。"));
      setPreview(data.preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PREVIEW 未完成。");
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!preview || !canApply) return;
    setApplying(true);
    setError("");
    const idempotencyKey = `v04-gray-test-object-${crypto.randomUUID()}`;
    try {
      const response = await fetch("/api/admin/v04-gray-test-object/apply", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          action: "CREATE_TEST_ONLY_GRAY_VIDEO",
          previewToken: preview.previewToken,
          idempotencyKey,
          confirmation,
          approvalReference: approvalReference.trim(),
          targetCodeSha: preview.targetCodeSha,
        }),
      });
      const data = await readJson(response);
      if (!data.result) {
        throw new Error(diagnosticError(data.error, "TEST_ONLY 对象创建未完成。"));
      }
      setResult(data.result);
      if (!response.ok || data.result.status !== "APPLIED") {
        throw new Error("事务已回滚；固定媒体已执行补偿或记录补偿失败状态。");
      }
      setConfirmation("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "TEST_ONLY 对象创建未完成。");
    } finally {
      setApplying(false);
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>稳定 SYSTEM_ADMIN · 同源 · TEST_ONLY</p>
          <h1>V0.4 灰度测试媒体对象</h1>
          <p>只允许写入版本化固定测试片；不接受管理员选择的文件，不进入普通片库。</p>
        </div>
        <div className={styles.switches}>
          <Link className={styles.secondaryButton} href="/admin/v04-schema">Schema 操作面</Link>
          <Link className={styles.secondaryButton} href="/">返回全部作品</Link>
        </div>
      </header>

      <section className={styles.switches} aria-label="工具开关状态">
        <span data-enabled={enabled}>TEST_ONLY 创建工具 {enabled ? "短期开启" : "关闭"}</span>
        <span>V0.4 灰度入口关闭</span>
        <span>普通片库保持 BUSINESS</span>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.eyebrow}>零写 PREVIEW</p><h2>核对唯一固定创建计划</h2></div>
          <button type="button" disabled={!enabled || loading || applying} onClick={() => void runPreview()}>
            {loading ? "正在只读核验…" : "运行 PREVIEW"}
          </button>
        </div>
        {!enabled ? <p className={styles.notice}>独立生产开关关闭；页面加载不会创建对象或业务行。</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </section>

      {preview ? (
        <>
          <section className={styles.summary}>
            <article><strong>{preview.ready ? "READY" : "STOP"}</strong><span>计划状态</span></article>
            <article><strong>{preview.facts.businessVideoCount}</strong><span>普通业务案例（不变）</span></article>
            <article><strong>{preview.plan.fileSize} B</strong><span>固定测试片</span></article>
            <article><strong>{preview.alreadyApplied ? "EXISTS" : "ABSENT"}</strong><span>目标状态</span></article>
          </section>
          <section className={styles.panel}>
            <h2>脱敏计划</h2>
            <dl className={styles.evidence}>
              <div><dt>计划 video.id</dt><dd>{preview.plan.videoId}</dd></div>
              <div><dt>作用域</dt><dd>{preview.plan.dataScope}</dd></div>
              <div><dt>test_run_id</dt><dd>{preview.plan.testRunId}</dd></div>
              <div><dt>媒体 SHA-256</dt><dd>{preview.plan.mediaSha256}</dd></div>
              <div><dt>object key 摘要</dt><dd>{preview.plan.objectKeyDigest.slice(0, 20)}</dd></div>
              <div><dt>Token 摘要</dt><dd>{preview.previewTokenDigest.slice(0, 20)}</dd></div>
              <div><dt>业务指纹</dt><dd>{preview.facts.businessFingerprint.slice(0, 20)}</dd></div>
              <div><dt>有效期</dt><dd>{preview.generatedAt} → {preview.expiresAt}</dd></div>
            </dl>
            {preview.stopReasons.length
              ? <ul className={styles.stopList}>{preview.stopReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              : <p className={styles.success}>身份、合同、目标、媒体键和普通业务指纹满足创建门槛。</p>}
          </section>
          <section className={styles.panel}>
            <p className={styles.eyebrow}>显式 APPLY · 默认关闭</p>
            <h2>创建唯一 TEST_ONLY 灰度对象</h2>
            <p>成功后保留用于灰度；如需清理，仅进入 90 天回收站，COS 不立即物理删除。</p>
            <label><span>批准引用</span><input value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)} autoComplete="off" /></label>
            <p className={styles.confirmation}>{V04_GRAY_TEST_OBJECT_CONFIRMATION}</p>
            <label><span>精确确认语句</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
            <button type="button" className={styles.dangerButton} disabled={!canApply || applying} onClick={() => void apply()}>
              {applying ? "固定媒体上传与事务核验中…" : "创建一次 TEST_ONLY 灰度对象"}
            </button>
            {result ? <p className={result.status === "APPLIED" ? styles.success : styles.error}>
              {result.status} · {result.videoId} · 补偿 {result.compensation}
            </p> : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
