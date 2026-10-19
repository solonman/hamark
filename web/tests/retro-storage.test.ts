// 预签名 GET 的响应头覆盖（Word／Excel／PPT 以附件下载、PDF 内联打开要用）：参数要放进签名，
// 不带参数时行为和原来完全一样。不连任何真实存储。
import assert from "node:assert/strict";
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
