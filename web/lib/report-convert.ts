// 报告转换流水线的纯逻辑：对象键拼装、外部命令的参数构造、命令输出的解析、
// 重试与降级策略。这个文件不碰文件系统、不碰数据库，只碰字符串和注入进来的
// 「执行器」——所以离线机没装 LibreOffice/poppler 的开发机上也能把这些逻辑
// 单测覆盖到。真正 spawn 子进程、下载/上传对象、写库的编排代码在
// scripts/convert-report-pages.ts，那边不再重复判断逻辑，只管调用这里的函数。
//
// 状态机与分级兜底顺序见 docs/19_报告逆向工程_实施规格_V0.1.md 第四节：
//   LibreOffice 正常转换 → 换 --infilter 重试 → 字体替换（不算失败）→
//   单页降级占位 → 才是整份 FAILED。

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// 对象键（3.4 节）：全部由 reportId / pageNo 派生，不额外存储。
// ---------------------------------------------------------------------------

/** 页号补零到 3 位：p7 → p007。 */
export function pad3(pageNo: number): string {
  return String(pageNo).padStart(3, "0");
}

export function originalObjectKey(reportId: string): string {
  return `reports/${reportId}/original`;
}

export function derivedPdfObjectKey(reportId: string): string {
  return `reports/${reportId}/derived.pdf`;
}

export function pageKeys(reportId: string, pageNo: number): { thumbKey: string; largeKey: string } {
  const n = pad3(pageNo);
  return {
    thumbKey: `reports/${reportId}/pages/p${n}.jpg`,
    largeKey: `reports/${reportId}/pages/p${n}@2x.jpg`,
  };
}

/** 按文件名后缀判断来源格式；上传口只收这三种，认不出的返回空串。 */
export function sourceFormatFromName(name: string): "PPT" | "PPTX" | "PDF" | "" {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "ppt") return "PPT";
  if (ext === "pptx") return "PPTX";
  if (ext === "pdf") return "PDF";
  return "";
}

// ---------------------------------------------------------------------------
// 外部命令参数构造：全部返回参数数组，不拼 shell 字符串，避免转义问题。
// ---------------------------------------------------------------------------

/** 第 2 次起改按固定格式解析，绕过 soffice 对损坏/非标文件的自动探测误判。 */
function inFilterForSourceFormat(format: ReturnType<typeof sourceFormatFromName>): string | null {
  if (format === "PPT") return "MS PowerPoint 97";
  if (format === "PPTX") return "Impress MS PowerPoint 2007 XML";
  return null;
}

/**
 * `attempt` 从 1 开始。第 1 次按 soffice 自动探测转；第 2、3 次强制加
 * `--infilter`（按 `input` 的扩展名选具体值），绕开自动探测对损坏/非标文件
 * 的误判。`--headless` 系列参数是 LibreOffice 无界面批量转换的固定写法。
 */
export function buildSofficeArgs(input: string, outDir: string, attempt: number): string[] {
  const args = ["--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard"];
  if (attempt >= 2) {
    const filter = inFilterForSourceFormat(sourceFormatFromName(input));
    if (filter) args.push(`--infilter=${filter}`);
  }
  args.push("--convert-to", "pdf", "--outdir", outDir, input);
  return args;
}

/**
 * 单页出两档图靠调两次：一次给缩略图 dpi、一次给大图 dpi。`-singlefile` 让
 * 输出文件名就是 `outPrefix.jpg`，不会因为 `-f/-l` 只框一页还带页号后缀，
 * 调用方不用猜文件名。
 */
export function buildPdftoppmArgs(pdf: string, pageNo: number, outPrefix: string, dpi: number): string[] {
  return ["-jpeg", "-r", String(dpi), "-f", String(pageNo), "-l", String(pageNo), "-singlefile", pdf, outPrefix];
}

/**
 * `out` 传 `"-"` 时 pdftotext 直接写 stdout，配合注入的执行器可以不落地临时
 * 文件就拿到文本——`extractPageExcerpt` 就是这么用的。
 */
export function buildPdftotextArgs(pdf: string, pageNo: number, out: string): string[] {
  return ["-f", String(pageNo), "-l", String(pageNo), "-layout", pdf, out];
}

// ---------------------------------------------------------------------------
// 命令输出解析
// ---------------------------------------------------------------------------

export function parsePdfinfoPages(stdout: string): number | null {
  const match = stdout.match(/^Pages:\s*(\d+)\s*$/m);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** `pdfinfo`（不带 -f/-l）报的是第一页的版面尺寸，供估算全篇统一的渲染 dpi 用。 */
export function parsePdfinfoPageSize(stdout: string): { widthPt: number; heightPt: number } | null {
  const match = stdout.match(/^Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/m);
  if (!match) return null;
  const widthPt = Number(match[1]);
  const heightPt = Number(match[2]);
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt) || widthPt <= 0 || heightPt <= 0) return null;
  return { widthPt, heightPt };
}

