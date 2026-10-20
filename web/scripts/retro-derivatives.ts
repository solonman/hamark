// 客户需求复盘库案例附件里图片派生图的离线生成：本机没有真实 COS（LOCAL_DEMO_MODE）时的退路，
// 或者生产数据万象出故障时的手动补救。生产默认走 lib/visual-derivatives.ts 的
// 数据万象持久化处理，不需要这台机器常驻——这个脚本只跑一遍就退出。
//
// 文档（PDF／Word／Excel／PPT）的逐页预览在生产由数据万象 doc_jobs 转换（lib/retro/doc-preview.ts）；
// 本机演示模式没有数据万象，这里对 PENDING 的文档生成 3 张占位页图（深色底上写「第 N 页 · 文件名」），
// 写 pages_json 并置 READY，只为在本机看弹层。连正式库跑时不碰文档（那是数据万象的活）。
//
// 用法：
//   npm run retro:derivatives         （连正式库，读 .env.local）
//   npm run retro:derivatives:local   （本机演示模式，读 .env.development.local）
//
// 只有这个文件 import sharp——它是 next 的可选依赖，不应该被任何 app/ 或 lib
// 运行时代码引用，否则会把 sharp 的原生绑定带进 serverless 运行时。
// 规则见 docs/26_客户需求复盘库_实施规格_V0.1.md 4.3（派生图链路照抄 docs/22 3.5）。

import { getDbClient, getVideoBucket, type DbClient } from "../db/index.ts";
import { RETRO_SCHEMA_STATEMENTS } from "../db/retro-schema.ts";
import { VISUAL_LIMITS } from "../lib/visual-contract.ts";
import { retroAssetDisplayKey, retroAssetPageKey, retroAssetThumbKey } from "../lib/retro/keys.ts";
import { formatVisualOversizeReason, isOversizedForVisualDerivative } from "../lib/visual-model.ts";

type PendingImageRow = { id: string; case_id: string; object_key: string; file_size: number };

// sharp ships its type declarations at a subpath its own package.json "exports"
// field doesn't expose a "types" condition for under `moduleResolution: bundler`,
// so a plain `import sharp from "sharp"` can't be typed by tsc here. Declare just
// the tiny slice of its chainable API this script actually calls, and load the
// real module dynamically (see main()) so this stays the one file that touches it.
type SharpPipeline = {
  rotate(): SharpPipeline;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{ width?: number; height?: number }>;
};
type SharpFactory = (input: Buffer) => SharpPipeline;

type PendingDocRow = { id: string; case_id: string; original_name: string };

/** 占位页的页数：够看出翻页、首尾不回绕和缩略条。 */
const PLACEHOLDER_PAGE_COUNT = 3;

async function loadSharp(): Promise<SharpFactory> {
  // A non-literal specifier keeps tsc from statically resolving "sharp"'s own
  // declaration files (see the comment above) — it types the import as `any`
  // instead of erroring, and the cast below narrows it back down to what we use.
  const specifier = "sharp";
  const mod = (await import(specifier)) as unknown as { default: SharpFactory };
  return mod.default;
}

/** 只建复盘库这几张表，不跑全量 db/bootstrap.ts（同 convert-report-pages.ts 的做法）。 */
async function ensureRetroSchema(db: DbClient) {
  await db.batch(RETRO_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

async function findPendingImages(db: DbClient): Promise<PendingImageRow[]> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.case_id, a.object_key, a.file_size
       FROM retro_case_assets a
       JOIN retro_cases c ON c.id = a.case_id
       WHERE a.type = 'IMAGE' AND a.upload_status = 'READY' AND a.derivative_status = 'PENDING'
         AND c.deleted_at IS NULL
       ORDER BY a.created_at ASC`,
    )
    .all<PendingImageRow>();
  return rows.results;
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function markFailed(db: DbClient, assetId: string, reason: string) {
  await db
    .prepare(
      `UPDATE retro_case_assets
       SET derivative_status = 'FAILED', derivative_error = ?, derivative_requested_at = now()
       WHERE id = ?`,
    )
    .bind(reason, assetId)
    .run();
}

async function processImage(db: DbClient, row: PendingImageRow): Promise<void> {
  const bucket = getVideoBucket();
  await db.prepare(`UPDATE retro_case_assets SET derivative_requested_at = now() WHERE id = ?`).bind(row.id).run();

  const object = await bucket.get(row.object_key);
  if (!object.body) {
    await markFailed(db, row.id, "找不到原图，可能还没有上传完成。");
    console.error(`[${row.id}] 找不到原图 ${row.object_key}`);
    return;
  }
  const original = await streamToBuffer(object.body);

  if (isOversizedForVisualDerivative(original.byteLength)) {
    await markFailed(db, row.id, formatVisualOversizeReason(original.byteLength));
    console.log(`[${row.id}] 原图超过处理上限，跳过。`);
    return;
  }

  try {
    const sharp = await loadSharp();

    const [thumbBuffer, displayBuffer, metadata] = await Promise.all([
      sharp(original)
        .rotate()
        .resize({ width: VISUAL_LIMITS.thumbnailWidth, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer(),
      sharp(original)
        .rotate()
        .resize({ width: VISUAL_LIMITS.displayWidth, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer(),
      sharp(original).rotate().metadata(),
    ]);

    const thumbKey = retroAssetThumbKey(row.case_id, row.id);
    const displayKey = retroAssetDisplayKey(row.case_id, row.id);
    await bucket.put(thumbKey, thumbBuffer, { httpMetadata: { contentType: "image/jpeg" } });
    await bucket.put(displayKey, displayBuffer, { httpMetadata: { contentType: "image/jpeg" } });

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width > 0 && height > 0) {
      await db
        .prepare(
          `UPDATE retro_case_assets
           SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL,
               width = ?, height = ?
           WHERE id = ?`,
        )
        .bind(thumbKey, displayKey, width, height, row.id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE retro_case_assets
           SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL
           WHERE id = ?`,
        )
        .bind(thumbKey, displayKey, row.id)
        .run();
    }
    console.log(`[${row.id}] 派生图完成。`);
  } catch (error) {
    // sharp 读不了（比如部分 HEIC 变体、损坏文件）就判 FAILED。
    await markFailed(db, row.id, "本机脚本处理不了这种格式。");
    console.error(`[${row.id}] sharp 处理失败：`, error);
  }
}

