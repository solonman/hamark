"use client";

import { useRef, useState, type JSX } from "react";
import { createThumbnailFromVideoFile } from "@/app/components/video-thumbnail";
import DeleteConfirmDialog from "@/components/shared/DeleteConfirmDialog";
import { retroApi, retroReasonText } from "@/lib/retro-client";
import { RETRO_FILE_ACCEPT, RETRO_LIMITS, formatRetroClock, type RetroAssetView, type RetroNewAssetInput } from "@/lib/retro-model";
import { checkRetroAttachFile, docFormatLabel, remainingRetroAssetSlots } from "@/lib/retro-ui";
import { AudioReviewIcon } from "../v04/V19AudioReviewParts";
import {
  putFile,
  readAudioMetadata,
  readImageDimensions,
  readVideoMetadata,
  runWithConcurrency,
} from "./retro-upload";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

type LocalUpload = {
  assetId: string;
  name: string;
  pct: number;
  state: "UPLOADING" | "FAILED";
  file: File;
  coverFile: File | null;
  contentType: string;
};

const DOC_COLOR: Record<string, string> = { PDF: "#ff8f7d", DOC: "#8db4ff", XLS: "#7fd19a", PPT: "#ffb36b" };

export function DocIcon({ label }: { label: string }): JSX.Element {
  return (
    <svg viewBox="0 0 26 30" fill="none" aria-hidden="true">
      <path d="M3 1.5h13l7.5 7.5v19.5H3z" stroke="#b9bbb2" strokeWidth="1.4" />
      <path d="M16 1.5V9h7.5" stroke="#b9bbb2" strokeWidth="1.4" />
      <text x="13" y="23" textAnchor="middle" fontSize="7" fontWeight="700" fill={DOC_COLOR[label] ?? "#e6e7df"} fontFamily="Arial, sans-serif">{label}</text>
    </svg>
  );
}

/**
 * 附件区（规格 4.3）：「任务与最初需求」的需求凭证和每个回合共用，规则完全一样——图片、视频、音频、文档，每处 ≤12 个。
 * 格子：图片缩略图／视频封面带 ▶／音频格带时长与转写状态／文档格是类型图标加文件名（带预览状态）。
 * 点任何格子都交给 onOpen，由案例页那一个站内弹层（RetroAssetViewer）预览（规格 4.3「全部在站内弹层预览」）。
 * 上传：建附件行 → 用到哪个签哪个 → 同时传 3 个 → complete 核对；部分失败时格子上重传或去掉。
 * 移除是真删，对话框当场提示。有权限的人看到「＋ 附件」和每格的 ×，其他人纯阅读。
 */
