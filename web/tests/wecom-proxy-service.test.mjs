import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  MAX_BODY_BYTES,
  MAX_CLOCK_SKEW_SECONDS,
  parseMemberRequest,
  signBody,
  verifySignedBody,
} from "../services/wecom-proxy/protocol.mjs";
import {
  createProxyServer,
  readProxyConfig,
} from "../services/wecom-proxy/server.mjs";
import {
  WeComServiceError,
  createWeComService,
} from "../services/wecom-proxy/wecom.mjs";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const PROXY_SECRET = "p".repeat(32);
const WECOM_SECRET = "wecom-secret-do-not-leak";

test("protocol signs timestamp and raw body with HMAC-SHA256 hex", () => {
  assert.equal(MAX_BODY_BYTES, 4096);
  assert.equal(MAX_CLOCK_SKEW_SECONDS, 60);
  assert.equal(
    signBody("test-secret", "1700000000", '{"code":"abc"}'),
    "9fa7f0f2003425fcdc77c73d26ad529f9eee5a4fbd7f2d5c4a2c3d90687455e4",
  );
});

test("protocol accepts signatures at the clock boundary and rejects bad signatures safely", () => {
  const rawBody = Buffer.from('{"code":"login-code"}');
  const timestamp = String(NOW_SECONDS - 60);
  const signature = signBody(PROXY_SECRET, timestamp, rawBody);

  assert.equal(
    verifySignedBody({
      secret: PROXY_SECRET,
      timestamp,
      signature,
      rawBody,
      nowSeconds: NOW_SECONDS,
    }),
    true,
  );
  assert.equal(
    verifySignedBody({
      secret: PROXY_SECRET,
      timestamp,
      signature: "00",
      rawBody,
      nowSeconds: NOW_SECONDS,
    }),
    false,
  );
  assert.equal(
    verifySignedBody({
      secret: PROXY_SECRET,
      timestamp,
      signature: "z".repeat(64),
      rawBody,
      nowSeconds: NOW_SECONDS,
    }),
    false,
  );
});

test("protocol rejects timestamps more than 60 seconds old or in the future", () => {
  const rawBody = '{"code":"login-code"}';

  for (const timestamp of [NOW_SECONDS - 61, NOW_SECONDS + 61]) {
    assert.equal(
      verifySignedBody({
        secret: PROXY_SECRET,
        timestamp: String(timestamp),
        signature: signBody(PROXY_SECRET, String(timestamp), rawBody),
        rawBody,
        nowSeconds: NOW_SECONDS,
      }),
      false,
    );
  }

  for (const timestamp of ["", "12.5", "not-a-time"]) {
    assert.equal(
      verifySignedBody({
        secret: PROXY_SECRET,
        timestamp,
        signature: "0".repeat(64),
        rawBody,
        nowSeconds: NOW_SECONDS,
      }),
      false,
    );
  }
});

test("parseMemberRequest accepts only a non-empty code of at most 512 characters", () => {
  assert.equal(parseMemberRequest('{"code":"login-code"}'), "login-code");
  assert.equal(parseMemberRequest(Buffer.from(`{"code":"${"a".repeat(512)}"}`)), "a".repeat(512));

  for (const rawBody of [
    "",
    "not-json",
    "null",
    "[]",
    "{}",
    '{"code":42}',
    '{"code":""}',
    '{"code":"   "}',
    `{"code":"${"a".repeat(513)}"}`,
    "x".repeat(MAX_BODY_BYTES + 1),
  ]) {
    assert.throws(
      () => parseMemberRequest(rawBody),
      (error) => {
        assert.equal(error.code, "INVALID_REQUEST");
        const inputFragment = rawBody.slice(0, 20);
        if (inputFragment.length > 0) {
          assert.equal(error.message.includes(inputFragment), false);
        }
        return true;
      },
    );
  }
});

