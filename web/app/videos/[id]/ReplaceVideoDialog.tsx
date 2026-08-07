"use client";

import { useId, useRef, useState } from "react";
import { createThumbnailFromVideoFile } from "@/app/components/video-thumbnail";

export type ReplacedVideoFile = {
  originalName: string;
  contentType: string;
  fileSize: number;
  playbackUrl: string;
  thumbnailUrl: string;
  status: "READY";
};

type Props = {
  videoId: string;
  currentName: string;
  onClose: () => void;
  onReplaced: (video: ReplacedVideoFile) => void;
};

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(
      `/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
    return true;
  }
  return false;
}

// The replacement file is uploaded straight to COS with a presigned URL. Sending it
// through the API route instead would exceed the serverless request body limit.
function uploadToStorage(
  url: string,
  file: Blob,
  onProgress: (value: number) => void,
  failureMessage: string,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
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
      reject(new Error("网络中断，新视频没有上传完成。")),
    );
    request.send(file);
  });
}

async function replaceVideoFile(
  videoId: string,
  file: File,
  onProgress: (value: number) => void,
) {
  const thumbnail = await createThumbnailFromVideoFile(file);
  const startResponse = await fetch(`/api/videos/${videoId}/replace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalName: file.name,
      contentType: file.type,
      rightsConfirmed: true,
    }),
  });
  if (redirectOnUnauthorized(startResponse)) return null;
  const started = (await startResponse.json().catch(() => ({}))) as {
    assetId?: string;
    uploadUrl?: string;
    thumbnailUploadUrl?: string;
    error?: string;
  };
  if (!startResponse.ok || !started.assetId || !started.uploadUrl || !started.thumbnailUploadUrl) {
    throw new Error(started.error || "原视频替换失败，请重试。");
  }

  await Promise.all([
    uploadToStorage(started.uploadUrl, file, onProgress, "新视频文件上传失败，请重试。"),
    uploadToStorage(
      started.thumbnailUploadUrl,
      thumbnail,
      () => undefined,
      "新视频封面上传失败，请重试。",
    ),
  ]);

  const completeResponse = await fetch(`/api/videos/${videoId}/replace/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assetId: started.assetId,
      originalName: file.name,
      contentType: file.type,
      fileSize: file.size,
    }),
  });
  if (redirectOnUnauthorized(completeResponse)) return null;
  const completed = (await completeResponse.json().catch(() => ({}))) as {
    video?: ReplacedVideoFile;
    error?: string;
  };
  if (!completeResponse.ok || !completed.video) {
    throw new Error(completed.error || "原视频替换失败，请重试。");
  }
  return completed.video;
}

export default function ReplaceVideoDialog({
  videoId,
  currentName,
  onClose,
  onReplaced,
}: Props) {
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("请先选择正确的视频文件。");
      return;
    }
    if (!rightsConfirmed) {
      setError("请先确认新素材的内部学习使用边界。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const replacement = await replaceVideoFile(videoId, file, setProgress);
      if (replacement) onReplaced(replacement);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "替换失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="upload-dialog replace-video-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog-head">
          <div>
            <p className="eyebrow">REPLACE SOURCE VIDEO</p>
            <h2 id={titleId}>替换原视频</h2>
          </div>
          <button
            className="close-button"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭替换窗口"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="replacement-preserve-note">
            <strong>只替换播放文件</strong>
            <p>作品标题、视频ID、逐镜脚本、作业、评分和公开分析全部保留。</p>
            <small>当前文件：{currentName}</small>
          </div>

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
              ↻
            </span>
            {file ? (
              <span>
                <strong>{file.name}</strong>
                <small>{(file.size / 1024 / 1024).toFixed(1)} MB · 点击重选</small>
              </span>
            ) : (
              <span>
                <strong>选择正确的视频文件</strong>
                <small>替换成功前，团队仍然可以播放当前文件</small>
              </span>
            )}
          </button>

          <label className="rights-check">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
              disabled={busy}
            />
            <span>
              我确认新素材仅用于公司内部学习与评审，并已判断其来源与使用边界。
            </span>
          </label>

          {error ? <p className="form-error">{error}</p> : null}
          {busy ? (
            <div className="upload-progress">
              <div>
                <span>正在替换原视频</span>
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
            <button
              className="button button-accent"
              type="submit"
              disabled={busy || !file || !rightsConfirmed}
            >
              {busy ? "正在替换…" : "确认替换原视频"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
