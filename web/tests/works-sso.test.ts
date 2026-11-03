import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getWorksConfig, worksLibraryUrl } from "../lib/works/config";
import {
  ADVAULT_TICKET_TTL_SECONDS,
  advaultEntryUrl,
  advaultTicketLocation,
  isValidAdvaultNonce,
  safeAdvaultReturnPath,
  signAdvaultTicket,
} from "../lib/works/sso";

const SECRET = "test-only-advault-sso-secret-0123456789";

// 两站共用的票据样本：AdVault 的 src/lib/hamark-sso.test.ts 用同一组输入校验同一串票据，
// 改格式时两边测试会一起红。
const FIXTURE_INPUT = {
  secret: SECRET,
  issuer: "https://hamark.boga.plus",
  audience: "https://advault.boga.plus",
  corpId: "ww-test-corp",
  userId: "zhangsan",
  name: "张三",
  avatar: null,
  email: "zhangsan@example.com",
  nonce: "nonce_ABCDEFGHIJKLMNOP",
  returnPath: "/campaigns/12?tab=board",
  now: new Date("2026-11-03T08:00:00.000Z"),
  jti: "00000000-0000-4000-8000-000000000001",
};
const FIXTURE_TICKET =
  "eyJ2IjoxLCJpc3MiOiJodHRwczovL2hhbWFyay5ib2dhLnBsdXMiLCJhdWQiOiJodHRwczovL2FkdmF1bHQuYm9nYS5wbHVzIiwiY29ycCI6Ind3LXRlc3QtY29ycCIsInN1YiI6InpoYW5nc2FuIiwibmFtZSI6IuW8oOS4iSIsImF2YXRhciI6bnVsbCwiZW1haWwiOiJ6aGFuZ3NhbkBleGFtcGxlLmNvbSIsIm5vbmNlIjoibm9uY2VfQUJDREVGR0hJSktMTU5PUCIsInJ0IjoiL2NhbXBhaWducy8xMj90YWI9Ym9hcmQiLCJpYXQiOjE3OTM2OTI4MDAsImV4cCI6MTc5MzY5Mjg2MCwianRpIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIn0" +
  ".Hbf0Tjfbj9dUj7K0XZeiY5WQHCrxb6arjUXYG64s6yE";

function decode(ticket: string) {
  const [body, signature] = ticket.split(".");
  return { body, signature, payload: JSON.parse(Buffer.from(body, "base64url").toString("utf8")) };
}

test("ticket is base64url(payload).base64url(HMAC-SHA256(payload segment))", () => {
  const ticket = signAdvaultTicket(FIXTURE_INPUT);
  const { body, signature, payload } = decode(ticket);
  assert.equal(signature, createHmac("sha256", SECRET).update(body).digest("base64url"));
  assert.deepEqual(payload, {
    v: 1,
    iss: "https://hamark.boga.plus",
    aud: "https://advault.boga.plus",
    corp: "ww-test-corp",
    sub: "zhangsan",
    name: "张三",
    avatar: null,
    email: "zhangsan@example.com",
    nonce: "nonce_ABCDEFGHIJKLMNOP",
    rt: "/campaigns/12?tab=board",
    iat: 1793692800,
    exp: 1793692800 + ADVAULT_TICKET_TTL_SECONDS,
    jti: "00000000-0000-4000-8000-000000000001",
  });
});

test("shared fixture ticket matches byte for byte", () => {
  const ticket = signAdvaultTicket(FIXTURE_INPUT);
  assert.equal(ticket, FIXTURE_TICKET);
});

test("ticket lives sixty seconds and gets a fresh jti by default", () => {
  const a = decode(signAdvaultTicket({ ...FIXTURE_INPUT, jti: undefined })).payload;
  const b = decode(signAdvaultTicket({ ...FIXTURE_INPUT, jti: undefined })).payload;
  assert.equal(a.exp - a.iat, 60);
  assert.notEqual(a.jti, b.jti);
});