test("WeCom service retrieves a token once and reuses it until five minutes before expiry", async () => {
  let now = NOW;
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, access_token: "access-token", expires_in: 601 }),
    ...memberResponses("alice"),
    ...memberResponses("bob"),
    jsonResponse({ errcode: 0, access_token: "fresh-token", expires_in: 7200 }),
    ...memberResponses("carol"),
  ]);
  const service = createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl: fetcher.fetch,
    now: () => now,
  });

  await service.getMemberByCode("code-one");
  now = new Date(NOW.getTime() + 300_000);
  await service.getMemberByCode("code-two");
  now = new Date(NOW.getTime() + 301_000);
  await service.getMemberByCode("code-three");

  const tokenCalls = fetcher.urls.filter((url) => url.includes("/cgi-bin/gettoken?"));
  assert.equal(tokenCalls.length, 2);
  assert.equal(
    tokenCalls[0],
    "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=wwcorp&corpsecret=wecom-secret-do-not-leak",
  );
  assert.equal(fetcher.urls.some((url) => url.includes("access_token=fresh-token")), true);
});

test("WeCom service caches department names for five minutes across logins", async () => {
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, access_token: "access-token", expires_in: 7200 }),
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({ errcode: 0, userid: "alice", name: "Alice", department: [1] }),
    jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] }),
    jsonResponse({ errcode: 0, UserId: "bob" }),
    jsonResponse({ errcode: 0, userid: "bob", name: "Bob", department: [1] }),
  ]);
  const service = createService(fetcher);

  await service.getMemberByCode("code-alice");
  const member = await service.getMemberByCode("code-bob");

  assert.deepEqual(member.departments, [
    { id: "1", name: "Engineering", isPrimary: true },
  ]);
  assert.equal(
    fetcher.urls.filter((url) => url.includes("/department/simplelist")).length,
    1,
  );
});

test("WeCom service single-flights concurrent token acquisition", async () => {
  let tokenRequests = 0;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      await Promise.resolve();
      return jsonResponse({ errcode: 0, access_token: "shared-token", expires_in: 7200 });
    }
    if (url.pathname.endsWith("/user/getuserinfo")) {
      return jsonResponse({ errcode: 0, UserId: url.searchParams.get("code") });
    }
    if (url.pathname.endsWith("/user/get")) {
      const userId = url.searchParams.get("userid");
      return jsonResponse({ errcode: 0, userid: userId, name: userId, department: [1] });
    }
    return jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] });
  };
  const service = createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl,
    now: () => NOW,
  });

  const members = await Promise.all([
    service.getMemberByCode("alice"),
    service.getMemberByCode("bob"),
  ]);

  assert.equal(tokenRequests, 1);
  assert.deepEqual(members.map((member) => member.userId), ["alice", "bob"]);
});

test("WeCom service refreshes an invalid cached access token once and retries the business chain", async () => {
  let tokenRequests = 0;
  const userInfoTokens = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      await Promise.resolve();
      return jsonResponse({
        errcode: 0,
        access_token: `access-token-${tokenRequests}`,
        expires_in: 7200,
      });
    }

    const accessToken = url.searchParams.get("access_token");
    if (url.pathname.endsWith("/user/getuserinfo")) {
      const code = url.searchParams.get("code");
      userInfoTokens.push({ code, accessToken });
      if (code.startsWith("refresh-") && accessToken === "access-token-1") {
        return jsonResponse({
          errcode: code.endsWith("bob") ? 42001 : 40014,
          errmsg: "invalid access-token-1",
        });
      }
      return jsonResponse({ errcode: 0, UserId: code });
    }
    if (url.pathname.endsWith("/user/get")) {
      const userId = url.searchParams.get("userid");
      return jsonResponse({ errcode: 0, userid: userId, name: userId, department: [1] });
    }
    return jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] });
  };
  const service = createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl,
    now: () => NOW,
  });

  await service.getMemberByCode("warm-cache");
  const members = await Promise.all([
    service.getMemberByCode("refresh-alice"),
    service.getMemberByCode("refresh-bob"),
  ]);

  assert.equal(tokenRequests, 2);
  assert.deepEqual(members.map((member) => member.userId), ["refresh-alice", "refresh-bob"]);
  assert.equal(
    userInfoTokens.filter((item) => item.accessToken === "access-token-2").length,
    2,
  );
});

test("WeCom service treats OAuth code expiry separately from access token expiry", async () => {
  for (const errcode of [40029, 42003, 42022]) {
    const fetcher = new QueuedFetch([
      jsonResponse({ errcode: 0, access_token: "access-token", expires_in: 7200 }),
      jsonResponse({ errcode }),
    ]);
    await assert.rejects(
      () => createService(fetcher).getMemberByCode("login-code"),
      (error) => {
        assertSanitizedServiceError(error, "AUTH_EXPIRED");
        return true;
      },
    );
  }
});

