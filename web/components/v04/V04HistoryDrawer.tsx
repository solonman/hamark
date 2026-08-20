"use client";

import { useEffect, useRef, useState } from "react";
import { V04UiApiError, v04UiApi } from "@/lib/v04-ui-api-client";
import styles from "./V04Surface.module.css";

type HistoryEvent = {
  id: string;
  eventType: "INITIAL_BASELINE" | "WORKING_SESSION" | "SUBMISSION" | "EXPERT" | "REVISION" | "RESTORE" | "COMMENT";
  createdAt: string;
  actor_name_snapshot?: string;
  submission_number?: number;
  revision?: number;
  grade?: string;
};

export default function V04HistoryDrawer({ videoId, open, onClose, onRestore }: {
  videoId: string;
  open: boolean;
  onClose: () => void;
  onRestore?: (source: { sourceType: "BASELINE" | "WORKING" | "SUBMISSION"; sourceId: string }) => Promise<void>;
}) {
  const tabToken = useRef(`v04-history-${crypto.randomUUID()}`);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void v04UiApi.history<{ events: HistoryEvent[] }>(videoId, tabToken.current, controller.signal)
      .then((value) => { setEvents(value.events); setError(""); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof V04UiApiError ? reason.message : "历史暂时无法读取。");
      });
    return () => controller.abort();
  }, [open, videoId]);
  if (!open) return null;
  const sourceType = (event: HistoryEvent) => event.eventType === "INITIAL_BASELINE"
    ? "BASELINE" as const
    : event.eventType === "SUBMISSION" ? "SUBMISSION" as const
      : event.eventType === "WORKING_SESSION" ? "WORKING" as const : null;
  return <aside className={styles.drawer} aria-label="历史版本"><header><h2>历史版本</h2><button onClick={onClose}>关闭</button></header><p>恢复只会创建新的工作稿，不覆盖旧提交或专家优选。</p>{error && <p role="alert">{error}</p>}{events === null && !error ? <p>正在读取历史…</p> : events?.length ? events.toReversed().map((event) => {
    const source = sourceType(event);
    const label = event.eventType === "SUBMISSION" ? `不可变提交 V${event.submission_number ?? "—"}` : event.eventType === "WORKING_SESSION" ? `工作稿修订 ${event.revision ?? "—"}` : event.eventType === "INITIAL_BASELINE" ? "初始基线" : event.eventType;
    return <article key={`${event.eventType}-${event.id}`}><b>{label}</b><span>{event.createdAt}{event.actor_name_snapshot ? ` · ${event.actor_name_snapshot}` : ""}{event.grade ? ` · ${event.grade}` : ""}</span>{onRestore && source && <button type="button" disabled={restoring === event.id} onClick={() => { setRestoring(event.id); void onRestore({ sourceType: source, sourceId: event.id }).finally(() => setRestoring("")); }}>{restoring === event.id ? "正在恢复…" : "以此版本创建恢复稿"}</button>}</article>;
  }) : <p>尚无历史事件。</p>}</aside>;
}
