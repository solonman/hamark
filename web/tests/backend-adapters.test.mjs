import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getRequiredEnv } from "../lib/env.ts";
import { buildCosEndpoint, CosVideoBucket, readCosConfig } from "../storage/cos.ts";
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

test("COS creates a short-lived signed PUT URL for a single video object", async () => {
  const bucket = new CosVideoBucket({
    region: "ap-guangzhou",
    bucket: "hamark-videos-1250000000",
    secretId: "secret-id",
    secretKey: "secret-key",
    endpoint: "https://cos.ap-guangzhou.myqcloud.com",
  });

  const uploadUrl = await bucket.createPresignedPutUrl("videos/video_123/original", {
    contentType: "video/mp4",
    expiresInSeconds: 600,
    now: new Date("2026-08-03T00:00:00Z"),
  });
  const parsed = new URL(uploadUrl);

  assert.equal(parsed.host, "hamark-videos-1250000000.cos.ap-guangzhou.myqcloud.com");
  assert.equal(parsed.pathname, "/videos/video_123/original");
  assert.equal(parsed.searchParams.get("q-sign-algorithm"), "sha1");
  assert.equal(parsed.searchParams.get("q-sign-time"), "1785715200;1785715800");
  assert.equal(parsed.searchParams.get("q-header-list"), "content-type;host");
  assert.match(parsed.searchParams.get("q-signature") ?? "", /^[a-f0-9]{40}$/);
  assert.equal(parsed.searchParams.has("x-amz-meta-uploader"), false);
});

test("COS creates a three-hour signed GET URL for a single video object", async () => {
  const bucket = new CosVideoBucket({
    region: "ap-shanghai",
    bucket: "hamark-videos-1250000000",
    secretId: "secret-id",
    secretKey: "secret-key",
    endpoint: "https://cos.ap-shanghai.myqcloud.com",
  });

  const playbackUrl = await bucket.createPresignedGetUrl("videos/video_123/original", {
    expiresInSeconds: 3 * 60 * 60,
    now: new Date("2026-08-03T00:00:00Z"),
  });
  const parsed = new URL(playbackUrl);

  assert.equal(parsed.host, "hamark-videos-1250000000.cos.ap-shanghai.myqcloud.com");
  assert.equal(parsed.pathname, "/videos/video_123/original");
  assert.equal(parsed.searchParams.get("q-sign-algorithm"), "sha1");
  assert.equal(parsed.searchParams.get("q-sign-time"), "1785715200;1785726000");
  assert.equal(parsed.searchParams.get("q-header-list"), "host");
  assert.match(parsed.searchParams.get("q-signature") ?? "", /^[a-f0-9]{40}$/);
  assert.equal(parsed.searchParams.has("response-content-disposition"), false);
});

test("Postgres pool fails fast when hosted database is unreachable", () => {
  const source = readRepoFile("../db/index.ts");

  assert.match(source, /connectionTimeoutMillis/);
  assert.match(source, /POSTGRES_CONNECTION_TIMEOUT_MS/);
});

test("database schema setup is an explicit migration command, not request-time work", () => {
  const packageJson = JSON.parse(readRepoFile("../package.json"));
  const migration = readRepoFile("../scripts/migrate-db.ts");
  const schema = readRepoFile("../db/bootstrap.ts");

  assert.equal(packageJson.scripts["db:migrate"], "tsx scripts/migrate-db.ts");
  assert.match(migration, /applySchema\(\)/);
  assert.match(schema, /thumbnail_key TEXT/);
  assert.match(schema, /ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail_key TEXT/);
});

test("thumbnail backfill is an explicit operator script", () => {
  const packageJson = JSON.parse(readRepoFile("../package.json"));
  const script = readRepoFile("../scripts/backfill-thumbnails.ts");

  assert.equal(packageJson.scripts["thumbnails:backfill"], "tsx scripts/backfill-thumbnails.ts");
  assert.match(script, /applySchema\(\)/);
  assert.match(script, /WHERE status = 'READY'/);
  assert.match(script, /thumbnail_key IS NULL OR thumbnail_key = ''/);
  assert.match(script, /ffmpeg/);
  assert.match(script, /scale='min\(1600,iw\)':-2/);
  assert.match(script, /image\/jpeg/);
  assert.match(script, /UPDATE videos\s+SET thumbnail_key = \?/s);
});

