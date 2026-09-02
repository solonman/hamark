"use client";

import { useCallback, useRef, useState } from "react";
import styles from "./ReportLibrary.module.css";

/**
 * demo 的 #toast（demo 第 106-107、172、251 行）：点一下还没就绪的卡片（封面或禁用态的
 * 「进入工作台」按钮）弹一句「页图还没生成好，先等一下。」，固定在页面底部居中，2.8 秒后
 * 自动消失，可以叠好几条。只服务报告库这一处交互，站内目前没有通用的 toast 组件，
 * 所以没有放进共享的 v04 模块，也不影响视频库。
 */
export type ReportToastItem = { id: number; message: string };

export function useReportToast() {
  const [toasts, setToasts] = useState<ReportToastItem[]>([]);
  const nextId = useRef(0);

  const notify = useCallback((message: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message }]);
    // demo：setTimeout(()=>d.remove(),2800) —— 到点自己摘掉，不用用户手动关。
    setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 2800);
  }, []);

  return { toasts, notify };
}

export function ReportToastStack({ toasts }: { toasts: ReportToastItem[] }) {
  if (!toasts.length) return null;
  return (
    <div className={styles.toastStack} aria-live="polite" aria-atomic="false">
      {toasts.map((item) => <div key={item.id}>{item.message}</div>)}
    </div>
  );
}
