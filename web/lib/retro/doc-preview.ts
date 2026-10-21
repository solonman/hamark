// 案例附件里文档（PDF／Word／Excel／PPT）的逐页预览（docs/26 4.3「全部在站内弹层预览」，2026-10-20）。
//
// 和报告库同一条链路：complete 后向数据万象提交两个 doc_jobs（大图 1600w、小图 480w，覆盖全部页），
// 输出到 retro/cases/{caseId}/assets/{assetId}/pages/p${Number}@2x.jpg 与 p${Number}.jpg。
// 没有回调：案例详情 GET 时对 PENDING 的文档按报告库的节流（15 秒）顺手查一次并收口。
// derivative_status 就是转换状态（PENDING／READY／FAILED），失败把中文原因写进 derivative_error，不往外抛。
//
// 模式切换跟本库的图片派生图一致（getRetroDerivativeMode：本机演示走 script，生产 COS 配齐走 ci）；
// script 模式由 scripts/retro-derivatives.ts 生成占位页图。
//
// 纯函数（提交计划、页结果整理、轮询判断、读回 pages_json）单测在 tests/retro-doc-preview.test.ts；
// 合并两个任务结果直接复用报告库的 mergeCiJobResults，CI 客户端复用 lib/report-ci.ts。

import type { DbClient, QueryResultRow } from "@/db";
import { getDocJob, submitDocJob, type CiFetch, type DocJobPage } from "@/lib/report-ci";
import {
  LARGE_IMAGE_PARAMS,
  SMALL_IMAGE_PARAMS,
  mergeCiJobResults,
  resolveCiQueueId,
  shouldPollReport,
  type CiPageOutcome,
  type DocProcessSubmissionPlan,
} from "@/lib/report-converter";
import { VISUAL_DERIVATIVE_STALE_MS } from "@/lib/visual-derivatives";
import { visualObjectExtension } from "@/lib/visual-model";
import { readCosConfig, type CosConfig } from "@/storage/cos";
import { friendlyRetroPreviewError } from "@/lib/retro-model";
import { isRetroDerivativeCiMode } from "./derivatives";
import { retroAssetPageKey, retroAssetPagesDir, retroAssetPageTemplate } from "./keys";

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "csv", "et", "ett"]);

/** 表格按工作表输出，文件名里多一个 ${SheetID}。 */
export function isRetroSpreadsheet(originalName: string): boolean {
  return SPREADSHEET_EXTENSIONS.has(visualObjectExtension(originalName));
}

/**
 * 表格的两份结果按 TgtUri 配对：每个工作表各自从第 1 页编号，PageNo 会重复，不能像报告库那样按页号合并。
 * 去掉大图的 @2x 后同名即为同一页；按「工作表、页」排序后重新编成 1…N。
 */
