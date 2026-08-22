import type { Metadata } from "next";
import { headers } from "next/headers";
import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requirePageUser } from "@/lib/current-user";
import { canAccessV04Surface } from "@/lib/v04-gray-access";
import V04LibraryClient from "@/components/v04/V04LibraryClient";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
import HomeClient from "./components/HomeClient";

export const metadata: Metadata = {
  title: "创意片库",
  description: "看片、拆片、交作业，让优秀作品成为团队共同的创意教材。",
};

export default async function Home() {
  const user = await requirePageUser("/");
  const isAdmin = await isAppAdmin(user);
  const v04DefaultEnabled = process.env.V04_DEFAULT_UI_ENABLED === "true";
  const v04LibraryEnabled = process.env.V04_LIBRARY_UI_ENABLED === "true"
    && await canAccessV04Surface(getDbClient(), user.id);
  const userView = {
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    departmentName:
      user.departments.find((item) => item.isPrimary)?.name ??
      user.departments[0]?.name ??
      null,
  };
  if (v04DefaultEnabled && v04LibraryEnabled) {
    const requestHeaders = await headers();
    if (detectV04LegacyBrowser(requestHeaders.get("user-agent") ?? "")) {
      return <V04BrowserCompatibilityMessage mode="READ" />;
    }
    return (
      <V04BrowserCompatibilityGate mode="READ">
        <V04LibraryClient
          viewerName={user.displayName}
          user={userView}
          isAdmin={isAdmin}
          formal
        />
      </V04BrowserCompatibilityGate>
    );
  }
  return (
    <HomeClient
      user={userView}
      isAdmin={isAdmin}
      v04LibraryEnabled={v04LibraryEnabled}
      v04DefaultEnabled={v04DefaultEnabled}
    />
  );
}
