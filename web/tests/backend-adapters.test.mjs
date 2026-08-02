import assert from "node:assert/strict";
import test from "node:test";

import { getRequiredEnv } from "../lib/env.ts";
import { buildCosEndpoint, readCosConfig } from "../storage/cos.ts";
import { translateSqlPlaceholders } from "../db/sql.ts";

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
