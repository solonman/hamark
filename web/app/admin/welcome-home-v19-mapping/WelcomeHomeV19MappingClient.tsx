"use client";

import Link from "next/link";
import { useState } from "react";
import {
  WELCOME_HOME_V19_MAPPING_CONFIRMATION,
  type WelcomeHomeV19MappingApplyResult,
  type WelcomeHomeV19MappingPreview,
} from "@/lib/welcome-home-v19-mapping-contract";
import styles from "../v04-schema/page.module.css";

type ApiResponse = {
  preview?: WelcomeHomeV19MappingPreview;
  result?: WelcomeHomeV19MappingApplyResult;
  error?: { code?: string; message?: string; details?: { stage?: string; reason?: string } };
};

async function readJson(response: Response) {
  const body = await response.text();
  if (!body) throw new Error(`服务器返回空响应（HTTP ${response.status}）。`);
  try { return JSON.parse(body) as ApiResponse; } catch {
    throw new Error(`服务器返回无法识别的响应（HTTP ${response.status}）。`);
  }
}

const short = (value: string) => value.slice(0, 20);
const newIdempotencyKey = () => `welcome-home-v19-${crypto.randomUUID()}`;

export default function WelcomeHomeV19MappingClient({
  previewEnabled,
  applyEnabled,
}: {
  previewEnabled: boolean;
  applyEnabled: boolean;
}) {
  const [preview, setPreview] = useState<WelcomeHomeV19MappingPreview | null>(null);
  const [result, setResult] = useState<WelcomeHomeV19MappingApplyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [approvalReference, setApprovalReference] = useState("");
  const [error, setError] = useState("");

  async function request(path: "preview" | "apply") {
    setLoading(true);
    setError("");
    try {
      const idempotencyKey = newIdempotencyKey();
      const response = await fetch(`/api/admin/welcome-home-v19-mapping/${path}`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: path === "apply" ? { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey } : undefined,
        body: path === "apply" ? JSON.stringify({
          action: "APPLY_WELCOME_HOME_V19_MAPPING",
          confirmation,
          previewToken: preview?.previewToken,
          targetCodeSha: preview?.targetCodeSha,
          idempotencyKey,
          approvalReference,
        }) : undefined,
      });
      const data = await readJson(response);
      if (!response.ok) {
        const context = [data.error?.code, data.error?.details?.stage, data.error?.details?.reason]
          .filter(Boolean).join(" / ");
        throw new Error(`${data.error?.message || "操作未完成。"}${context ? `（诊断：${context}）` : ""}`);
      }
      if (path === "preview" && data.preview) {
        // The complete token stays only in this same-origin React state. It is
        // never rendered, copied, logged, put in a URL or persisted in storage.
        setPreview(data.preview);
        setResult(null);
      } else if (path === "apply" && data.result) {
        setResult(data.result);
      } else throw new Error("服务器响应缺少预期结果。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作未完成。");
    } finally {
      setLoading(false);
    }
  }

  const canApply = Boolean(applyEnabled && preview?.ready && !preview.alreadyApplied
    && confirmation === WELCOME_HOME_V19_MAPPING_CONFIRMATION
    && approvalReference.trim().length >= 12 && !loading);

  return <main className={styles.shell} data-welcome-home-v19-mapping>
    <header className={styles.header}><div>
      <p className={styles.eyebrow}>稳定 SYSTEM_ADMIN · SAME-ORIGIN · 固定单案例</p>
      <h1>《欢迎回家》V1.9 直接映射</h1>
      <p>固定 V0.3 共享轮 1／rev 153；只填空白、相同 no-op、不同绝不覆盖。</p>
    </div><Link className={styles.secondaryButton} href="/">返回全部作品</Link></header>

    <section className={styles.switches} aria-label="工具开关状态">
      <span>PREVIEW {previewEnabled ? "短期开启" : "关闭"}</span>
      <span>APPLY {applyEnabled ? "短期开启" : "关闭"}</span>
      <span>不创建提交／专家优选</span>
    </section>

    <section className={styles.panel}><div className={styles.panelHeader}>
      <div><p className={styles.eyebrow}>零写预检</p><h2>校验源、目标、结构与 196 实例</h2></div>
      <button type="button" disabled={!previewEnabled || loading} onClick={() => void request("preview")}>
        {loading ? "正在处理…" : "运行 PREVIEW"}
      </button>
    </div>
      {!previewEnabled ? <p className={styles.notice}>独立开关关闭；页面加载不会执行 PREVIEW 或 APPLY。</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>

    {preview ? <>
      <section className={styles.summary}>
        <article><strong>{preview.ready ? "READY" : "STOP"}</strong><span>预检结论</span></article>
        <article><strong>{preview.totals.TARGET_EMPTY}</strong><span>空白候选</span></article>
        <article><strong>{preview.totals.TARGET_SAME}</strong><span>相同 no-op</span></article>
        <article><strong>{preview.totals.TARGET_DIFFERENT}</strong><span>不同，保留</span></article>
        <article><strong>{preview.totals.UNADDRESSABLE}</strong><span>不可定位</span></article>
      </section>
      <section className={styles.panel}><h2>脱敏事实</h2><dl className={styles.evidence}>
        <div><dt>合同</dt><dd>{preview.contract.version} · {short(preview.contract.hash)}</dd></div>
        <div><dt>源</dt><dd>轮 {preview.source.roundNumber} · rev {preview.source.revision}</dd></div>
        <div><dt>源摘要</dt><dd>{short(preview.source.sourceDigest)}</dd></div>
        <div><dt>目标</dt><dd>rev {preview.target.revision} · {preview.target.workspaceStatus}</dd></div>
        <div><dt>桥段／镜头</dt><dd>{preview.structure.sourceShotGroupCount}／{preview.structure.sourceShotCount}</dd></div>
        <div><dt>提交／专家／活动租约</dt><dd>{preview.target.submissionCount}／{preview.target.expertReleaseCount}／{preview.target.activeLeaseCount}</dd></div>
        <div><dt>PREVIEW 摘要</dt><dd>{short(preview.previewHash)}</dd></div>
        <div><dt>Token 摘要</dt><dd>{short(preview.previewTokenDigest)}</dd></div>
        <div><dt>零写</dt><dd>{preview.zeroWrite.unchanged ? "前后不变" : "事实变化"}</dd></div>
      </dl>
      {preview.stopReasons.length ? <ul className={styles.stopList}>{preview.stopReasons.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      </section>
      <section className={styles.panel}><h2>受控 APPLY</h2>
        <p>只有独立 APPLY 开关开启、PREVIEW 为 READY、显式确认与批准引用齐备时才可执行。</p>
        <label>确认口令<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <label>批准引用<input value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)} /></label>
        <button type="button" disabled={!canApply} onClick={() => void request("apply")}>执行固定映射</button>
        {result ? <p className={styles.success}>结果 {result.outcome} · rev {result.revision} · 196 项均为 SAME。</p> : null}
      </section>
    </> : null}
  </main>;
}