test("WeCom service shares token refresh failures and can recover on the next request", async () => {
  let tokenRequests = 0;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gettoken")) {
      tokenRequests += 1;
      await Promise.resolve();
      if (tokenRequests === 1) {
        return jsonResponse({ errcode: -1, errmsg: "transient upstream failure" });
      }
      return jsonResponse({ errcode: 0, access_token: "recovered-token", expires_in: 7200 });
    }
    if (url.pathname.endsWith("/user/getuserinfo")) {
      return jsonResponse({ errcode: 0, UserId: "alice" });
    }
    if (url.pathname.endsWith("/user/get")) {
      return jsonResponse({ errcode: 0, userid: "alice", name: "Alice", department: [1] });
    }
    return jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] });
  };
  const service = createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl,
    now: () => NOW,
  });

  const failures = await Promise.allSettled([
    service.getMemberByCode("code-one"),
    service.getMemberByCode("code-two"),
  ]);
  assert.equal(tokenRequests, 1);
  for (const result of failures) {
    assert.equal(result.status, "rejected");
    assertSanitizedServiceError(result.reason, "WECOM_UNAVAILABLE");
  }

  const member = await service.getMemberByCode("code-three");
  assert.equal(member.userId, "alice");
  assert.equal(tokenRequests, 2);
});

test("WeCom service calls member endpoints in order and normalizes the profile", async () => {
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, access_token: "access-token", expires_in: 7200 }),
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({
      errcode: 0,
      userid: "alice",
      name: "Alice",
      thumb_avatar: "https://cdn.example/alice-small.png",
      department: [7, 8, 7],
      main_department: 8,
    }),
    jsonResponse({
      errcode: 0,
      department_id: [
        { id: 7, name: "Brand" },
        { id: 8, name: "Engineering" },
      ],
    }),
  ]);

  const member = await createService(fetcher).getMemberByCode("login-code");

  assert.deepEqual(member, {
    userId: "alice",
    displayName: "Alice",
    avatarUrl: "https://cdn.example/alice-small.png",
    email: null,
    departments: [
      { id: "7", name: "Brand", isPrimary: false },
      { id: "8", name: "Engineering", isPrimary: true },
    ],
  });
  assert.deepEqual(
    fetcher.urls.slice(1).map((value) => new URL(value).pathname),
    [
      "/cgi-bin/user/getuserinfo",
      "/cgi-bin/user/get",
      "/cgi-bin/department/simplelist",
    ],
  );
});

test("every WeCom request receives an 8-second timeout signal", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  };
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, access_token: "access-token", expires_in: 7200 }),
    ...memberResponses("alice"),
  ]);

  try {
    await createService(fetcher).getMemberByCode("login-code");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(timeouts, [8000, 8000, 8000, 8000]);
  assert.equal(fetcher.calls.every((call) => call.init?.signal instanceof AbortSignal), true);
});

test("WeCom service maps upstream failures to stable sanitized error codes", async () => {
  const cases = [
    {
      responses: [jsonResponse({ errcode: 40029, errmsg: "bad login-code access-token" })],
      code: "AUTH_EXPIRED",
    },
    {
      responses: [jsonResponse({ errcode: 50001, errmsg: "denied login-code" })],
      code: "MEMBER_NOT_ALLOWED",
    },
    {
      responses: [jsonResponse({ errcode: 0, UserId: "alice" }), jsonResponse({ errcode: 0 })],
      code: "PROFILE_UNAVAILABLE",
    },
    {
      responses: [jsonResponse({ errcode: 60020, errmsg: WECOM_SECRET })],
      code: "PROXY_MISCONFIGURED",
    },
    {
      responses: [jsonResponse({ errcode: -1, errmsg: "raw upstream response" })],
      code: "WECOM_UNAVAILABLE",
    },
  ];

  for (const item of cases) {
    const fetcher = new QueuedFetch([
      jsonResponse({ errcode: 0, access_token: "access-token", expires_in: 7200 }),
      ...item.responses,
    ]);
    await assert.rejects(
      () => createService(fetcher).getMemberByCode("login-code"),
      (error) => {
        assertSanitizedServiceError(error, item.code);
        return true;
      },
    );
  }

  const tokenFetcher = new QueuedFetch([
    jsonResponse({ errcode: 40013, errmsg: `${WECOM_SECRET} raw upstream response` }),
  ]);
  await assert.rejects(
    () => createService(tokenFetcher).getMemberByCode("login-code"),
    (error) => {
      assertSanitizedServiceError(error, "PROXY_MISCONFIGURED");
      return true;
    },
  );
});

