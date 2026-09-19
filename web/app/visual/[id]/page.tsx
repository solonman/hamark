import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/current-user";
import { isVisualFeatureEnabled } from "@/lib/visual-contract";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import VisualCaseClient from "@/components/visual/VisualCaseClient";

export const metadata: Metadata = {
  title: "公共视觉库",
};

/**
 * `/visual/[id]`：公共视觉库案例详情的路由外壳。开关先查、门禁其次，照
 * `app/reports/[id]/page.tsx` 的先例——总开关关着时接口一律 404，页面也不例外；
 * 旧浏览器门禁与只读成果页同一套（mode="READ"，本页面没有可编辑草稿要保护）。
 */
export default async function VisualCasePage({ params }: { params: Promise<{ id: string }> }) {
  if (!isVisualFeatureEnabled()) notFound();

  const { id } = await params;
  const user = await requirePageUser(`/visual/${encodeURIComponent(id)}`);

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
      <VisualCaseClient caseId={id} viewerName={user.displayName} user={userView} />
    </V04BrowserCompatibilityGate>
  );
}
