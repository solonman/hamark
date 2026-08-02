import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getRequiredEnv } from "../lib/env.ts";
import { buildCosEndpoint, readCosConfig } from "../storage/cos.ts";
import { translateSqlPlaceholders } from "../db/sql.ts";

const readRepoFile = (pathFromTestFile) =>
  readFileSync(new URL(pathFromTestFile, import.meta.url), "utf8");

test("getRequiredEnv reads runtime env and reports missing keys clearly", () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://example";
  assert.equal(getRequiredEnv("DATABASE_URL"), "postgresql://example");

  delete process.env.DATABASE_URL;
  assert.throws(
    () => getRequiredEnv("DATABASE_URL"),
    /Missing required environment variable: DATABASE_URL/,
  );

  if (previous === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previous;
  }
});

test("translateSqlPlaceholders converts positional placeholders without touching string literals", () => {
  const translated = translateSqlPlaceholders(
    "SELECT '?' AS literal, id FROM videos WHERE id = ? AND author_email = ?",
  );

  assert.equal(
    translated,
    "SELECT '?' AS literal, id FROM videos WHERE id = $1 AND author_email = $2",
  );
});

test("readCosConfig uses env-only Tencent COS settings", () => {
  const previous = {
    COS_REGION: process.env.COS_REGION,
    COS_BUCKET: process.env.COS_BUCKET,
    COS_SECRET_ID: process.env.COS_SECRET_ID,
    COS_SECRET_KEY: process.env.COS_SECRET_KEY,
    COS_ENDPOINT: process.env.COS_ENDPOINT,
  };

  process.env.COS_REGION = "ap-guangzhou";
  process.env.COS_BUCKET = "hamark-videos-1250000000";
  process.env.COS_SECRET_ID = "secret-id";
  process.env.COS_SECRET_KEY = "secret-key";
  delete process.env.COS_ENDPOINT;

  assert.deepEqual(readCosConfig(), {
    region: "ap-guangzhou",
    bucket: "hamark-videos-1250000000",
    secretId: "secret-id",
    secretKey: "secret-key",
    endpoint: "https://cos.ap-guangzhou.myqcloud.com",
  });
  assert.equal(
    buildCosEndpoint("ap-shanghai"),
    "https://cos.ap-shanghai.myqcloud.com",
  );

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("environment example documents only the expected auth variables with safe placeholders", () => {
  const envExample = readRepoFile("../.env.example");
  const entries = new Map(
    envExample
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 2)),
  );

  const expectedAuthEntries = new Map([
    ["APP_URL", "https://hamark.boga.plus"],
    ["AUTH_SECRET", "replace-with-at-least-32-random-bytes-base64"],
    ["WECOM_CORP_ID", "wwxxxxxxxxxxxxxxxx"],
    ["WECOM_AGENT_ID", "1000002"],
    ["WECOM_SECRET", "replace-with-wecom-app-secret"],
  ]);

  const authVariableNames = [...entries.keys()].filter(
    (name) => name === "APP_URL" || name.startsWith("AUTH_") || name.startsWith("WECOM_"),
  );

  assert.deepEqual(authVariableNames.sort(), [...expectedAuthEntries.keys()].sort());
  for (const [name, value] of expectedAuthEntries) {
    assert.equal(entries.get(name), value);
  }
});

test("web README documents WeCom callback and trusted domain", () => {
  const readme = readRepoFile("../README.md");

  assert.match(readme, /https:\/\/hamark\.boga\.plus\/api\/auth\/wecom\/callback/);
  assert.match(readme, /hamark\.boga\.plus/);
});

test("handoff README documents WeCom auth deployment prerequisites and verification", () => {
  const handoff = readRepoFile("../../README_同事接手必读.md");

  assert.match(handoff, /Supabase SQL.*(?:before|先于|部署前|上线前)/is);
  assert.match(handoff, /Vercel.*Production.*环境变量|Production.*Vercel.*环境变量/is);
  assert.match(handoff, /企业微信|WeCom/i);
  assert.match(handoff, /可见范围|visible scope/i);
  assert.match(handoff, /桌面.*扫码|desktop.*QR/i);
  assert.match(handoff, /企业微信客户端|in-WeCom-client|WeCom client/i);
  assert.match(handoff, /demo-user fallback|演示身份兜底|演示用户兜底/i);
});

test("documentation and tests do not contain real-looking secrets", () => {
  const filesToCheck = [
    "../.env.example",
    "../README.md",
    "../../README_同事接手必读.md",
    fileURLToPath(import.meta.url),
  ];

  const allowedPlaceholders = [
    "wwxxxxxxxxxxxxxxxx",
    "AKIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "replace-with-at-least-32-random-bytes-base64",
    "replace-with-wecom-app-secret",
  ];

  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/,
    /\b(?:token|secret|session|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{24,}["']?/i,
    /\bAKID(?!x{16,})[A-Za-z0-9]{16,}\b/,
  ];

  for (const filePath of filesToCheck) {
    let contents = filePath.startsWith("/")
      ? readFileSync(filePath, "utf8")
      : readRepoFile(filePath);
    for (const placeholder of allowedPlaceholders) {
      contents = contents.replaceAll(placeholder, "");
    }

    for (const pattern of secretPatterns) {
      assert.doesNotMatch(contents, pattern, `${filePath} contains ${pattern}`);
    }
  }
});
