// 数据万象文档转码完成后的回调入口。这条路由是给 CI 调的，不是给浏览器调的：
// 不要求登录、不走 requireSameOriginMutation 的同源守卫（同源守卫会拒掉所有跨站
// POST，CI 的服务器显然不是"同源"）。
//
// 安全模型：回调体不可信（谁都可以伪造一个 POST 打过来），所以这里不读回调体里的
// 任何"成功/失败"字段，只用它可能带的 JobId 当"查哪份报告"的线索；真正的结果一律
// 重新用 GET /doc_jobs/<jobId> 向数据万象权威查询（checkReportCiJobs 内部做的事）。
// 找不到对应报告、或处理过程出错，都直接回 200——不该让 CI 因为收到非 200 而重试
// 轰炸；反正兜底还有列表/详情接口的轮询。
import { getDbClient } from "@/db";
import { checkReportCiJobs, extractCallbackJobIdHint, findReportForCiCallback } from "@/lib/report-converter";

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  const rawBody = await request.text().catch(() => "");
  const jobIdHint = extractCallbackJobIdHint(rawBody);

  const db = getDbClient();
  try {
    const report = await findReportForCiCallback(db, { token, jobIdHint });
    if (report) {
      await checkReportCiJobs(db, {
        id: report.id,
        ciJobLarge: report.ci_job_large,
        ciJobSmall: report.ci_job_small,
      });
    }
  } catch (error) {
    console.error("数据万象回调处理失败：", error);
  }
  return new Response(null, { status: 200 });
}
