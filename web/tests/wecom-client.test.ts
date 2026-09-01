import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { WeComAuthConfig } from "../lib/auth/config.ts";
import { encryptSecret } from "../lib/auth/security.ts";
import type {
  AuthStore,
  CurrentUser,
  EncryptedAppToken,
  NewOAuthState,
  NewSession,
  OAuthStateRecord,
} from "../lib/auth/store.ts";
import { AuthError, type WeComMember } from "../lib/auth/types.ts";
import { buildWeComAuthorizationUrl, WeComClient } from "../lib/auth/wecom.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const CONFIG: WeComAuthConfig = {
  appUrl: "https://hamark.boga.plus",
  authSecret: "a".repeat(32),
  corpId: "wwcorp",
  agentId: "1000002",
  secret: "super-secret-value",
  proxy: null,
};
const PROXY_CONFIG: WeComAuthConfig = {
  ...CONFIG,
  secret: "direct-secret-must-not-be-used",
  proxy: {
    url: "https://hamark-wecom.boga.plus",
    secret: "proxy-secret-value".padEnd(32, "p"),
  },
};

test("buildWeComAuthorizationUrl creates the exact QR authorization URL", () => {
  const value = buildWeComAuthorizationUrl(CONFIG, "QR", "state-token");
  const url = new URL(value);

  assert.equal(
    value,
    "https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=wwcorp&agentid=1000002&redirect_uri=https%3A%2F%2Fhamark.boga.plus%2Fapi%2Fauth%2Fwecom%2Fcallback&state=state-token",
  );
  assert.equal(url.origin + url.pathname, "https://open.work.weixin.qq.com/wwopen/sso/qrConnect");
  assert.equal(url.searchParams.get("appid"), "wwcorp");
  assert.equal(url.searchParams.get("agentid"), "1000002");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://hamark.boga.plus/api/auth/wecom/callback",
  );
  assert.equal(url.searchParams.get("state"), "state-token");
});

test("buildWeComAuthorizationUrl creates IN_APP OAuth URL with base scope and wechat redirect hash", () => {
  const value = buildWeComAuthorizationUrl(CONFIG, "IN_APP", "state-token");
  const withoutHash = value.slice(0, -"#wechat_redirect".length);
  const url = new URL(withoutHash);

  assert.equal(
    value,
    "https://open.weixin.qq.com/connect/oauth2/authorize?appid=wwcorp&redirect_uri=https%3A%2F%2Fhamark.boga.plus%2Fapi%2Fauth%2Fwecom%2Fcallback&response_type=code&scope=snsapi_base&state=state-token&agentid=1000002#wechat_redirect",
  );
  assert.equal(value.startsWith("https://open.weixin.qq.com/connect/oauth2/authorize?"), true);
  assert.equal(url.searchParams.get("appid"), "wwcorp");
  assert.equal(url.searchParams.get("agentid"), "1000002");
  assert.equal(url.searchParams.get("scope"), "snsapi_base");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://hamark.boga.plus/api/auth/wecom/callback",
  );
  assert.equal(value.endsWith("#wechat_redirect"), true);
});

test("getMemberByCode uses cached app token and avoids gettoken", async () => {
  const store = new FakeAuthStore();
  await store.seedToken(CONFIG, "cached-token", new Date(NOW.getTime() + 301_000));
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({
      errcode: 0,
      userid: "alice",
      name: "Alice",
      avatar: "https://cdn.example/alice.png",
      email: "alice@example.com",
      department: [7],
    }),
    jsonResponse({ errcode: 0, department_id: [{ id: 7, name: "Brand" }] }),
  ]);

  const member = await newClient(store, fetcher).getMemberByCode("login-code");

  assert.equal(fetcher.urls.some((url) => url.includes("/cgi-bin/gettoken?")), false);
  assert.equal(member.userId, "alice");
  assert.equal(member.displayName, "Alice");
  assert.deepEqual(member.departments, [{ id: "7", name: "Brand", isPrimary: true }]);
});

test("getMemberByCode rejects a missing direct secret before using a fresh cached token", async () => {
  const config: WeComAuthConfig = { ...CONFIG, secret: null, proxy: null };
  const store = new FakeAuthStore();
  await store.seedToken(config, "cached-token", new Date(NOW.getTime() + 3_600_000));
  const fetcher = new QueuedFetch([]);

  await assert.rejects(
    () =>
      new WeComClient({ config, store, fetchImpl: fetcher.fetch, now: () => NOW }).getMemberByCode(
        "login-code",
      ),
    (error) => {
      assertAuthError(error, "auth_misconfigured");
      return true;
    },
  );
  assert.equal(fetcher.calls.length, 0);
});

