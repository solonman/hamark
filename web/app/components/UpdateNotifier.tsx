"use client";

import { useEffect, useState } from "react";
import {
  HOME_NAVIGATION_EVENT,
  isProtectedDraftWorkspacePath,
  type HomeNavigationEventDetail,
} from "./GlobalHomeButton";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
// 非工作稿页没有页面接管时的短延迟。工作稿绝不走此回退：
// 它必须等自己的唯一保存协调器显式续行。
const AUTOSAVE_FLUSH_DELAY_MS = 2500;
// 练习页接管保存后若一直没刷新（例如保存失败留在原页），恢复按钮供重试。
const RELOAD_TAKEOVER_TIMEOUT_MS = 10 * 1000;

export default function UpdateNotifier({ version }: { version: string }) {
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!version || version === "dev" || updateReady) return;
    let cancelled = false;
    let lastCheckedAt = 0;

    async function check() {
      if (cancelled || document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastCheckedAt < MIN_CHECK_GAP_MS) return;
      lastCheckedAt = now;
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { version?: string };
        if (
          !cancelled &&
          data.version &&
          data.version !== "dev" &&
          data.version !== version
        ) {
          setUpdateReady(true);
        }
      } catch {
        // 网络波动时静默跳过，下个周期再查。
      }
    }

    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    function handleVisibility() {
      if (document.visibilityState === "visible") void check();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [updateReady, version]);

  function reloadForUpdate() {
    if (reloading) return;
    setReloading(true);
    const reload = () => window.location.reload();
    const navigationEvent = new CustomEvent<HomeNavigationEventDetail>(
      HOME_NAVIGATION_EVENT,
      { cancelable: true, detail: { continueNavigation: reload } },
    );
    const navigationWasNotTakenOver = window.dispatchEvent(navigationEvent);
    const v04WorkspaceMustTakeOver = isProtectedDraftWorkspacePath(window.location.pathname) &&
      Boolean(document.querySelector('[data-v04-page="workspace"]'));
    if (navigationWasNotTakenOver && !v04WorkspaceMustTakeOver) {
      window.setTimeout(reload, AUTOSAVE_FLUSH_DELAY_MS);
    } else {
      // A workspace must explicitly call continueNavigation after its single
      // save coordinator confirms the latest edit. The timeout only restores
      // this button after a failed/cancelled takeover; it never reloads.
      window.setTimeout(() => setReloading(false), RELOAD_TAKEOVER_TIMEOUT_MS);
    }
  }

  if (!updateReady || dismissed) return null;

  return (
    <div className="update-toast" role="status">
      <div>
        <strong>应用有新版本</strong>
        <span>刷新即可使用；未保存的草稿会先自动保存。</span>
      </div>
      <div className="update-toast-actions">
        <button
          className="button button-accent compact"
          type="button"
          onClick={reloadForUpdate}
          disabled={reloading}
        >
          {reloading ? "正在保存并刷新…" : "立即刷新"}
        </button>
        <button
          className="button button-ghost compact"
          type="button"
          onClick={() => setDismissed(true)}
          disabled={reloading}
        >
          稍后
        </button>
      </div>
    </div>
  );
}
