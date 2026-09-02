import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getDbClient } from "@/db";
import { isAppAdmin } from "@/lib/admin";
import { requirePageUser } from "@/lib/current-user";
import { isReportFeatureEnabled, canManageReport } from "@/lib/report-model";
import { loadReportDetail } from "@/lib/report-server";
import { detectV04LegacyBrowser } from "@/lib/v04-browser-compat";
import V04BrowserCompatibilityGate from "@/components/v04/V04BrowserCompatibilityGate";
import V04BrowserCompatibilityMessage from "@/components/v04/V04BrowserCompatibilityMessage";
import ReportStudioClient from "@/components/report/studio/ReportStudioClient";
import ReportStatusPage from "@/components/report/studio/ReportStatusPage";

export const metadata: Metadata = {
  title: "报告拆解工作台",
};

/**
 * `/reports/[id]`：报告拆解工作台的路由外壳。门禁与状态分支照抄
 * `app/videos/[id]/page.tsx`（同一套 `V04BrowserCompatibilityGate`／旧浏览器判定），
 * 只是把「V0.4 灰度」换成报告库自己的开关；报告没有视频那样的编辑权限分层，
 * 能看见工作台的人都能在自己的版本上编辑（规格 2.4／五）。
 */
export default async function ReportStudioPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isReportFeatureEnabled()) notFound();

  const { id } = await params;
  const user = await requirePageUser(`/reports/${encodeURIComponent(id)}`);

  const report = await loadReportDetail(getDbClient(), id);
  if (!report) notFound();

  const libraryHref = "/?library=REPORT";

  if (report.status !== "READY") {
    const isAdmin = await isAppAdmin(user);
    const canManage = canManageReport({ createdByEmail: report.createdByEmail }, {
      identityKey: user.identityKey,
      isAdmin,
    });
    return <ReportStatusPage reportId={id} initialReport={report} canManage={canManage} libraryHref={libraryHref} />;
  }

  const requestHeaders = await headers();
  if (detectV04LegacyBrowser(requestHeaders.get("user-agent") ?? "")) {
    return <V04BrowserCompatibilityMessage mode="EDIT" />;
  }

  return (
    <V04BrowserCompatibilityGate mode="EDIT">
      <ReportStudioClient
        reportId={id}
        initialReport={report}
        viewerName={user.displayName}
        navigation={{ libraryHref }}
      />
    </V04BrowserCompatibilityGate>
  );
}