test("getMemberByCode refreshes stale tokens but rechecks cache inside the refresh lock first", async () => {
  const store = new FakeAuthStore();
  await store.seedToken(CONFIG, "stale-token", new Date(NOW.getTime() + 300_000));
  const freshInsideLock = await encryptedToken(CONFIG, "fresh-token", new Date(NOW.getTime() + 3_600_000));
  store.onLock = () => {
    store.token = freshInsideLock;
  };
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({ errcode: 0, userid: "alice", name: "Alice", department: [1] }),
    jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] }),
  ]);

  await newClient(store, fetcher).getMemberByCode("login-code");

  assert.equal(store.lockCount, 1);
  assert.equal(fetcher.urls.some((url) => url.includes("/cgi-bin/gettoken?")), false);
  assert.equal(
    fetcher.urls.some((url) => url.includes("access_token=fresh-token")),
    true,
  );
});

test("getMemberByCode fetches and stores a new encrypted app token when cache remains stale", async () => {
  const store = new FakeAuthStore();
  await store.seedToken(CONFIG, "stale-token", new Date(NOW.getTime() + 60_000));
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, access_token: "new-token", expires_in: 7200 }),
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({ errcode: 0, userid: "alice", name: "Alice", department: [1] }),
    jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] }),
  ]);

  await newClient(store, fetcher).getMemberByCode("login-code");

  assert.equal(fetcher.urls[0], "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=wwcorp&corpsecret=super-secret-value");
  assert.equal(store.putTokens.length, 1);
  assert.equal(store.putTokens[0]?.expiresAt, "2026-08-02T14:00:00.000Z");
});

test("getMemberByCode maps WeCom auth and profile errors to AuthError codes without leaking sensitive data", async () => {
  await assertWeComFailure(
    [jsonResponse({ errcode: 40029, errmsg: "invalid code login-code super-secret-value" })],
    "auth_expired",
  );
  await assertWeComFailure([jsonResponse({ errcode: 42003 })], "auth_expired");
  await assertWeComFailure([jsonResponse({ errcode: 42022 })], "auth_expired");
  await assertWeComFailure(
    [jsonResponse({ errcode: 60020, errmsg: "not allow to access from your ip" })],
    "wecom_untrusted_ip",
  );
  await assertWeComFailure(
    [jsonResponse({ errcode: 50001, errmsg: "not allowed access-token" })],
    "member_not_allowed",
  );
  await assertWeComFailure([jsonResponse({ errcode: 60021 })], "member_not_allowed");
  await assertWeComFailure(
    [jsonResponse({ errcode: 0 })],
    "member_not_allowed",
  );
  await assertWeComFailure(
    [jsonResponse({ errcode: 0, UserId: "alice" }), jsonResponse({ errcode: 60111 })],
    "member_not_allowed",
  );
  await assertWeComFailure(
    [jsonResponse({ errcode: 0, UserId: "alice" }), jsonResponse({ errcode: 0 })],
    "profile_unavailable",
  );
  await assertWeComFailure([jsonResponse({ errcode: -1 })], "service_unavailable");
  await assertWeComFailure([jsonResponse({ errcode: 0 }, 503)], "service_unavailable");
});

test("getMemberByCode maps network failures to service_unavailable", async () => {
  const store = new FakeAuthStore();
  await store.seedToken(CONFIG, "cached-token", new Date(NOW.getTime() + 3_600_000));
  const fetcher: typeof fetch = async () => {
    throw new TypeError("network down with login-code and cached-token");
  };

  await assert.rejects(
    () => new WeComClient({ config: CONFIG, store, fetchImpl: fetcher, now: () => NOW }).getMemberByCode("login-code"),
    (error) => {
      assertAuthError(error, "service_unavailable");
      return true;
    },
  );
});

test("getMemberByCode handles missing avatar and email, dedupes departments, and falls back missing names", async () => {
  const store = new FakeAuthStore();
  await store.seedToken(CONFIG, "cached-token", new Date(NOW.getTime() + 3_600_000));
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({ errcode: 0, userid: "alice", name: "Alice", department: [3, 4, 3] }),
    jsonResponse({ errcode: 0, department_id: [{ id: 3, name: "Sales" }, { id: 4, parentid: 1 }] }),
  ]);

  const member = await newClient(store, fetcher).getMemberByCode("login-code");

  assert.deepEqual(member, {
    userId: "alice",
    displayName: "Alice",
    avatarUrl: null,
    email: null,
    departments: [
      { id: "3", name: "Sales", isPrimary: true },
      { id: "4", name: "部门 4", isPrimary: false },
    ],
  });
});

