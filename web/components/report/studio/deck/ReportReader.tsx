"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReportPageView } from "@/lib/report-model";
import styles from "./ReportDeck.module.css";
import type { ReportReaderButtonProps } from "./deck-types";

/**
 * "查看报告"：按钮 + 整本报告的只读预览 modal——所有页按页序纵向排成一列的
 * 原图，页下居中标页码，纯浏览，不带任何标注入口（跟 `ReportPageModal` 不
 * 是一回事：那个是"点开单页去标注"，这个是"整本从头看到尾"）。
 *
 * 跟 `ReportMindMapButton`（`./ReportMindMap`）同一个骨架，两处理由也一样：
 * 触发按钮留在外壳的 PART 03 标题栏原位，够不着 `ReportDeck` 自己的 `.root`
 * 子树，`--rd-*` 那套变量摸不到，单独包一层 `.root` 补上；`.ov` 遮罩
 * `createPortal` 到 `document.body`（同样要再套一层 `.root`，原因见
 * `ReportMindMap.tsx` 顶部注释——真实工作台标题栏的 `backdrop-filter` 会给
 * 后代重新建立一个 `position:fixed` 的包含块，不 portal 会被那层矩形关住）；
 * Esc 关闭、打开时锁 body 滚动，两个全屏浮层保持一致。
 *
 * 外框直接复用页面 modal 的 `.ov`/`.ovbox`（`ReportPageModal.tsx` 同一套
 * 类，`.ovbox` 本来就是 flex-column，内容区自己 `flex:1`+`overflow:auto`
 * 接上就是一个可滚动主体，不用再起一层新外壳）；内容区是单栏纵向滚动，不进
 * `.ovmain`/`.ovside` 那套左右分栏，另起一套 `.reader*` 类。
 */

/**
 * 每页的大图——生产每张约 1600 宽，50 页全部立即加载会在打开的头几秒糊一屏
 * 黑块，所以用 `loading="lazy"`，滚到哪加载到哪。这条在 `ReportDeck.tsx` 的
 * `thumbImg` 踩过一次坑：没有高度的图，浏览器永远判不出"进了视口"，
 * `loading="lazy"` 会直接卡死不加载。这里不会重蹈覆辙——量得出真实像素尺寸
 * 时标上 `width`/`height` 属性，浏览器照属性自己算 `aspect-ratio`；量不出
 * 尺寸的退回 CSS 占位比例（`.readerPage img:not([width]):not([data-loaded])`），
 * `onLoad` 后打 `data-loaded` 摘掉。两种情况加载前都有非零高度，`lazy` 对
 * 两者都安全，不用再按 `known` 分流。缩略图（`ReportDeck.tsx` 的 `thumbImg`）
 * 不动：那边张数少（一份报告的页数）、图也小，全量立即加载本来就是有意的
 * 选择，不跟着这里改。
 */
function readerPageImg(p: ReportPageView) {
  const known = p.width > 0 && p.height > 0;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 本地对象存储签名 URL，不适用 next/image 远程域名白名单
    <img
      src={p.largeUrl ?? undefined}
      alt=""
      draggable={false}
      width={known ? p.width : undefined}
      height={known ? p.height : undefined}
      loading="lazy"
      onLoad={(event) => { event.currentTarget.dataset.loaded = "1"; }}
    />
  );
}

export function ReportReaderButton({ pages, reportTitle }: ReportReaderButtonProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const close = () => setOpen(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记"已经在浏览器挂载"，SSR 期间没有更早的时机能做这件事（同类见 ReportMindMap.tsx）
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 打开时锁住 body 的滚动——理由同 `ReportMindMapButton`：`.ov` 铺满视口但
  // 本身不滚动，划到页图以外的地方滚轮会一路冒泡到身后的工作台。↑↓／
  // PageUp／PageDown 不用另外接，锁住 body 之后它们默认就是滚 `.readerBody`
  // （页面上唯一还能滚的容器）。
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // 没有页可看就不露这个按钮——跟脑图"没结构就不露"一个道理。
  if (!pages.length) return null;

  const sortedPages = [...pages].sort((a, b) => a.pageNo - b.pageNo);

  const modal = open ? (
    <div className={styles.ov} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className={styles.ovbox} role="dialog" aria-label={`查看报告：${reportTitle}`}>
        <div className={styles.ovhead}>
          <b>查看报告</b>
          <span className={styles.readerTitle}>{reportTitle} · {sortedPages.length} 页</span>
          <button type="button" className={styles.smBtn} onClick={close}>关闭 esc</button>
        </div>
        <div className={styles.readerBody}>
          {sortedPages.map((p) => {
            const failed = p.renderStatus !== "OK" || !p.largeUrl;
            return (
              <div key={p.pageNo} className={styles.readerPage}>
                {failed ? <div className={styles.pcFail}>该页渲染失败</div> : readerPageImg(p)}
                <b className={styles.readerPageNo}>p{String(p.pageNo).padStart(2, "0")}</b>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <span className={styles.root}>
        <button
          type="button"
          className={`${styles.smBtn} ${styles.smBtnIcon}`}
          title="按页序浏览整本报告的原始页图"
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 1.5h5.5L12.5 4.5V14.5H4z" />
            <path d="M9.5 1.5V4.5H12.5" />
            <path d="M6 8h4M6 10.5h4" />
          </svg>
          查看报告
        </button>
      </span>
      {modal && mounted
        ? createPortal(<div className={styles.root}>{modal}</div>, document.body)
        : null}
    </>
  );
}

export default ReportReaderButton;
