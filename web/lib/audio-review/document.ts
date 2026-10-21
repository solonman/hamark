// 文字点评（docs/25 二之二）：把上传的文档读成按段落切好的「文字稿」，走和录音转写同一份
// transcript_json。流水线的 TRANSCRIBING 这一步对文档就是这里——不调腾讯云。
//
//   - .docx：不加依赖，自己读 ZIP。找 End of Central Directory → 中央目录 → 正文部件
//     （word/document.xml；没有时按 _rels/.rels 里的 officeDocument 关系找）的本地文件头，
//     方法 0（存储）直接取、方法 8 用 node:zlib 的 inflateRawSync 解压。再按 <w:p> 取段落：
//     段内拼接所有 <w:t> 的文字，<w:tab/> 记制表、<w:br/>/<w:cr/> 记换行，表格里的段落照样取；
//     修订里删掉的字（<w:delText>）和域代码（<w:instrText>）不算；文本框在 mc:Fallback 里的
//     重复副本跳过。
//   - .txt / .md：先按 UTF-8（fatal，自动去 BOM）读，读不通再按 GB18030；带 UTF-16 BOM 的按 UTF-16。
//   - 统一切段：按换行切，去首尾空白，丢空行，保留原顺序。
//
// 失败（读不出字、超过 10 万字、ZIP 损坏、不是 Word 文档……）一律返回带中文原因的结果，不抛。
// 除了读存储流的 readAudioReviewObjectBytes，全是纯函数，单测在 tests/audio-review-document.test.ts。

import { inflateRawSync } from "node:zlib";
import {
  AUDIO_REVIEW_DOCUMENT_MAX_BYTES,
  AUDIO_REVIEW_DOCUMENT_MAX_CHARS,
  AUDIO_REVIEW_DOCX_CONTENT_TYPE,
} from "@/lib/audio-review-model";
import type { AudioReviewTranscriptSegment } from "./transcript";

/** 文档「文字稿」的 engine：区别于腾讯云的引擎名，排查时一眼看出这份文字稿是读文档来的。 */
export const AUDIO_REVIEW_DOCUMENT_ENGINE = "DOCUMENT";

/** 给人看的失败原因（写进 fail_reason）。 */
export const AUDIO_REVIEW_DOCUMENT_REASONS = {
  empty: "文档里没有读到文字。",
  tooLong: `文档超过 ${AUDIO_REVIEW_DOCUMENT_MAX_CHARS / 10_000} 万字，请只保留这份作业的点评后重传。`,
  tooLarge: `文档超过 ${AUDIO_REVIEW_DOCUMENT_MAX_BYTES / 1024 / 1024}MB，请只保留这份作业的点评后重传。`,
  brokenDocx: "Word 文件无法打开，请另存为 .docx 后重传。",
  legacyDoc: "Word 文件无法打开（可能是老格式 .doc 改了扩展名，或设置了打开密码），请另存为 .docx 后重传。",
  encrypted: "Word 文件设置了加密，请去掉密码、另存为 .docx 后重传。",
  notWord: "这个文件不是 Word 文档（没有找到正文），请另存为 .docx 后重传。",
  undecodable: "读不出文档里的文字（编码无法识别），请另存为 UTF-8 编码的 .txt 后重传，或直接粘贴文字。",
  unsupported: "暂不支持这种文档格式，请另存为 .docx 或直接粘贴文字。",
  missing: "没有找到上传的文档，请重新上传。",
  storage: "读取文档失败（存储暂时不可用），请重试。",
} as const;

export type AudioReviewDocumentParseResult =
  | { ok: true; paragraphs: string[]; charCount: number }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 按存进库的 Content-Type 解析（建任务时由扩展名推出，见 audioReviewDocumentContentType）。 */
export function parseAudioReviewDocument(bytes: Uint8Array, contentType: string): AudioReviewDocumentParseResult {
  const type = contentType.trim().toLowerCase().split(";")[0];
  let text: string;
  if (type === AUDIO_REVIEW_DOCX_CONTENT_TYPE) {
    const docx = extractDocxText(bytes);
    if (!docx.ok) return docx;
    text = docx.text;
  } else if (type === "text/plain" || type === "text/markdown") {
    const decoded = decodeAudioReviewTextDocument(bytes);
    if (decoded === null) return { ok: false, reason: AUDIO_REVIEW_DOCUMENT_REASONS.undecodable };
    text = decoded;
  } else {
    return { ok: false, reason: AUDIO_REVIEW_DOCUMENT_REASONS.unsupported };
  }
  return finishAudioReviewDocument(text);
}

