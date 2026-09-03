"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import v04 from "@/components/v04/V04Surface.module.css";
import styles from "./DeleteConfirmDialog.module.css";

/**
 * 通用的「删除确认」弹出式对话框：原来只有报告线一份
 * （components/report/ReportDeleteDialog.tsx，报告库卡片与拆解工作台页头两处
 * 入口共用），现在提炼成 components/shared 下的共享组件——视频侧二合一工作台
 * 页头的「删除案例」、以及只读成果页那条内联确认条，都改接这一个组件，三条线
 * 不再各自维护一份同构的壳。外观仍是原来那套（居中 modal + 遮罩，复用报告库
 * 上传对话框同一套壳的类名，只是现在这些类挪进了这个组件自己的
 * DeleteConfirmDialog.module.css，不再依赖 ReportLibrary.module.css）。
 *
 * 眉题固定 DELETE；标题（`heading`，如"删除报告"/"删除案例"）与正文首行的
 * 作品名（`title`，拼进「把《…》移入回收站？」）都由调用方给。
 *
 * 跟 ReportMindMap.tsx / ReportReader.tsx 同一个骨架：portal 到
 * `document.body`，理由一样——工作台页头 `.siteHeader` 是 `position:sticky`
 * 且带 `backdrop-filter`，会给它的后代重新建立一个 `position:fixed` 的包含块，
 * 不 portal 到 `document.body` 的话，遮罩会被页头这层矩形关住；SSR 阶段没有
 * `document`，`mounted` 挂载后才第一次真正 portal。
 *
 * 调用方始终渲染这个组件（用 `open` 控制显隐，不是条件挂载/卸载），这样
 * Esc／锁滚动／焦点这几个 effect 可以按 `open` 变化正常追踪；`!open` 时最终
 * 渲染 `null`，不会往 DOM 里插入任何东西。
 */
export default function DeleteConfirmDialog({
  open,
  heading,
  title,
  lines,
  error,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** 弹窗标题，如"删除报告"/"删除案例"。 */
  heading: string;
  /** 报告/案例标题，拼进「把《…》移入回收站？」这句里。 */
  title: string;
  /** 正文说明，每条一行；行数由调用方决定（报告库卡片一行，两处工作台各两行）。 */
  lines: string[];
  /** 最近一次删除失败的原因，空字符串/undefined 表示没出错。 */
  error?: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记"已经在浏览器挂载"，SSR 期间没有更早的时机能做这件事（同类见 ReportMindMap.tsx/ReportReader.tsx）
  useEffect(() => { setMounted(true); }, []);

  // Esc 关闭；正在提交时不关，跟遮罩点击、× 按钮的门禁保持一致。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending, onCancel]);

  // 打开时锁住 body 的滚动——遮罩铺满视口但本身不滚动，划到对话框以外的地方
  // 滚轮会一路冒泡到身后的列表/工作台。
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // 打开时把焦点放到「取消」按钮——不可逆的破坏性操作，默认焦点不该落在会
  // 提交请求的那个按钮上；提交中（pending）两个按钮都是 disabled，不用再抢焦点。
  useEffect(() => {
    if (open && mounted && !pending) cancelRef.current?.focus();
  }, [open, mounted, pending]);

  if (!open || !mounted) return null;

  // portal 到 body 之后就出了 V04 的 `.surface` 子树，`--v04-panel`/`--v04-accent`
  // 这些 token 全部摸不到（它们只定义在 `.surface` 上）——实测弹窗盒子变透明、
  // 确认按钮文字变成近黑。再套一层 `.surface` 把 token 带过来，`display: contents`
  // 让这层不生成盒子，`.surface` 自带的 min-height/背景不会在 body 底下多画一块。
  return createPortal(
    <div className={v04.surface} style={{ display: "contents" }}>
    <div
      className={styles.uploadBackdrop}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel(); }}
    >
      <section
        className={`${styles.uploadDialog} ${styles.deleteDialog}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.uploadHead}>
          <div><small>DELETE</small><b id={titleId}>{heading}</b></div>
          {/* 提交阶段整个不渲染关闭按钮，不是留着但点不动。 */}
          {pending ? null : (
            <button type="button" className={styles.uploadClose} onClick={onCancel} aria-label="关闭删除确认窗口">×</button>
          )}
        </div>
        <div className={styles.uploadBody}>
          <b>把《{title}》移入回收站？</b>
          {lines.map((line, index) => <span key={index} className={styles.deleteDialogLine}>{line}</span>)}
          {error ? <p className={styles.formError} role="alert">{error}</p> : null}
        </div>
        <div className={styles.uploadFooter}>
          <button type="button" ref={cancelRef} disabled={pending} onClick={onCancel}>取消</button>
          <button type="button" className={styles.deleteDialogConfirm} disabled={pending} onClick={onConfirm}>
            {pending ? "正在移入回收站…" : "确认移入回收站"}
          </button>
        </div>
      </section>
    </div>
    </div>,
    document.body,
  );
}