test("every WeCom fetch receives an 8000ms timeout signal", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  const store = new FakeAuthStore();
  const fetcher = new QueuedFetch([
    jsonResponse({ errcode: 0, access_token: "new-token", expires_in: 7200 }),
    jsonResponse({ errcode: 0, UserId: "alice" }),
    jsonResponse({ errcode: 0, userid: "alice", name: "Alice", department: [1] }),
    jsonResponse({ errcode: 0, department_id: [{ id: 1, name: "Engineering" }] }),
  ]);

  try {
    await newClient(store, fetcher).getMemberByCode("login-code");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(timeouts, [8000, 8000, 8000, 8000]);
  assert.equal(fetcher.calls.every((call) => call.init?.signal instanceof AbortSignal), true);
});

test("getMemberByCode signs the exact proxy request and never calls qyapi", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  const fetcher = new QueuedFetch([
    jsonResponse({
      ok: true,
      member: {
        userId: "alice",
        displayName: "Alice",
        avatarUrl: null,
        email: "alice@example.com",
        departments: [{ id: "7", name: "Brand", isPrimary: true }],
      },
    }),
  ]);

  let member: WeComMember;
  try {
    member = await new WeComClient({
      config: PROXY_CONFIG,
      store: new FakeAuthStore(),
      fetchImpl: fetcher.fetch,
      now: () => NOW,
    }).getMemberByCode("login-code");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  const call = fetcher.calls[0];
  assert.equal(fetcher.calls.length, 1);
  assert.equal(call?.url, "https://hamark-wecom.boga.plus/v1/member-by-code");
  assert.equal(call?.init?.method, "POST");
  assert.equal(call?.init?.redirect, "error");
  assert.equal(call?.init?.body, JSON.stringify({ code: "login-code" }));
  assert.equal(fetcher.urls.some((url) => url.includes("qyapi.weixin.qq.com")), false);
  const headers = new Headers(call?.init?.headers);
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const expectedSignature = createHmac("sha256", PROXY_CONFIG.proxy!.secret)
    .update(`${timestamp}.${JSON.stringify({ code: "login-code" })}`)
    .digest("hex");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-hamark-timestamp"), timestamp);
  assert.equal(headers.get("x-hamark-signature"), expectedSignature);
  assert.deepEqual(timeouts, [8000]);
  assert.deepEqual(member, {
    userId: "alice",
    displayName: "Alice",
    avatarUrl: null,
    email: "alice@example.com",
    departments: [{ id: "7", name: "Brand", isPrimary: true }],
  });
});

test("getMemberByCode strictly validates successful proxy member responses", async () => {
  const invalidMembers: unknown[] = [
    null,
    {},
    { userId: "", displayName: "Alice", avatarUrl: null, email: null, departments: [] },
    { userId: "alice", displayName: "Alice", avatarUrl: 1, email: null, departments: [] },
    { userId: "alice", displayName: "Alice", avatarUrl: null, email: null, departments: {} },
    {
      userId: "alice",
      displayName: "Alice",
      avatarUrl: null,
      email: null,
      departments: [{ id: "7", name: "Brand", isPrimary: "yes" }],
    },
  ];

  for (const member of invalidMembers) {
    await assertProxyFailure(jsonResponse({ ok: true, member }), "service_unavailable");
  }
});

test("getMemberByCode maps stable proxy errors without exposing sensitive data", async () => {
  await assertProxyFailure(
    jsonResponse({ ok: false, error: "AUTH_EXPIRED", detail: "login-code proxy-response-secret" }, 400),
    "auth_expired",
  );
  await assertProxyFailure(
    jsonResponse({ ok: false, error: "MEMBER_NOT_ALLOWED", detail: "login-code proxy-response-secret" }, 403),
    "member_not_allowed",
  );
  await assertProxyFailure(
    jsonResponse({ ok: false, error: "PROFILE_UNAVAILABLE", detail: "login-code proxy-response-secret" }, 422),
    "profile_unavailable",
  );
  await assertProxyFailure(
    jsonResponse(
      { ok: false, error: "PROFILE_UNAVAILABLE", detail: "login-code proxy-response-secret" },
      502,
    ),
    "profile_unavailable",
  );
  await assertProxyFailure(
    jsonResponse({ ok: false, error: "AUTH_EXPIRED", detail: "proxy-response-secret" }, 401),
    "auth_expired",
  );
  await assertProxyFailure(
    jsonResponse({ ok: false, error: "WECOM_UNAVAILABLE", detail: "proxy-response-secret" }, 503),
    "service_unavailable",
  );
  await assertProxyFailure(
    new Response("proxy-response-secret login-code", { status: 200 }),
    "service_unavailable",
  );
  await assertProxyFailure(
    new Response("proxy-response-secret login-code", { status: 502 }),
    "service_unavailable",
  );
});

test("getMemberByCode keeps invalid 401 proxy responses service_unavailable", async () => {
  await assertProxyFailure(
    jsonResponse(
      { ok: false, error: "INVALID_SIGNATURE", detail: "login-code proxy-response-secret" },
      401,
    ),
    "service_unavailable",
  );
  await assertProxyFailure(
    new Response("login-code proxy-response-secret", { status: 401 }),
    "service_unavailable",
  );
});