/** 切段 + 空文档 / 超长检查。 */
export function finishAudioReviewDocument(text: string): AudioReviewDocumentParseResult {
  const paragraphs = splitAudioReviewDocumentParagraphs(text);
  if (paragraphs.length === 0) return { ok: false, reason: AUDIO_REVIEW_DOCUMENT_REASONS.empty };
  // 按字（码点）数，不算段落之间的换行。
  const charCount = paragraphs.reduce((total, paragraph) => total + Array.from(paragraph).length, 0);
  if (charCount > AUDIO_REVIEW_DOCUMENT_MAX_CHARS) return { ok: false, reason: AUDIO_REVIEW_DOCUMENT_REASONS.tooLong };
  return { ok: true, paragraphs, charCount };
}

/** 按换行切，去首尾空白（含全角空格），丢空行，保留原顺序。 */
export function splitAudioReviewDocumentParagraphs(text: string): string[] {
  return text
    .split(/\r\n|[\r\n\u2028\u2029\f\v]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 段落 → transcript_json 的片段：编号从 1 起就是段落号；没有时间，说话人一律记 S0（默认都是老孙）。 */
export function audioReviewDocumentSegments(paragraphs: readonly string[]): AudioReviewTranscriptSegment[] {
  return paragraphs.map((text, index) => ({ id: index + 1, startMs: 0, endMs: 0, speakerId: "S0", text }));
}

/** 把存储读回来的流收成字节；超过上限就停下（返回 null），不把超大文件读进内存。 */
export async function readAudioReviewObjectBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number = AUDIO_REVIEW_DOCUMENT_MAX_BYTES,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 纯文本
// ---------------------------------------------------------------------------

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * .txt / .md 的文字。先 UTF-8（去 BOM），读不通再 GB18030（Windows 记事本「ANSI」存的中文）；
 * 带 UTF-16 BOM 的（记事本「Unicode」）按 UTF-16。读出来含 NUL 的不是文字文件，按读不出处理。
 */
export function decodeAudioReviewTextDocument(bytes: Uint8Array): string | null {
  let text: string | null;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = tryDecode("utf-16le", bytes);
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = tryDecode("utf-16be", bytes);
  else text = tryDecode("utf-8", bytes) ?? tryDecode("gb18030", bytes);
  if (text === null || text.includes("\u0000")) return null;
  return text;
}

// ---------------------------------------------------------------------------
// .docx：ZIP
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** 解压后的正文 XML 不超过这么大（防 ZIP 炸弹；10 万字的正文连标签也远到不了）。 */
export const AUDIO_REVIEW_DOCX_XML_MAX_BYTES = 64 * 1024 * 1024;
/** 老格式 .doc（以及加密的 .docx）是 OLE 复合文件，开头是这 8 个字节。 */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

type ZipRead = { ok: true; data: Uint8Array } | { ok: false; problem: "BROKEN" | "ENCRYPTED" };

function viewOf(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 中央目录里的全部条目；不是 ZIP、目录损坏、ZIP64（.docx 用不到）都返回 null。 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < EOCD_MIN_SIZE) return null;
  const view = viewOf(bytes);
  // EOCD 在文件末尾，后面最多跟 65535 字节的注释。
  const lowest = Math.max(0, bytes.length - EOCD_MIN_SIZE - 0xffff);
  let eocd = -1;
  for (let index = bytes.length - EOCD_MIN_SIZE; index >= lowest; index -= 1) {
    if (view.getUint32(index, true) !== EOCD_SIGNATURE) continue;
    if (index + EOCD_MIN_SIZE + view.getUint16(index + 20, true) <= bytes.length) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff || directoryOffset + directorySize > eocd) return null;

  const names = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) return null;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    if (cursor + 46 + nameLength > eocd) return null;
    entries.push({
      name: names.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      flags: view.getUint16(cursor + 8, true),
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localHeaderOffset: view.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 取一个条目的内容：方法 0 原样、方法 8 解压；大小以中央目录为准（本地头可能因数据描述符记 0）。 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxOutputBytes = AUDIO_REVIEW_DOCX_XML_MAX_BYTES): ZipRead {
  if (entry.flags & 0x1) return { ok: false, problem: "ENCRYPTED" };
  const view = viewOf(bytes);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_SIGNATURE) return { ok: false, problem: "BROKEN" };
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) return { ok: false, problem: "BROKEN" };
  const raw = bytes.subarray(start, end);
  if (entry.method === 0) return { ok: true, data: raw };
  if (entry.method !== 8) return { ok: false, problem: "BROKEN" };
  try {
    const inflated = inflateRawSync(raw, { maxOutputLength: maxOutputBytes });
    return { ok: true, data: new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength) };
  } catch {
    return { ok: false, problem: "BROKEN" };
  }
}

const MAIN_DOCUMENT_PATH = "word/document.xml";

