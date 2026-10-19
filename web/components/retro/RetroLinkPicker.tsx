"use client";

import { useEffect, useId, useMemo, useState, type JSX } from "react";
import { readJsonResponse } from "@/lib/http-json";
import {
  RETRO_LIMITS,
  RETRO_LINK_KIND_LABELS,
  RETRO_LINK_KIND_LIST,
  normalizeRetroSearch,
  type RetroLinkKind,
  type RetroLinkView,
} from "@/lib/retro-model";
import report from "../report/library/ReportLibrary.module.css";
import styles from "./Retro.module.css";

type PickEntry = { kind: RetroLinkKind; id: string; title: string; subtitle: string; thumb: string | null };

const keyOf = (kind: RetroLinkKind, id: string) => `${kind}:${id}`;

async function getList<T>(path: string, field: string, operation: string): Promise<T[]> {
  const response = await fetch(path, { cache: "no-store" });
  const data = await readJsonResponse<Record<string, unknown>>(response, operation);
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `${operation}失败`);
  return (data[field] as T[] | undefined) ?? [];
}

/** 数据直接用三个库现有的列表接口（规格 4.4），不新开查询。 */
async function loadPickEntries(): Promise<Record<RetroLinkKind, { entries: PickEntry[]; error: string }>> {
  const safe = async (kind: RetroLinkKind, load: () => Promise<PickEntry[]>) => {
    try { return [kind, { entries: await load(), error: "" }] as const; }
    catch (reason) { return [kind, { entries: [], error: reason instanceof Error ? reason.message : "读取失败" }] as const; }
  };
  const results = await Promise.all([
    safe("VIDEO", async () => (await getList<{ id: string; title: string; brand: string; thumbnailUrl: string | null }>("/api/videos", "videos", "视频库读取"))
      .map((item) => ({ kind: "VIDEO" as const, id: item.id, title: item.title, subtitle: item.brand || "未标注品牌", thumb: item.thumbnailUrl }))),
    safe("REPORT", async () => (await getList<{ id: string; title: string; taskType: string; coverUrl: string | null }>("/api/reports", "reports", "报告库读取"))
      .map((item) => ({ kind: "REPORT" as const, id: item.id, title: item.title, subtitle: item.taskType || "报告", thumb: item.coverUrl }))),
    safe("VISUAL", async () => (await getList<{ id: string; title: string; creator: string; cover: { thumbnailUrl: string | null } | null }>("/api/visual-cases", "cases", "公共视觉库读取"))
      .map((item) => ({ kind: "VISUAL" as const, id: item.id, title: item.title, subtitle: item.creator || "未标注创作方", thumb: item.cover?.thumbnailUrl ?? null }))),
  ]);
  return Object.fromEntries(results) as Record<RetroLinkKind, { entries: PickEntry[]; error: string }>;
}

/**
 * 关联作品选择框（规格 4.4）：三个页签（视频库／报告库／公共视觉库）、带搜索、可以多选，每回合最多 6 个。
 * 已删除的原作品不在列表里，但已有的关联会原样保留。
 */
