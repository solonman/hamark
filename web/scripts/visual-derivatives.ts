// 公共视觉库图片派生图的离线生成：本机没有真实 COS（LOCAL_DEMO_MODE）时的退路，
// 或者生产数据万象出故障时的手动补救。生产默认走 lib/visual-derivatives.ts 的
// 数据万象持久化处理，不需要这台机器常驻——这个脚本只跑一遍就退出。
//
// 用法：
//   npm run visual:derivatives         （连正式库，读 .env.local）
//   npm run visual:derivatives:local   （本机演示模式，读 .env.development.local）
//
// 只有这个文件 import sharp——它是 next 的可选依赖，不应该被任何 app/ 或 lib
// 运行时代码引用，否则会把 sharp 的原生绑定带进 serverless 运行时。
// 规则见 docs/22_公共视觉_立项与实施规格_V0.2.md 3.5。

import { getDbClient, getVideoBucket, type DbClient } from "../db/index.ts";
import { VISUAL_SCHEMA_STATEMENTS } from "../db/visual-schema.ts";
import { VISUAL_LIMITS } from "../lib/visual-contract.ts";
import {
  formatVisualOversizeReason,
  isOversizedForVisualDerivative,
  visualDisplayObjectKey,
  visualThumbObjectKey,
} from "../lib/visual-model.ts";

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

async function loadSharp(): Promise<SharpFactory> {
  // A non-literal specifier keeps tsc from statically resolving "sharp"'s own
  // declaration files (see the comment above) — it types the import as `any`
  // instead of erroring, and the cast below narrows it back down to what we use.
  const specifier = "sharp";
  const mod = (await import(specifier)) as unknown as { default: SharpFactory };
  return mod.default;
}

/** 只建公共视觉这三张表，不跑全量 db/bootstrap.ts（同 convert-report-pages.ts 的做法）。 */
async function ensureVisualSchema(db: DbClient) {
  await db.batch(VISUAL_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

async function findPendingImages(db: DbClient): Promise<PendingImageRow[]> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.case_id, a.object_key, a.file_size
       FROM visual_case_assets a
       JOIN visual_cases c ON c.id = a.case_id
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
      `UPDATE visual_case_assets
       SET derivative_status = 'FAILED', derivative_error = ?, derivative_requested_at = now()
       WHERE id = ?`,
    )
    .bind(reason, assetId)
    .run();
}

async function processImage(db: DbClient, row: PendingImageRow): Promise<void> {
  const bucket = getVideoBucket();
  await db.prepare(`UPDATE visual_case_assets SET derivative_requested_at = now() WHERE id = ?`).bind(row.id).run();

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

    const thumbKey = visualThumbObjectKey(row.case_id, row.id);
    const displayKey = visualDisplayObjectKey(row.case_id, row.id);
    await bucket.put(thumbKey, thumbBuffer, { httpMetadata: { contentType: "image/jpeg" } });
    await bucket.put(displayKey, displayBuffer, { httpMetadata: { contentType: "image/jpeg" } });

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width > 0 && height > 0) {
      await db
        .prepare(
          `UPDATE visual_case_assets
           SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL,
               width = ?, height = ?
           WHERE id = ?`,
        )
        .bind(thumbKey, displayKey, width, height, row.id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE visual_case_assets
           SET thumbnail_key = ?, display_key = ?, derivative_status = 'READY', derivative_error = NULL
           WHERE id = ?`,
        )
        .bind(thumbKey, displayKey, row.id)
        .run();
    }
    console.log(`[${row.id}] 派生图完成。`);
  } catch (error) {
    // sharp 读不了（比如部分 HEIC 变体、损坏文件）就判 FAILED，原图仍然可以查看。
    await markFailed(db, row.id, "本机脚本处理不了这种格式；可以查看原图");
    console.error(`[${row.id}] sharp 处理失败：`, error);
  }
}

async function main() {
  const db = getDbClient();
  await ensureVisualSchema(db);
  const rows = await findPendingImages(db);
  console.log(`visual derivatives：待处理 ${rows.length} 张图片。`);
  for (const row of rows) {
    await processImage(db, row);
  }
  console.log("visual derivatives：处理完成。");
}

await main();