/** 正文部件的路径：照例是 word/document.xml；个别软件另起名字时按 _rels/.rels 的 officeDocument 关系找。 */
function mainDocumentEntry(bytes: Uint8Array, entries: readonly ZipEntry[]): ZipEntry | null {
  const direct = entries.find((entry) => entry.name === MAIN_DOCUMENT_PATH);
  if (direct) return direct;
  const rels = entries.find((entry) => entry.name === "_rels/.rels");
  if (!rels) return null;
  const read = readZipEntry(bytes, rels);
  if (!read.ok) return null;
  const xml = new TextDecoder("utf-8").decode(read.data);
  for (const tag of xml.match(/<(?:\w+:)?Relationship\b[^>]*>/g) ?? []) {
    const type = /\bType\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? "";
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? "";
    if (!type.endsWith("/officeDocument") || !target) continue;
    const path = decodeXmlEntities(target).replace(/^\/+/, "");
    return entries.find((entry) => entry.name === path) ?? null;
  }
  return null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** .docx → 段落之间用换行连起来的文字（切段交给 finishAudioReviewDocument）。 */
export function extractDocxText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  const entries = listZipEntries(bytes);
  if (!entries) {
    return {
      ok: false,
      reason: startsWith(bytes, OLE_SIGNATURE) ? AUDIO_REVIEW_DOCUMENT_REASONS.legacyDoc : AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx,
    };
  }
  const main = mainDocumentEntry(bytes, entries);
  if (!main) return { ok: false, reason: AUDIO_REVIEW_DOCUMENT_REASONS.notWord };
  const read = readZipEntry(bytes, main);
  if (!read.ok) {
    return { ok: false, reason: read.problem === "ENCRYPTED" ? AUDIO_REVIEW_DOCUMENT_REASONS.encrypted : AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx };
  }
  const xml = new TextDecoder("utf-8").decode(read.data);
  if (!/<w:body[\s>/]/.test(xml)) return { ok: false, reason: AUDIO_REVIEW_DOCUMENT_REASONS.notWord };
  return { ok: true, text: extractWordParagraphs(xml).join("\n") };
}

// ---------------------------------------------------------------------------
// .docx：正文 XML → 段落
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** XML 实体：五个预定义实体，以及 &#十进制; / &#x十六进制;。认不出的原样保留。 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

// 注释 | CDATA | 声明与处理指令 | 标签（属性值里允许出现 >）| 文字
const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

/**
 * 按 <w:p> 取段落，段内拼接 <w:t> 的文字。<w:tab/>、<w:br/>、<w:cr/> 只在 <w:r> 里才算
 * （段落属性 <w:tabs> 里的 <w:tab> 是制表位定义，不是字符）。文本框里的段落嵌在外层段落的
 * run 里，先于外层段落结束，所以排在外层段落前面；mc:Fallback 里的旧式副本跳过，免得重复。
 */
export function extractWordParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  const open: string[][] = [];
  let runDepth = 0;
  let textDepth = 0;
  let fallbackDepth = 0;
  const append = (value: string) => {
    if (open.length) open[open.length - 1].push(value);
  };
  XML_TOKEN.lastIndex = 0;
  for (let match = XML_TOKEN.exec(xml); match; match = XML_TOKEN.exec(xml)) {
    const [, cdata, closing, name, , selfClosing, text] = match;
    if (name === "mc:Fallback") {
      if (!selfClosing) fallbackDepth = Math.max(0, fallbackDepth + (closing ? -1 : 1));
      continue;
    }
    if (fallbackDepth > 0) continue;
    if (text !== undefined || cdata !== undefined) {
      if (textDepth > 0) append(text !== undefined ? decodeXmlEntities(text) : cdata);
      continue;
    }
    if (!name || (selfClosing && closing)) continue;
    switch (name) {
      case "w:p":
        if (selfClosing) break;
        if (closing) {
          const parts = open.pop();
          if (parts) paragraphs.push(parts.join(""));
        } else {
          open.push([]);
        }
        break;
      case "w:r":
        if (!selfClosing) runDepth = Math.max(0, runDepth + (closing ? -1 : 1));
        break;
      case "w:t":
        if (!selfClosing) textDepth = Math.max(0, textDepth + (closing ? -1 : 1));
        break;
      case "w:tab":
      case "w:ptab":
        if (!closing && runDepth > 0) append("\t");
        break;
      case "w:br":
      case "w:cr":
        if (!closing && runDepth > 0) append("\n");
        break;
      case "w:noBreakHyphen":
        if (!closing && runDepth > 0) append("-");
        break;
      default:
        break;
    }
  }
  // 结构残缺（没闭合的段落）：已经读到的字照样留下。
  while (open.length) paragraphs.push(open.shift()!.join(""));
  return paragraphs;
}
