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
        proxy: null,
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
      assert.throws(
        () => getWeComAuthConfig(),
        /Either WECOM_SECRET or a complete WeCom proxy configuration is required/,
      );
    },
  );
});

test("getWeComAuthConfig validates fixed IP proxy environment", () => {
  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      WECOM_PROXY_URL: "https://hamark-wecom.boga.plus",
      WECOM_PROXY_SECRET: "p".repeat(32),
      NODE_ENV: "production",
    },
    () => {
      assert.deepEqual(getWeComAuthConfig(), {
        appUrl: "https://hamark.boga.plus",
        authSecret: "a".repeat(32),
        corpId: "wwcorp",
        agentId: "1000002",
        secret: null,
        proxy: {
          url: "https://hamark-wecom.boga.plus",
          secret: "p".repeat(32),
        },
      });
    },
  );

  for (const [proxyUrl, expectedError] of [
    [
      "https://proxy-user@hamark-wecom.boga.plus",
      /WECOM_PROXY_URL must not include username or password/,
    ],
    [
      "https://:proxy-password@hamark-wecom.boga.plus",
      /WECOM_PROXY_URL must not include username or password/,
    ],
    [
      "https://hamark-wecom.boga.plus?region=shanghai",
      /WECOM_PROXY_URL must not include query parameters or fragments/,
    ],
    [
      "https://hamark-wecom.boga.plus#production",
      /WECOM_PROXY_URL must not include query parameters or fragments/,
    ],
  ] as const) {
    withEnv(
      {
        APP_URL: "https://hamark.boga.plus",
        AUTH_SECRET: "a".repeat(32),
        WECOM_CORP_ID: "wwcorp",
        WECOM_AGENT_ID: "1000002",
        WECOM_SECRET: "wecom-secret",
        WECOM_PROXY_URL: proxyUrl,
        WECOM_PROXY_SECRET: "p".repeat(32),
        NODE_ENV: "production",
      },
      () => {
        assert.throws(() => getWeComAuthConfig(), expectedError);
      },
    );
  }

  for (const [proxyUrl, proxySecret] of [
    ["https://hamark-wecom.boga.plus", ""],
    ["", "p".repeat(32)],
  ]) {
    withEnv(
      {
        APP_URL: "https://hamark.boga.plus",
        AUTH_SECRET: "a".repeat(32),
        WECOM_CORP_ID: "wwcorp",
        WECOM_AGENT_ID: "1000002",
        WECOM_SECRET: "wecom-secret",
        WECOM_PROXY_URL: proxyUrl,
        WECOM_PROXY_SECRET: proxySecret,
        NODE_ENV: "production",
      },
      () => {
        assert.throws(
          () => getWeComAuthConfig(),
          /WECOM_PROXY_URL and WECOM_PROXY_SECRET must be configured together/,
        );
      },
    );
  }

  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      WECOM_PROXY_URL: "https://hamark-wecom.boga.plus",
      WECOM_PROXY_SECRET: "p".repeat(31),
      NODE_ENV: "production",
    },
    () => {
      assert.throws(
        () => getWeComAuthConfig(),
        /WECOM_PROXY_SECRET must contain at least 32 UTF-8 bytes/,
      );
    },
  );

  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      WECOM_PROXY_URL: "https://hamark-wecom.boga.plus",
      WECOM_PROXY_SECRET: "密".repeat(11),
      NODE_ENV: "production",
    },
    () => {
      assert.equal(getWeComAuthConfig().proxy?.secret, "密".repeat(11));
    },
  );

  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      WECOM_PROXY_URL: "http://hamark-wecom.boga.plus",
      WECOM_PROXY_SECRET: "p".repeat(32),
      NODE_ENV: "production",
    },
    () => {
      assert.throws(() => getWeComAuthConfig(), /WECOM_PROXY_URL must use HTTPS/);
    },
  );

  withEnv(
    {
      APP_URL: "http://localhost:3000",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      WECOM_PROXY_URL: "http://127.0.0.1:3201",
      WECOM_PROXY_SECRET: "p".repeat(32),
      NODE_ENV: "development",
    },
    () => {
      assert.equal(getWeComAuthConfig().proxy?.url, "http://127.0.0.1:3201");
    },
  );

  withEnv(
    {
      APP_URL: "https://hamark.boga.plus",
      AUTH_SECRET: "a".repeat(32),
      WECOM_CORP_ID: "wwcorp",
      WECOM_AGENT_ID: "1000002",
      WECOM_SECRET: "",
      WECOM_PROXY_URL: "",
      WECOM_PROXY_SECRET: "",
      NODE_ENV: "production",
    },
    () => {
      assert.throws(
        () => getWeComAuthConfig(),
        /Either WECOM_SECRET or a complete WeCom proxy configuration is required/,
      );
    },
  );
});

function withEnv(values: Record<string, string>, operation: () => void) {
  values = { WECOM_PROXY_URL: "", WECOM_PROXY_SECRET: "", ...values };
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
