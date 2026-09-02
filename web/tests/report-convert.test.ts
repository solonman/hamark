import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPdftoppmArgs,
  buildPdftotextArgs,
  buildSofficeArgs,
  collectFontSubstitutionNotes,
  type ConvertRunner,
  type ConvertRunResult,
  convertPptToPdf,
  convertReportPage,
  describeMissingTools,
  dpiForTargetWidth,
  excerptFromText,
  extractPageExcerpt,
  originalObjectKey,
  derivedPdfObjectKey,
  pad3,
  pageKeys,
  parsePdfinfoPages,
  parsePdfinfoPageSize,
  pixelSizeForDpi,
  renderPageImages,
  retryPolicy,
  sourceFormatFromName,
} from "../lib/report-convert.ts";

// ---------------------------------------------------------------------------
// 对象键与格式判定
// ---------------------------------------------------------------------------

test("page numbers pad to 3 digits and derive the thumb/large object keys", () => {
  assert.equal(pad3(7), "007");
  assert.equal(pad3(120), "120");
  assert.deepEqual(pageKeys("r1", 7), {
    thumbKey: "reports/r1/pages/p007.jpg",
    largeKey: "reports/r1/pages/p007@2x.jpg",
  });
  assert.equal(originalObjectKey("r1"), "reports/r1/original");
  assert.equal(derivedPdfObjectKey("r1"), "reports/r1/derived.pdf");
});

test("source format comes from the file extension, unrecognized extensions are empty", () => {
  assert.equal(sourceFormatFromName("红谷滩策略.ppt"), "PPT");
  assert.equal(sourceFormatFromName("浦江镇提报.PPTX"), "PPTX");
  assert.equal(sourceFormatFromName("北蔡总结.pdf"), "PDF");
  assert.equal(sourceFormatFromName("说明.docx"), "");
  assert.equal(sourceFormatFromName("没有后缀"), "");
});

// ---------------------------------------------------------------------------
// 外部命令参数构造
// ---------------------------------------------------------------------------

test("soffice args only add --infilter from the 2nd attempt, matching the file's own extension", () => {
  const first = buildSofficeArgs("/tmp/in/deck.ppt", "/tmp/out", 1);
  assert.ok(!first.some((arg) => arg.startsWith("--infilter")));
  const convertIdx = first.indexOf("--convert-to");
  assert.ok(convertIdx >= 0);
  assert.deepEqual(first.slice(convertIdx, convertIdx + 4), ["--convert-to", "pdf", "--outdir", "/tmp/out"]);
  assert.equal(first.at(-1), "/tmp/in/deck.ppt");

  const secondPpt = buildSofficeArgs("/tmp/in/deck.ppt", "/tmp/out", 2);
  assert.ok(secondPpt.includes("--infilter=MS PowerPoint 97"));

  const secondPptx = buildSofficeArgs("/tmp/in/deck.pptx", "/tmp/out", 2);
  assert.ok(secondPptx.includes("--infilter=Impress MS PowerPoint 2007 XML"));

  // PDF 直传不会走 soffice，但函数本身对认不出后缀的文件也不该崩，只是不加 --infilter。
  const unknownExt = buildSofficeArgs("/tmp/in/deck.pdf", "/tmp/out", 3);
  assert.ok(!unknownExt.some((arg) => arg.startsWith("--infilter")));
});

test("pdftoppm args render exactly one page per call and force a predictable filename", () => {
  const args = buildPdftoppmArgs("/tmp/in.pdf", 12, "/tmp/out/p012", 480);
  assert.deepEqual(args, ["-jpeg", "-r", "480", "-f", "12", "-l", "12", "-singlefile", "/tmp/in.pdf", "/tmp/out/p012"]);
});

test("pdftotext args request layout-preserving text for exactly one page", () => {
  const args = buildPdftotextArgs("/tmp/in.pdf", 3, "-");
  assert.deepEqual(args, ["-f", "3", "-l", "3", "-layout", "/tmp/in.pdf", "-"]);
});

// ---------------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------------

test("pdfinfo page count parses the Pages line and rejects garbage", () => {
  const stdout = "Title:          示例\nPages:          235\nEncrypted:      no\n";
  assert.equal(parsePdfinfoPages(stdout), 235);
  assert.equal(parsePdfinfoPages("no such line here"), null);
  assert.equal(parsePdfinfoPages("Pages:          0"), null);
});

