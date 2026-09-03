"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import v04 from "@/components/v04/V04Surface.module.css";
import styles from "./library/ReportLibrary.module.css";

/**
 * 「删除报告」的弹出式确认对话框：报告库卡片（ReportCard.tsx）与拆解工作台页头
 * （ReportStudioClient.tsx）两处入口共用这一个组件——原先各自内联一条复用
 * V04Surface.module.css `.recoveryBanner` 的页内确认条，现在改成居中 modal +
 * 遮罩，外观复用报告库上传对话框同一套壳（ReportLibrary.module.css 的
 * uploadBackdrop/uploadDialog/uploadHead/uploadBody/uploadFooter，见
 * ReportUploadDialog.tsx），只新增 `.deleteDialog*` 三个专属类（窄一点的宽度、
 * 说明行的字号颜色、确认按钮的强调色）。
 *
 * 跟 ReportMindMap.tsx / ReportReader.tsx 同一个骨架：`.ov` 换成这里的
 * `.uploadBackdrop`，理由一样——工作台页头 `.siteHeader` 是
 * `position:sticky` 且带 `backdrop-filter`（V04Surface.module.css 第 86～91
 * 行），会给它的后代重新建立一个 `position:fixed` 的包含块，不 portal 到
 * `document.body` 的话，遮罩会被页头这层矩形关住；SSR 阶段没有
 * `document`，`mounted` 挂载后才第一次真正 portal。
 *
 * 调用方始终渲染这个组件（用 `open` 控制显隐，不是条件挂载/卸载），这样
 * Esc／锁滚动／焦点这几个 effect 可以按 `open` 变化正常追踪；`!open` 时最终
 * 渲染 `null`，不会往 DOM 里插入任何东西。
 */
export default function ReportDeleteDialog({
  open,
  title,
  lines,
  error,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** 报告标题，拼进「把《…》移入回收站？」这句里。 */
  title: string;
  /** 正文说明，每条一行；工作台两行，报告库一行，文案由调用方给。 */
  lines: string[];
  /** 最近一次删除失败的原因，空字符串表示没出错。 */
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

  // 打开时锁住 body 的滚动——理由同 ReportReader.tsx：遮罩铺满视口但本身不滚动，
  // 划到对话框以外的地方滚轮会一路冒泡到身后的列表/工作台。
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
          <div><small>DELETE</small><b id={titleId}>删除报告</b></div>
          {/* 跟 ReportUploadDialog 上传中同一个道理：提交阶段整个不渲染关闭按钮，不是留着但点不动。 */}
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
