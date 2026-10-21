// 文字点评测试用的最小 .docx：自己拼 ZIP（node:zlib 的 deflateRawSync / crc32），不放二进制文件。
// 被 tests/audio-review-document.test.ts 与 tests/audio-review-service.test.ts 引用。
import { crc32, deflateRawSync } from "node:zlib";

export type ZipFile = {
  name: string;
  data: string | Uint8Array;
  /** 0 = 存储，8 = 压缩（默认）。 */
  method?: 0 | 8;
  /** 本地头不写大小（标志位 3，大小只在中央目录和数据描述符里），Word 自己存的文件常这样。 */
  descriptor?: boolean;
  /** 标志位 0：加密。 */
  encrypted?: boolean;
};

export function buildZip(files: readonly ZipFile[], options: { comment?: string } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = typeof file.data === "string" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data);
    const method = file.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(data);
    const flags = 0x0800 | (file.descriptor ? 0x0008 : 0) | (file.encrypted ? 0x0001 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(file.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(file.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(file.descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(file.descriptor ? 16 : 0);
    if (file.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    locals.push(local, name, body, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, directory, end, comment]));
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/** 正文 XML：body 里放给定的块（<w:p>、<w:tbl>…）。 */
export function wordDocumentXml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:mc="${MC}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

export function relsXml(target = "word/document.xml") {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
}

/** 一个最小但完整的 .docx：[Content_Types].xml、_rels/.rels、word/document.xml。 */
export function buildDocx(body: string, options: { method?: 0 | 8; descriptor?: boolean; mainPath?: string } = {}): Uint8Array {
  const mainPath = options.mainPath ?? "word/document.xml";
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES, method: options.method },
    { name: "_rels/.rels", data: relsXml(mainPath), method: options.method },
    { name: mainPath, data: wordDocumentXml(body), method: options.method, descriptor: options.descriptor },
  ]);
}

/** 一段普通文字的 <w:p>。 */
export const wordParagraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
