"use client";

import { useId, useRef, useState } from "react";

export type ReplacedVideoFile = {
  originalName: string;
  contentType: string;
  fileSize: number;
  status: "READY";
};

type Props = {
  videoId: string;
  currentName: string;
  onClose: () => void;
  onReplaced: (video: ReplacedVideoFile) => void;
};

function replaceVideoFile(
  videoId: string,
  file: File,
  onProgress: (value: number) => void,
) {
  return new Promise<ReplacedVideoFile>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `/api/videos/${videoId}/replace`);
    request.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    request.setRequestHeader("X-Original-File-Name", encodeURIComponent(file.name));
    request.setRequestHeader("X-Original-File-Size", String(file.size));
    request.setRequestHeader("X-Rights-Confirmed", "1");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      let response: { video?: ReplacedVideoFile; error?: string } = {};
      try {
        response = JSON.parse(request.responseText);
      } catch {
        response = {};
      }
      if (request.status >= 200 && request.status < 300 && response.video) {
        resolve(response.video);
      } else {
        reject(new Error(response.error || "原视频替换失败，请重试。"));
      }
    });
    request.addEventListener("error", () =>
      reject(new Error("网络中断，新视频没有上传完成。")),
    );
    request.send(file);
  });
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
      onReplaced(replacement);
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
