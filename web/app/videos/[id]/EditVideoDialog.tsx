"use client";

import { useId, useState } from "react";
import { readJsonResponse } from "@/lib/http-json";

export type EditableVideoInfo = {
  title: string;
  brand: string;
  description: string;
  tags: string[];
};

type Props = {
  videoId: string;
  video: EditableVideoInfo;
  onClose: () => void;
  onSaved: (video: EditableVideoInfo) => void;
};

function redirectOnUnauthorized(response: Response) {
  if (response.status === 401) {
    window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    return true;
  }
  return false;
}

export default function EditVideoDialog({ videoId, video, onClose, onSaved }: Props) {
  const titleId = useId();
  const [title, setTitle] = useState(video.title);
  const [brand, setBrand] = useState(video.brand);
  const [tags, setTags] = useState(video.tags.join("，"));
  const [description, setDescription] = useState(video.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/videos/${videoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          brand,
          description,
          tags: tags.split(/[，,]/).map((tag) => tag.trim()),
        }),
      });
      if (redirectOnUnauthorized(response)) return;
      const data = await readJsonResponse<{ video?: EditableVideoInfo; error?: string }>(
        response,
        "保存作品信息",
      );
      if (!response.ok || !data.video) {
        throw new Error(data.error || "作品信息保存失败，请重试。");
      }
      onSaved(data.video);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作品信息保存失败，请重试。");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <div>
            <p className="eyebrow">EDIT VIDEO DETAILS</p>
            <h2 id={titleId}>编辑作品信息</h2>
          </div>
          <button className="close-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭编辑窗口">×</button>
        </div>

        <form onSubmit={submit}>
          <div className="form-grid">
            <label>
              <span>片名 *</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} required disabled={busy} />
            </label>
            <label>
              <span>品牌</span>
              <input value={brand} onChange={(event) => setBrand(event.target.value)} disabled={busy} />
            </label>
            <label className="form-span">
              <span>标签</span>
              <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="品牌片，情感，反转（用逗号分隔）" disabled={busy} />
            </label>
            <label className="form-span">
              <span>一句话备注</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} disabled={busy} />
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="dialog-actions">
            <button className="button button-ghost" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="button button-accent" type="submit" disabled={busy}>{busy ? "正在保存…" : "保存信息"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
