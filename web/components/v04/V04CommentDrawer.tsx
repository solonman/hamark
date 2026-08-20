"use client";

import styles from "./V04Surface.module.css";

const tasks = [
  { id: "comment-1", module: "第一模块｜脚本反写", subject: "桥段01｜画面内容", excerpt: "雨夜，一辆车驶入安静的住宅区……" },
  { id: "comment-2", module: "第二模块｜全片事实与核心判断", subject: "创意母题", excerpt: "欢迎回家" },
];

export default function V04CommentDrawer({ open, onClose, readOnly = false }: { open: boolean; onClose: () => void; readOnly?: boolean }) {
  if (!open) return null;
  return <aside className={styles.drawer} aria-label="全部批注任务"><header><h2>全部批注任务</h2><button onClick={onClose}>关闭</button></header>{tasks.map((task) => <article key={task.id}><b>{task.module}</b><strong>{task.subject}</strong><span>原文：{task.excerpt}</span><button type="button" onClick={() => document.getElementById(task.subject.includes("创意母题") ? "field-creativeMotif" : "module-1")?.scrollIntoView({ behavior: "smooth", block: "center" })}>定位科目</button>{!readOnly && <button type="button">添加批注（演示）</button>}</article>)}</aside>;
}