test("return path stays a relative AdVault path", () => {
  assert.equal(safeAdvaultReturnPath("/campaigns/12"), "/campaigns/12");
  assert.equal(safeAdvaultReturnPath(null), "/");
  assert.equal(safeAdvaultReturnPath("https://evil.example/"), "/");
  assert.equal(safeAdvaultReturnPath("//evil.example/"), "/");
  assert.equal(safeAdvaultReturnPath("/\\evil"), "/");
  assert.equal(safeAdvaultReturnPath("/a\nb"), "/");
  assert.equal(safeAdvaultReturnPath(`/${"a".repeat(3000)}`), "/");
  assert.equal(decode(signAdvaultTicket({ ...FIXTURE_INPUT, returnPath: "//evil" })).payload.rt, "/");
});

test("nonce must be 16–128 base64url characters", () => {
  assert.equal(isValidAdvaultNonce("nonce_ABCDEFGHIJKLMNOP"), true);
  assert.equal(isValidAdvaultNonce("short"), false);
  assert.equal(isValidAdvaultNonce("has space ABCDEFGHIJKLMNOP"), false);
  assert.equal(isValidAdvaultNonce("a".repeat(129)), false);
  assert.equal(isValidAdvaultNonce(null), false);
});

test("redirect targets are fixed: ticket rides in the fragment, entry starts at AdVault", () => {
  assert.equal(advaultTicketLocation("https://advault.boga.plus", "T.S"), "https://advault.boga.plus/sso/hamark#ticket=T.S");
  assert.equal(advaultEntryUrl("https://advault.boga.plus"), "https://advault.boga.plus/api/auth/hamark/start?callbackUrl=%2F");
});

test("works library is off unless flag, URL and a 32-byte secret are all present", () => {
  const saved = { ...process.env };
  try {
    delete process.env.WORKS_LIBRARY_ENABLED;
    process.env.ADVAULT_URL = "https://advault.boga.plus/";
    process.env.ADVAULT_SSO_SECRET = SECRET;
    assert.equal(getWorksConfig(), null);
    assert.equal(worksLibraryUrl(), null);

    process.env.WORKS_LIBRARY_ENABLED = "true";
    assert.deepEqual(getWorksConfig(), { advaultOrigin: "https://advault.boga.plus", secret: SECRET });
    assert.equal(worksLibraryUrl(), "https://advault.boga.plus/api/auth/hamark/start?callbackUrl=%2F");

    process.env.ADVAULT_SSO_SECRET = "too-short";
    assert.equal(getWorksConfig(), null);

    process.env.ADVAULT_SSO_SECRET = SECRET;
    process.env.ADVAULT_URL = "http://advault.boga.plus";
    assert.equal(getWorksConfig(), null, "plain http only allowed in development");

    process.env.ADVAULT_URL = "not a url";
    assert.equal(getWorksConfig(), null);
  } finally {
    process.env = saved;
  }
});

test("nav renders 作品库 as a new-tab link after 客户需求复盘库, only when configured", () => {
  const source = readFileSync(new URL("../components/v04/V04LibraryClient.tsx", import.meta.url), "utf8");
  const retroAt = source.indexOf(">客户需求复盘库</button>");
  const worksAt = source.indexOf('{worksLibraryUrl ? <a href={worksLibraryUrl} target="_blank" rel="noopener">作品库</a> : null}');
  assert.ok(retroAt > 0 && worksAt > retroAt);
  assert.ok(!source.includes('"WORKS"'), "作品库不是 hamark 里的页签");
});

test("the SSO endpoint passes the proxy and checks the session itself", () => {
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /"\/api\/sso\/advault",/);
  const route = readFileSync(new URL("../app/api/sso/advault/route.ts", import.meta.url), "utf8");
  assert.match(route, /getUserForToken\(services\.store, request\.cookies\.get\(SESSION_COOKIE\)/);
  assert.match(route, /loginUrl\.pathname = "\/login"/);
});
