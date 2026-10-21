// 文字点评（docs/25 二之二）：读文档。.docx 自己解 ZIP（存储 / 压缩两种方法、数据描述符、注释、
// 损坏、加密、老格式 .doc、不是 Word），按 <w:p> 取段落（表格、制表、换行、实体、修订、文本框）；
// .txt / .md 的 UTF-8 / BOM / GB18030 / UTF-16；统一切段、空文档、超长；读存储流的上限。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_REVIEW_DOCUMENT_MAX_CHARS,
  AUDIO_REVIEW_DOCX_CONTENT_TYPE,
  audioReviewDocumentContentType,
  audioReviewSourceKindOf,
} from "../lib/audio-review-model";
import {
  AUDIO_REVIEW_DOCUMENT_ENGINE,
  AUDIO_REVIEW_DOCUMENT_REASONS,
  audioReviewDocumentSegments,
  decodeAudioReviewTextDocument,
  decodeXmlEntities,
  extractDocxText,
  extractWordParagraphs,
  finishAudioReviewDocument,
  listZipEntries,
  parseAudioReviewDocument,
  readAudioReviewObjectBytes,
  readZipEntry,
  splitAudioReviewDocumentParagraphs,
} from "../lib/audio-review/document";
import { parseStoredTranscript } from "../lib/audio-review/transcript";
import { buildDocx, buildZip, relsXml, wordDocumentXml, wordParagraph } from "./audio-review-docx-fixtures";

const DOCX = AUDIO_REVIEW_DOCX_CONTENT_TYPE;
const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (value: string) => Uint8Array.from(value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));

function paragraphsOf(bytes: Uint8Array, contentType = DOCX) {
  const result = parseAudioReviewDocument(bytes, contentType);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.paragraphs;
}

function reasonOf(bytes: Uint8Array, contentType = DOCX) {
  const result = parseAudioReviewDocument(bytes, contentType);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.reason;
}

// ---------------------------------------------------------------------------
// 来源与类型（共用契约）
// ---------------------------------------------------------------------------

test("document types come from the extension; the three document types are the only DOCUMENT sources", () => {
  assert.equal(audioReviewDocumentContentType("点评.DOCX"), DOCX);
  assert.equal(audioReviewDocumentContentType("粘贴的点评文字.txt"), "text/plain");
  assert.equal(audioReviewDocumentContentType("notes.md"), "text/markdown");
  assert.equal(audioReviewDocumentContentType("notes.pdf"), null);
  assert.equal(audioReviewDocumentContentType("点评.m4a"), null);
  assert.equal(audioReviewSourceKindOf(DOCX), "DOCUMENT");
  assert.equal(audioReviewSourceKindOf("text/plain; charset=utf-8"), "DOCUMENT");
  assert.equal(audioReviewSourceKindOf("audio/mp4"), "AUDIO");
  assert.equal(audioReviewSourceKindOf("video/mp4"), "AUDIO");
});

// ---------------------------------------------------------------------------
// .docx
// ---------------------------------------------------------------------------

const RICH_BODY = [
  // 段落属性里的制表位定义不是制表符；一段里分几个 run。
  `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="420"/></w:tabs><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>老孙点评：</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">母题 </w:t></w:r><w:r><w:t>看浅了。</w:t></w:r></w:p>`,
  `<w:p/>`,
  `<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t><w:cr/><w:t>丁</w:t></w:r></w:p>`,
  `<w:p><w:r><w:t>A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos; &#x4E2D;&#25991; &unknown;</w:t></w:r></w:p>`,
  // 修订：删掉的字不算，插入的算。
  `<w:p><w:del><w:r><w:delText>删掉的字</w:delText></w:r></w:del><w:ins><w:r><w:t>新加的字</w:t></w:r></w:ins></w:p>`,
  `<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>表格第一格</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表格第二格</w:t></w:r></w:p><w:p><w:r><w:t>同一格第二段</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  `<w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>`,
  // 域代码不算，域结果算；超链接里的字算。
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "x" </w:instrText></w:r><w:hyperlink r:id="rId9"><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p>`,
  // 文本框：Choice 里的读一次，Fallback 里的旧式副本跳过。
  `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>外层段落</w:t></w:r></w:p>`,
  `<w:p><w:r><w:t>　　全角空格缩进的一段　</w:t></w:r></w:p>`,
].join("");

const RICH_PARAGRAPHS = [
  "老孙点评：母题 看浅了。",
  "甲\t乙",
  "丙",
  "丁",
  "A & B <C> \"D\" 'E' 中文 &unknown;",
  "新加的字",
  "表格第一格",
  "表格第二格",
  "同一格第二段",
  "链接文字",
  "文本框",
  "外层段落",
  "全角空格缩进的一段",
];

test("docx: paragraphs, runs, tables, tab/br/cr, entities, tracked changes, field codes and text boxes", () => {
  assert.deepEqual(paragraphsOf(buildDocx(RICH_BODY)), RICH_PARAGRAPHS);
});

