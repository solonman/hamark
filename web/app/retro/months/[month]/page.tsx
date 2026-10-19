import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/current-user";
import { isRetroFeatureEnabled, isRetroMonthKey } from "@/lib/retro-model";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import RetroMonthClient from "@/components/retro/RetroMonthClient";

export const metadata: Metadata = {
  title: "客户需求复盘库",
};

/**
 * `/retro/months/[YYYY-MM]`：月份页的路由外壳。开关先查、月份格式其次、门禁最后；
 * 老孙在这里审阅草稿，但草稿的每次修改都即时存到服务端，没有本地未保存的内容，旧浏览器门禁同案例页用只读那一套。
 */
export default async function RetroMonthPage({ params }: { params: Promise<{ month: string }> }) {
  if (!isRetroFeatureEnabled()) notFound();

  const { month } = await params;
  if (!isRetroMonthKey(month)) notFound();
  const user = await requirePageUser(`/retro/months/${month}`);

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
      <RetroMonthClient monthKey={month} viewerName={user.displayName} user={userView} />
    </V04BrowserCompatibilityGate>
  );
}
