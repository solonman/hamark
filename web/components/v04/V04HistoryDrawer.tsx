"use client";

import { useEffect, useRef, useState } from "react";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import type { V04ContentSummary } from "@/lib/v04-domain";
import {
  describeV04ContentSummary,
  describeV04RestoreLoss,
  formatV04HistoryTime,
} from "@/lib/v04-history-versions";
import styles from "./V04Surface.module.css";

type HistoryEvent = {
  id: string;
  eventType: "INITIAL_BASELINE" | "WORKING_SESSION" | "SUBMISSION" | "EXPERT" | "REVISION" | "RESTORE" | "COMMENT";
  createdAt: string;
  actor_name_snapshot?: string;
  submission_number?: number;
  revision?: number;
  grade?: string;
  contentSummary?: V04ContentSummary | null;
};

type HistoryModel = {
  events: HistoryEvent[];
  currentSummary?: V04ContentSummary | null;
};

export default function V04HistoryDrawer({ videoId, open, onClose, onRestore }: {
  videoId: string;
  open: boolean;
  onClose: () => void;
  onRestore?: (source: { sourceType: "BASELINE" | "WORKING" | "SUBMISSION"; sourceId: string }) => Promise<void>;
}) {
  const tabToken = useRef(`v04-history-${crypto.randomUUID()}`);
  const [model, setModel] = useState<HistoryModel | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState("");
  const [confirming, setConfirming] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void v04UiApi.history<HistoryModel>(videoId, tabToken.current, controller.signal)
      .then((value) => { setModel(value); setError(""); setConfirming(""); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof V04UiApiError ? reason.message : "历史暂时无法读取。");
      });
    return () => controller.abort();
  }, [open, videoId]);
  if (!open) return null;
  const events = model?.events ?? null;
  const currentSummary = model?.currentSummary ?? null;
  const sourceType = (event: HistoryEvent) => event.eventType === "INITIAL_BASELINE"
    ? "BASELINE" as const
    : event.eventType === "SUBMISSION" ? "SUBMISSION" as const
      : event.eventType === "WORKING_SESSION" ? "WORKING" as const : null;
  const startRestore = (event: HistoryEvent) => {
    const source = sourceType(event);
    if (!source || !onRestore) return;
    setConfirming("");
    setRestoring(event.id);
    void onRestore({ sourceType: source, sourceId: event.id }).finally(() => setRestoring(""));
  };
  return <aside className={styles.drawer} aria-label="历史版本"><header><h2>历史版本</h2><button onClick={onClose}>关闭</button></header><p>恢复只会创建新的工作稿，不覆盖旧提交或专家优选；当前工作稿也会继续留在本列表中，可以再恢复回来。</p>{currentSummary && <p data-v04-history-current>当前工作稿：{describeV04ContentSummary(currentSummary)}</p>}{error && <p role="alert">{error}</p>}{events === null && !error ? <p>正在读取历史…</p> : events?.length ? events.toReversed().map((event) => {
    const source = sourceType(event);
    const label = event.eventType === "SUBMISSION" ? `不可变提交 V${event.submission_number ?? "—"}` : event.eventType === "WORKING_SESSION" ? `工作稿修订 ${event.revision ?? "—"}` : event.eventType === "INITIAL_BASELINE" ? "初始基线" : event.eventType;
    const loss = source ? describeV04RestoreLoss(currentSummary, event.contentSummary) : "";
    return <article key={`${event.eventType}-${event.id}`}><b>{label}</b><span>{formatV04HistoryTime(event.createdAt)}{event.actor_name_snapshot ? ` · ${event.actor_name_snapshot}` : ""}{event.grade ? ` · ${event.grade}` : ""}</span>{source && <span data-v04-history-summary>{describeV04ContentSummary(event.contentSummary)}</span>}{onRestore && source && (confirming === event.id
      ? <><span role="alert" className={styles.historyWarning}>{loss}恢复后当前内容仍可从本列表找回。</span><div className={styles.historyConfirm}><button type="button" onClick={() => startRestore(event)}>确认恢复此版本</button><button type="button" onClick={() => setConfirming("")}>取消</button></div></>
      : <button type="button" disabled={restoring === event.id} onClick={() => { if (loss) setConfirming(event.id); else startRestore(event); }}>{restoring === event.id ? "正在恢复…" : "以此版本创建恢复稿"}</button>)}</article>;
  }) : <p>尚无历史事件。</p>}</aside>;
}
