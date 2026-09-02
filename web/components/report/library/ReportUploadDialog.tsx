"use client";

import { useId, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import {
  isValidTaskType,
  REPORT_ALLOWED_EXTENSIONS,
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
  // 标签是一个逗号分隔的纯文本框（demo 第 226 行、视频上传对话框 app/components/UploadDialog.tsx
  // 同一做法），不是 chip 编辑器；上限（REPORT_MAX_TAGS）由服务端 normalizeReportTags 兜底截断。
  const [tagsText, setTagsText] = useState(() => (replacing?.tags ?? []).join(","));
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
          tags: tagsText.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean),
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
          <div><small>UPLOAD</small><b id={titleId}>{busy ? "正在上传" : replacing ? "改传 PDF" : "上传报告"}</b></div>
          {/* demo 在「正在上传」阶段整个不渲染关闭按钮（第 218 行），不是留着但点不动。 */}
          {busy ? null : (
            <button type="button" className={styles.uploadClose} onClick={onClose} aria-label="关闭上传窗口">×</button>
          )}
        </div>
        {busy ? (
          // demo 上传中把整张表单换成这一小块（第 219-220 行）：文件名／百分比／进度条／状态语，
          // 不是给表单字段套 disabled 然后在下面再叠一段进度条。
          <div className={styles.uploadBody}>
            <div className={styles.uploadProgress}>
              <span>{file?.name}</span>
              <b>{progress}%</b>
              <div className={styles.coverBar}><i className={styles.coverBarFill} style={{ width: `${progress}%` }} /></div>
              <span>{progress < 100 ? "直传到对象存储，浏览器不用等服务器中转" : "上传完成，进入转换队列…"}</span>
            </div>
          </div>
        ) : (
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
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={replacing ? ".pdf" : REPORT_ALLOWED_EXTENSIONS.join(",")}
                  onChange={handleFileChange}
                  hidden
                />
                {/* .fileDrop 是 grid 容器（demo 第 132 行），<b> 与 <span> 要是它的直接子节点才会
                    各占一行；套一层 <span> 包起来会让两段文字挤在同一行，见 demo 第 223 行。 */}
                {file ? (
                  <>
                    <b>{file.name}</b>
                    <span>{(file.size / 1024 / 1024).toFixed(1)} MB · 点击换一个</span>
                  </>
                ) : replacing ? (
                  <>
                    <b>选择 PDF 文件</b>
                    <span>只接受 PDF，单个不超过 200 MB</span>
                  </>
                ) : (
                  <>
                    <b>选择文件</b>
                    <span>PPT／PPTX／PDF，单个不超过 200 MB</span>
                  </>
                )}
              </button>
              {fileError ? <p className={styles.formError}>{fileError}</p> : null}

              <label className={styles.field}>
                <small>报告名</small>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="默认用文件名"
                  required
                />
              </label>

              <div className={styles.two}>
                <label className={styles.field}>
                  <small>任务类型</small>
                  <select value={taskType} onChange={(event) => setTaskType(event.target.value)} required>
                    <option value="">请选择</option>
                    {TASK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                </label>
                {/* 标签是一个逗号分隔的纯文本框，与 demo 第 226 行、视频上传对话框同一做法——
                    不是 chip 编辑器；上限由服务端 normalizeReportTags 截断兜底。 */}
                <label className={styles.field}>
                  <small>标签</small>
                  <input
                    value={tagsText}
                    onChange={(event) => setTagsText(event.target.value)}
                    placeholder="用逗号分开，选填"
                  />
                </label>
              </div>

              {replacing ? null : (
                <p className={styles.hint}>
                  PPT 会在服务端转成 PDF 再逐页出图，绝大多数版式能还原；动画、未嵌入的字体、部分 SmartArt 可能有出入。
                  <b>版式要求高的，建议直接上传 PDF。</b>
                </p>
              )}

              {error ? <p className={styles.formError} role="alert">{error}</p> : null}
            </div>
            <div className={styles.uploadFooter}>
              <button type="button" onClick={onClose}>取消</button>
              <button type="submit" className={styles.uploadGo} disabled={!file}>开始上传</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