async function findPendingDocs(db: DbClient): Promise<PendingDocRow[]> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.case_id, a.original_name
       FROM retro_case_assets a
       JOIN retro_cases c ON c.id = a.case_id
       WHERE a.type = 'DOC' AND a.upload_status = 'READY' AND a.derivative_status = 'PENDING'
         AND c.deleted_at IS NULL
       ORDER BY a.created_at ASC`,
    )
    .all<PendingDocRow>();
  return rows.results;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 一张 4:3 的占位页（SVG 交给 sharp 栅格化）：深色底、页号大字、文件名小字。 */
function placeholderPageSvg(pageNo: number, fileName: string, width: number): Buffer {
  const height = Math.round((width * 3) / 4);
  const name = [...fileName].length > 28 ? `${[...fileName].slice(0, 27).join("")}…` : fileName;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1600 1200">
  <rect width="1600" height="1200" fill="#141511"/>
  <rect x="60" y="60" width="1480" height="1080" fill="none" stroke="#3a3c33" stroke-width="4"/>
  <text x="800" y="560" text-anchor="middle" font-size="150" font-weight="700" fill="#e6e7df"
    font-family="PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Microsoft YaHei, sans-serif">第 ${pageNo} 页</text>
  <text x="800" y="700" text-anchor="middle" font-size="58" fill="#a3a69b"
    font-family="PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Microsoft YaHei, sans-serif">${escapeXml(name)}</text>
  <text x="800" y="1060" text-anchor="middle" font-size="36" fill="#6d7066"
    font-family="ui-monospace, Menlo, monospace">LOCAL PREVIEW PLACEHOLDER</text>
</svg>`;
  return Buffer.from(svg);
}

async function processDoc(db: DbClient, row: PendingDocRow): Promise<void> {
  const bucket = getVideoBucket();
  try {
    const sharp = await loadSharp();
    const pages: Array<{ pageNo: number; ok: true; thumbKey: string; largeKey: string }> = [];
    for (let pageNo = 1; pageNo <= PLACEHOLDER_PAGE_COUNT; pageNo += 1) {
      const thumbKey = retroAssetPageKey(row.case_id, row.id, pageNo, "small");
      const largeKey = retroAssetPageKey(row.case_id, row.id, pageNo, "large");
      const [thumb, large] = await Promise.all([
        sharp(placeholderPageSvg(pageNo, row.original_name, 480)).jpeg({ quality: 80 }).toBuffer(),
        sharp(placeholderPageSvg(pageNo, row.original_name, 1600)).jpeg({ quality: 85 }).toBuffer(),
      ]);
      await bucket.put(thumbKey, thumb, { httpMetadata: { contentType: "image/jpeg" } });
      await bucket.put(largeKey, large, { httpMetadata: { contentType: "image/jpeg" } });
      pages.push({ pageNo, ok: true, thumbKey, largeKey });
    }
    await db
      .prepare(
        `UPDATE retro_case_assets
         SET derivative_status = 'READY', derivative_error = NULL, page_count = ?, pages_json = ?::jsonb,
             derivative_requested_at = now(), ci_checked_at = now()
         WHERE id = ? AND derivative_status = 'PENDING'`,
      )
      .bind(pages.length, JSON.stringify(pages), row.id)
      .run();
    console.log(`[${row.id}] 文档占位页图完成（${pages.length} 页）。`);
  } catch (error) {
    await markFailed(db, row.id, "本机脚本没能生成占位页图。");
    console.error(`[${row.id}] 占位页图生成失败：`, error);
  }
}

async function main() {
  const db = getDbClient();
  await ensureRetroSchema(db);
  const rows = await findPendingImages(db);
  console.log(`retro derivatives：待处理 ${rows.length} 张图片。`);
  for (const row of rows) {
    await processImage(db, row);
  }
  // 文档占位页图只在本机演示模式生成：正式库上的文档由数据万象转换，这里不能拿占位图冒充。
  if (process.env.LOCAL_DEMO_MODE === "1") {
    const docs = await findPendingDocs(db);
    console.log(`retro derivatives：待处理 ${docs.length} 份文档（本机占位页图）。`);
    for (const doc of docs) await processDoc(db, doc);
  }
  console.log("retro derivatives：处理完成。");
}

await main();
