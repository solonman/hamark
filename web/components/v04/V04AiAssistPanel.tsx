"use client";

import { useState } from "react";
import styles from "./V04Surface.module.css";

const suggestions = ["将“回家”定义为可被重复、换位的关系动作。", "补充门灯与车灯作为视听规则的证据链。"];

export default function V04AiAssistPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [generated, setGenerated] = useState(false);
  const [preview, setPreview] = useState("");
  if (!open) return null;
  return <aside className={styles.aiPanel} aria-label="AI 建议演示外壳"><header><div><small>AI MOCK · 不连接真实模型</small><h2>AI 建议</h2></div><button onClick={onClose}>关闭</button></header><section><b>当前上下文</b><p>第二模块｜创意母题与机制</p></section><label>向 AI 提问<textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：这段判断还缺什么证据？" /></label><button className={styles.primaryButton} onClick={() => setGenerated(true)}>生成多条建议</button>{generated && suggestions.map((item, index) => <article key={item}><b>建议 {index + 1}</b><p>{item}</p><div><button onClick={() => setPreview(`引用：${item}`)}>引用</button><button onClick={() => setPreview(`替换预览：${item}`)}>替换</button><button>忽略</button></div></article>)}{preview && <section className={styles.aiPreview}><b>人工确认前后预览</b><p>{preview}</p><button onClick={() => setPreview("")}>取消</button><button onClick={() => setPreview("已记录人工采纳来源（演示）")}>确认采纳</button></section>}</aside>;
}
