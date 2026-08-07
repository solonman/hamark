"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const HOME_NAVIGATION_EVENT = "reverse:request-home-navigation";

export type HomeNavigationEventDetail = {
  continueNavigation: () => void;
};

export default function GlobalHomeButton() {
  const pathname = usePathname();
  const isHome = pathname === "/";

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