test("docx: stored (method 0) and deflated (method 8) entries, data descriptors and a ZIP comment all read the same", () => {
  assert.deepEqual(paragraphsOf(buildDocx(RICH_BODY, { method: 0 })), RICH_PARAGRAPHS);
  assert.deepEqual(paragraphsOf(buildDocx(RICH_BODY, { descriptor: true })), RICH_PARAGRAPHS);
  const withComment = buildZip([
    { name: "_rels/.rels", data: relsXml() },
    { name: "word/document.xml", data: wordDocumentXml(wordParagraph("有注释的 ZIP")) },
  ], { comment: "PK\u0005\u0006 不是真的目录结尾" });
  assert.deepEqual(paragraphsOf(withComment), ["有注释的 ZIP"]);
  const entries = listZipEntries(buildDocx(RICH_BODY, { method: 0 }))!;
  assert.deepEqual(entries.map((entry) => [entry.name, entry.method]), [["[Content_Types].xml", 0], ["_rels/.rels", 0], ["word/document.xml", 0]]);
});

test("docx: a main part under another name is found through _rels/.rels", () => {
  const bytes = buildDocx(wordParagraph("正文换了名字"), { mainPath: "word/document2.xml" });
  assert.deepEqual(paragraphsOf(bytes), ["正文换了名字"]);
});

test("docx: broken, legacy .doc, encrypted and non-Word files fail with a reason instead of throwing", () => {
  const good = buildDocx(RICH_BODY);
  // 不是 ZIP。
  assert.equal(reasonOf(utf8("这根本不是 Word 文件")), AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx);
  assert.equal(reasonOf(new Uint8Array()), AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx);
  // 截断：目录结尾没了。
  assert.equal(reasonOf(good.slice(0, good.length - 30)), AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx);
  // 压缩数据被破坏（目录还在）。
  const corrupted = good.slice();
  const main = listZipEntries(corrupted)!.find((entry) => entry.name === "word/document.xml")!;
  const dataStart = main.localHeaderOffset + 30 + "word/document.xml".length;
  corrupted.fill(0xff, dataStart, dataStart + Math.min(40, main.compressedSize));
  assert.equal(reasonOf(corrupted), AUDIO_REVIEW_DOCUMENT_REASONS.brokenDocx);
  // 老格式 .doc / 设了打开密码的 .docx：OLE 复合文件。
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(reasonOf(ole), AUDIO_REVIEW_DOCUMENT_REASONS.legacyDoc);
  // ZIP 条目加密。
  const encrypted = buildZip([{ name: "word/document.xml", data: wordDocumentXml(wordParagraph("x")), encrypted: true }]);
  assert.equal(reasonOf(encrypted), AUDIO_REVIEW_DOCUMENT_REASONS.encrypted);
  // 是 ZIP，但不是 Word（例如 .xlsx 改了扩展名）。
  const workbook = buildZip([
    { name: "_rels/.rels", data: relsXml("xl/workbook.xml") },
    { name: "xl/workbook.xml", data: "<workbook><sheets/></workbook>" },
  ]);
  assert.equal(reasonOf(workbook), AUDIO_REVIEW_DOCUMENT_REASONS.notWord);
  assert.equal(reasonOf(buildZip([{ name: "readme.txt", data: "hello" }])), AUDIO_REVIEW_DOCUMENT_REASONS.notWord);
});

test("docx: an empty document and one over 100,000 characters are refused", () => {
  assert.equal(reasonOf(buildDocx("<w:p/><w:p><w:r><w:t> </w:t></w:r></w:p>")), AUDIO_REVIEW_DOCUMENT_REASONS.empty);
  const long = "字".repeat(AUDIO_REVIEW_DOCUMENT_MAX_CHARS / 2);
  assert.deepEqual(paragraphsOf(buildDocx(wordParagraph(long) + wordParagraph(long))).length, 2);
  assert.equal(reasonOf(buildDocx(wordParagraph(long) + wordParagraph(`${long}多`))), AUDIO_REVIEW_DOCUMENT_REASONS.tooLong);
  assert.match(AUDIO_REVIEW_DOCUMENT_REASONS.tooLong, /10 万字/);
});

test("docx: inflating stops at the output cap (no zip bombs)", () => {
  const bomb = buildZip([{ name: "word/document.xml", data: "a".repeat(200_000) }]);
  const entry = listZipEntries(bomb)![0];
  assert.deepEqual(readZipEntry(bomb, entry, 1_000), { ok: false, problem: "BROKEN" });
  assert.equal(readZipEntry(bomb, entry).ok, true);
});

test("docx text is the paragraphs joined by newlines; the XML walker is tolerant of odd markup", () => {
  const extracted = extractDocxText(buildDocx(wordParagraph("一") + wordParagraph("二")));
  assert.deepEqual(extracted, { ok: true, text: "一\n二" });
  // 注释、CDATA、属性值里的 >、没闭合的段落。
  assert.deepEqual(
    extractWordParagraphs(`<w:body><!-- <w:p><w:r><w:t>注释</w:t></w:r></w:p> --><w:p w:rsidR="a>b"><w:r><w:t><![CDATA[x<y]]></w:t></w:r></w:p><w:p><w:r><w:t>没闭合`),
    ["x<y", "没闭合"],
  );
  assert.equal(decodeXmlEntities("&#0; &#xD800; &#x110000; &amp;amp;"), "&#0; &#xD800; &#x110000; &amp;");
});

