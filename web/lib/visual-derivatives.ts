// 公共视觉库图片派生图（缩略图 480w、展示图 1600w）的生成后端选择与数据万象
// （CI）持久化处理编排。规则见 docs/22_公共视觉_立项与实施规格_V0.2.md 3.5、决定 #4。
//
// 两条路径并存，选择逻辑照抄 lib/report-converter.ts 的 chooseConverterMode：
//   - ci：complete/列表/详情接口顺手向数据万象提交一次「云上数据处理」（持久化处理，
//     不是报告域那种异步 doc_jobs），一次请求内直接拿到处理结果——不需要离线机，
//     也不需要轮询/回调。
//   - script：本机没有真实 COS（LOCAL_DEMO_MODE）时退回离线脚本
//     scripts/visual-derivatives.ts，那边才会用到 sharp——这个文件不 import sharp，
//     任何 app/ 或 lib 运行时代码都不应该 import sharp。
//
// 这个文件里的"决策"函数（选模式、拼 Pic-Operations、解析响应 XML、超限判断）都是
// 纯函数或只依赖注入的 fetch，单测在 tests/visual-derivatives.test.ts 里直接覆盖，
// 不打真实网络。真正碰数据库/网络的 submitVisualImageDerivative /
// runVisualDerivativesForCase / runStaleVisualDerivatives 是编排层，用注入的
// fetchImpl 和结构兼容的 DbClient，测试用假实现覆盖。

import type { DbClient, QueryResultRow } from "@/db";
import { readCosConfig, createCosAuthorization, type CosConfig } from "@/storage/cos";
import { getOptionalEnv } from "@/lib/env";
import { VISUAL_LIMITS } from "./visual-contract";
import {
  formatVisualOversizeReason,
  isOversizedForVisualDerivative,
  visualDisplayObjectKey,
  visualThumbObjectKey,
} from "./visual-model";

// ---------------------------------------------------------------------------
// 模式选择：VISUAL_DERIVATIVES 显式指定优先；否则本机演示模式一律走 script；
// 否则 COS 四件套配置齐全就走 ci，缺了退回 script。纯函数，输入显式参数，
// 不直接读 process.env，方便单测覆盖各种组合（同 chooseConverterMode）。
// ---------------------------------------------------------------------------

export type VisualDerivativeMode = "ci" | "script";

export function chooseVisualDerivativeMode(input: {
  visualDerivativesOverride?: string | null;
  isLocalDemo: boolean;
  hasCiCosConfig: boolean;
}): VisualDerivativeMode {
  const override = input.visualDerivativesOverride?.trim();
  if (override === "ci" || override === "script") return override;
  if (input.isLocalDemo) return "script";
  return input.hasCiCosConfig ? "ci" : "script";
}

function hasCiCosEnvConfig(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.COS_REGION?.trim() && env.COS_BUCKET?.trim() && env.COS_SECRET_ID?.trim() && env.COS_SECRET_KEY?.trim(),
  );
}

/** 读 process.env 的薄封装；chooseVisualDerivativeMode 本身保持纯函数、可单测。 */
export function getVisualDerivativeMode(): VisualDerivativeMode {
  return chooseVisualDerivativeMode({
    visualDerivativesOverride: getOptionalEnv("VISUAL_DERIVATIVES"),
    isLocalDemo: process.env.LOCAL_DEMO_MODE === "1",
    hasCiCosConfig: hasCiCosEnvConfig(process.env),
  });
}

export function isVisualDerivativeCiMode(): boolean {
  return getVisualDerivativeMode() === "ci";
}

// ---------------------------------------------------------------------------
// Pic-Operations（云上数据处理，持久化处理已有对象）：一次请求出两档派生图。
// 纯函数，字段顺序固定，单测直接断言 JSON 内容。
// ---------------------------------------------------------------------------

export type VisualPicOperationsRule = { fileid: string; rule: string };
export type VisualPicOperationsPlan = { is_pic_info: 1; rules: [VisualPicOperationsRule, VisualPicOperationsRule] };

export function buildVisualPicOperationsPlan(thumbKey: string, displayKey: string): VisualPicOperationsPlan {
  return {
    is_pic_info: 1,
    rules: [
      {
        fileid: `/${thumbKey}`,
        rule: `imageMogr2/auto-orient/thumbnail/${VISUAL_LIMITS.thumbnailWidth}x/format/jpg/quality/85`,
      },
      {
        fileid: `/${displayKey}`,
        rule: `imageMogr2/auto-orient/thumbnail/${VISUAL_LIMITS.displayWidth}x/format/jpg/quality/85`,
      },
    ],
  };
}

export function buildVisualPicOperationsHeader(thumbKey: string, displayKey: string): string {
  return JSON.stringify(buildVisualPicOperationsPlan(thumbKey, displayKey));
}

