// 报告转换后端的选择与数据万象（CI）编排。
//
// 两条转换路径并存：
//   - script：现状不变，completeReportUpload/retryReport 只把状态置 QUEUED，等
//     scripts/convert-report-pages.ts 那台离线机来领（见 lib/report-convert.ts）。
//   - ci：不需要离线机。complete/retry 直接向数据万象提交两个 doc_jobs 异步任务
//     （大图、小图各一个，覆盖全部页），状态置 PROCESSING；完成后由 CI 回调
//     （POST /api/reports/ci-callback）或列表/详情接口顺手轮询来收口。
//
// 这个文件里的"决策"函数（选转换器、挑队列、合并两个任务的查询结果、判断要不要
// 轮询、比对回调 token）都是纯函数，不碰数据库/网络，单测在 tests/report-ci.test.ts
// 里直接覆盖。真正碰数据库的 submitReportToCi / checkReportCiJobs /
// maybePollReportCi / findReportForCiCallback 是薄的编排层，跟
// scripts/convert-report-pages.ts 一样不单测——它们只管调用上面的纯函数和
// lib/report-ci.ts 的 CI 客户端。

import { getOptionalEnv, getRequiredEnv } from "@/lib/env";
import { pageKeys } from "@/lib/report-convert";
import {
  extractCallbackJobIdHint,
  getDocJob,
  listDocQueues,
  pickActiveQueueId,
  submitDocJob,
  type CiFetch,
  type DocJobResult,
} from "@/lib/report-ci";
import { readCosConfig, type CosConfig } from "@/storage/cos";
import type { DbClient, QueryResultRow } from "@/db";

export type ConverterMode = "ci" | "script";

/**
 * REPORT_CONVERTER 显式覆盖优先；否则本机演示模式（没有 COS）一律走 script；
 * 否则 COS 四件套配置齐全就走 ci，缺了退回 script（离线机模式仍然可用，不阻断上线）。
 * 队列 id 不在这里判断——它是运行时自动发现的（见 resolveCiQueueId），不是启动时的
 * 静态门槛。纯函数，输入用显式参数而不是直接读 process.env，方便单测覆盖各种组合。
 */
export function chooseConverterMode(input: {
  reportConverterOverride?: string | null;
  isLocalDemo: boolean;
  hasCiCosConfig: boolean;
}): ConverterMode {
  const override = input.reportConverterOverride?.trim();
  if (override === "ci" || override === "script") return override;
  if (input.isLocalDemo) return "script";
  return input.hasCiCosConfig ? "ci" : "script";
}

function hasCiCosEnvConfig(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.COS_REGION?.trim() &&
      env.COS_BUCKET?.trim() &&
      env.COS_SECRET_ID?.trim() &&
      env.COS_SECRET_KEY?.trim(),
  );
}

/** 读 process.env 的薄封装；chooseConverterMode 本身保持纯函数、可单测。 */
export function getConverterMode(): ConverterMode {
  return chooseConverterMode({
    reportConverterOverride: process.env.REPORT_CONVERTER,
    isLocalDemo: process.env.LOCAL_DEMO_MODE === "1",
    hasCiCosConfig: hasCiCosEnvConfig(process.env),
  });
}

// ---------------------------------------------------------------------------
// 队列发现与进程内缓存：开通文档处理会自动建队列，不需要手动创建（也没有"创建
// 转码队列"这一步）；COS_CI_DOC_QUEUE_ID 只是可选的覆盖项，缺省时首次提交任务前
// 调一次 GET /docqueue 自动发现，之后缓存在进程内，不用每次提交都查一遍。
// ---------------------------------------------------------------------------

let cachedQueueId: string | null = null;

/** 仅供单测复位缓存；生产代码不应该调用。 */
export function resetCiQueueIdCacheForTests(): void {
  cachedQueueId = null;
}

export type ResolveQueueIdOutcome = { ok: true; queueId: string } | { ok: false; reason: string };