function newClient(store: FakeAuthStore, fetcher: QueuedFetch) {
  return new WeComClient({ config: CONFIG, store, fetchImpl: fetcher.fetch, now: () => NOW });
}

async function assertWeComFailure(
  responses: Response[],
  expectedCode: AuthError["code"],
): Promise<void> {
  const store = new FakeAuthStore();
  await store.seedToken(CONFIG, "access-token", new Date(NOW.getTime() + 3_600_000));
  const fetcher = new QueuedFetch(responses);

  await assert.rejects(
    () => newClient(store, fetcher).getMemberByCode("login-code"),
    (error) => {
      assertAuthError(error, expectedCode);
      return true;
    },
  );
}

async function assertProxyFailure(response: Response, expectedCode: AuthError["code"]): Promise<void> {
  const fetcher = new QueuedFetch([response]);

  await assert.rejects(
    () =>
      new WeComClient({
        config: PROXY_CONFIG,
        store: new FakeAuthStore(),
        fetchImpl: fetcher.fetch,
        now: () => NOW,
      }).getMemberByCode("login-code"),
    (error) => {
      assertAuthError(error, expectedCode);
      const message = (error as Error).message;
      assert.equal(message.includes(PROXY_CONFIG.proxy!.secret), false);
      assert.equal(message.includes(PROXY_CONFIG.secret!), false);
      assert.equal(message.includes("proxy-response-secret"), false);
      return true;
    },
  );
}

function assertAuthError(error: unknown, expectedCode: AuthError["code"]): void {
  assert.equal(error instanceof AuthError, true);
  const authError = error as AuthError;
  assert.equal(authError.code, expectedCode);
  assert.equal(authError.message.includes(CONFIG.secret ?? ""), false);
  assert.equal(authError.message.includes("login-code"), false);
  assert.equal(authError.message.includes("access-token"), false);
  assert.equal(authError.message.includes("{"), false);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function encryptedToken(
  config: WeComAuthConfig,
  value: string,
  expiresAt: Date,
): Promise<EncryptedAppToken> {
  return {
    corpId: config.corpId,
    agentId: config.agentId,
    token: await encryptSecret(value, config.authSecret),
    expiresAt: expiresAt.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

class QueuedFetch {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];

  constructor(private readonly responses: Response[]) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    this.calls.push({ url, init });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    return response;
  };

  get urls(): string[] {
    return this.calls.map((call) => call.url);
  }
}

class FakeAuthStore implements AuthStore {
  token: EncryptedAppToken | null = null;
  lockCount = 0;
  putTokens: EncryptedAppToken[] = [];
  onLock: (() => void) | null = null;

  async seedToken(config: WeComAuthConfig, value: string, expiresAt: Date): Promise<void> {
    this.token = await encryptedToken(config, value, expiresAt);
  }

  async getAppToken(corpId: string, agentId: string, now: string): Promise<EncryptedAppToken | null> {
    if (!this.token || this.token.corpId !== corpId || this.token.agentId !== agentId) {
      return null;
    }
    return this.token.expiresAt > now ? this.token : null;
  }

  async putAppToken(input: EncryptedAppToken): Promise<void> {
    this.token = input;
    this.putTokens.push(input);
  }

  async withAppTokenRefreshLock<T>(
    _corpId: string,
    _agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.lockCount += 1;
    this.onLock?.();
    return operation();
  }

  async createOAuthState(input: NewOAuthState): Promise<void> {
    void input;
    throw new Error("Not implemented for WeComClient tests.");
  }

  async consumeOAuthState(
    stateHash: string,
    nonceHash: string,
    now: string,
  ): Promise<OAuthStateRecord | null> {
    void stateHash;
    void nonceHash;
    void now;
    throw new Error("Not implemented for WeComClient tests.");
  }

  async syncUser(
    corpId: string,
    member: WeComMember,
    identityKey: string,
    now: string,
  ): Promise<CurrentUser> {
    void corpId;
    void member;
    void identityKey;
    void now;
    throw new Error("Not implemented for WeComClient tests.");
  }

  async createSession(input: NewSession): Promise<void> {
    void input;
    throw new Error("Not implemented for WeComClient tests.");
  }

  async getSession(
    tokenHash: string,
    now: string,
    renewedExpiresAt: string,
  ): Promise<CurrentUser | null> {
    void tokenHash;
    void now;
    void renewedExpiresAt;
    throw new Error("Not implemented for WeComClient tests.");
  }

  async revokeSession(tokenHash: string, now: string): Promise<void> {
    void tokenHash;
    void now;
    throw new Error("Not implemented for WeComClient tests.");
  }
}
