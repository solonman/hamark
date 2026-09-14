"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useThemePreference } from "@/app/components/ThemeProvider";
import { THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from "@/lib/theme";
import styles from "./ThemeSwitcher.module.css";

function ThemeIcon({ kind }: { kind: ThemePreference }) {
  if (kind === "light") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="2.9" />
        <path d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M3.3 12.7l1.1-1.1M11.6 4.4l1.1-1.1" />
      </svg>
    );
  }
  if (kind === "dark") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.4 10.1A5.6 5.6 0 0 1 5.9 2.6a5.6 5.6 0 1 0 7.5 7.5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.8" y="2.6" width="12.4" height="8.6" rx="1.4" />
      <path d="M5.6 14h4.8M8 11.2V14" />
    </svg>
  );
}

/**
 * 顶栏里的外观开关：浅色／深色／跟随系统。
 * 做成三选一的菜单而不是来回切的单个按钮——点一下循环切换的开关看不出下一步是什么，
 * 也藏住了「跟随系统」这一档。选中后立即生效，偏好由 ThemeProvider 写进 cookie。
 */
export default function ThemeSwitcher() {
  const { preference, setPreference } = useThemePreference();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    itemRefs.current[THEME_PREFERENCES.indexOf(preference)]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, preference]);

  function moveFocus(event: React.KeyboardEvent, index: number) {
    const count = THEME_PREFERENCES.length;
    const next = {
      ArrowDown: (index + 1) % count,
      ArrowUp: (index - 1 + count) % count,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  }

  function choose(option: ThemePreference) {
    setPreference(option);
    setOpen(false);
    triggerRef.current?.focus();
  }

  const label = `外观：${THEME_LABELS[preference]}`;
  return (
    <div className={styles.root} ref={rootRef} data-theme-switcher>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <ThemeIcon kind={preference} />
      </button>
      {open ? (
        <div className={styles.popover}>
          <p className={styles.heading} aria-hidden="true">外观</p>
          <div id={menuId} role="menu" aria-label="外观">
            {THEME_PREFERENCES.map((option, index) => (
              <button
                key={option}
                ref={(element) => { itemRefs.current[index] = element; }}
                type="button"
                role="menuitemradio"
                aria-checked={preference === option}
                className={styles.option}
                onKeyDown={(event) => moveFocus(event, index)}
                onClick={() => choose(option)}
              >
                <ThemeIcon kind={option} />
                <span>
                  {THEME_LABELS[option]}
                  {option === "system" ? <small>按电脑的深浅设置自动切换</small> : null}
                </span>
                {preference === option ? <b aria-hidden="true">✓</b> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