/** 目标像素宽换算成 pdftoppm 的 `-r`（dpi）：dpi = 目标宽 / (页宽点数/72)。 */
export function dpiForTargetWidth(pageWidthPt: number, targetWidthPx: number): number {
  if (!Number.isFinite(pageWidthPt) || pageWidthPt <= 0) return 96;
  return Math.max(36, Math.round((targetWidthPx * 72) / pageWidthPt));
}

export function pixelSizeForDpi(
  sizePt: { widthPt: number; heightPt: number },
  dpi: number,
): { width: number; height: number } {
  return {
    width: Math.round((sizePt.widthPt / 72) * dpi),
    height: Math.round((sizePt.heightPt / 72) * dpi),
  };
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** 工作台来源信息里的"页摘录"：首个非空行，取前 80 字。 */
export function excerptFromText(text: string): string {
  return firstNonEmptyLine(text).slice(0, 80);
}

/** 从 soffice 的合并输出里挑出疑似字体替换的行，原样留给 convert_notes。 */
export function collectFontSubstitutionNotes(log: string): string[] {
  const notes: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (/font/i.test(line) && /(not found|missing|substitut|fallback|replac)/i.test(line)) {
      const trimmed = line.trim();
      if (trimmed) notes.push(trimmed);
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// 缺工具时的中文提示（探测本身在 scripts/ 里做，这里只管拼可读的报错文案）。
// ---------------------------------------------------------------------------

export type ConverterToolStatus = {
  soffice: boolean;
  pdftoppm: boolean;
  pdftotext: boolean;
  pdfinfo: boolean;
};

const TOOL_LABELS: Record<keyof ConverterToolStatus, string> = {
  soffice: "LibreOffice（soffice）",
  pdftoppm: "poppler 的 pdftoppm",
  pdftotext: "poppler 的 pdftotext",
  pdfinfo: "poppler 的 pdfinfo",
};

/** 全部齐全返回 null；缺什么就在返回的中文提示里点名，脚本据此直接退出。 */
export function describeMissingTools(status: ConverterToolStatus): string | null {
  const missing = (Object.keys(status) as (keyof ConverterToolStatus)[])
    .filter((key) => !status[key])
    .map((key) => TOOL_LABELS[key]);
  if (missing.length === 0) return null;
  return `缺少以下命令行工具，请先安装：${missing.join("、")}。参见 scripts/README-report-convert.md。`;
}

// ---------------------------------------------------------------------------
// 重试策略（第四节）
// ---------------------------------------------------------------------------

export const retryPolicy = {
  /** PPT/PPTX → PDF：最多 3 次，每次独立超时；第 2 次起带 --infilter。 */
  pptToPdf: {
    maxAttempts: 3,
    timeoutMs: 30 * 60 * 1000,
  },
  /** 单页渲染：失败就降级占位、记录原因，不重试、不中断整份。 */
  pageRender: {
    timeoutMs: 5 * 60 * 1000,
    placeholderOnFailure: true,
  },
} as const;

// ---------------------------------------------------------------------------
// 可注入的执行器
// ---------------------------------------------------------------------------

export type ConvertRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export interface ConvertRunner {
  run(cmd: string, args: string[], options: { timeoutMs: number }): Promise<ConvertRunResult>;
}

/** 生产环境用的实现：真 spawn 子进程，超时就 SIGKILL——LibreOffice 卡死是常态，杀掉重来比等着靠谱。 */
export function createProcessRunner(): ConvertRunner {
  return {
    run(cmd, args, { timeoutMs }) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr: stderr || String(error), timedOut });
        });
        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        });
      });
    },
  };
}

function describeFailure(result: ConvertRunResult): string {
  return result.timedOut ? "超时" : `退出码 ${result.code}`;
}

/** `soffice --version` 与 `pdftoppm -v` 的输出拼一串，日后换渲染器能认出哪些报告要重出图。 */
export async function converterVersionString(runner: ConvertRunner): Promise<string> {
  const soffice = await runner.run("soffice", ["--version"], { timeoutMs: 30_000 });
  const pdftoppm = await runner.run("pdftoppm", ["-v"], { timeoutMs: 10_000 });
  const sofficeVersion = firstNonEmptyLine(soffice.stdout) || firstNonEmptyLine(soffice.stderr) || "soffice 版本未知";
  const pdftoppmVersion = firstNonEmptyLine(pdftoppm.stdout) || firstNonEmptyLine(pdftoppm.stderr) || "poppler 版本未知";
  return `${sofficeVersion} | ${pdftoppmVersion}`;
}

// ---------------------------------------------------------------------------
// PPT/PPTX → PDF：能救就救，三次仍失败才 FAILED。
// ---------------------------------------------------------------------------

export type SofficeConvertOutcome =
  | { ok: true; attempts: number; notes: string[] }
  | { ok: false; attempts: number; reason: string; notes: string[] };

