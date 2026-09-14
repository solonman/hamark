"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  THEME_CHANNEL,
  themeCookie,
  parseThemePreference,
  themePreferenceFromCookieHeader,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 换主题的那一帧先关掉全部过渡：页面上不少按钮带 background/color 过渡，
 * 不关的话整页颜色会参差不齐地「渐变」过去，像是闪了一下。
 */
function withoutTransitions(change: () => void) {
  const style = document.createElement("style");
  style.appendChild(document.createTextNode("*,*::before,*::after{transition:none!important}"));
  document.head.appendChild(style);
  change();
  // 强制算一次样式，让新颜色在无过渡的状态下落定，再撤掉这条规则。
  void window.getComputedStyle(document.body).opacity;
  window.setTimeout(() => style.remove(), 1);
}

export function ThemeProvider({
  initialPreference,
  children,
}: {
  initialPreference: ThemePreference;
  children: React.ReactNode;
}) {
  const [preference, setPreferenceState] = useState(initialPreference);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const apply = useCallback((next: ThemePreference) => {
    if (document.documentElement.dataset.theme !== next) {
      withoutTransitions(() => {
        document.documentElement.dataset.theme = next;
      });
    }
    setPreferenceState(next);
  }, []);

  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(THEME_CHANNEL);
    if (channel) channel.onmessage = (event) => apply(parseThemePreference(String(event.data)));
    channelRef.current = channel;
    // 从往返缓存里恢复的页面收不到广播，回来时对一下 cookie。
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) apply(themePreferenceFromCookieHeader(document.cookie));
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      channel?.close();
      channelRef.current = null;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [apply]);

  const setPreference = useCallback((next: ThemePreference) => {
    document.cookie = themeCookie(next, { secure: window.location.protocol === "https:" });
    apply(next);
    channelRef.current?.postMessage(next);
  }, [apply]);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePreference(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useThemePreference must be used inside <ThemeProvider>.");
  return value;
}