// ---------------------------------------------------------------------------
// XML：手写小拼接/解析，跟 lib/report-ci.ts 同样的最小实现，只覆盖用得到的字段。
// ---------------------------------------------------------------------------

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) blocks.push(match[1]);
  return blocks;
}

export type VisualPicOperationsOutcome =
  | { ok: true; width: number | null; height: number | null }
  | { ok: false; reason: string };

/**
 * 解析持久化处理的响应：2xx 时期待 <UploadResult> 里有两条 <Object>（缩略图、
 * 展示图各一条）——缺一条就判处理没跑完整；<OriginalInfo><ImageInfo> 里的
 * Width/Height 取不到就不写（调用方据此决定要不要更新素材的宽高）。
 * 非 2xx 时尝试从 <Code>/<Message> 给可读原因，取不到就退回通用文案。
 */
export function parseVisualPicOperationsResponse(status: number, text: string): VisualPicOperationsOutcome {
  if (status < 200 || status >= 300) {
    const code = extractTag(text, "Code");
    const message = extractTag(text, "Message");
    if (message) return { ok: false, reason: `数据万象返回错误：${message}${code ? `（${code}）` : ""}` };
    return { ok: false, reason: `数据万象请求失败（HTTP ${status}）。` };
  }

  const objectBlocks = extractBlocks(text, "Object");
  if (objectBlocks.length < 2) {
    return { ok: false, reason: "数据万象未返回完整的派生图结果，响应格式异常。" };
  }

  let width: number | null = null;
  let height: number | null = null;
  const originalInfo = extractTag(text, "OriginalInfo");
  const imageInfo = originalInfo ? extractTag(originalInfo, "ImageInfo") : null;
  if (imageInfo) {
    const w = Number(extractTag(imageInfo, "Width"));
    const h = Number(extractTag(imageInfo, "Height"));
    width = Number.isFinite(w) && w > 0 ? w : null;
    height = Number.isFinite(h) && h > 0 ? h : null;
  }

  return { ok: true, width, height };
}

// ---------------------------------------------------------------------------
// 签名请求：只碰网络，传输层可注入。host 换成 <bucket>.cos.<region>.myqcloud.com
// （不是 report-ci 那条 .ci. 域名——持久化处理走的是 COS 本体，不是异步任务队列）。
// ---------------------------------------------------------------------------

export type VisualCiFetch = (input: string, init?: RequestInit) => Promise<Response>;

function cosObjectHost(config: CosConfig): string {
  return `${config.bucket}.cos.${config.region}.myqcloud.com`;
}

function encodeObjectKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function visualPicOperationsUrl(config: CosConfig, objectKey: string): string {
  return `https://${cosObjectHost(config)}/${encodeObjectKeyPath(objectKey)}?image_process`;
}

type PicOperationsRequestOutcome =
  | { kind: "response"; status: number; text: string }
  | { kind: "network-error" };

async function requestVisualPicOperations(
  config: CosConfig,
  objectKey: string,
  picOperationsHeader: string,
  fetchImpl: VisualCiFetch,
): Promise<PicOperationsRequestOutcome> {
  const url = visualPicOperationsUrl(config, objectKey);
  const headers = new Headers();
  headers.set("Pic-Operations", picOperationsHeader);
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
  const text = await response.text();
  return { kind: "response", status: response.status, text };
}

// ---------------------------------------------------------------------------
// 编排层：碰数据库/网络，不单测决策本身（决策已经在上面的纯函数里覆盖），
// 只用假 db／假 fetch 覆盖"超限跳过""失败写 FAILED"这类落库行为。
// ---------------------------------------------------------------------------

export type VisualDerivativeAssetRow = {
  id: string;
  caseId: string;
  objectKey: string;
  fileSize: number;
};

