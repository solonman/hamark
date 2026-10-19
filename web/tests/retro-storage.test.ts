// 预签名 GET 的响应头覆盖（Word／Excel／PPT 以附件下载、PDF 内联打开要用）：参数要放进签名，
// 不带参数时行为和原来完全一样。不连任何真实存储。
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { CosVideoBucket } from "../storage/cos";

const bucket = new CosVideoBucket({
  region: "ap-shanghai",
  bucket: "demo-1250000000",
  secretId: "TEST_ONLY_ID",
  secretKey: "TEST_ONLY_KEY",
  endpoint: "https://cos.ap-shanghai.myqcloud.com",
});
const NOW = new Date("2026-10-19T08:00:00.000Z");

test("a plain presigned GET carries only the signature fields", async () => {
  const url = new URL(await bucket.createPresignedGetUrl("retro/cases/c/assets/a/original.pdf", { now: NOW }));
  assert.deepEqual([...url.searchParams.keys()].sort(), ["q-ak", "q-header-list", "q-key-time", "q-sign-algorithm", "q-sign-time", "q-signature", "q-url-param-list"]);
  assert.equal(url.searchParams.get("q-url-param-list"), "");
});

test("response-content-* overrides are query parameters and are covered by the signature", async () => {
  const disposition = "attachment; filename=\"a.docx\"; filename*=UTF-8''%E6%96%B9%E6%A1%88.docx";
  const url = new URL(await bucket.createPresignedGetUrl("retro/cases/c/assets/a/original.docx", {
    now: NOW,
    responseContentDisposition: disposition,
    responseContentType: "application/octet-stream",
  }));
  assert.equal(url.searchParams.get("response-content-disposition"), disposition);
  assert.equal(url.searchParams.get("response-content-type"), "application/octet-stream");
  assert.equal(url.searchParams.get("q-url-param-list"), "response-content-disposition;response-content-type");
  // 同样的键不带覆盖参数，签名必须不一样。
  const plain = new URL(await bucket.createPresignedGetUrl("retro/cases/c/assets/a/original.docx", { now: NOW }));
  assert.notEqual(plain.searchParams.get("q-signature"), url.searchParams.get("q-signature"));
});

// ---------------------------------------------------------------------------
// 编码一致：URL 上的查询串必须和签名用的是同一套编码（空格 %20、~ 不编码）
// ---------------------------------------------------------------------------

/** COS 规则的编码（和 storage/cos.ts 里签名用的一致）：encodeURIComponent，再把 !'()* 转成 %XX。 */
const cosEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

test("without overrides the presigned URLs are byte-for-byte what they were before (fixed vectors)", async () => {
  const fixed = new Date("2026-10-19T08:00:00.000Z");
  assert.equal(
    await bucket.createPresignedGetUrl("videos/a b/中文~x.mp4", { now: fixed, expiresInSeconds: 600 }),
    "https://demo-1250000000.cos.ap-shanghai.myqcloud.com/videos/a%20b/%E4%B8%AD%E6%96%87~x.mp4?q-sign-algorithm=sha1&q-ak=TEST_ONLY_ID&q-sign-time=1792396800%3B1792397400&q-key-time=1792396800%3B1792397400&q-header-list=host&q-url-param-list=&q-signature=b5f4df70c61b481f26c65e7b8e95921f918b297a",
  );
  assert.equal(
    await bucket.createPresignedPutUrl("videos/a.mp4", { contentType: "video/mp4", now: fixed, expiresInSeconds: 600 }),
    "https://demo-1250000000.cos.ap-shanghai.myqcloud.com/videos/a.mp4?q-sign-algorithm=sha1&q-ak=TEST_ONLY_ID&q-sign-time=1792396800%3B1792397400&q-key-time=1792396800%3B1792397400&q-header-list=content-type%3Bhost&q-url-param-list=&q-signature=12367e10664058d4cd127072a483fb269b126826",
  );
});

test("override values with Chinese, spaces, quotes and ~ are written to the URL exactly as they were signed", async () => {
  const key = "retro/cases/rtc_1/assets/rta_1/original.docx";
  const fileName = "方案 (v2)~终稿's.docx";
  const disposition = `attachment; filename="_____ (v2)~___'s.docx"; filename*=UTF-8''${cosEncode(fileName)}`;
  const urlText = await bucket.createPresignedGetUrl(key, { now: NOW, expiresInSeconds: 600, responseContentDisposition: disposition, responseContentType: "application/octet-stream" });
  const query = new URL(urlText).search.slice(1);

  // 1) 原文逐字一致：不能有 + 号，空格是 %20，~ 不编码，引号括号星号都按 COS 规则编码。
  assert.ok(query.includes(`response-content-disposition=${cosEncode(disposition)}`), "the URL carries the COS-encoded value verbatim");
  assert.ok(query.includes("response-content-type=application%2Foctet-stream"));
  assert.ok(!query.includes("+"), "no form-encoding plus signs");
  assert.ok(!query.includes("%7E") && query.includes("~"), "tilde stays literal");
  assert.ok(query.includes("%20") && !/[ ]/.test(query));

  // 2) 用 URL 上的原文独立重算签名，必须和 URL 里的 q-signature 一致（证明签名串和 URL 用的是同一套编码）。
  const pairs = query.split("&").map((pair) => pair.split("=") as [string, string]);
  const raw = new Map(pairs);
  const signedNames = (raw.get("q-url-param-list") ?? "").split("%3B").join(";").split(";");
  assert.deepEqual(signedNames, ["response-content-disposition", "response-content-type"]);
  const canonicalParams = signedNames.map((name) => `${name}=${raw.get(name)}`).join("&");
  const host = "demo-1250000000.cos.ap-shanghai.myqcloud.com";
  const httpString = ["get", `/${key}`, canonicalParams, `host=${host}`, ""].join("\n");
  const keyTime = decodeURIComponent(raw.get("q-key-time")!);
  const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signKey = createHmac("sha1", "TEST_ONLY_KEY").update(keyTime).digest("hex");
  assert.equal(createHmac("sha1", signKey).update(stringToSign).digest("hex"), raw.get("q-signature"));
});
