"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const HOME_NAVIGATION_EVENT = "reverse:request-home-navigation";

export type HomeNavigationEventDetail = {
  continueNavigation: () => void;
};

export function isProtectedDraftWorkspacePath(pathname: string) {
  return /^\/videos\/[^/]+\/practice(?:\/|$)/.test(pathname) ||
    /^\/v04-shadow\/videos\/[^/]+\/workspace(?:\/|$)/.test(pathname);
}

/**
 * V04 正式界面里已经在案例详情/工作台这一层的路径：logo 点一下就能回列表，浮动的
 * 「← 全部作品」按钮反而是多余的重复入口，这一层不显示它。视频库的详情页、练习页
 * 原来就认；报告库的拆解工作台（/reports/[id]，见 app/reports/[id]/page.tsx）之前
 * 漏判，浮钮在报告工作台里一直露着、跟视频工作台不一致——这里补上同一条规则。
 */
export function isFormalV04SurfacePath(pathname: string) {
  return pathname === "/" ||
    /^\/videos\/[^/]+(?:\/practice)?$/.test(pathname) ||
    /^\/reports\/[^/]+$/.test(pathname);
}

export default function GlobalHomeButton({ hideForV04Default = false }: { hideForV04Default?: boolean }) {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const isFormalV04Surface = isFormalV04SurfacePath(pathname);

  if (hideForV04Default && isFormalV04Surface) return null;

  return (
    <Link
      className={`global-home-button ${isHome ? "is-current" : ""}`}
      href="/"
      aria-current={isHome ? "page" : undefined}
      aria-label={isHome ? "全部作品首页" : "返回全部作品首页"}
      onClick={(event) => {
        if (isHome) return;
        const navigationEvent = new CustomEvent<HomeNavigationEventDetail>(
          HOME_NAVIGATION_EVENT,
          {
            cancelable: true,
            detail: {
              continueNavigation: () => window.location.assign("/"),
            },
          },
        );
        if (!window.dispatchEvent(navigationEvent)) event.preventDefault();
      }}
    >
      <span aria-hidden="true">{isHome ? "●" : "←"}</span>
      全部作品
    </Link>
  );
}
