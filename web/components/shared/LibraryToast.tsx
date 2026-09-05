"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import v04 from "@/components/v04/V04Surface.module.css";
import styles from "./LibraryToast.module.css";

/**
 * 首页两个库共用的浮层提示：固定在视口底部居中，到点自己消失，可以叠好几条。
 *
 * 原来只有报告库一份（components/report/library/ReportToast.tsx，服务
 * 「点了还没就绪的卡片」那一处），现在视频库也要用——票投完了这种「这一下
 * 没生效」的话，必须出现在用户眼前。原先它写在页面顶部的提示条里，用户
 * 正在页面深处点卡片，那条横幅在屏幕外，等于没提示。做法照
 * components/shared/DeleteConfirmDialog.tsx 的先例：提炼到 shared，
 * portal 到 body，外面套一层 `.surface` 把颜色 token 带过去
 * （token 只定义在 `.surface` 上，portal 出去就够不着了）。
 */
export type LibraryToastItem = { id: number; message: string; tone: "plain" | "warn" };

/** demo 的 2.8 秒（demo 第 251 行）；要读一句「先取消一票再投别的」就得给久一点。 */
const DEFAULT_DURATION_MS = 2800;
const WARN_DURATION_MS = 4200;

export function useLibraryToast() {
  const [toasts, setToasts] = useState<LibraryToastItem[]>([]);
  const nextId = useRef(0);
  /** 此刻挂在屏幕上的那几句话。用 ref 而不是读 toasts，连点几下也是同一份最新的。 */
  const showing = useRef(new Set<string>());

  const notify = useCallback((message: string, tone: "plain" | "warn" = "plain") => {
    // 同一句话还在屏幕上就不再叠一条：连点三下第四票，堆出三条一模一样的提示
    // 只是把屏幕占掉，没有多告诉用户任何事。原来那条按自己的时间正常消失。
    if (showing.current.has(message)) return;
    showing.current.add(message);
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      showing.current.delete(message);
      setToasts((current) => current.filter((item) => item.id !== id));
    }, tone === "warn" ? WARN_DURATION_MS : DEFAULT_DURATION_MS);
  }, []);

  return { toasts, notify };
}

export function LibraryToastStack({ toasts }: { toasts: LibraryToastItem[] }) {
  if (!toasts.length || typeof document === "undefined") return null;
  return createPortal(
    <div className={v04.surface} style={{ display: "contents" }}>
      <div className={styles.toastStack} role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <div key={item.id} className={item.tone === "warn" ? styles.warn : undefined}>
            {item.message}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