export default function RetroAssetBlock({
  caseId,
  roundId,
  assets,
  editable,
  variant,
  notify,
  refresh,
  onOpen,
  onRetryTranscript,
}: {
  caseId: string;
  /** null = 需求凭证。 */
  roundId: string | null;
  assets: readonly RetroAssetView[];
  editable: boolean;
  variant: "need" | "round";
  notify: (message: string, tone?: "plain" | "warn") => void;
  refresh: () => Promise<void>;
  onOpen: (asset: RetroAssetView) => void;
  onRetryTranscript: (asset: RetroAssetView) => void;
}): JSX.Element | null {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refillInputRef = useRef<HTMLInputElement>(null);
  const refillTarget = useRef<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, LocalUpload>>({});
  const [removing, setRemoving] = useState<RetroAssetView | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState("");

  const sorted = [...assets].sort((a, b) => a.position - b.position);
  const slots = remainingRetroAssetSlots(sorted.length);
  const failedCount = sorted.filter((asset) => asset.uploadStatus !== "READY" && uploads[asset.id]?.state !== "UPLOADING").length;

  if (!sorted.length && !editable) return null;

  function patchUpload(assetId: string, patch: Partial<LocalUpload>) {
    setUploads((current) => (current[assetId] ? { ...current, [assetId]: { ...current[assetId], ...patch } } : current));
  }

  /** 已经有了附件行（assetId）和本地文件：签地址、直传、complete。 */
  async function runUploads(batch: LocalUpload[]) {
    const ids = batch.map((item) => item.assetId);
    const failedIds = new Set<string>();
    await runWithConcurrency(batch, 3, async (upload) => {
      const assetId = upload.assetId;
      patchUpload(assetId, { state: "UPLOADING", pct: 0 });
      try {
        const signed = await retroApi.assetUploadUrl(caseId, assetId);
        if (!signed.uploadUrl) throw new Error("获取上传地址失败");
        const total = upload.file.size + (upload.coverFile?.size ?? 0);
        // 用服务端返回的 contentType（按扩展名定的白名单类型，已签进上传地址），不用浏览器的 file.type。
        await putFile(signed.uploadUrl, upload.file, signed.contentType || upload.contentType, (loaded) => patchUpload(assetId, { pct: Math.round((loaded / total) * 100) }));
        if (upload.coverFile && signed.coverUploadUrl) {
          await putFile(signed.coverUploadUrl, upload.coverFile, upload.coverFile.type || "image/jpeg", (loaded) =>
            patchUpload(assetId, { pct: Math.round(((upload.file.size + loaded) / total) * 100) }));
        }
        patchUpload(assetId, { pct: 100 });
      } catch {
        failedIds.add(assetId);
        patchUpload(assetId, { state: "FAILED" });
      }
    });
    const okIds = ids.filter((id) => !failedIds.has(id));
    if (okIds.length) {
      try {
        const done = await retroApi.completeAssets(caseId, okIds);
        for (const id of done.missing ?? []) { failedIds.add(id); patchUpload(id, { state: "FAILED" }); }
      } catch (reason) {
        for (const id of okIds) { failedIds.add(id); patchUpload(id, { state: "FAILED" }); }
        notify(retroReasonText(reason, "确认上传完成失败，请重试。"), "warn");
      }
    }
    setUploads((current) => {
      const next = { ...current };
      for (const id of ids) if (!failedIds.has(id)) delete next[id];
      return next;
    });
    await refresh();
    if (failedIds.size) notify(`有 ${failedIds.size} 个附件没传上：可以在格子上重传，或者去掉`, "warn");
  }

  async function handlePicked(fileList: FileList | null) {
    if (!fileList || !fileList.length) return;
    let room = slots;
    const entries: Array<{ file: File; input: RetroNewAssetInput; coverFile: File | null; contentType: string }> = [];
    for (const file of Array.from(fileList)) {
      const checked = checkRetroAttachFile(file);
      if (!checked.ok) { notify(checked.reason, "warn"); continue; }
      if (room <= 0) { notify(`最多 ${RETRO_LIMITS.assetsPerOwnerMax} 个附件，多出来的没有加进来`, "warn"); break; }
      room -= 1;
      const input: RetroNewAssetInput = { roundId, originalName: file.name, contentType: file.type || "application/octet-stream", fileSize: file.size };
      let coverFile: File | null = null;
      if (checked.type === "IMAGE") {
        const dims = await readImageDimensions(file);
        input.width = dims.width; input.height = dims.height;
      } else if (checked.type === "VIDEO") {
        const meta = await readVideoMetadata(file);
        input.durationSeconds = meta.durationSeconds; input.width = meta.width; input.height = meta.height;
        try { coverFile = await createThumbnailFromVideoFile(file); } catch { /* 截封面失败也允许上传，只是没有封面 */ }
      } else if (checked.type === "AUDIO") {
        const meta = await readAudioMetadata(file);
        input.durationSeconds = meta.durationSeconds;
      }
      entries.push({ file, input, coverFile, contentType: input.contentType });
    }
    if (!entries.length) return;
    try {
      const added = await retroApi.addAssets(caseId, entries.map((entry) => entry.input));
      const ids = added.assetIds ?? [];
      if (ids.length !== entries.length) throw new Error("建立附件失败，请重试。");
      const next: Record<string, LocalUpload> = {};
      ids.forEach((assetId, index) => {
        next[assetId] = { assetId, name: entries[index].file.name, pct: 0, state: "UPLOADING", file: entries[index].file, coverFile: entries[index].coverFile, contentType: entries[index].contentType };
      });
      setUploads((current) => ({ ...current, ...next }));
      await refresh();
      await runUploads(Object.values(next));
    } catch (reason) {
      notify(retroReasonText(reason, "建立附件失败，请重试。"), "warn");
    }
  }

  function retryOne(asset: RetroAssetView) {
    const local = uploads[asset.id];
    if (local) { void runUploads([local]); return; }
    // 页面刷新过：本地没有原文件了，重新选一次文件补传到这一格。
    refillTarget.current = asset.id;
    refillInputRef.current?.click();
  }

  async function handleRefill(fileList: FileList | null) {
    const assetId = refillTarget.current;
    refillTarget.current = null;
    const file = fileList?.[0];
    if (!assetId || !file) return;
    const checked = checkRetroAttachFile(file);
    if (!checked.ok) { notify(checked.reason, "warn"); return; }
    const entry: LocalUpload = { assetId, name: file.name, pct: 0, state: "UPLOADING", file, coverFile: null, contentType: file.type || "application/octet-stream" };
    setUploads((current) => ({ ...current, [assetId]: entry }));
    await runUploads([entry]);
  }

  function openAsset(asset: RetroAssetView) {
    if (asset.uploadStatus !== "READY") return;
    onOpen(asset);
  }

  async function removeAsset(asset: RetroAssetView) {
    setRemovePending(true);
    setRemoveError("");
    try {
      await retroApi.deleteAsset(caseId, asset.id);
      setUploads((current) => { const next = { ...current }; delete next[asset.id]; return next; });
      setRemoving(null);
      await refresh();
      notify(`已删除「${asset.originalName}」`);
    } catch (reason) {
      setRemoveError(retroReasonText(reason, "删除未完成，附件未发生变化，可重试。"));
    } finally {
      setRemovePending(false);
    }
  }

  function requestRemove(asset: RetroAssetView) {
    // 还没传完或没传上的格子：没有可丢的东西，直接去掉；传完了的才是真删，要确认。
    if (asset.uploadStatus !== "READY") { void removeAsset(asset); return; }
    setRemoveError("");
    setRemoving(asset);
  }

  function tile(asset: RetroAssetView): JSX.Element {
    const local = uploads[asset.id];
    const ready = asset.uploadStatus === "READY";
    const openLabel = asset.type === "AUDIO" || asset.type === "VIDEO" ? "播放" : asset.type === "DOC" ? "预览" : "查看";
    const xButton = editable ? (
      <button type="button" className={styles.x} aria-label={`移除 ${asset.originalName}`} title="移除" onClick={() => requestRemove(asset)}>×</button>
    ) : null;
    const stateLayer = ready ? null : local?.state === "UPLOADING" ? (
      <span className={styles.tileState}>上传中<i><b style={{ width: `${local.pct}%` }} /></i></span>
    ) : (
      <span className={`${styles.tileState} ${styles.bad}`}>没传上{editable ? <button type="button" onClick={() => retryOne(asset)}>重传</button> : null}</span>
    );
    const open = ready ? (
      <button type="button" className={styles.open} aria-label={`${openLabel} ${asset.originalName}`} onClick={() => openAsset(asset)} />
    ) : null;

    if (asset.type === "DOC") {
      return (
        <li key={asset.id} className={`${styles.assetTile} ${styles.docTile}`} data-v04-scheme="dark">
          {open}
          <span className={styles.pdfIcon}>
            <DocIcon label={docFormatLabel(asset.docFormat)} />
            <span>{asset.originalName}</span>
            {ready && asset.derivativeStatus === "PENDING" ? <em className={styles.docState}><span className={`${v04.reviewSpin} ${styles.spinSmall}`} aria-hidden="true" />生成预览中</em> : null}
            {ready && asset.derivativeStatus === "FAILED" ? <em className={`${styles.docState} ${styles.bad}`}>预览失败</em> : null}
            {ready && asset.derivativeStatus === "READY" && asset.pages?.length ? <em className={styles.docState}>{asset.pages.length} 页</em> : null}
          </span>
          {stateLayer}{xButton}
        </li>
      );
    }
    if (asset.type === "AUDIO") {
      const t = asset.transcribe;
      const status = !ready ? null
        : t?.status === "TRANSCRIBING" ? <span className={styles.audioDur}><span className={`${v04.reviewSpin} ${styles.spinSmall}`} aria-hidden="true" />转写中</span>
        : t?.status === "FAILED" ? <button type="button" className={styles.tileRetry} onClick={() => onRetryTranscript(asset)}>转写失败 · 重试</button>
        : <span className={styles.audioDur}>{t?.durationMs ? formatRetroClock(t.durationMs) : asset.durationSeconds ? formatRetroClock(asset.durationSeconds * 1000) : "--:--"} · 文字稿</span>;
      return (
        <li key={asset.id} className={`${styles.assetTile} ${styles.docTile} ${styles.audioTile}`} data-v04-scheme="dark">
          {open}
          <span className={styles.pdfIcon}>
            <span className={styles.audioIcon}><AudioReviewIcon name="mic" /></span>
            <span>{asset.originalName}</span>
            {status}
          </span>
          {stateLayer}{xButton}
        </li>
      );
    }
    const isVideo = asset.type === "VIDEO";
    return (
      <li key={asset.id} className={styles.assetTile} data-v04-scheme="dark">
        {asset.thumbnailUrl
          // eslint-disable-next-line @next/next/no-img-element -- 缩略图来自对象存储签名 URL，不走 next/image 的远程域名白名单
          ? <img className={styles.tileArt} src={asset.thumbnailUrl} alt="" loading="lazy" />
          : <span className={styles.tileFallback}>{ready && asset.derivativeStatus === "FAILED" ? "无预览" : ready && !isVideo ? "生成中" : ""}</span>}
        {open}
        {isVideo ? (
          <>
            <span className={styles.play} aria-hidden="true">▶</span>
            <span className={styles.kind}>视频 {formatRetroClock(asset.durationSeconds * 1000)}</span>
          </>
        ) : <span className={styles.kind}>{asset.originalName}</span>}
        {stateLayer}{xButton}
      </li>
    );
  }

  const acceptHint = `图片、视频、音频、文档，最多 ${RETRO_LIMITS.assetsPerOwnerMax} 个`;
  return (
    <div className={`${styles.assetBlock} ${variant === "need" ? styles.assetBlockPad : ""}`.trim()} data-retro-assets={roundId ?? "need"}>
      <small className={styles.assetLabel}>
        附件{variant === "need" ? " · 客户需求的原始凭证" : ""}
        {editable ? <> <i>选填 · {acceptHint}</i></> : null}
      </small>
      <ul className={styles.assetGrid}>
        {sorted.map(tile)}
        {editable && slots > 0 ? (
          <li>
            <button type="button" className={styles.addTile} onClick={() => fileInputRef.current?.click()}>＋ 附件</button>
          </li>
        ) : null}
      </ul>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={RETRO_FILE_ACCEPT}
        onChange={(event) => { void handlePicked(event.target.files); event.target.value = ""; }}
      />
      <input
        ref={refillInputRef}
        type="file"
        hidden
        accept={RETRO_FILE_ACCEPT}
        onChange={(event) => { void handleRefill(event.target.files); event.target.value = ""; }}
      />
      {failedCount ? <p className={styles.formErrorText}>有 {failedCount} 个没传上：可以在格子上重传，或者去掉。</p> : null}
      <DeleteConfirmDialog
        open={removing !== null}
        heading="移除附件"
        title={removing?.originalName ?? ""}
        question={removing ? `移除「${removing.originalName}」？` : undefined}
        lines={["编辑时移除附件是真删：会连原文件一起彻底删除，不进回收站，不能恢复。"]}
        error={removeError}
        pending={removePending}
        confirmLabel="确认删除"
        pendingLabel="正在删除…"
        onConfirm={() => { if (removing) void removeAsset(removing); }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