// ---------------------------------------------------------------------------
// .txt / .md
// ---------------------------------------------------------------------------

test("text: UTF-8 with or without BOM, CRLF, blank lines and indentation", () => {
  const text = "老孙点评：母题看浅了。\r\n\r\n　　第二段的作用不对。\n   \n# 小标题\r最后一段  ";
  const expected = ["老孙点评：母题看浅了。", "第二段的作用不对。", "# 小标题", "最后一段"];
  assert.deepEqual(paragraphsOf(utf8(text), "text/plain"), expected);
  assert.deepEqual(paragraphsOf(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]), "text/markdown"), expected);
  assert.equal(decodeAudioReviewTextDocument(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("甲")])), "甲");
});

test("text: GB18030 (Windows ANSI) and UTF-16 with BOM are decoded", () => {
  // 「老孙点评：母题看浅了。\r\n　　第二段的作用不对。」的 GB18030 编码。
  const gbk = hex("c0cfcbefb5e3c6c0a3bac4b8cce2bfb4c7b3c1cba1a3" + "0d0a" + "a1a1a1a1" + "b5dab6feb6ceb5c4d7f7d3c3b2bbb6d4a1a3");
  assert.deepEqual(paragraphsOf(gbk, "text/plain"), ["老孙点评：母题看浅了。", "第二段的作用不对。"]);
  const utf16 = Buffer.from("\ufeff甲\r\n乙", "utf16le");
  assert.deepEqual(paragraphsOf(new Uint8Array(utf16), "text/plain"), ["甲", "乙"]);
  const utf16be = Buffer.from("\ufeff丙", "utf16le").swap16();
  assert.deepEqual(paragraphsOf(new Uint8Array(utf16be), "text/plain"), ["丙"]);
});

test("text: binary data, empty files and over-long text fail with a reason", () => {
  assert.equal(reasonOf(new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43]), "text/plain"), AUDIO_REVIEW_DOCUMENT_REASONS.undecodable);
  assert.equal(reasonOf(new Uint8Array([0x81]), "text/plain"), AUDIO_REVIEW_DOCUMENT_REASONS.undecodable);
  assert.equal(reasonOf(utf8(" \r\n\n　\t"), "text/plain"), AUDIO_REVIEW_DOCUMENT_REASONS.empty);
  assert.equal(reasonOf(new Uint8Array(), "text/markdown"), AUDIO_REVIEW_DOCUMENT_REASONS.empty);
  assert.equal(reasonOf(utf8("字".repeat(AUDIO_REVIEW_DOCUMENT_MAX_CHARS + 1)), "text/plain"), AUDIO_REVIEW_DOCUMENT_REASONS.tooLong);
  // 按字（码点）数：四字节的字也只算一个。
  assert.equal(finishAudioReviewDocument("𠀀".repeat(AUDIO_REVIEW_DOCUMENT_MAX_CHARS)).ok, true);
  assert.equal(reasonOf(utf8("x"), "application/pdf"), AUDIO_REVIEW_DOCUMENT_REASONS.unsupported);
});

test("splitting keeps the original order and drops blank lines", () => {
  assert.deepEqual(splitAudioReviewDocumentParagraphs("\n 一 \n\n二\u2028三\f四\r\n"), ["一", "二", "三", "四"]);
  assert.deepEqual(splitAudioReviewDocumentParagraphs(""), []);
});

// ---------------------------------------------------------------------------
// 文字稿形状、读存储流
// ---------------------------------------------------------------------------

test("paragraphs become transcript segments numbered from 1, at 0 ms, all S0, and survive the stored-transcript parser", () => {
  const segments = audioReviewDocumentSegments(["第一段", "第二段"]);
  assert.deepEqual(segments, [
    { id: 1, startMs: 0, endMs: 0, speakerId: "S0", text: "第一段" },
    { id: 2, startMs: 0, endMs: 0, speakerId: "S0", text: "第二段" },
  ]);
  const stored = parseStoredTranscript(JSON.stringify({ segments, durationMs: null, engine: AUDIO_REVIEW_DOCUMENT_ENGINE }));
  assert.deepEqual(stored, { segments, durationMs: null, engine: "DOCUMENT" });
});

test("reading a stored object collects every chunk and stops past the cap", async () => {
  const stream = (chunks: number[][]) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  assert.deepEqual([...(await readAudioReviewObjectBytes(stream([[1, 2], [3], [], [4, 5]]), 5))!], [1, 2, 3, 4, 5]);
  assert.equal(await readAudioReviewObjectBytes(stream([[1, 2], [3, 4], [5, 6]]), 5), null);
});
