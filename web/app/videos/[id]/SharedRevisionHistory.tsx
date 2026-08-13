"use client";

import { useEffect, useMemo, useState } from "react";
import { formatLongDate } from "@/lib/date-format";

type Revision = {
  id: string;
  changeSetId: string;
  baseRevision: number;
  appliedRevision: number;
  targetKey: string;
  targetLabel: string;
  valueType: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  actorName: string;
  createdAt: string;
};

function displayValue(value: unknown) {
  if (Array.isArray(value)) return value.join(" · ") || "（空）";
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "") || "（空）";
}

export default function SharedRevisionHistory({ videoId }: { videoId: string }) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`/api/videos/${videoId}/collaboration-revisions`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { revisions?: Revision[]; error?: string };
        if (!response.ok) throw new Error(data.error || "共享修订历史读取失败");
        if (active) setRevisions(data.revisions ?? []);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "共享修订历史读取失败");
      });
    return () => { active = false; };
  }, [videoId]);

  const changeSets = useMemo(() => {
    const groups = new Map<string, Revision[]>();
    for (const revision of revisions) {
      const current = groups.get(revision.changeSetId) ?? [];
      current.push(revision);
      groups.set(revision.changeSetId, current);
    }
    return [...groups.values()];
  }, [revisions]);

  return (
    <details className="shared-revision-history">
      <summary>共享修订记录 · {changeSets.length} 次保存 / {revisions.length} 项变化</summary>
      {error ? <p className="review-notice error">{error}</p> : null}
      <div className="shared-revision-list">
        {changeSets.map((changes) => {
          const first = changes[0];
          return (
            <article key={first.changeSetId}>
              <header>
                <strong>{first.actorName}</strong>
                <span>rev {first.baseRevision} → rev {first.appliedRevision}</span>
                <time>{formatLongDate(first.createdAt)}</time>
              </header>
              {changes.map((change) => (
                <div className="shared-revision-change" key={change.id}>
                  <strong>{change.targetLabel}</strong>
                  <p><span>修订前</span>{displayValue(change.beforeValue)}</p>
                  <p><span>修订后</span>{displayValue(change.afterValue)}</p>
                  {change.reason ? <small>原因：{change.reason}</small> : null}
                </div>
              ))}
            </article>
          );
        })}
        {!changeSets.length && !error ? <p>当前还没有共享修订事件。</p> : null}
      </div>
    </details>
  );
}