export default function RetroLinkPicker({
  currentLinks,
  onClose,
  onSave,
  notify,
}: {
  currentLinks: readonly RetroLinkView[];
  onClose: () => void;
  onSave: (links: { kind: RetroLinkKind; targetId: string }[]) => Promise<void>;
  notify: (message: string, tone?: "plain" | "warn") => void;
}): JSX.Element {
  const titleId = useId();
  const [lists, setLists] = useState<Record<RetroLinkKind, { entries: PickEntry[]; error: string }> | null>(null);
  const [tab, setTab] = useState<RetroLinkKind>("VIDEO");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(() => currentLinks.map((link) => keyOf(link.kind, link.targetId)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadPickEntries().then((next) => { if (!cancelled) setLists(next); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, onClose]);

  const normalized = normalizeRetroSearch(query).trim();
  const rows = useMemo(() => {
    const entries = lists?.[tab].entries ?? [];
    return normalized ? entries.filter((entry) => normalizeRetroSearch(`${entry.title} ${entry.subtitle}`).includes(normalized)) : entries;
  }, [lists, tab, normalized]);

  function toggle(kind: RetroLinkKind, id: string) {
    const key = keyOf(kind, id);
    if (selected.includes(key)) { setSelected((current) => current.filter((item) => item !== key)); return; }
    if (selected.length >= RETRO_LIMITS.linksPerRoundMax) { notify(`每回合最多关联 ${RETRO_LIMITS.linksPerRoundMax} 个作品`, "warn"); return; }
    setSelected((current) => [...current, key]);
  }

  async function save() {
    setPending(true);
    setError("");
    try {
      await onSave(selected.map((key) => {
        const [kind, ...rest] = key.split(":");
        return { kind: kind as RetroLinkKind, targetId: rest.join(":") };
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试。");
      setPending(false);
    }
  }

  const tabError = lists?.[tab].error ?? "";
  return (
    <div className={styles.root}>
      <div className={report.uploadBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
        <section className={`${report.uploadDialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className={`${report.uploadHead} ${styles.dialogHead}`}>
            <div><small>LINK WORKS</small><b id={titleId}>关联作品</b></div>
            <button type="button" className={report.uploadClose} onClick={onClose} aria-label="关闭" disabled={pending}>×</button>
          </div>
          <div className={report.uploadBody}>
            <div className={styles.pickTabs} role="group" aria-label="作品库">
              {RETRO_LINK_KIND_LIST.map((kind) => {
                const count = selected.filter((key) => key.startsWith(`${kind}:`)).length;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={styles.partPill}
                    aria-pressed={tab === kind}
                    onClick={() => setTab(kind)}
                  >
                    {RETRO_LINK_KIND_LABELS[kind]}{count ? ` · ${count}` : ""}
                  </button>
                );
              })}
            </div>
            <label className={report.field}>
              <input aria-label="搜索作品" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、品牌或客户" />
            </label>
            <ul className={styles.pickList}>
              {!lists ? <li className={styles.pickEmpty}>正在读取…</li>
                : tabError ? <li className={styles.pickEmpty}>读取失败：{tabError}</li>
                : rows.length ? rows.map((entry) => {
                  const on = selected.includes(keyOf(entry.kind, entry.id));
                  return (
                    <li key={keyOf(entry.kind, entry.id)}>
                      <button type="button" className={styles.pickRow} role="checkbox" aria-checked={on} onClick={() => toggle(entry.kind, entry.id)}>
                        <span className={styles.box}>{on ? "✓" : ""}</span>
                        <span className={styles.linkThumb} data-v04-scheme="dark">
                          {/* eslint-disable-next-line @next/next/no-img-element -- 缩略图来自各库已签名的地址 */}
                          {entry.thumb ? <img src={entry.thumb} alt="" loading="lazy" /> : null}
                        </span>
                        <span className={styles.pickWho}><b>{entry.title}</b><small>{entry.subtitle}</small></span>
                      </button>
                    </li>
                  );
                }) : <li className={styles.pickEmpty}>没有找到对应作品。</li>}
            </ul>
            <p className={styles.recNote}>列表直接用三个库现有的列表接口。进 AI 输入的只有库名、标题、品牌或客户、标签和一句话摘要，不展开全文。</p>
            {error ? <p className={report.formError} role="alert">{error}</p> : null}
          </div>
          <div className={`${report.uploadFooter} ${styles.dialogFoot}`}>
            <span className={styles.footNote}>已选 {selected.length} / {RETRO_LIMITS.linksPerRoundMax}</span>
            <button type="button" onClick={onClose} disabled={pending}>取消</button>
            <button type="button" className={report.uploadGo} disabled={pending} onClick={() => void save()}>{pending ? "保存中…" : "确定"}</button>
          </div>
        </section>
      </div>
    </div>
  );
}