async function markVisualDerivativeFailed(db: DbClient, assetId: string, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE visual_case_assets
       SET derivative_status = 'FAILED', derivative_error = ?, derivative_requested_at = now()
       WHERE id = ?`,
    )
    .bind(reason, assetId)
    .run();
}

/**
 * 处理单张图片的派生图：超过 20 MB 直接判 FAILED，不发请求（规格 3.5 的 20 MB
 * 上限）；否则向数据万象提交一次持久化处理，成功写 thumbnail_key/display_key
 * （连带能拿到的宽高）并置 READY，失败写人能看懂的 FAILED 原因。任何异常
 * （包括读不到 COS 配置）都落成 FAILED，不向上抛——调用方（complete/列表/详情
 * 接口的 after() 钩子）不需要再包一层 try/catch。
 */
export async function submitVisualImageDerivative(
  db: DbClient,
  asset: VisualDerivativeAssetRow,
  options: { fetchImpl?: VisualCiFetch } = {},
): Promise<void> {
  if (isOversizedForVisualDerivative(asset.fileSize)) {
    await markVisualDerivativeFailed(db, asset.id, formatVisualOversizeReason(asset.fileSize));
    return;
  }

  await db
    .prepare(`UPDATE visual_case_assets SET derivative_requested_at = now() WHERE id = ?`)
    .bind(asset.id)
    .run();

  const thumbKey = visualThumbObjectKey(asset.caseId, asset.id);
  const displayKey = visualDisplayObjectKey(asset.caseId, asset.id);

  try {
    const config = readCosConfig();
    const header = buildVisualPicOperationsHeader(thumbKey, displayKey);
    const outcome = await requestVisualPicOperations(config, asset.objectKey, header, options.fetchImpl ?? fetch);
    if (outcome.kind === "network-error") {
      await markVisualDerivativeFailed(db, asset.id, "无法连接数据万象服务，请检查网络后重试。");
      return;
    }
    const parsed = parseVisualPicOperationsResponse(outcome.status, outcome.text);
    if (!parsed.ok) {
      await markVisualDerivativeFailed(db, asset.id, parsed.reason);
      return;
    }
    if (parsed.width && parsed.height) {
      await db
        .prepare(
          `UPDATE visual_case_assets
           SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL,
               width = ?, height = ?
           WHERE id = ?`,
        )
        .bind(thumbKey, displayKey, parsed.width, parsed.height, asset.id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE visual_case_assets
           SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL
           WHERE id = ?`,
        )
        .bind(thumbKey, displayKey, asset.id)
        .run();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markVisualDerivativeFailed(db, asset.id, `数据万象处理未能启动：${message}`);
  }
}

/** 一次最多并发 3 个，简单的按序补位调度，不引入额外依赖。 */
async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function pump(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => pump()));
}

export const VISUAL_DERIVATIVE_CONCURRENCY = 3;
/** 「PENDING 超过 60 秒」的兜底重提交窗口（同报告域"卡在 PROCESSING 超过 15 秒就顺手查一次"的思路）。 */
export const VISUAL_DERIVATIVE_STALE_MS = 60_000;

type PendingImageRow = QueryResultRow & {
  id: string;
  case_id: string;
  object_key: string;
  file_size: number;
};

function toDerivativeAsset(row: PendingImageRow): VisualDerivativeAssetRow {
  return { id: row.id, caseId: row.case_id, objectKey: row.object_key, fileSize: Number(row.file_size) };
}

/** complete 路由用 after() 调用：处理这条案例里全部「已传完、PENDING」的图片。 */
export async function runVisualDerivativesForCase(
  db: DbClient,
  caseId: string,
  options: { fetchImpl?: VisualCiFetch } = {},
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.case_id, a.object_key, a.file_size
       FROM visual_case_assets a
       JOIN visual_cases c ON c.id = a.case_id
       WHERE a.case_id = ? AND a.type = 'IMAGE' AND a.upload_status = 'READY'
         AND a.derivative_status = 'PENDING' AND c.deleted_at IS NULL`,
    )
    .bind(caseId)
    .all<PendingImageRow>();
  await runWithConcurrencyLimit(rows.results.map(toDerivativeAsset), VISUAL_DERIVATIVE_CONCURRENCY, (asset) =>
    submitVisualImageDerivative(db, asset, options),
  );
}

/**
 * 列表／详情接口用 after() 调用的兜底：PENDING 超过 60 秒（或从没提交过）的图片
 * 顺手再提交一次。不传 caseId 时扫全库（列表页），传了就只扫这一条案例（详情页）。
 */
export async function runStaleVisualDerivatives(
  db: DbClient,
  options: { caseId?: string; fetchImpl?: VisualCiFetch; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - VISUAL_DERIVATIVE_STALE_MS).toISOString();
  const rows = options.caseId
    ? await db
        .prepare(
          `SELECT a.id, a.case_id, a.object_key, a.file_size
           FROM visual_case_assets a
           JOIN visual_cases c ON c.id = a.case_id
           WHERE a.case_id = ? AND a.type = 'IMAGE' AND a.upload_status = 'READY'
             AND a.derivative_status = 'PENDING' AND c.deleted_at IS NULL
             AND (a.derivative_requested_at IS NULL OR a.derivative_requested_at < ?)`,
        )
        .bind(options.caseId, staleBefore)
        .all<PendingImageRow>()
    : await db
        .prepare(
          `SELECT a.id, a.case_id, a.object_key, a.file_size
           FROM visual_case_assets a
           JOIN visual_cases c ON c.id = a.case_id
           WHERE a.type = 'IMAGE' AND a.upload_status = 'READY'
             AND a.derivative_status = 'PENDING' AND c.deleted_at IS NULL
             AND (a.derivative_requested_at IS NULL OR a.derivative_requested_at < ?)`,
        )
        .bind(staleBefore)
        .all<PendingImageRow>();
  await runWithConcurrencyLimit(rows.results.map(toDerivativeAsset), VISUAL_DERIVATIVE_CONCURRENCY, (asset) =>
    submitVisualImageDerivative(db, asset, { fetchImpl: options.fetchImpl }),
  );
}