test("gettoken maps only explicit configuration errors to PROXY_MISCONFIGURED", async () => {
  for (const errcode of [40001, 40013, 60020]) {
    const fetcher = new QueuedFetch([
      jsonResponse({ errcode, errmsg: `${WECOM_SECRET} raw upstream response` }),
    ]);
    await assert.rejects(
      () => createService(fetcher).getMemberByCode("login-code"),
      (error) => {
        assertSanitizedServiceError(error, "PROXY_MISCONFIGURED");
        return true;
      },
    );
  }

  const transientFetcher = new QueuedFetch([
    jsonResponse({ errcode: -1, errmsg: `${WECOM_SECRET} transient failure` }),
  ]);
  await assert.rejects(
    () => createService(transientFetcher).getMemberByCode("login-code"),
    (error) => {
      assertSanitizedServiceError(error, "WECOM_UNAVAILABLE");
      return true;
    },
  );

  const malformedSuccessFetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, expires_in: 7200 }),
  ]);
  await assert.rejects(
    () => createService(malformedSuccessFetcher).getMemberByCode("login-code"),
    (error) => {
      assertSanitizedServiceError(error, "WECOM_UNAVAILABLE");
      return true;
    },
  );
});

test("WeCom service rejects upstream response bodies larger than 1 MiB before using them", async () => {
  let fetchCalls = 0;
  const oversizedToken = JSON.stringify({
    errcode: 0,
    access_token: "t".repeat(1024 * 1024),
    expires_in: 7200,
  });
  const fetchImpl = async () => {
    fetchCalls += 1;
    if (fetchCalls > 1) {
      throw new Error("oversized token must not be used");
    }
    return new Response(oversizedToken, {
      headers: { "content-type": "application/json" },
    });
  };
  const service = createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl,
    now: () => NOW,
  });

  await assert.rejects(
    () => service.getMemberByCode("login-code"),
    (error) => {
      assertSanitizedServiceError(error, "WECOM_UNAVAILABLE");
      return true;
    },
  );
  assert.equal(fetchCalls, 1);
});

test("WeCom service links caller aborts to every upstream fetch without AbortSignal.any", async () => {
  const controller = new AbortController();
  let fetchSignal;
  let finishFetch;
  const fetchStarted = new Promise((resolveStarted) => {
    finishFetch = resolveStarted;
  });
  const fetchImpl = async (_input, init) => {
    fetchSignal = init.signal;
    finishFetch();
    await new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error("fetch was not aborted")), 250);
      init.signal.addEventListener("abort", () => {
        clearTimeout(fallback);
        reject(new Error("fetch aborted"));
      }, { once: true });
    });
  };
  const service = createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl,
    now: () => NOW,
  });

  const operation = service.getMemberByCode("login-code", { signal: controller.signal });
  await fetchStarted;
  controller.abort();

  await assert.rejects(operation, (error) => {
    assertSanitizedServiceError(error, "WECOM_UNAVAILABLE");
    return true;
  });
  assert.equal(fetchSignal.aborted, true);
});

test("WeCom service converts network and malformed response failures without leaking details", async () => {
  const fetchImpl = async () => {
    throw new Error(`${WECOM_SECRET} login-code access-token raw upstream response`);
  };

  await assert.rejects(
    () => createWeComService({
      corpId: "wwcorp",
      secret: WECOM_SECRET,
      fetchImpl,
      now: () => NOW,
    }).getMemberByCode("login-code"),
    (error) => {
      assertSanitizedServiceError(error, "WECOM_UNAVAILABLE");
      return true;
    },
  );
});

