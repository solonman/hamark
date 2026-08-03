"use client";

import { useId, useRef, useState } from "react";

type UploadDialogProps = {
  onClose: () => void;
  onUploaded: (videoId: string) => Promise<void>;
};

function redirectOnUnauthorized(response: Response | XMLHttpRequest) {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

function uploadFile(url: string, file: File, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("视频文件上传失败，请重试。"));
    });
    request.addEventListener("error", () =>
      reject(new Error("视频文件未能直传到存储服务，请检查网络后重试。")),
    );
    request.send(file);
  });
}

export default function UploadDialog({
  onClose,
  onUploaded,
}: UploadDialogProps) {
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("请先选择一个视频文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          brand,
          tags: tags.split(/[，,]/).map((tag) => tag.trim()),
          description,
          originalName: file.name,
          contentType: file.type,
          fileSize: file.size,
          rightsConfirmed,
        }),
      });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as {
        videoId?: string;
        uploadUrl?: string;
        error?: string;
      };
      if (!response.ok || !data.videoId || !data.uploadUrl) {
        throw new Error(data.error || "无法创建视频条目。");
      }
      await uploadFile(data.uploadUrl, file, setProgress);
      const completeResponse = await fetch(`/api/videos/${data.videoId}/complete`, {
        method: "POST",
      });
      if (redirectOnUnauthorized(completeResponse)) return;
      const completeData = (await completeResponse.json()) as { error?: string };
      if (!completeResponse.ok) {
        throw new Error(completeData.error || "视频上传完成确认失败，请重试。");
      }
      await onUploaded(data.videoId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "上传失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">ADD TO LIBRARY</p>
            <h2 id={titleId}>上传一支好片</h2>
          </div>
          <button
            className="close-button"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭上传窗口"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <button
            className={`file-drop ${file ? "has-file" : ""}`}
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <input
              ref={fileInput}
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              hidden
            />
            <span className="file-drop-icon" aria-hidden="true">
              ↑
            </span>
            {file ? (
              <span>
                <strong>{file.name}</strong>
                <small>{(file.size / 1024 / 1024).toFixed(1)} MB · 点击更换</small>
              </span>
            ) : (
              <span>
                <strong>选择本地视频文件</strong>
                <small>系统不限制格式与大小；能否网页直播放取决于浏览器</small>
              </span>
            )}
          </button>

          <div className="form-grid">
            <label>
              <span>片名 *</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：The Greatest"
                required
                disabled={busy}
              />
            </label>
            <label>
              <span>品牌</span>
              <input
                value={brand}
                onChange={(event) => setBrand(event.target.value)}
                placeholder="例如：Apple"
                disabled={busy}
              />
            </label>
            <label className="form-span">
              <span>标签</span>
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="品牌片，情感，反转（用逗号分隔）"
                disabled={busy}
              />
            </label>
            <label className="form-span">
              <span>一句话备注</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="为什么值得大家一起拆解？"
                rows={3}
                disabled={busy}
              />
            </label>
          </div>

          <label className="rights-check">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
              disabled={busy}
            />
            <span>
              我确认该素材仅用于公司内部学习与评审，并已判断其来源与使用边界。
            </span>
          </label>

          {error ? <p className="form-error">{error}</p> : null}
          {busy ? (
            <div className="upload-progress">
              <div>
                <span>正在上传原始文件</span>
                <strong>{progress}%</strong>
              </div>
              <div className="meter-track">
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>
          ) : null}

          <div className="dialog-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button className="button button-accent" type="submit" disabled={busy}>
              {busy ? "正在入库…" : "上传并加入片库"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