export function pairRetroSpreadsheetPages(large: readonly DocJobPage[], small: readonly DocJobPage[]): CiPageOutcome[] {
  const clean = (uri: string) => uri.replace(/^\/+/, "");
  const keyOf = (uri: string) => clean(uri).replace(/@2x(?=\.jpg$)/, "");
  const smallByKey = new Map(small.map((page) => [keyOf(page.tgtUri), clean(page.tgtUri)]));
  const largeByKey = new Map(large.map((page) => [keyOf(page.tgtUri), clean(page.tgtUri)]));
  const order = (key: string) => {
    const match = /s(\d+)p(\d+)\.jpg$/.exec(key);
    return match ? [Number(match[1]), Number(match[2])] : [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  };
  const keys = [...new Set([...largeByKey.keys(), ...smallByKey.keys()])].sort((a, b) => {
    const [aSheet, aPage] = order(a);
    const [bSheet, bPage] = order(b);
    return aSheet - bSheet || aPage - bPage || a.localeCompare(b);
  });
  return keys.map((key, index) => {
    const largeKey = largeByKey.get(key);
    const thumbKey = smallByKey.get(key);
    return largeKey && thumbKey
      ? { pageNo: index + 1, renderStatus: "OK" as const, thumbKey, largeKey }
      : { pageNo: index + 1, renderStatus: "FAILED" as const, thumbKey: "", largeKey: "" };
  });
}

/** 大图、小图两份 doc_jobs 的参数。源类型取原文件扩展名（原件对象键是 original.<ext>）。 */
export function planRetroDocSubmission(asset: {
  caseId: string;
  assetId: string;
  objectKey: string;
  originalName: string;
}): DocProcessSubmissionPlan {
  const srcType = visualObjectExtension(asset.originalName);
  const spreadsheet = isRetroSpreadsheet(asset.originalName);
  return {
    large: {
      srcObjectKey: asset.objectKey,
      srcType,
      outputObjectTemplate: retroAssetPageTemplate(asset.caseId, asset.assetId, "large", spreadsheet),
      imageParams: LARGE_IMAGE_PARAMS,
    },
    small: {
      srcObjectKey: asset.objectKey,
      srcType,
      outputObjectTemplate: retroAssetPageTemplate(asset.caseId, asset.assetId, "small", spreadsheet),
      imageParams: SMALL_IMAGE_PARAMS,
    },
  };
}

/** pages_json 里的一页：转换成功的页另带两档对象键（数据万象查询结果给的 TgtUri）。 */
export type RetroStoredDocPage = { pageNo: number; ok: boolean; thumbKey?: string; largeKey?: string };

/** mergeCiJobResults 的逐页结果 → 落库的 pages_json。失败页不存键（那是报告库命名的占位键，对复盘库没意义）。 */
export function retroDocPagesFromCi(pages: readonly CiPageOutcome[]): RetroStoredDocPage[] {
  return pages.map((page) => (page.renderStatus === "OK"
    ? { pageNo: page.pageNo, ok: true, thumbKey: page.thumbKey, largeKey: page.largeKey }
    : { pageNo: page.pageNo, ok: false }));
}

export type RetroDocPageKeys = { pageNo: number; ok: boolean; thumbKey: string | null; largeKey: string | null };

/**
 * 读回 pages_json。存的键必须落在这个附件自己的 pages/ 目录下，否则按约定的文件名重算
 * （不会因为一条脏数据去签别的对象）。格式不对的条目丢掉，按页号排序。
 */
export function retroDocPagesFromStored(value: unknown, caseId: string, assetId: string): RetroDocPageKeys[] {
  const raw = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!Array.isArray(raw)) return [];
  const dir = retroAssetPagesDir(caseId, assetId);
  const own = (key: unknown, fallback: string) => (typeof key === "string" && key.startsWith(dir) && !key.includes("..") ? key : fallback);
  const seen = new Set<number>();
  const pages: RetroDocPageKeys[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const pageNo = Number(entry.pageNo);
    if (!Number.isInteger(pageNo) || pageNo <= 0 || seen.has(pageNo)) continue;
    seen.add(pageNo);
    const ok = entry.ok === true;
    pages.push({
      pageNo,
      ok,
      thumbKey: ok ? own(entry.thumbKey, retroAssetPageKey(caseId, assetId, pageNo, "small")) : null,
      largeKey: ok ? own(entry.largeKey, retroAssetPageKey(caseId, assetId, pageNo, "large")) : null,
    });
  }
  return pages.sort((a, b) => a.pageNo - b.pageNo);
}

/** 详情 GET 顺手查一次的条件：PENDING、两个任务都已提交、距上次检查超过报告库的节流窗口。 */
export function shouldPollRetroDoc(
  asset: { derivativeStatus: string; ciJobLarge: string | null; ciJobSmall: string | null; ciCheckedAt: string | null },
  now: Date,
): boolean {
  if (!asset.ciJobLarge || !asset.ciJobSmall) return false;
  return shouldPollReport({ status: asset.derivativeStatus === "PENDING" ? "PROCESSING" : asset.derivativeStatus, ciCheckedAt: asset.ciCheckedAt }, now);
}

// ---------------------------------------------------------------------------
// 编排层（碰数据库／网络；任何失败都落成 FAILED 或只记检查时间，不往外抛）
// ---------------------------------------------------------------------------

export type RetroDocAssetRow = { id: string; caseId: string; objectKey: string; originalName: string };

async function markDocFailed(db: DbClient, assetId: string, reason: string): Promise<void> {
  await db.prepare(
    `UPDATE retro_case_assets SET derivative_status = 'FAILED', derivative_error = ?, ci_checked_at = now(), updated_at = now()
     WHERE id = ? AND type = 'DOC'`,
  ).bind(friendlyRetroPreviewError(reason) ?? reason, assetId).run();
}

/**
 * 认领：只有 PENDING、还没提交过任务、且（从没认领过或上次认领超过 60 秒）的文档才提交。
 * complete 的 after() 和详情 GET 的兜底同时到达时，只有一边拿得到。
 */