test("readProxyConfig validates secrets, host, and port without exposing values", () => {
  assert.deepEqual(readProxyConfig({
    WECOM_CORP_ID: "wwcorp",
    WECOM_SECRET,
    WECOM_PROXY_SECRET: PROXY_SECRET,
  }), {
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    proxySecret: PROXY_SECRET,
    host: "127.0.0.1",
    port: 3201,
  });

  for (const env of [
    {},
    { WECOM_CORP_ID: "wwcorp", WECOM_SECRET, WECOM_PROXY_SECRET: "short" },
    { WECOM_CORP_ID: "wwcorp", WECOM_SECRET, WECOM_PROXY_SECRET: PROXY_SECRET, HOST: "" },
    { WECOM_CORP_ID: "wwcorp", WECOM_SECRET, WECOM_PROXY_SECRET: PROXY_SECRET, PORT: "0" },
    { WECOM_CORP_ID: "wwcorp", WECOM_SECRET, WECOM_PROXY_SECRET: PROXY_SECRET, PORT: "abc" },
    {
      WECOM_CORP_ID: "wwcorp",
      WECOM_SECRET,
      WECOM_PROXY_SECRET: PROXY_SECRET,
      HOST: "0.0.0.0",
    },
  ]) {
    assert.throws(
      () => readProxyConfig(env),
      (error) => {
        assert.equal(error.code, "PROXY_MISCONFIGURED");
        assert.equal(error.message.includes(WECOM_SECRET), false);
        assert.equal(error.message.includes(PROXY_SECRET), false);
        return true;
      },
    );
  }
});

test("HTTP server exposes health and a signed member route with safe response headers", async (t) => {
  const calls = [];
  const server = createProxyServer({
    proxySecret: PROXY_SECRET,
    nowSeconds: () => NOW_SECONDS,
    wecomService: {
      async getMemberByCode(code) {
        calls.push(code);
        return {
          userId: "alice",
          displayName: "Alice",
          avatarUrl: null,
          email: null,
          departments: [],
        };
      },
    },
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assertSafeResponseHeaders(health);

  const rawBody = '{"code":"login-code"}';
  const response = await fetch(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hamark-timestamp": String(NOW_SECONDS),
      "x-hamark-signature": signBody(PROXY_SECRET, String(NOW_SECONDS), rawBody),
    },
    body: rawBody,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    member: {
      userId: "alice",
      displayName: "Alice",
      avatarUrl: null,
      email: null,
      departments: [],
    },
  });
  assert.deepEqual(calls, ["login-code"]);
  assertSafeResponseHeaders(response);
});

test("HTTP server verifies signatures before parsing JSON and rejects unsupported routes", async (t) => {
  const server = createProxyServer({
    proxySecret: PROXY_SECRET,
    nowSeconds: () => NOW_SECONDS,
    wecomService: {
      async getMemberByCode() {
        throw new Error("must not be called");
      },
    },
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const invalidSignature = await fetch(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hamark-timestamp": String(NOW_SECONDS),
      "x-hamark-signature": "0".repeat(64),
    },
    body: "not-json-login-code",
  });
  assert.equal(invalidSignature.status, 401);
  assert.deepEqual(await invalidSignature.json(), { ok: false, error: "INVALID_SIGNATURE" });

  const wrongContentType = await fetch(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "login-code",
  });
  assert.equal(wrongContentType.status, 400);
  assert.deepEqual(await wrongContentType.json(), { ok: false, error: "INVALID_REQUEST" });

  const missing = await fetch(`${baseUrl}/not-exposed`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: "INVALID_REQUEST" });
});

test("HTTP server enforces the 4 KiB streaming limit and sanitizes service errors and logs", async (t) => {
  const logs = [];
  const server = createProxyServer({
    proxySecret: PROXY_SECRET,
    nowSeconds: () => NOW_SECONDS,
    logger: { error: (...args) => logs.push(args) },
    wecomService: {
      async getMemberByCode() {
        throw new WeComServiceError(
          "WECOM_UNAVAILABLE",
          `${WECOM_SECRET} login-code access-token raw upstream response`,
        );
      },
    },
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const oversizedBody = "x".repeat(MAX_BODY_BYTES + 1);
  const oversized = await fetch(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hamark-timestamp": String(NOW_SECONDS),
      "x-hamark-signature": signBody(PROXY_SECRET, String(NOW_SECONDS), oversizedBody),
    },
    body: oversizedBody,
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { ok: false, error: "INVALID_REQUEST" });

  const rawBody = '{"code":"login-code"}';
  const unavailable = await fetch(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hamark-timestamp": String(NOW_SECONDS),
      "x-hamark-signature": signBody(PROXY_SECRET, String(NOW_SECONDS), rawBody),
    },
    body: rawBody,
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, error: "WECOM_UNAVAILABLE" });

  const serializedLogs = JSON.stringify(logs);
  for (const sensitive of [WECOM_SECRET, "login-code", "access-token", "raw upstream response"]) {
    assert.equal(serializedLogs.includes(sensitive), false);
  }
});

