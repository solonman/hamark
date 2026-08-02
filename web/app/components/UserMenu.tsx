"use client";

import { useState } from "react";

export type UserMenuUser = {
  displayName: string;
  avatarUrl: string | null;
  departmentName: string | null;
};

export default function UserMenu({ user }: { user: UserMenuUser }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const initial = user.displayName.trim().charAt(0).toUpperCase() || "U";

  async function logout() {
    setPending(true);
    const response = await fetch("/api/auth/logout", { method: "POST" });
    const data = (await response.json().catch(() => ({}))) as { redirectTo?: string };
    window.location.assign(data.redirectTo ?? "/login");
  }

  return (
    <div className="user-menu">
      <button
        className="user-menu-trigger"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" />
        ) : (
          <span>{initial}</span>
        )}
        <strong>{user.displayName}</strong>
      </button>
      {open ? (
        <div className="user-menu-popover">
          <p>{user.departmentName ?? "企业微信成员"}</p>
          <button type="button" onClick={logout} disabled={pending}>
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  );
}