test("Vercel functions run near the Supabase database", () => {
  const vercelConfig = JSON.parse(readRepoFile("../vercel.json"));

  assert.deepEqual(vercelConfig.regions, ["syd1"]);
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
    ["WECOM_PROXY_URL", "https://hamark-wecom.boga.plus"],
    ["WECOM_PROXY_SECRET", "replace-with-at-least-32-random-bytes-base64"],
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
  assert.match(readme, /hamark-wecom\.boga\.plus/);
  assert.match(readme, /111\.229\.151\.122/);
});

test("WeCom proxy deployment files isolate the service and expose only its HTTPS host", () => {
  const systemd = readRepoFile("../services/wecom-proxy/deploy/hamark-wecom-proxy.service");
  const nginx = readRepoFile("../services/wecom-proxy/deploy/nginx.conf");

  assert.match(systemd, /^User=hamark-wecom$/m);
  assert.match(systemd, /^Group=hamark-wecom$/m);
  assert.match(systemd, /^EnvironmentFile=\/etc\/hamark-wecom-proxy\.env$/m);
  assert.match(systemd, /^WorkingDirectory=\/opt\/hamark-wecom-proxy$/m);
  assert.match(
    systemd,
    /^ExecStart=\/opt\/node-v22\.23\.2\/bin\/node \/opt\/hamark-wecom-proxy\/server\.mjs$/m,
  );
  assert.match(systemd, /\[Unit\][\s\S]*StartLimitIntervalSec=300[\s\S]*StartLimitBurst=5[\s\S]*\[Service\]/);
  assert.doesNotMatch(systemd, /\[Service\][\s\S]*StartLimitIntervalSec/);
  assert.match(systemd, /^NoNewPrivileges=true$/m);
  assert.match(systemd, /^ProtectSystem=strict$/m);
  assert.match(systemd, /^ProtectHome=true$/m);

  assert.match(nginx, /server_name hamark-wecom\.boga\.plus;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3201;/);
  assert.match(nginx, /client_max_body_size 4k;/);
  assert.match(nginx, /location = \/health/);
  assert.match(nginx, /location = \/v1\/member-by-code/);
  assert.match(nginx, /limit_req zone=hamark_wecom_proxy/);
  assert.match(nginx, /location \/\s*\{\s*return 404;/s);
  assert.match(nginx, /listen 80;[\s\S]*access_log off;[\s\S]*return 301/s);

  const bootstrap = readRepoFile("../services/wecom-proxy/deploy/nginx-bootstrap.conf");
  assert.match(bootstrap, /access_log off;/);
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
  assert.match(handoff, /WECOM_PROXY_URL/);
  assert.match(handoff, /WECOM_PROXY_SECRET/);
  assert.match(handoff, /111\.229\.151\.122/);
  const vercelEnvBlock = handoff.match(/Vercel Production[^`]*```env([\s\S]*?)```/i)?.[1] ?? "";
  assert.doesNotMatch(vercelEnvBlock, /^WECOM_SECRET=/m);
});

test("web README documents the certificate-safe fixed IP proxy rollout order", () => {
  const readme = readRepoFile("../README.md");

  assert.match(readme, /useradd[^\n]*hamark-wecom/);
  assert.match(readme, /\/opt\/hamark-wecom-proxy/);
  assert.match(readme, /chmod 600 \/etc\/hamark-wecom-proxy\.env/);
  assert.match(readme, /nginx-bootstrap\.conf[\s\S]*certbot[\s\S]*nginx\.conf/);
  assert.match(readme, /systemctl enable --now hamark-wecom-proxy/);
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