export async function resolveCiQueueId(
  cosConfig: CosConfig,
  options: { fetchImpl?: CiFetch } = {},
): Promise<ResolveQueueIdOutcome> {
  const override = getOptionalEnv("COS_CI_DOC_QUEUE_ID");
  if (override) return { ok: true, queueId: override };
  if (cachedQueueId) return { ok: true, queueId: cachedQueueId };

  const listed = await listDocQueues({ cosConfig, fetchImpl: options.fetchImpl });
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const queueId = pickActiveQueueId(listed.queues);
  if (!queueId) {
    return {
      ok: false,
      reason: "数据万象未找到已启用的文档处理队列，请在控制台确认「文档处理」已开启。",
    };
  }
  cachedQueueId = queueId;
  return { ok: true, queueId };
}

// ---------------------------------------------------------------------------
// 提交计划：大图、小图两份任务的参数，纯函数、单测直接覆盖对象键与 ImageParams。
// ---------------------------------------------------------------------------

const LARGE_IMAGE_PARAMS = "imageMogr2/thumbnail/1600x/quality/85";
const SMALL_IMAGE_PARAMS = "imageMogr2/thumbnail/480x/quality/80";

export type DocProcessJobPlan = {
  srcObjectKey: string;
  srcType: string;
  outputObjectTemplate: string;
  imageParams: string;
};

export type DocProcessSubmissionPlan = { large: DocProcessJobPlan; small: DocProcessJobPlan };

export function planDocProcessSubmission(report: {
  id: string;
  objectKey: string;
  sourceFormat: string;
}): DocProcessSubmissionPlan {
  const srcType = report.sourceFormat.trim().toLowerCase();
  return {
    large: {
      srcObjectKey: report.objectKey,
      srcType,
      outputObjectTemplate: `reports/${report.id}/pages/p\${Number}@2x.jpg`,
      imageParams: LARGE_IMAGE_PARAMS,
    },
    small: {
      srcObjectKey: report.objectKey,
      srcType,
      outputObjectTemplate: `reports/${report.id}/pages/p\${Number}.jpg`,
      imageParams: SMALL_IMAGE_PARAMS,
    },
  };
}

export function buildCiCallbackUrl(appUrl: string, token: string): string {
  const url = new URL("/api/reports/ci-callback", appUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

// ---------------------------------------------------------------------------
// 合并大图/小图两个任务的查询结果，得出这份报告该落成什么状态。纯函数：只吃
// lib/report-ci.ts 的权威查询结果（getDocJob 的返回值），不吃回调体——回调体不可信
// 这条规则靠"这个函数的入参类型里根本没有回调体"来保证，不是靠调用方自觉。
// ---------------------------------------------------------------------------

export type CiPageOutcome = {
  pageNo: number;
  renderStatus: "OK" | "FAILED";
  thumbKey: string;
  largeKey: string;
};

export type CiConversionOutcome =
  | { kind: "pending" }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; pageCount: number; pages: CiPageOutcome[]; notes: string[] };

function isTerminal(result: DocJobResult): boolean {
  return result.state !== "Submitted" && result.state !== "Running";
}

function jobFailureReason(label: string, result: DocJobResult): string | null {
  if (result.state === "Failed") return `${label}任务失败：${result.message || result.code || "原因未知"}`;
  if (result.state === "Pause") return `${label}任务被数据万象暂停，请在控制台确认队列状态后重试。`;
  if (result.state === "Cancel") return `${label}任务被取消，请重试。`;
  return null;
}

/** 去掉数据万象返回的 TgtUri 可能带的前导斜杠，跟仓库其余对象键（无前导斜杠）对齐。 */
function normalizeCiObjectKey(value: string): string {
  return value.replace(/^\/+/, "");
}

export function mergeCiJobResults(
  reportId: string,
  large: DocJobResult,
  small: DocJobResult,
): CiConversionOutcome {
  if (!isTerminal(large) || !isTerminal(small)) return { kind: "pending" };

  const largeFail = jobFailureReason("大图", large);
  const smallFail = jobFailureReason("小图", small);
  if (largeFail || smallFail) {
    return { kind: "failed", reason: [largeFail, smallFail].filter(Boolean).join("；") };
  }
  if (large.state !== "Success" || small.state !== "Success") {
    // 前面已经排除了非 Success 的终态分支，这里只是给 TypeScript 收窄类型。
    return { kind: "failed", reason: "数据万象任务状态异常，请重试。" };
  }

  const largeByPage = new Map(large.pages.map((page) => [page.pageNo, page.tgtUri]));
  const smallByPage = new Map(small.pages.map((page) => [page.pageNo, page.tgtUri]));
  const pageCount = Math.max(large.totalPageCount, small.totalPageCount, largeByPage.size, smallByPage.size);

  const pages: CiPageOutcome[] = [];
  const notes: string[] = [];
  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    const largeUri = largeByPage.get(pageNo);
    const smallUri = smallByPage.get(pageNo);
    if (largeUri && smallUri) {
      pages.push({
        pageNo,
        renderStatus: "OK",
        thumbKey: normalizeCiObjectKey(smallUri),
        largeKey: normalizeCiObjectKey(largeUri),
      });
    } else {
      // 该页任一档缺失都判失败：键位仍按现有约定命名（不落地图片），工作台按
      // render_status 显示"渲染失败"占位，不去请求这个不存在的 key。
      const fallback = pageKeys(reportId, pageNo);
      const missing = [!largeUri ? "大图" : null, !smallUri ? "小图" : null].filter(Boolean).join("、");
      notes.push(`第 ${pageNo} 页转码失败（缺少${missing}输出）。`);
      pages.push({ pageNo, renderStatus: "FAILED", thumbKey: fallback.thumbKey, largeKey: fallback.largeKey });
    }
  }

  if (large.failPageCount > 0 || small.failPageCount > 0) {
    notes.push(`数据万象报告：大图失败 ${large.failPageCount} 页，小图失败 ${small.failPageCount} 页。`);
  }

  return { kind: "ready", pageCount, pages, notes };
}

