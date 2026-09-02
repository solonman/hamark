"use client";

import { useId, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import {
  isValidTaskType,
  REPORT_ALLOWED_EXTENSIONS,
  REPORT_MAX_TAGS,
  TASK_TYPES,
  validateReportUpload,
} from "@/lib/report-model";
import type { ReportReplaceTarget } from "@/lib/report-library-view";
import styles from "./ReportLibrary.module.css";

type ReportUploadDialogProps = {
  onClose: () => void;
  /** 上传 + complete 都成功之后调用；关不关对话框、要不要刷新列表由调用方决定。 */
  onUploaded: () => void;
  /**
   * 「改传 PDF」：从一份失败报告发起，带着它的标题/任务类型/标签起步，文件只收 PDF。
   * 新报告 complete 成功后，这里会再对旧的失败报告调一次 trash；两步都成功才算完（调用 onUploaded），
   * trash 失败则把「新报告已上传，旧的未能删除」的原话留在对话框里，不关、不触发上层的关闭与刷新。
   */
  replacing?: ReportReplaceTarget;
};

/** 未登录时后端会先一步 401，这里跟视频上传对话框一样直接带回登录页，不留一个卡死的弹窗。 */
function redirectOnUnauthorized(response: Response): boolean {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

function uploadReportFile(url: string, file: File, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("报告文件上传失败，请重试。"));
    });
    request.addEventListener("error", () => reject(new Error("报告文件上传失败，请检查网络后重试。")));
    request.send(file);
  });
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export default function ReportUploadDialog({ onClose, onUploaded, replacing }: ReportUploadDialogProps) {
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  // 「改传 PDF」用旧报告的标题/任务类型/标签起步；这几个 useState 只在挂载时读一次 props，
  // 而对话框每次打开都是全新挂载（父组件用条件渲染开关它），所以不需要额外的 effect 去同步。
  const [title, setTitle] = useState(() => replacing?.title ?? "");
  const [taskType, setTaskType] = useState(() => replacing?.taskType ?? "");
  const [tags, setTags] = useState<string[]>(() => replacing?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    // 清空 value：不然连着两次选同一个文件，onChange 不会再触发。
    event.target.value = "";
    if (!picked) return;
    const validation = validateReportUpload({
      originalName: picked.name,
      contentType: picked.type,
      fileSize: picked.size,
    });
    if (!validation.ok) {
      setFile(null);
      setFileError(validation.error);
      return;
    }
    if (replacing && validation.sourceFormat !== "PDF") {
      setFile(null);
      setFileError("改传只接受 PDF 文件。");
      return;
    }
    setFileError("");
    setFile(picked);
    setTitle((current) => current || stripExtension(picked.name));
  }

  function addTag() {
    const trimmed = tagDraft.trim();
    if (!trimmed) return;
    setTagDraft("");
    setTags((current) => (current.includes(trimmed) || current.length >= REPORT_MAX_TAGS ? current : [...current, trimmed]));
  }

  function handleTagKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag();
    } else if (event.key === "Backspace" && !tagDraft && tags.length) {
      setTags((current) => current.slice(0, -1));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("请先选择要上传的报告文件。");
      return;
    }
    if (!title.trim()) {
      setError("请填写报告标题。");
      return;
    }
    if (!isValidTaskType(taskType)) {
      setError("请选择任务类型。");
      return;
    }
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const createResponse = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          originalName: file.name,
          contentType: file.type,
          fileSize: file.size,
          taskType,
          tags,
        }),
      });
      if (redirectOnUnauthorized(createResponse)) return;
      const created = await readJsonResponse<{ reportId?: string; uploadUrl?: string; error?: string }>(
        createResponse,
        "创建报告条目",
      );
      if (!createResponse.ok || !created.reportId || !created.uploadUrl) {
        throw new Error(created.error || "无法创建报告条目。");
      }

      await uploadReportFile(created.uploadUrl, file, setProgress);

      const completeResponse = await fetch(`/api/reports/${created.reportId}/complete`, { method: "POST" });
      if (redirectOnUnauthorized(completeResponse)) return;
      const completeData = await readJsonResponse<{ error?: string }>(completeResponse, "确认报告上传完成");
      if (!completeResponse.ok) {
        throw new Error(completeData.error || "确认上传完成失败，请重试。");
      }

      if (replacing) {
        // 新报告已经稳稳落地了，这一步再失败也不该把它撤销掉——只提示旧的没删成，交给用户去手动清。
        const trashResponse = await fetch(`/api/reports/${replacing.reportId}/trash`, { method: "POST" });
        if (redirectOnUnauthorized(trashResponse)) return;
        const trashData = await readJsonResponse<{ error?: string }>(trashResponse, "删除旧报告");
        if (!trashResponse.ok) {
          setError(`新报告已上传，旧的未能删除：${trashData.error || "请稍后手动删除。"}`);
          setBusy(false);
          return;
        }
      }
      onUploaded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "上传失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <div
      className={styles.uploadBackdrop}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <section className={styles.uploadDialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.uploadHead}>
          <div><small>UPLOAD</small><b id={titleId}>{replacing ? "改传 PDF" : "上传报告"}</b></div>
          <button type="button" className={styles.uploadClose} onClick={onClose} disabled={busy} aria-label="关闭上传窗口">×</button>
        </div>
        <form onSubmit={submit}>
          <div className={styles.uploadBody}>
            {replacing ? (
              <p className={styles.hint}>
                改传一份 PDF。转换成功后，《{replacing.title}》那份失败记录会自动删除。
              </p>
            ) : null}
            <button
              type="button"
              className={`${styles.fileDrop} ${file ? styles.fileDropHas : ""}`.trim()}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={replacing ? ".pdf" : REPORT_ALLOWED_EXTENSIONS.join(",")}
                onChange={handleFileChange}
                hidden
              />
              {file ? (
                <span><b>{file.name}</b><span>{(file.size / 1024 / 1024).toFixed(1)} MB · 点击换一个</span></span>
              ) : replacing ? (
                <span><b>选择 PDF 文件</b><span>只接受 PDF，单个不超过 200 MB</span></span>
              ) : (
                <span><b>选择文件</b><span>PPT／PPTX／PDF，单个不超过 200 MB</span></span>
              )}
            </button>
            {fileError ? <p className={styles.formError}>{fileError}</p> : null}

            <label className={styles.field}>
              <small>报告名</small>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="默认用文件名"
                disabled={busy}
                required
              />
            </label>

            <div className={styles.two}>
              <label className={styles.field}>
                <small>任务类型</small>
                <select value={taskType} onChange={(event) => setTaskType(event.target.value)} disabled={busy} required>
                  <option value="">请选择</option>
                  {TASK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <div className={styles.field}>
                {/* 这里不用 <label> 包一整个 tagBox：框里除了草稿输入框还有每个 chip 的删除按钮，
                    <label> 只会把点击指给它找到的第一个可聚焦控件，包多个控件点击目标就不确定了。
                    改用 aria-labelledby 把说明文字和输入框显式关联，行为上更可预期。 */}
                <small id={`${titleId}-tags-label`}>标签</small>
                <div className={styles.tagBox} role="group" aria-labelledby={`${titleId}-tags-label`}>
                  {tags.map((tag) => (
                    <span className={styles.tagChip} key={tag}>
                      {tag}
                      <button
                        type="button"
                        onClick={() => setTags((current) => current.filter((item) => item !== tag))}
                        disabled={busy}
                        aria-label={`移除标签 ${tag}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={handleTagKeyDown}
                    aria-label="添加标签，回车确认"
                    placeholder={tags.length >= REPORT_MAX_TAGS ? "" : "回车添加，选填"}
                    disabled={busy || tags.length >= REPORT_MAX_TAGS}
                  />
                </div>
              </div>
            </div>
            <p className={styles.tagHint}>最多 {REPORT_MAX_TAGS} 个标签{tags.length ? `，已添加 ${tags.length} 个` : ""}。</p>

            {replacing ? null : (
              <p className={styles.hint}>
                PPT 会在服务端转成 PDF 再逐页出图，绝大多数版式能还原；动画、未嵌入的字体、部分 SmartArt 可能有出入。
                <b>版式要求高的，建议直接上传 PDF。</b>
              </p>
            )}

            {error ? <p className={styles.formError} role="alert">{error}</p> : null}
            {busy ? (
              <div className={styles.uploadProgress}>
                <div>
                  <span>{progress < 100 ? "正在上传原件" : "上传完成，正在进入转换队列…"}</span>
                  <b>{progress}%</b>
                </div>
                <div className={styles.coverBar}><i className={styles.coverBarFill} style={{ width: `${progress}%` }} /></div>
              </div>
            ) : null}
          </div>
          <div className={styles.uploadFooter}>
            <button type="button" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className={styles.uploadGo} disabled={busy || !file}>{busy ? "正在上传…" : "开始上传"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
