"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { formatRetroClock, type RetroSource } from "@/lib/retro-model";
import {
  describeRetroRoundMarks,
  describeRetroSource,
  uniqueRetroSources,
  type RetroRoundMark,
  type RetroSourceContext,
  type RetroSourceView,
} from "@/lib/retro-ui";
import v04 from "../v04/V04Surface.module.css";
import styles from "./Retro.module.css";

export type RetroListenHandler = (view: RetroSourceView) => boolean;
export type RetroRoundJumpHandler = (mark: RetroRoundMark) => boolean;

/**
 * 出处标记与浮层（规格 6.7）：每一条带出处的内容后面跟一个或几个小标记，形如「案例 2 · 12:40」「总结 · 03:15」「客户录音 · 00:42」；
 * 点标记弹出小浮层列出被引用的句子（说话人、时间点、原文），底部「去听原声」跳到案例页并从这个时间点开始播放；
 * 引用了回合的再加一个「第二版」标记，点击跳到案例页的那一回合。
 * 标记文字由 formatRetroSourceLabel 拼出（lib/retro-ui 的 describeRetroSource）；原文来自发布时冻结的快照，录音以后被移除照样能看。
 * onListen／onRoundJump 返回 true 表示当前页自己处理了（比如案例页上的「在本月纪要里」就在本页跳转），否则走路由跳转。
 */
export function RetroSourceMarks({
  sources,
  ctx,
  onListen,
  onRoundJump,
}: {
  sources: readonly RetroSource[];
  ctx: RetroSourceContext;
  onListen?: RetroListenHandler;
  onRoundJump?: RetroRoundJumpHandler;
}): JSX.Element | null {
  const router = useRouter();
  const [open, setOpen] = useState<{ key: string; left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 标记已在浏览器挂载，SSR 期间没有 document（同 DeleteConfirmDialog）
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target)) return;
      for (const button of buttonRefs.current.values()) if (button.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const button = buttonRefs.current.get(open.key);
      close();
      button?.focus();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // 浮层出现后把焦点放到「去听原声」。
  useEffect(() => {
    if (open) popRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [open]);

  const unique = uniqueRetroSources(sources);
  const views = unique.map((source) => ({ source, markId: `${describeRetroSource(source, ctx).key}#${source.segmentIds.join(",")}`, view: describeRetroSource(source, ctx) }));
  const roundMarks = unique.flatMap((source) => describeRetroRoundMarks(source, ctx));
  const dedupedRounds = roundMarks.filter((mark, index) => roundMarks.findIndex((other) => other.roundId === mark.roundId) === index);
  if (!views.length && !dedupedRounds.length) return null;

  const current = open ? views.find((entry) => entry.markId === open.key) : undefined;

  function toggle(key: string, button: HTMLButtonElement) {
    if (open?.key === key) { setOpen(null); return; }
    const rect = button.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    // 先放在按钮下方；放不下（离窗口底部太近）就翻到上面。高度未知，按 220 估算，渲染后不再调整。
    const below = rect.bottom + 6;
    const top = below + 220 > window.innerHeight - 12 ? Math.max(12, rect.top - 226) : below;
    setOpen({ key, left, top });
  }

  function listen(view: RetroSourceView) {
    setOpen(null);
    if (onListen?.(view)) return;
    router.push(view.href);
  }

  return (
    <>
      {views.map(({ view, markId }) => (
        <button
          key={markId}
          type="button"
          className={styles.srcMark}
          aria-haspopup="dialog"
          aria-expanded={open?.key === markId}
          title={view.title}
          ref={(node) => { if (node) buttonRefs.current.set(markId, node); else buttonRefs.current.delete(markId); }}
          onClick={(event) => toggle(markId, event.currentTarget)}
        >
          {view.label}
        </button>
      ))}
      {dedupedRounds.map((mark) => (
        mark.href ? (
          <Link
            key={mark.roundId}
            href={mark.href}
            className={styles.roundMark}
            title="跳到案例里的这一回合"
            onClick={(event) => { if (onRoundJump?.(mark)) event.preventDefault(); }}
          >
            {mark.label}
          </Link>
        ) : <span key={mark.roundId} className={styles.roundMark}>{mark.label}</span>
      ))}
      {open && current && mounted ? createPortal(
        <div className={v04.surface} style={{ display: "contents" }}>
          <div className={styles.root} style={{ display: "contents" }}>
            <div ref={popRef} className={styles.srcPop} role="dialog" aria-label="出处原话" style={{ left: open.left, top: open.top }}>
              <h4>{current.view.heading}</h4>
              {current.view.quotes.length ? current.view.quotes.map((quote) => (
                <div className={styles.quote} key={quote.segmentId}>
                  <QuoteRow speaker={quote.speakerLabel} clock={formatRetroClock(quote.startMs)} text={quote.text} />
                </div>
              )) : (
                <div className={styles.quote}><QuoteRow speaker="—" clock="" text="这个片段不存在。" /></div>
              )}
              <footer>
                <button type="button" className={v04.reviewPrimaryButton} onClick={() => listen(current.view)}>去听原声 →</button>
              </footer>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function QuoteRow({ speaker, clock, text }: { speaker: string; clock: string; text: string }): JSX.Element {
  return (
    <>
      <span><b>{speaker}</b>{clock}</span>
      <p>{text}</p>
    </>
  );
}