test("HTTP server enforces a total request deadline and passes its signal to the service", async (t) => {
  let serviceSignal;
  const server = createProxyServer({
    proxySecret: PROXY_SECRET,
    nowSeconds: () => NOW_SECONDS,
    logger: { error() {} },
    requestDeadlineMs: 25,
    wecomService: {
      async getMemberByCode(_code, options = {}) {
        serviceSignal = options.signal;
        await new Promise((resolve, reject) => {
          if (!serviceSignal) {
            reject(new Error("missing request signal"));
            return;
          }
          serviceSignal.addEventListener("abort", () => {
            reject(new WeComServiceError("WECOM_UNAVAILABLE"));
          }, { once: true });
        });
      },
    },
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const rawBody = '{"code":"login-code"}';
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: signedHeaders(rawBody),
    body: rawBody,
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "WECOM_UNAVAILABLE" });
  assert.equal(serviceSignal instanceof AbortSignal, true);
  assert.equal(serviceSignal.aborted, true);
  assert.equal(Date.now() - startedAt < 1000, true);
});

test("HTTP server aborts in-flight service work when the client disconnects", async (t) => {
  let serviceSignal;
  let markServiceStarted;
  let markServiceAborted;
  const serviceStarted = new Promise((resolveStarted) => {
    markServiceStarted = resolveStarted;
  });
  const serviceAborted = new Promise((resolveAborted) => {
    markServiceAborted = resolveAborted;
  });
  const server = createProxyServer({
    proxySecret: PROXY_SECRET,
    nowSeconds: () => NOW_SECONDS,
    logger: { error() {} },
    requestDeadlineMs: 1000,
    wecomService: {
      async getMemberByCode(_code, options = {}) {
        serviceSignal = options.signal;
        markServiceStarted();
        return new Promise((_resolve, reject) => {
          serviceSignal?.addEventListener("abort", () => {
            markServiceAborted();
            reject(new WeComServiceError("WECOM_UNAVAILABLE"));
          }, { once: true });
        });
      },
    },
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const rawBody = '{"code":"login-code"}';
  const request = httpRequest(`${baseUrl}/v1/member-by-code`, {
    method: "POST",
    headers: signedHeaders(rawBody),
  });
  request.on("error", () => {});
  request.end(rawBody);

  await serviceStarted;
  request.destroy();
  await Promise.race([
    serviceAborted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort not propagated")), 500)),
  ]);

  assert.equal(serviceSignal instanceof AbortSignal, true);
  assert.equal(serviceSignal.aborted, true);
});

function createService(fetcher) {
  return createWeComService({
    corpId: "wwcorp",
    secret: WECOM_SECRET,
    fetchImpl: fetcher.fetch,
    now: () => NOW,
  });
}

function memberResponses(userId) {
  return [
    jsonResponse({ errcode: 0, UserId: userId }),
    jsonResponse({ errcode: 0, userid: userId, name: userId, department: [1] }),
    jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] }),
  ];
}

function assertSanitizedServiceError(error, code) {
  assert.equal(error instanceof WeComServiceError, true);
  assert.equal(error.code, code);
  for (const sensitive of [WECOM_SECRET, "login-code", "access-token", "raw upstream response", "{"]) {
    assert.equal(error.message.includes(sensitive), false);
  }
}

function assertSafeResponseHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
}

function signedHeaders(rawBody) {
  return {
    "content-type": "application/json",
    "x-hamark-timestamp": String(NOW_SECONDS),
    "x-hamark-signature": signBody(PROXY_SECRET, String(NOW_SECONDS), rawBody),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

class QueuedFetch {
  calls = [];

  constructor(responses) {
    this.responses = [...responses];
  }

  fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    this.calls.push({ url, init });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch");
    }
    return response;
  };

  get urls() {
    return this.calls.map((call) => call.url);
  }
}
