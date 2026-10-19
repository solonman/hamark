// 案例附件里图片的派生图（480w 缩略图、1600w 展示图），链路照抄公共视觉（docs/26 4.3）：
//   - ci：complete／详情顺手向数据万象提交一次「持久化处理」，一次请求内拿到结果；
//   - script：本机没有真实 COS（LOCAL_DEMO_MODE）时退回 scripts/retro-derivatives.ts（只有那个文件用 sharp）。
// 模式选择、Pic-Operations 拼装、响应解析都是公共视觉那份纯函数，这里只换表名和对象键。

import type { DbClient, QueryResultRow } from "@/db";
import { createCosAuthorization, readCosConfig, type CosConfig } from "@/storage/cos";
import {
  buildVisualPicOperationsHeader,
  getVisualDerivativeMode,
  parseVisualPicOperationsResponse,
  visualPicOperationsUrl,
  VISUAL_DERIVATIVE_CONCURRENCY,
  VISUAL_DERIVATIVE_STALE_MS,
  type VisualCiFetch,
  type VisualDerivativeMode,
} from "@/lib/visual-derivatives";
import { formatVisualOversizeReason, isOversizedForVisualDerivative } from "@/lib/visual-model";
import { retroAssetDisplayKey, retroAssetThumbKey } from "./keys";

export function getRetroDerivativeMode(): VisualDerivativeMode {
  return getVisualDerivativeMode();
}

export function isRetroDerivativeCiMode(): boolean {
  return getVisualDerivativeMode() === "ci";
}

export type RetroDerivativeAssetRow = { id: string; caseId: string; objectKey: string; fileSize: number };

type RequestOutcome = { kind: "response"; status: number; text: string } | { kind: "network-error" };

async function requestPicOperations(
  config: CosConfig,
  objectKey: string,
  header: string,
  fetchImpl: VisualCiFetch,
): Promise<RequestOutcome> {
  const url = visualPicOperationsUrl(config, objectKey);
  const headers = new Headers();
  headers.set("Pic-Operations", header);
  const unsigned = new Request(url, { method: "POST", headers });
  const signedHeaders = new Headers(unsigned.headers);
  signedHeaders.set("host", new URL(url).host);
  signedHeaders.set("authorization", await createCosAuthorization(unsigned, config));
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: signedHeaders });
  } catch {
    return { kind: "network-error" };
  }
  return { kind: "response", status: response.status, text: await response.text() };
}

async function markFailed(db: DbClient, assetId: string, reason: string): Promise<void> {
  await db.prepare(
    `UPDATE retro_case_assets SET derivative_status = 'FAILED', derivative_error = ?, derivative_requested_at = now(), updated_at = now()
     WHERE id = ?`,
  ).bind(reason, assetId).run();
}

/**
 * 处理单张图片：超过 20 MB 直接判 FAILED，不发请求；否则向数据万象提交一次持久化处理，
 * 成功写 thumbnail_key／display_key（连带宽高）并置 READY，失败写人能看懂的原因。
 * 任何异常都落成 FAILED，不向上抛。
 */
export async function submitRetroImageDerivative(
  db: DbClient,
  asset: RetroDerivativeAssetRow,
  options: { fetchImpl?: VisualCiFetch } = {},
): Promise<void> {
  if (isOversizedForVisualDerivative(asset.fileSize)) {
    await markFailed(db, asset.id, formatVisualOversizeReason(asset.fileSize));
    return;
  }
  await db.prepare(`UPDATE retro_case_assets SET derivative_requested_at = now() WHERE id = ?`).bind(asset.id).run();
  const thumbKey = retroAssetThumbKey(asset.caseId, asset.id);
  const displayKey = retroAssetDisplayKey(asset.caseId, asset.id);
  try {
    const outcome = await requestPicOperations(
      readCosConfig(),
      asset.objectKey,
      buildVisualPicOperationsHeader(thumbKey, displayKey),
      options.fetchImpl ?? fetch,
    );
    if (outcome.kind === "network-error") {
      await markFailed(db, asset.id, "无法连接数据万象服务，请检查网络后重试。");
      return;
    }
    const parsed = parseVisualPicOperationsResponse(outcome.status, outcome.text);
    if (!parsed.ok) {
      await markFailed(db, asset.id, parsed.reason);
      return;
    }
    await db.prepare(
      `UPDATE retro_case_assets
       SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL,
           width = COALESCE(?, width), height = COALESCE(?, height), updated_at = now()
       WHERE id = ?`,
    ).bind(thumbKey, displayKey, parsed.width, parsed.height, asset.id).run();
  } catch (error) {
    await markFailed(db, asset.id, `数据万象处理未能启动：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runWithConcurrencyLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function pump(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => pump()));
}

type PendingRow = QueryResultRow & { id: string; case_id: string; object_key: string; file_size: number | string };

const toAsset = (row: PendingRow): RetroDerivativeAssetRow => ({
  id: row.id,
  caseId: row.case_id,
  objectKey: row.object_key,
  fileSize: Number(row.file_size),
});

/** complete 路由用 after() 调用：处理这个案例里全部「已传完、PENDING」的图片。 */
export async function runRetroDerivativesForCase(db: DbClient, caseId: string, options: { fetchImpl?: VisualCiFetch } = {}): Promise<void> {
  const rows = await db.prepare(
    `SELECT a.id, a.case_id, a.object_key, a.file_size FROM retro_case_assets a
     JOIN retro_cases c ON c.id = a.case_id
     WHERE a.case_id = ? AND a.type = 'IMAGE' AND a.upload_status = 'READY' AND a.derivative_status = 'PENDING' AND c.deleted_at IS NULL`,
  ).bind(caseId).all<PendingRow>();
  await runWithConcurrencyLimit(rows.results.map(toAsset), VISUAL_DERIVATIVE_CONCURRENCY, (asset) => submitRetroImageDerivative(db, asset, options));
}

/**
 * 列表／详情接口用 after() 调用的兜底：PENDING 超过 60 秒（或从没提交过）的图片顺手再提交一次。
 * 不传 caseId 时扫全库，传了就只扫这个案例。
 */
export async function runStaleRetroDerivatives(
  db: DbClient,
  options: { caseId?: string; fetchImpl?: VisualCiFetch; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - VISUAL_DERIVATIVE_STALE_MS).toISOString();
  const scoped = options.caseId ? "AND a.case_id = ?" : "";
  const rows = await db.prepare(
    `SELECT a.id, a.case_id, a.object_key, a.file_size FROM retro_case_assets a
     JOIN retro_cases c ON c.id = a.case_id
     WHERE a.type = 'IMAGE' AND a.upload_status = 'READY' AND a.derivative_status = 'PENDING' AND c.deleted_at IS NULL
       ${scoped} AND (a.derivative_requested_at IS NULL OR a.derivative_requested_at < ?::timestamptz)`,
  ).bind(...(options.caseId ? [options.caseId, staleBefore] : [staleBefore])).all<PendingRow>();
  await runWithConcurrencyLimit(rows.results.map(toAsset), VISUAL_DERIVATIVE_CONCURRENCY, (asset) =>
    submitRetroImageDerivative(db, asset, { fetchImpl: options.fetchImpl }),
  );
}
