import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/current-user";
import { isRetroFeatureEnabled } from "@/lib/retro-model";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import RetroCaseClient from "@/components/retro/RetroCaseClient";

export const metadata: Metadata = {
  title: "客户需求复盘库",
};

/**
 * `/retro/[id]`：客户需求复盘库案例页的路由外壳。开关先查、门禁其次，照
 * `app/visual/[id]/page.tsx`——总开关关着时接口一律 404，页面也不例外。
 * 案例页有原位编辑，但每次失焦就存，没有需要整页保护的草稿，旧浏览器门禁用只读那一套（mode="READ"，同公共视觉库）。
 */
export default async function RetroCasePage({ params }: { params: Promise<{ id: string }> }) {
  if (!isRetroFeatureEnabled()) notFound();

  const { id } = await params;
  const user = await requirePageUser(`/retro/${encodeURIComponent(id)}`);

  const requestHeaders = await headers();
  if (detectV04LegacyBrowser(requestHeaders.get("user-agent") ?? "")) {
    return <V04BrowserCompatibilityMessage mode="READ" />;
  }

  const userView = {
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    departmentName:
      user.departments.find((item) => item.isPrimary)?.name ??
      user.departments[0]?.name ??
      null,
  };

  return (
    <V04BrowserCompatibilityGate mode="READ">
      <RetroCaseClient caseId={id} viewerName={user.displayName} user={userView} />
    </V04BrowserCompatibilityGate>
  );
}
