import assert from "node:assert/strict";
import test from "node:test";
import { getWeComAuthConfig } from "../lib/auth/config.ts";
import {
  buildIdentityKey,
  decryptSecret,
  encryptSecret,
  hashToken,
  randomToken,
  safeReturnTo,
} from "../lib/auth/security.ts";

test("safeReturnTo only accepts local application paths", () => {
  assert.equal(safeReturnTo("/videos/1?tab=work"), "/videos/1?tab=work");
  assert.equal(safeReturnTo("https://evil.example/x"), "/");
  assert.equal(safeReturnTo("//evil.example/x"), "/");
  assert.equal(safeReturnTo("/%2fevil.example/x"), "/");
  assert.equal(safeReturnTo("/%5csignin-with-chatgpt"), "/");
  assert.equal(safeReturnTo("/api/auth/wecom/callback"), "/");
  assert.equal(safeReturnTo("/signin-with-chatgpt"), "/");
  assert.equal(safeReturnTo("/signin-with-chatgpt/"), "/");
  assert.equal(safeReturnTo("/%73ignin-with-chatgpt"), "/");
  assert.equal(safeReturnTo("/signout-with-chatgpt?return_to=/"), "/");
  assert.equal(safeReturnTo("/callback?code=secret"), "/");
  assert.equal(safeReturnTo("/callback/"), "/");
  assert.equal(safeReturnTo("/%63allback"), "/");
});

test("identity keys are stable and separate corporations", () => {
  assert.equal(buildIdentityKey("wwcorp", "Alice"), buildIdentityKey("wwcorp", "Alice"));
  assert.notEqual(buildIdentityKey("wwcorp", "Alice"), buildIdentityKey("other", "Alice"));
});

test("tokens are random, hashable, and secrets round trip", async () => {
  const first = randomToken();
  const second = randomToken();
  assert.notEqual(first, second);
  assert.equal(first.length, 43);
  assert.equal((await hashToken(first)).length, 64);
  const encrypted = await encryptSecret("token-value", "a".repeat(43));
  assert.equal(await decryptSecret(encrypted, "a".repeat(43)), "token-value");
});

test("getWeComAuthConfig validates required auth environment", () => {
  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "production",
    },
    () => {
      assert.deepEqual(getWeComAuthConfig(), {
        appUrl: "https://hamark.boga.plus",
        authSecret: "a".repeat(32),
        corpId: "wwcorp",
        agentId: "1000002",
        secret: "wecom-secret",
      });
    },
  );

  withEnv(
    {
      APP_URL: "http://localhost:3000",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "development",
    },
    () => {
      assert.equal(getWeComAuthConfig().appUrl, "http://localhost:3000");
    },
  );

  withEnv(
    {
      APP_URL: "ftp://localhost",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "development",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), /APP_URL must use HTTP or HTTPS/);
    },
  );

  withEnv(
    {
      APP_URL: "http://localhost:3000",
      AUTH_SECRET: "密".repeat(11),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "development",
    },
    () => {
      assert.equal(getWeComAuthConfig().authSecret, "密".repeat(11));
    },
  );

  withEnv(
    {
      APP_URL: "http://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "production",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), /APP_URL must use HTTPS/);
    },
  );

  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "short",
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "production",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), /AUTH_SECRET must contain at least 32 UTF-8 bytes/);
    },
  );

  withEnv(
    {
      APP_URL: "not a url",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "production",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), TypeError);
    },
  );

  withEnv(
    {
      APP_URL: "",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "wecom-secret",
      NODE_ENV: "production",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), /Missing required environment variable: APP_URL/);
    },
  );

  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      NODE_ENV: "production",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), /Missing required environment variable: WECOM_SECRET/);
    },
  );
});

function withEnv(values: Record<string, string>, operation: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