async function claimDocSubmission(db: DbClient, assetId: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - VISUAL_DERIVATIVE_STALE_MS).toISOString();
  const claimed = await db.prepare(
    `UPDATE retro_case_assets SET derivative_requested_at = now()
     WHERE id = ? AND type = 'DOC' AND upload_status = 'READY' AND derivative_status = 'PENDING' AND ci_job_large IS NULL
       AND (derivative_requested_at IS NULL OR derivative_requested_at < ?::timestamptz)
     RETURNING id`,
  ).bind(assetId, staleBefore).first<QueryResultRow & { id: string }>();
  return Boolean(claimed);
}

export async function submitRetroDocPreview(
  db: DbClient,
  asset: RetroDocAssetRow,
  options: { fetchImpl?: CiFetch; now?: Date } = {},
): Promise<void> {
  if (!(await claimDocSubmission(db, asset.id, options.now ?? new Date()))) return;
  try {
    const cosConfig = readCosConfig();
    const queue = await resolveCiQueueId(cosConfig, { fetchImpl: options.fetchImpl });
    if (!queue.ok) {
      await markDocFailed(db, asset.id, queue.reason);
      return;
    }
    const plan = planRetroDocSubmission({ caseId: asset.caseId, assetId: asset.id, objectKey: asset.objectKey, originalName: asset.originalName });
    const [large, small] = await Promise.all([
      submitDocJob({ cosConfig, queueId: queue.queueId, fetchImpl: options.fetchImpl, ...plan.large }),
      submitDocJob({ cosConfig, queueId: queue.queueId, fetchImpl: options.fetchImpl, ...plan.small }),
    ]);
    if (!large.ok || !small.ok) {
      const reason = [!large.ok ? large.reason : null, !small.ok ? small.reason : null].filter(Boolean).join("；") || "数据万象任务提交失败。";
      await markDocFailed(db, asset.id, reason);
      return;
    }
    await db.prepare(
      `UPDATE retro_case_assets SET ci_job_large = ?, ci_job_small = ?, ci_checked_at = NULL, updated_at = now()
       WHERE id = ? AND derivative_status = 'PENDING'`,
    ).bind(large.jobId, small.jobId, asset.id).run();
  } catch (error) {
    await markDocFailed(db, asset.id, `文档预览转换未能启动：${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
  }
}

/**
 * 查两个任务的权威状态并落库：都到终态才收口；任一整体失败就 FAILED；都成功就写逐页结果、置 READY。
 * 查询本身失败（网络、鉴权抖动）只记一次检查时间，留给下一次详情 GET 再试。
 */
export async function checkRetroDocPreview(
  db: DbClient,
  asset: { id: string; ciJobLarge: string; ciJobSmall: string; originalName?: string },
  options: { fetchImpl?: CiFetch } = {},
): Promise<void> {
  let cosConfig: CosConfig;
  try {
    cosConfig = readCosConfig();
  } catch {
    return;
  }
  const touch = () => db.prepare(`UPDATE retro_case_assets SET ci_checked_at = now() WHERE id = ?`).bind(asset.id).run();
  const [large, small] = await Promise.all([
    getDocJob({ cosConfig, jobId: asset.ciJobLarge, fetchImpl: options.fetchImpl }),
    getDocJob({ cosConfig, jobId: asset.ciJobSmall, fetchImpl: options.fetchImpl }),
  ]);
  if (!large.ok || !small.ok) {
    await touch();
    return;
  }
  const merged = mergeCiJobResults(asset.id, large.result, small.result);
  if (merged.kind === "pending") {
    await touch();
    return;
  }
  if (merged.kind === "failed") {
    await markDocFailed(db, asset.id, merged.reason);
    return;
  }
  const spreadsheet = Boolean(asset.originalName && isRetroSpreadsheet(asset.originalName))
    && large.result.state === "Success" && small.result.state === "Success";
  const pageOutcomes = spreadsheet && large.result.state === "Success" && small.result.state === "Success"
    ? pairRetroSpreadsheetPages(large.result.pages, small.result.pages)
    : merged.pages;
  const pageCount = spreadsheet ? pageOutcomes.length : merged.pageCount;
  const pages = retroDocPagesFromCi(pageOutcomes);
  if (!pages.some((page) => page.ok)) {
    await markDocFailed(db, asset.id, "数据万象没有转换出可以预览的页面。");
    return;
  }
  await db.prepare(
    `UPDATE retro_case_assets
     SET derivative_status = 'READY', derivative_error = NULL, page_count = ?, pages_json = ?::jsonb,
         ci_checked_at = now(), updated_at = now()
     WHERE id = ? AND derivative_status = 'PENDING'`,
  ).bind(pageCount, JSON.stringify(pages), asset.id).run();
}

type PendingDocRow = QueryResultRow & { id: string; case_id: string; object_key: string; original_name: string };

const toDocAsset = (row: PendingDocRow): RetroDocAssetRow => ({
  id: row.id,
  caseId: row.case_id,
  objectKey: row.object_key,
  originalName: row.original_name,
});

/**
 * 提交这个案例里还没提交的 PENDING 文档（complete 的 after() 调用）。认领条件里带着 60 秒的过期判断，
 * 所以详情 GET 的兜底也调这个：从没提交成功、又已经过了 60 秒的，会再提交一次。
 */
export async function runRetroDocPreviewsForCase(db: DbClient, caseId: string, options: { fetchImpl?: CiFetch; now?: Date } = {}): Promise<void> {
  const rows = await db.prepare(
    `SELECT a.id, a.case_id, a.object_key, a.original_name FROM retro_case_assets a
     JOIN retro_cases c ON c.id = a.case_id
     WHERE a.case_id = ? AND a.type = 'DOC' AND a.upload_status = 'READY' AND a.derivative_status = 'PENDING'
       AND a.ci_job_large IS NULL AND c.deleted_at IS NULL
     ORDER BY a.created_at ASC`,
  ).bind(caseId).all<PendingDocRow>();
  for (const row of rows.results) await submitRetroDocPreview(db, toDocAsset(row), options);
}

type PollRow = QueryResultRow & { id: string; original_name: string; derivative_status: string; ci_job_large: string | null; ci_job_small: string | null; ci_checked_at: unknown };

function isoText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

/**
 * 「已就绪」却一页都没有、也从没提交过转换任务的文档，说明从来没转过（例如文档预览上线前传的，
 * 当时文档不转换、直接记成就绪）：改回 PENDING，交给后面的提交兜底去转。规则对任何漏转的文档都成立，
 * 同步执行，这样这次详情响应就是「正在生成预览」，前端会照常轮询。
 * 提交阶段就失败（没拿到任务 id）的文档，过 10 分钟后打开详情也会再提交一次——这类失败多半是配置或参数问题，
 * 修好之后不用重传；数据万象没有因此计费。转换阶段失败的（拿到过任务 id）不重试。
 */
export async function requeueNeverConvertedDocs(db: DbClient, caseId: string): Promise<void> {
  await db.prepare(
    `UPDATE retro_case_assets SET derivative_status = 'PENDING', derivative_error = NULL, derivative_requested_at = NULL, updated_at = now()
     WHERE case_id = ? AND type = 'DOC' AND upload_status = 'READY' AND ci_job_large IS NULL AND pages_json IS NULL AND page_count = 0
       AND (derivative_status = 'READY'
         OR (derivative_status = 'FAILED' AND (derivative_requested_at IS NULL OR derivative_requested_at < now() - interval '10 minutes')))`,
  ).bind(caseId).run();
}

/** 案例详情 GET 时调用（只在 ci 模式）：对 PENDING、已提交的文档按节流查一次。吞掉异常，纯读接口不因数据万象抖动报错。 */
export async function pollRetroDocPreviews(db: DbClient, caseId: string, options: { fetchImpl?: CiFetch; now?: Date } = {}): Promise<void> {
  if (!isRetroDerivativeCiMode()) return;
  const now = options.now ?? new Date();
  try {
    await requeueNeverConvertedDocs(db, caseId);
    const rows = await db.prepare(
      `SELECT id, original_name, derivative_status, ci_job_large, ci_job_small, ci_checked_at FROM retro_case_assets
       WHERE case_id = ? AND type = 'DOC' AND upload_status = 'READY' AND derivative_status = 'PENDING'
         AND ci_job_large IS NOT NULL AND ci_job_small IS NOT NULL`,
    ).bind(caseId).all<PollRow>();
    const due = rows.results.filter((row) => shouldPollRetroDoc({
      derivativeStatus: row.derivative_status,
      ciJobLarge: row.ci_job_large,
      ciJobSmall: row.ci_job_small,
      ciCheckedAt: isoText(row.ci_checked_at),
    }, now));
    await Promise.all(due.map((row) => checkRetroDocPreview(db, { id: row.id, ciJobLarge: row.ci_job_large!, ciJobSmall: row.ci_job_small!, originalName: row.original_name }, options)
      .catch((error) => console.error(`[retro asset ${row.id}] 数据万象文档转换轮询失败：`, error))));
  } catch (error) {
    console.error("[retro] 文档预览轮询失败", error);
  }
}