test("pdfinfo page size parses width/height in points", () => {
  const stdout = "Page size:      960 x 540 pts\nPage rot:       0\n";
  assert.deepEqual(parsePdfinfoPageSize(stdout), { widthPt: 960, heightPt: 540 });
  assert.equal(parsePdfinfoPageSize("nothing useful"), null);
});

test("dpi is derived from the target pixel width against the page's point width", () => {
  // 960pt 宽的标准 16:9 页面，要出 480px 缩略图：480 / (960/72) = 36dpi。
  assert.equal(dpiForTargetWidth(960, 480), 36);
  // 同一页出 1600px 大图：1600 / (960/72) = 120dpi。
  assert.equal(dpiForTargetWidth(960, 1600), 120);
  // 页宽信息缺失时退回一个保守默认值，而不是抛错或出 0dpi 的空白图。
  assert.equal(dpiForTargetWidth(0, 480), 96);
  assert.equal(dpiForTargetWidth(-10, 480), 96);
});

test("pixel size scales the point size by dpi/72", () => {
  assert.deepEqual(pixelSizeForDpi({ widthPt: 960, heightPt: 540 }, 120), { width: 1600, height: 900 });
});

test("excerpt takes the first non-empty line, capped at 80 characters", () => {
  assert.equal(excerptFromText("\n\n  \n第一段真正有内容的话，后面还有很多字\n第二行"), "第一段真正有内容的话，后面还有很多字");
  const longLine = "字".repeat(120);
  assert.equal(excerptFromText(longLine), "字".repeat(80));
  assert.equal(excerptFromText("   \n\t\n"), "");
});

test("font substitution notes are picked out of a soffice log without touching unrelated lines", () => {
  const log = [
    "convert /tmp/deck.pptx as a Impress document -> /tmp/deck.pdf using filter",
    "Warning: font 'PingFangSC' not found, substituting with Noto Sans CJK",
    "some unrelated informational line",
    "font 微软雅黑 missing, using fallback 思源黑体",
  ].join("\n");
  const notes = collectFontSubstitutionNotes(log);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /PingFangSC/);
  assert.match(notes[1], /微软雅黑/);
});

test("missing tool message names every absent tool in Chinese, or is null when all present", () => {
  assert.equal(
    describeMissingTools({ soffice: true, pdftoppm: true, pdftotext: true, pdfinfo: true }),
    null,
  );
  const message = describeMissingTools({ soffice: false, pdftoppm: true, pdftotext: false, pdfinfo: true });
  assert.match(message ?? "", /LibreOffice（soffice）/);
  assert.match(message ?? "", /pdftotext/);
  assert.doesNotMatch(message ?? "", /pdftoppm/);
});

// ---------------------------------------------------------------------------
// 重试策略常量
// ---------------------------------------------------------------------------

test("retry policy matches the spec: 3 attempts / 30 minutes each, page failures never retry", () => {
  assert.equal(retryPolicy.pptToPdf.maxAttempts, 3);
  assert.equal(retryPolicy.pptToPdf.timeoutMs, 30 * 60 * 1000);
  assert.equal(retryPolicy.pageRender.placeholderOnFailure, true);
});

// ---------------------------------------------------------------------------
// 注入假执行器，验证重试与降级的实际行为
// ---------------------------------------------------------------------------

function ok(stdout = ""): ConvertRunResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}
function timedOutResult(): ConvertRunResult {
  return { code: null, stdout: "", stderr: "", timedOut: true };
}
function failed(code = 1, stderr = ""): ConvertRunResult {
  return { code, stdout: "", stderr, timedOut: false };
}

/** 记录每次调用，按 `cmd` 分别喂预设好的结果序列；序列用完后一直返回最后一个。 */
function scriptedRunner(script: Record<string, ConvertRunResult[]>): ConvertRunner & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const cursors: Record<string, number> = {};
  return {
    calls,
    async run(cmd, args) {
      calls.push({ cmd, args });
      const queue = script[cmd] ?? [];
      const index = cursors[cmd] ?? 0;
      const result = queue[Math.min(index, queue.length - 1)] ?? ok();
      cursors[cmd] = index + 1;
      return result;
    },
  };
}