/**
 * 第 1 次按自动探测转；失败（含超时/崩溃）就换 `--infilter` 强制解析重试；
 * 三次都失败才判定整份 FAILED，原因写成人能看懂的中文，并给"改传 PDF"的台阶。
 * 字体替换不算失败，只把疑似字体替换的行收进 notes，由调用方写进
 * `convert_notes`（不进 `fail_reason`，卡片上不报错）。
 */
export async function convertPptToPdf(
  runner: ConvertRunner,
  input: string,
  outDir: string,
): Promise<SofficeConvertOutcome> {
  const notes: string[] = [];
  const { maxAttempts, timeoutMs } = retryPolicy.pptToPdf;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const args = buildSofficeArgs(input, outDir, attempt);
    const result = await runner.run("soffice", args, { timeoutMs });
    notes.push(...collectFontSubstitutionNotes(`${result.stdout}\n${result.stderr}`));

    if (result.code === 0) {
      return { ok: true, attempts: attempt, notes };
    }
    notes.push(`第 ${attempt} 次转换失败（${describeFailure(result)}）`);
  }

  return {
    ok: false,
    attempts: maxAttempts,
    reason:
      "PPT 转 PDF 失败，已重试 3 次仍未成功，文件可能已损坏、被加密，或包含无法渲染的嵌入对象；可以改传 PDF 后重新上传。",
    notes,
  };
}

// ---------------------------------------------------------------------------
// 单页渲染：失败就降级占位，不中断整份。
// ---------------------------------------------------------------------------

export type PageImageOutcome = { ok: true } | { ok: false; reason: string };

/** 缩略图、大图各调一次 pdftoppm；哪一档失败就整页判失败，调用方转用占位图。 */
export async function renderPageImages(
  runner: ConvertRunner,
  params: {
    pdfPath: string;
    pageNo: number;
    thumbOutPrefix: string;
    largeOutPrefix: string;
    thumbDpi: number;
    largeDpi: number;
    timeoutMs: number;
  },
): Promise<PageImageOutcome> {
  const { pdfPath, pageNo, thumbOutPrefix, largeOutPrefix, thumbDpi, largeDpi, timeoutMs } = params;

  const thumb = await runner.run("pdftoppm", buildPdftoppmArgs(pdfPath, pageNo, thumbOutPrefix, thumbDpi), {
    timeoutMs,
  });
  if (thumb.code !== 0) {
    return {
      ok: false,
      reason: `第 ${pageNo} 页缩略图生成失败（${describeFailure(thumb)}），该页改用占位图，其余页照常生成。`,
    };
  }

  const large = await runner.run("pdftoppm", buildPdftoppmArgs(pdfPath, pageNo, largeOutPrefix, largeDpi), {
    timeoutMs,
  });
  if (large.code !== 0) {
    return {
      ok: false,
      reason: `第 ${pageNo} 页大图生成失败（${describeFailure(large)}），该页改用占位图，其余页照常生成。`,
    };
  }

  return { ok: true };
}

export type PageExcerptOutcome = { ok: true; excerpt: string } | { ok: false; excerpt: "" };

/** `pdftotext` 输出直接写 stdout（`out="-"`），不用先落地文件再读。 */
export async function extractPageExcerpt(
  runner: ConvertRunner,
  params: { pdfPath: string; pageNo: number; timeoutMs: number },
): Promise<PageExcerptOutcome> {
  const result = await runner.run("pdftotext", buildPdftotextArgs(params.pdfPath, params.pageNo, "-"), {
    timeoutMs: params.timeoutMs,
  });
  if (result.code !== 0) return { ok: false, excerpt: "" };
  return { ok: true, excerpt: excerptFromText(result.stdout) };
}

export type ConvertPageResult =
  | { pageNo: number; renderStatus: "OK"; textExcerpt: string }
  | { pageNo: number; renderStatus: "FAILED"; reason: string };

/**
 * 单页的完整流水：出图失败直接判该页 FAILED（占位图由调用方落地）；出图成功
 * 但摘录失败不算该页失败，摘录留空——摘录只是锦上添花，不是页图的一部分。
 */
export async function convertReportPage(
  runner: ConvertRunner,
  params: {
    pdfPath: string;
    pageNo: number;
    thumbOutPrefix: string;
    largeOutPrefix: string;
    thumbDpi: number;
    largeDpi: number;
    timeoutMs: number;
  },
): Promise<ConvertPageResult> {
  const images = await renderPageImages(runner, params);
  if (!images.ok) {
    return { pageNo: params.pageNo, renderStatus: "FAILED", reason: images.reason };
  }
  const text = await extractPageExcerpt(runner, {
    pdfPath: params.pdfPath,
    pageNo: params.pageNo,
    timeoutMs: params.timeoutMs,
  });
  return { pageNo: params.pageNo, renderStatus: "OK", textExcerpt: text.ok ? text.excerpt : "" };
}