// ---------------------------------------------------------------------------
// 轮询节流：纯函数，接受显式 now 方便单测。
// ---------------------------------------------------------------------------

export const CI_POLL_THROTTLE_MS = 15_000;

export function shouldPollReport(
  report: { status: string; ciCheckedAt: string | null },
  now: Date,
  throttleMs: number = CI_POLL_THROTTLE_MS,
): boolean {
  if (report.status !== "PROCESSING") return false;
  if (!report.ciCheckedAt) return true;
  const last = new Date(report.ciCheckedAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= throttleMs;
}

// ---------------------------------------------------------------------------
// 回调 token 匹配：纯函数。回调体本身不可信，token 只用来"找到是哪份报告"，真正
// 的成功/失败判断一律来自 mergeCiJobResults 消费的权威查询结果。
// ---------------------------------------------------------------------------

export function callbackTokenMatches(
  report: { ciCallbackToken: string | null },
  providedToken: string | null,
): boolean {
  return Boolean(report.ciCallbackToken) && Boolean(providedToken) && report.ciCallbackToken === providedToken;
}

export { extractCallbackJobIdHint };

// ---------------------------------------------------------------------------
// 下面是碰数据库/网络的编排层，不单测（跟 scripts/convert-report-pages.ts 同口径）。
// ---------------------------------------------------------------------------

type ReportRow = QueryResultRow & { id: string; status: string };

async function markReportFailed(db: DbClient, reportId: string, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE reports SET status = 'FAILED', fail_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(reason, reportId)
    .run();
}

function newCallbackToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * 提交一份报告的两个 doc_jobs（大图/小图）。成功则把状态推进到 PROCESSING 并记下
 * 两个 jobId、回调 token；失败（含队列没发现到、CI 拒绝、网络问题、环境变量缺失）
 * 一律落 FAILED + 人能看懂的 fail_reason，不抛出——调用方（complete/retry）不用再
 * 包一层 try/catch 才能保证报告不会卡在中间状态。
 */
export async function submitReportToCi(
  db: DbClient,
  report: { id: string; objectKey: string; sourceFormat: string },
  options: { fetchImpl?: CiFetch } = {},
): Promise<void> {
  try {
    const cosConfig = readCosConfig();
    const queueResolution = await resolveCiQueueId(cosConfig, { fetchImpl: options.fetchImpl });
    if (!queueResolution.ok) {
      await markReportFailed(db, report.id, queueResolution.reason);
      return;
    }
    const appUrl = getRequiredEnv("APP_URL");
    const token = newCallbackToken();
    const callbackUrl = buildCiCallbackUrl(appUrl, token);
    const plan = planDocProcessSubmission(report);

    const [largeResult, smallResult] = await Promise.all([
      submitDocJob({
        cosConfig,
        queueId: queueResolution.queueId,
        callbackUrl,
        fetchImpl: options.fetchImpl,
        ...plan.large,
      }),
      submitDocJob({
        cosConfig,
        queueId: queueResolution.queueId,
        callbackUrl,
        fetchImpl: options.fetchImpl,
        ...plan.small,
      }),
    ]);

    if (!largeResult.ok || !smallResult.ok) {
      const reason =
        [!largeResult.ok ? largeResult.reason : null, !smallResult.ok ? smallResult.reason : null]
          .filter(Boolean)
          .join("；") || "数据万象任务提交失败。";
      await markReportFailed(db, report.id, reason);
      return;
    }

    await db
      .prepare(
        `UPDATE reports
         SET status = 'PROCESSING', ci_job_large = ?, ci_job_small = ?, ci_callback_token = ?,
             converter_version = 'ci-docprocess/1', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(largeResult.jobId, smallResult.jobId, token, report.id)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markReportFailed(db, report.id, `数据万象转换未能启动：${message}`).catch(() => {});
  }
}

type CiCheckedReport = QueryResultRow & {
  id: string;
  ci_job_large: string | null;
  ci_job_small: string | null;
};

async function touchCiCheckedAt(db: DbClient, reportId: string): Promise<void> {
  // ci_checked_at 是 TIMESTAMPTZ，不能用 CURRENT_TIMESTAMP——db/index.ts 的
  // normalizeSql 会把它替换成 (CURRENT_TIMESTAMP::text) 给 TEXT 类型的时间戳列用，
  // 套在 TIMESTAMPTZ 列上会类型不匹配；用 now() 就不会被那条替换规则碰到。
  await db.prepare(`UPDATE reports SET ci_checked_at = now() WHERE id = ?`).bind(reportId).run();
}

/**
 * 查两个任务的权威状态并落库：两者都到终态才收口；任一整体失败就报告 FAILED；
 * 都成功就按页合并结果、upsert report_pages、报告置 READY。查询本身失败（网络/
 * 鉴权抖动）只记一次检查时间，不改变报告状态，留给下一次轮询/回调再试。
 */
export async function checkReportCiJobs(
  db: DbClient,
  report: { id: string; ciJobLarge: string | null; ciJobSmall: string | null },
  options: { fetchImpl?: CiFetch } = {},
): Promise<void> {
  if (!report.ciJobLarge || !report.ciJobSmall) return;

  let cosConfig: CosConfig;
  try {
    cosConfig = readCosConfig();
  } catch {
    return;
  }

  const [largeOutcome, smallOutcome] = await Promise.all([
    getDocJob({ cosConfig, jobId: report.ciJobLarge, fetchImpl: options.fetchImpl }),
    getDocJob({ cosConfig, jobId: report.ciJobSmall, fetchImpl: options.fetchImpl }),
  ]);

  if (!largeOutcome.ok || !smallOutcome.ok) {
    await touchCiCheckedAt(db, report.id);
    return;
  }

  const merged = mergeCiJobResults(report.id, largeOutcome.result, smallOutcome.result);
  if (merged.kind === "pending") {
    await touchCiCheckedAt(db, report.id);
    return;
  }
  if (merged.kind === "failed") {
    await db
      .prepare(
        `UPDATE reports SET status = 'FAILED', fail_reason = ?, ci_checked_at = now(), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(merged.reason, report.id)
      .run();
    return;
  }

  await db.withTransaction(async (tx) => {
    for (const page of merged.pages) {
      await tx
        .prepare(
          `INSERT INTO report_pages (report_id, page_no, thumb_key, large_key, width, height, text_excerpt, render_status)
           VALUES (?, ?, ?, ?, 0, 0, '', ?)
           ON CONFLICT (report_id, page_no) DO UPDATE SET
             thumb_key = EXCLUDED.thumb_key,
             large_key = EXCLUDED.large_key,
             render_status = EXCLUDED.render_status`,
        )
        .bind(report.id, page.pageNo, page.thumbKey, page.largeKey, page.renderStatus)
        .run();
    }
    await tx
      .prepare(
        `UPDATE reports
         SET status = 'READY', page_count = ?, pages_done = ?, convert_notes = ?,
             fail_reason = NULL, ci_checked_at = now(), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(merged.pageCount, merged.pages.length, merged.notes.length ? merged.notes.join("\n") : null, report.id)
      .run();
  });
}

/** 列表/详情读接口的轮询兜底：只在 PROCESSING 且距上次检查超过节流窗口时才查一次，
 * 而且吞掉异常——纯读接口不该因为数据万象抖动而整体报错。 */
export async function maybePollReportCi(
  db: DbClient,
  report: {
    id: string;
    status: string;
    ciCheckedAt: string | null;
    ciJobLarge: string | null;
    ciJobSmall: string | null;
  },
  now: Date = new Date(),
): Promise<void> {
  if (!shouldPollReport({ status: report.status, ciCheckedAt: report.ciCheckedAt }, now)) return;
  if (!report.ciJobLarge || !report.ciJobSmall) return;
  try {
    await checkReportCiJobs(db, { id: report.id, ciJobLarge: report.ciJobLarge, ciJobSmall: report.ciJobSmall });
  } catch (error) {
    console.error(`[report ${report.id}] 数据万象轮询失败：`, error);
  }
}

type CallbackTargetRow = QueryResultRow & {
  id: string;
  ci_callback_token: string | null;
  ci_job_large: string | null;
  ci_job_small: string | null;
};

/**
 * 按回调 URL 上的 token 找报告；找不到（token 缺失/不匹配，比如队列级回调没带上
 * per-job 的 CallBack URL）就退回用回调体里挖出来的 JobId 当线索——JobId 只用来
 * "查哪份报告"，不用来判断成功/失败，真正的判断仍然只信 checkReportCiJobs 里对
 * getDocJob 的权威查询。都找不到就返回 null，路由据此直接 200 忽略。
 */
export async function findReportForCiCallback(
  db: DbClient,
  input: { token: string | null; jobIdHint: string | null },
): Promise<CallbackTargetRow | null> {
  if (input.token) {
    const byToken = await db
      .prepare(
        `SELECT id, ci_callback_token, ci_job_large, ci_job_small FROM reports
         WHERE ci_callback_token = ? AND deleted_at IS NULL`,
      )
      .bind(input.token)
      .first<CallbackTargetRow>();
    if (byToken && callbackTokenMatches({ ciCallbackToken: byToken.ci_callback_token }, input.token)) {
      return byToken;
    }
  }
  if (input.jobIdHint) {
    return db
      .prepare(
        `SELECT id, ci_callback_token, ci_job_large, ci_job_small FROM reports
         WHERE (ci_job_large = ? OR ci_job_small = ?) AND deleted_at IS NULL`,
      )
      .bind(input.jobIdHint, input.jobIdHint)
      .first<CallbackTargetRow>();
  }
  return null;
}

/** 轮询候选：所有 PROCESSING 且已经提交了 CI 任务的报告（script 模式的 PROCESSING
 * 没有 ci_job_*，天然被这个过滤条件排除，不会被误触发数据万象查询）。 */
export async function pollAllProcessingReports(db: DbClient): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT id, status, ci_checked_at, ci_job_large, ci_job_small FROM reports
       WHERE status = 'PROCESSING' AND ci_job_large IS NOT NULL AND ci_job_small IS NOT NULL AND deleted_at IS NULL`,
    )
    .all<ReportRow & { ci_checked_at: string | null; ci_job_large: string | null; ci_job_small: string | null }>();
  const now = new Date();
  await Promise.all(
    rows.results.map((row) =>
      maybePollReportCi(
        db,
        {
          id: row.id,
          status: row.status,
          ciCheckedAt: row.ci_checked_at,
          ciJobLarge: row.ci_job_large,
          ciJobSmall: row.ci_job_small,
        },
        now,
      ),
    ),
  );
}

/** 单份报告的轮询兜底：详情接口调用，只查这一份报告是否需要顺手轮询。 */
export async function pollReportIfProcessing(db: DbClient, reportId: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT status, ci_checked_at, ci_job_large, ci_job_small FROM reports
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(reportId)
    .first<CiCheckedReport & { status: string; ci_checked_at: string | null }>();
  if (!row) return;
  await maybePollReportCi(db, {
    id: reportId,
    status: row.status,
    ciCheckedAt: row.ci_checked_at,
    ciJobLarge: row.ci_job_large,
    ciJobSmall: row.ci_job_small,
  });
}