test("soffice retry: 1st attempt times out, 2nd attempt with --infilter succeeds", async () => {
  const runner = scriptedRunner({ soffice: [timedOutResult(), ok()] });
  const outcome = await convertPptToPdf(runner, "/tmp/deck.pptx", "/tmp/out");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.attempts, 2);
  }
  assert.equal(runner.calls.length, 2);
  assert.ok(!runner.calls[0].args.some((arg) => arg.startsWith("--infilter")));
  assert.ok(runner.calls[1].args.includes("--infilter=Impress MS PowerPoint 2007 XML"));
});

test("soffice retry: all 3 attempts fail returns a human-readable reason and suggests switching to PDF", async () => {
  const runner = scriptedRunner({ soffice: [failed(1), failed(1), timedOutResult()] });
  const outcome = await convertPptToPdf(runner, "/tmp/deck.ppt", "/tmp/out");
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.attempts, 3);
    assert.match(outcome.reason, /改传 PDF/);
    assert.equal(outcome.notes.filter((n) => n.includes("第")).length, 3);
  }
  assert.equal(runner.calls.length, 3);
});

test("soffice retry: font substitution lines are collected as notes without failing the conversion", async () => {
  const runner = scriptedRunner({
    soffice: [{ code: 0, stdout: "", stderr: "font 'Arial' not found, substituting with 思源黑体", timedOut: false }],
  });
  const outcome = await convertPptToPdf(runner, "/tmp/deck.pptx", "/tmp/out");
  assert.equal(outcome.ok, true);
  assert.ok(outcome.notes.some((n) => n.includes("Arial")));
});

test("a single failed page is marked FAILED while the rest of the deck keeps going", async () => {
  const runner = scriptedRunner({
    // 第 1、3 页两次 pdftoppm 都成功；第 2 页第一次调用（缩略图）失败。
    pdftoppm: [ok(), ok(), failed(2, "poppler error"), ok(), ok()],
    pdftotext: [ok("第一页正文\n"), ok("第三页正文\n")],
  });

  const results = [];
  for (const pageNo of [1, 2, 3]) {
    results.push(
      await convertReportPage(runner, {
        pdfPath: "/tmp/in.pdf",
        pageNo,
        thumbOutPrefix: `/tmp/out/p${pad3(pageNo)}`,
        largeOutPrefix: `/tmp/out/p${pad3(pageNo)}@2x`,
        thumbDpi: 96,
        largeDpi: 300,
        timeoutMs: 1000,
      }),
    );
  }

  assert.equal(results[0].renderStatus, "OK");
  assert.equal(results[1].renderStatus, "FAILED");
  assert.equal(results[2].renderStatus, "OK");
  if (results[1].renderStatus === "FAILED") {
    assert.match(results[1].reason, /第 2 页/);
    assert.match(results[1].reason, /占位图/);
  }
  if (results[0].renderStatus === "OK") {
    assert.equal(results[0].textExcerpt, "第一页正文");
  }
  // 失败页不该再去跑 pdftotext——图都出不了，摘录没有意义。
  assert.equal(runner.calls.filter((c) => c.cmd === "pdftotext").length, 2);
});

test("renderPageImages fails on the large image even when the thumbnail succeeded", async () => {
  const runner = scriptedRunner({ pdftoppm: [ok(), failed(1)] });
  const outcome = await renderPageImages(runner, {
    pdfPath: "/tmp/in.pdf",
    pageNo: 5,
    thumbOutPrefix: "/tmp/out/p005",
    largeOutPrefix: "/tmp/out/p005@2x",
    thumbDpi: 96,
    largeDpi: 300,
    timeoutMs: 1000,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.reason, /大图/);
  }
});

test("extractPageExcerpt reads pdftotext's stdout and truncates like excerptFromText", async () => {
  const runner = scriptedRunner({ pdftotext: [ok("   \n招商策略核心结论：抢占区域第一\n下一行")] });
  const outcome = await extractPageExcerpt(runner, { pdfPath: "/tmp/in.pdf", pageNo: 1, timeoutMs: 1000 });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.excerpt, "招商策略核心结论：抢占区域第一");
  }
});

test("extractPageExcerpt returns an empty excerpt (not a failure) when pdftotext itself fails", async () => {
  const runner = scriptedRunner({ pdftotext: [failed(1)] });
  const outcome = await extractPageExcerpt(runner, { pdfPath: "/tmp/in.pdf", pageNo: 1, timeoutMs: 1000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.excerpt, "");
});
