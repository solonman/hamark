"use client";

import type { V04UiCase } from "@/lib/v04-ui-model";
import styles from "./V04Surface.module.css";

export default function V04HistoryDrawer({ item, open, onClose }: { item: V04UiCase; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <aside className={styles.drawer} aria-label="历史版本"><header><h2>历史版本</h2><button onClick={onClose}>关闭</button></header><p>恢复只会创建新的工作稿，不覆盖旧提交或专家优选。</p>{item.submissions.length ? item.submissions.toReversed().map((submission) => <article key={submission.id}><b>不可变提交 V{submission.versionNumber}</b><span>{submission.submittedAt} · {submission.submittedBy}</span><button type="button">查看详情</button><button type="button">以此版本恢复（演示）</button></article>) : <p>尚无提交历史。</p>}</aside>;
}
