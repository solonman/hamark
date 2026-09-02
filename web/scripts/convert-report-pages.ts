// 报告转换流水线的编排：下载原件 → （PPT/PPTX）soffice 转 PDF → pdfinfo 取页数 →
// 逐页 pdftoppm 两档 + pdftotext 摘录 → 上传对象存储 → 写 report_pages/reports。
// 判断"该重试""该降级""该报什么原因"的逻辑全部在 lib/report-convert.ts 里，
// 单测覆盖；这个文件只管调用那些纯函数、碰真实的文件系统/数据库/对象存储，
// 跟 scripts/backfill-thumbnails.ts 是同一台离线机、同一套写法。
//
// 状态机与分级兜底顺序见 docs/19_报告逆向工程_实施规格_V0.1.md 第四节。
//
// 用法：
//   node --env-file=.env.local --import tsx scripts/convert-report-pages.ts            持续轮询
//   node --env-file=.env.local --import tsx scripts/convert-report-pages.ts --once     只处理一份，处理完（或没有排队中的）就退出
//   node --env-file=.env.local --import tsx scripts/convert-report-pages.ts --report <id>   只处理指定报告（须是 QUEUED 状态），处理完就退出

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { spawn } from "node:child_process";

import { getDbClient, getVideoBucket, type DbClient } from "../db/index.ts";
import { REPORT_SCHEMA_STATEMENTS } from "../db/report-schema.ts";
import {
  convertPptToPdf,
  convertReportPage,
  converterVersionString,
  createProcessRunner,
  derivedPdfObjectKey,
  describeMissingTools,
  dpiForTargetWidth,
  pad3,
  pageKeys,
  parsePdfinfoPageSize,
  parsePdfinfoPages,
  pixelSizeForDpi,
  retryPolicy,
  sourceFormatFromName,
  type ConverterToolStatus,
  type ConvertRunner,
} from "../lib/report-convert.ts";

type ClaimedReport = {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  source_format: string;
};

const PDFINFO_TIMEOUT_MS = 60_000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function positiveIntegerFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseArgs(argv: string[]) {
  const once = argv.includes("--once");
  const reportFlagIndex = argv.indexOf("--report");
  const reportEq = argv.find((value) => value.startsWith("--report="));
  const reportId =
    reportFlagIndex !== -1 && argv[reportFlagIndex + 1]
      ? argv[reportFlagIndex + 1]
      : reportEq
        ? reportEq.slice("--report=".length)
        : undefined;
  return { once, reportId };
}

