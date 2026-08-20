"use client";

import { useId, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";

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
      const data = await readJsonResponse<{ error?: string | { message?: string } }>(
        response,
        "移入回收站",
      );
      const message = typeof data.error === "string" ? data.error : data.error?.message;
      if (!response.ok) throw new Error(message || "移入回收站失败，请重试。");
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移入回收站失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="upload-dialog delete-video-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <div>
            <p className="eyebrow">MOVE TO TRASH</p>
            <h2 id={titleId}>移入回收站</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭删除确认窗口">×</button>
        </div>
        <div className="delete-video-warning">
          <strong>90 天内可恢复</strong>
          <p>原视频、封面、工作稿、提交版和审计历史都会保留；本操作不会删除 COS 对象。</p>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="button delete-video-button" type="button" onClick={() => void removeVideo()} disabled={busy}>{busy ? "正在移入…" : "移入回收站"}</button>
        </div>
      </section>
    </div>
  );
}
