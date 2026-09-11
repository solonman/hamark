"use client";

import { useId, useRef, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";
import { confirmVideoUpload, UploadConfirmationError } from "./confirm-video-upload";
import { createThumbnailFromVideoFile } from "./video-thumbnail";

type UploadDialogProps = {
  onClose: () => void;
  onUploaded: (videoId: string) => Promise<void>;
};

function redirectToLogin() {
  window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

function redirectOnUnauthorized(response: Response | XMLHttpRequest) {
  if (response.status === 401) {
    redirectToLogin();
    return true;
  }
  return false;
}

function uploadFile(
  url: string,
  file: Blob,
  onProgress: (value: number) => void,
  failureMessage = "视频文件上传失败，请重试。",
) {
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
      else reject(new Error(failureMessage));
    });
    request.addEventListener("error", () =>
      reject(new Error(`${failureMessage} 请检查网络后重试。`)),
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
  // 文件和封面都已落到 COS、只差确认入库的那条条目。再点提交只补确认，不重建条目、不重传。
  const [pendingVideoId, setPendingVideoId] = useState<string | null>(null);
  const locked = busy || pendingVideoId !== null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("请先选择一个视频文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let videoId = pendingVideoId;
      if (!videoId) {
        const thumbnail = await createThumbnailFromVideoFile(file);
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
        const data = await readJsonResponse<{
          videoId?: string;
          uploadUrl?: string;
          thumbnailUploadUrl?: string;
          error?: string;
        }>(response, "创建视频条目");
        if (!response.ok || !data.videoId || !data.uploadUrl || !data.thumbnailUploadUrl) {
          throw new Error(data.error || "无法创建视频条目。");
        }
        await Promise.all([
          uploadFile(data.uploadUrl, file, setProgress),
          uploadFile(
            data.thumbnailUploadUrl,
            thumbnail,
            () => undefined,
            "视频封面上传失败，请重试。",
          ),
        ]);
        videoId = data.videoId;
        setPendingVideoId(videoId);
      }
      if ((await confirmVideoUpload(videoId)) === "unauthorized") {
        redirectToLogin();
        return;
      }
      await onUploaded(videoId);
    } catch (reason) {
      if (reason instanceof UploadConfirmationError && reason.retryable) {
        setError(`${reason.message}（点「重新确认入库」只补这一步，不会重传文件。）`);
      } else {
        // 服务端明确拒绝的确认（文件没传上、大小对不上）补确认也没用，下次从头建条目重传。
        if (reason instanceof UploadConfirmationError) setPendingVideoId(null);
        setError(reason instanceof Error ? reason.message : "上传失败，请重试。");
      }
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
            disabled={locked}
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
                disabled={locked}
              />
            </label>
            <label>
              <span>品牌</span>
              <input
                value={brand}
                onChange={(event) => setBrand(event.target.value)}
                placeholder="例如：Apple"
                disabled={locked}
              />
            </label>
            <label className="form-span">
              <span>标签</span>
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="品牌片，情感，反转（用逗号分隔）"
                disabled={locked}
              />
            </label>
            <label className="form-span">
              <span>一句话备注</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="为什么值得大家一起拆解？"
                rows={3}
                disabled={locked}
              />
            </label>
          </div>

          <label className="rights-check">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
              disabled={locked}
            />
            <span>
              我确认该素材仅用于公司内部学习与评审，并已判断其来源与使用边界。
            </span>
          </label>

          {error ? <p className="form-error">{error}</p> : null}
          {busy ? (
            <div className="upload-progress">
              <div>
                <span>{pendingVideoId ? "文件已上传，正在确认入库" : "正在生成封面并上传原始文件"}</span>
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
              {busy ? "正在入库…" : pendingVideoId ? "重新确认入库" : "上传并加入片库"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