/** 只探测退出码，不解析版本号——版本号的解析在 lib 的 converterVersionString 里。 */
function probeCommand(cmd: string, probeArgs: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, probeArgs, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function detectTools(): Promise<ConverterToolStatus> {
  const [soffice, pdftoppm, pdftotext, pdfinfo] = await Promise.all([
    probeCommand("soffice", ["--version"]),
    probeCommand("pdftoppm", ["-v"]),
    probeCommand("pdftotext", ["-v"]),
    probeCommand("pdfinfo", ["-v"]),
  ]);
  return { soffice, pdftoppm, pdftotext, pdfinfo };
}

/**
 * 只建报告这几张表，不跑全量 db/bootstrap.ts——那份要连视频侧、v0.4 契约等一大
 * 堆不相干的表一起建，离线转换机没有理由为了这几张表牵连那么多东西。
 * db/report-schema.ts 的语句本身是 CREATE TABLE IF NOT EXISTS，幂等、可重复跑。
 */
async function ensureReportSchema(db: DbClient) {
  await db.batch(REPORT_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

async function downloadToFile(objectKey: string, outputPath: string) {
  const object = await getVideoBucket().get(objectKey);
  if (!object.body) {
    throw new Error(`对象 ${objectKey} 不存在或读取不到内容。`);
  }
  await pipeline(
    Readable.fromWeb(object.body as NodeReadableStream<Uint8Array>),
    createWriteStream(outputPath),
  );
}

async function uploadFile(key: string, localPath: string, contentType: string) {
  const stream = Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream<Uint8Array>;
  await getVideoBucket().put(key, stream, { httpMetadata: { contentType } });
}

/**
 * 一条 UPDATE...WHERE id=(SELECT...FOR UPDATE SKIP LOCKED) 原子完成"挑一份排队
 * 中的报告并标记为处理中"，天然是单条语句、单个隐式事务，不依赖 DbClient 是否
 * 支持显式多语句事务——同一时刻多台离线机各跑一份脚本也不会抢到同一份报告。
 * 传 reportId 时只在"这份报告确实是 QUEUED"的前提下抢占，用于 --report 手动重跑。
 */
async function claimNextQueuedReport(db: DbClient, reportId?: string): Promise<ClaimedReport | null> {
  const innerSelect = reportId
    ? `SELECT id FROM reports WHERE id = ? AND status = 'QUEUED' AND deleted_at IS NULL FOR UPDATE SKIP LOCKED`
    : `SELECT id FROM reports WHERE status = 'QUEUED' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
  const sql = `UPDATE reports
    SET status = 'PROCESSING', convert_attempts = convert_attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = (${innerSelect})
    RETURNING id, object_key, original_name, content_type, source_format`;
  const statement = db.prepare(sql);
  return reportId
    ? statement.bind(reportId).first<ClaimedReport>()
    : statement.first<ClaimedReport>();
}

async function markReportFailed(db: DbClient, id: string, reason: string, notes: string[]) {
  await db
    .prepare(
      `UPDATE reports
       SET status = 'FAILED', fail_reason = ?, convert_notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(reason, notes.length ? notes.join("\n") : null, id)
    .run();
}

async function markReportReady(db: DbClient, id: string, pageCount: number, converterVersion: string, notes: string[]) {
  await db
    .prepare(
      `UPDATE reports
       SET status = 'READY', page_count = ?, pages_done = ?, converter_version = ?,
           convert_notes = ?, fail_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(pageCount, pageCount, converterVersion, notes.length ? notes.join("\n") : null, id)
    .run();
}

async function existingPageNumbers(db: DbClient, reportId: string) {
  const rows = await db
    .prepare(`SELECT page_no FROM report_pages WHERE report_id = ?`)
    .bind(reportId)
    .all<{ page_no: number }>();
  return new Set(rows.results.map((row) => Number(row.page_no)));
}

async function upsertPage(
  db: DbClient,
  reportId: string,
  pageNo: number,
  thumbKey: string,
  largeKey: string,
  width: number,
  height: number,
  textExcerpt: string,
  renderStatus: "OK" | "FAILED",
) {
  await db
    .prepare(
      `INSERT INTO report_pages (report_id, page_no, thumb_key, large_key, width, height, text_excerpt, render_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (report_id, page_no) DO UPDATE SET
         thumb_key = EXCLUDED.thumb_key,
         large_key = EXCLUDED.large_key,
         width = EXCLUDED.width,
         height = EXCLUDED.height,
         text_excerpt = EXCLUDED.text_excerpt,
         render_status = EXCLUDED.render_status`,
    )
    .bind(reportId, pageNo, thumbKey, largeKey, width, height, textExcerpt, renderStatus)
    .run();
}

function extensionForSourceFormat(originalName: string, sourceFormat: string) {
  const fromName = path.extname(originalName);
  if (fromName) return fromName;
  if (sourceFormat === "PPT") return ".ppt";
  if (sourceFormat === "PPTX") return ".pptx";
  if (sourceFormat === "PDF") return ".pdf";
  return "";
}

function humanReadableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `转换过程中出现意外错误：${message}`;
}

async function processReport(db: DbClient, runner: ConvertRunner, report: ClaimedReport) {
  const workDir = await mkdtemp(path.join(tmpdir(), `hamark-report-convert-${report.id}-`));
  try {
    const sourceFormat = report.source_format || sourceFormatFromName(report.original_name);
    const originalExt = extensionForSourceFormat(report.original_name, sourceFormat);
    // 固定叫 original.<ext>：soffice --convert-to pdf --outdir 的产物文件名永远是
    // 输入文件去掉扩展名再加 .pdf，叫 original 就永远知道产物叫 original.pdf，
    // 不用扫目录猜文件名。
    const originalPath = path.join(workDir, `original${originalExt}`);
    await downloadToFile(report.object_key, originalPath);

    const notes: string[] = [];
    let pdfPath = originalPath;

    if (sourceFormat === "PPT" || sourceFormat === "PPTX") {
      const outcome = await convertPptToPdf(runner, originalPath, workDir);
      notes.push(...outcome.notes);
      if (!outcome.ok) {
        await markReportFailed(db, report.id, outcome.reason, notes);
        console.error(`[${report.id}] PPT 转 PDF 失败：${outcome.reason}`);
        return;
      }
      pdfPath = path.join(workDir, "original.pdf");
      const derivedKey = derivedPdfObjectKey(report.id);
      await uploadFile(derivedKey, pdfPath, "application/pdf");
      await db.prepare(`UPDATE reports SET derived_pdf_key = ? WHERE id = ?`).bind(derivedKey, report.id).run();
    } else if (sourceFormat !== "PDF") {
      await markReportFailed(
        db,
        report.id,
        `无法识别的文件格式（${report.original_name || "未命名"}），只支持 PPT／PPTX／PDF，请重新上传。`,
        notes,
      );
      return;
    }

    const infoResult = await runner.run("pdfinfo", [pdfPath], { timeoutMs: PDFINFO_TIMEOUT_MS });
    if (infoResult.code !== 0) {
      await markReportFailed(db, report.id, "无法读取 PDF 信息，文件可能已损坏或被加密。", notes);
      return;
    }
    const pageCount = parsePdfinfoPages(infoResult.stdout);
    if (!pageCount) {
      await markReportFailed(db, report.id, "无法读取页数，PDF 可能已损坏。", notes);
      return;
    }
    const pageSize = parsePdfinfoPageSize(infoResult.stdout);
    const thumbDpi = pageSize ? dpiForTargetWidth(pageSize.widthPt, 480) : 96;
    const largeDpi = pageSize ? dpiForTargetWidth(pageSize.widthPt, 1600) : 300;

    await db
      .prepare(`UPDATE reports SET page_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(pageCount, report.id)
      .run();

    // 重试时跳过已经生成过的页——上一次跑到一半失败，不用把已经出好的页再出一遍。
    const alreadyDone = await existingPageNumbers(db, report.id);
    let pagesDone = alreadyDone.size;

    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      if (alreadyDone.has(pageNo)) continue;

      const thumbPrefix = path.join(workDir, `p${pad3(pageNo)}`);
      const largePrefix = path.join(workDir, `p${pad3(pageNo)}@2x`);
      const pageResult = await convertReportPage(runner, {
        pdfPath,
        pageNo,
        thumbOutPrefix: thumbPrefix,
        largeOutPrefix: largePrefix,
        thumbDpi,
        largeDpi,
        timeoutMs: retryPolicy.pageRender.timeoutMs,
      });
      const { thumbKey, largeKey } = pageKeys(report.id, pageNo);

      if (pageResult.renderStatus === "OK") {
        await uploadFile(thumbKey, `${thumbPrefix}.jpg`, "image/jpeg");
        await uploadFile(largeKey, `${largePrefix}.jpg`, "image/jpeg");
        const dims = pageSize ? pixelSizeForDpi(pageSize, largeDpi) : { width: 0, height: 0 };
        await upsertPage(db, report.id, pageNo, thumbKey, largeKey, dims.width, dims.height, pageResult.textExcerpt, "OK");
      } else {
        // 该页降级：不落地图片文件，键位仍按约定命名——工作台按 render_status
        // 判断显示"渲染失败"占位而不是去请求这个 key；下次重试命中同一页时
        // 直接覆盖同一个 key，不产生孤儿对象。
        notes.push(pageResult.reason);
        await upsertPage(db, report.id, pageNo, thumbKey, largeKey, 0, 0, "", "FAILED");
      }

      pagesDone += 1;
      await db
        .prepare(`UPDATE reports SET pages_done = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(pagesDone, report.id)
        .run();
    }

    const converterVersion = await converterVersionString(runner);
    await markReportReady(db, report.id, pageCount, converterVersion, notes);
    console.log(`[${report.id}] READY，共 ${pageCount} 页${notes.length ? `，${notes.length} 条备注` : ""}。`);
  } catch (error) {
    await markReportFailed(db, report.id, humanReadableError(error), []);
    console.error(`[${report.id}] 转换出现异常：`, error);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const { once, reportId } = parseArgs(process.argv.slice(2));
  const pollMs = positiveIntegerFromEnv("REPORT_CONVERT_POLL_MS", 15_000);

  const toolStatus = await detectTools();
  const missing = describeMissingTools(toolStatus);
  if (missing) {
    console.error(missing);
    process.exit(1);
  }

  const db = getDbClient();
  await ensureReportSchema(db);
  const runner = createProcessRunner();

  console.log(
    `report page converter 启动${reportId ? `（仅处理报告 ${reportId}）` : once ? "（--once）" : `（轮询间隔 ${pollMs}ms）`}`,
  );

  for (;;) {
    const claimed = await claimNextQueuedReport(db, reportId);
    if (!claimed) {
      if (reportId) {
        console.log(`报告 ${reportId} 当前不是排队中状态（或不存在），未处理。`);
        return;
      }
      if (once) {
        console.log("没有排队中的报告。");
        return;
      }
      await sleep(pollMs);
      continue;
    }

    await processReport(db, runner, claimed);

    if (once || reportId) return;
  }
}

await main();
