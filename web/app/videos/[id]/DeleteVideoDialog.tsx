"use client";

import { useId, useState } from "react";

type Props = {
  videoId: string;
  onClose: () => void;
  onDeleted: () => void;
};

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

export default function DeleteVideoDialog({ videoId, onClose, onDeleted }: Props) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function removeVideo() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/videos/${videoId}`, { method: "DELETE" });
      if (redirectOnUnauthorized(response)) return;
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "视频删除失败，请重试。");
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "视频删除失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="upload-dialog delete-video-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <div>
            <p className="eyebrow">PERMANENT DELETION</p>
            <h2 id={titleId}>永久删除视频</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭删除确认窗口">×</button>
        </div>
        <div className="delete-video-warning">
          <strong>永久删除后无法恢复</strong>
          <p>原视频、封面和未提交的作业草稿都会被清除。已有任何作业提交的视频不能删除。</p>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="button delete-video-button" type="button" onClick={() => void removeVideo()} disabled={busy}>{busy ? "正在删除…" : "永久删除"}</button>
        </div>
      </section>
    </div>
  );
}
