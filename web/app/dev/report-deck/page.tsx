import { notFound } from "next/navigation";
import { getDbClient } from "@/db";
import { requirePageUser } from "@/lib/current-user";
import { loadReportDetail } from "@/lib/report-server";
import DevReportDeckClient from "./DevReportDeckClient";

/**
 * 开发用预览页：只在本机开发环境开放，直接读红谷滩 demo 报告（50 页）的
 * 页图，交给客户端组件用本地 state 承载 annotation 渲染 `ReportDeck`。
 * 不接版本链／保存／评审这些外壳职责——那是 `ReportStudioClient` 的事；
 * 这里单纯是给我自己和验收人用真实鼠标测交互的地方。
 *
 * 直接调 `loadReportDetail`（跟 `GET /api/reports/[id]` 内部用的是同一个
 * 函数）而不是自己发 fetch 打那个接口，省一次同源 cookie 转发的麻烦；
 * 数据形状与真正接口完全一致。
 */
const DEMO_REPORT_ID = "rpt-honggutan-demo";

export default async function DevReportDeckPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  const user = await requirePageUser("/dev/report-deck");
  const report = await loadReportDetail(getDbClient(), DEMO_REPORT_ID);
  if (!report || !report.pages.length) notFound();

  return (
    <DevReportDeckClient
      pages={report.pages}
      reportTitle={report.title}
      viewerName={user.displayName}
    />
  );
}
