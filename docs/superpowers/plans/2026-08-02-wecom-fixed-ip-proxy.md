# WeCom Fixed IP Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Hamark enterprise WeChat identity lookups through the fixed public IP `111.229.151.122` without exposing WeCom credentials or affecting existing services.

**Architecture:** Vercel keeps OAuth state, callbacks, Supabase users, and sessions. After state validation it sends the one-time WeCom code to `https://hamark-wecom.boga.plus/v1/member-by-code` in a timestamped HMAC-signed POST. A dedicated localhost-only Node service resolves the code through WeCom and returns a minimal normalized member object.

**Tech Stack:** Next.js 16, TypeScript, Node.js core HTTP/crypto APIs, Node test runner, Nginx, systemd, Certbot.

---

## File Map

- Modify `web/lib/auth/config.ts`: validate direct and proxy credential modes.
- Create `web/lib/auth/wecom-proxy.ts`: signed proxy request and response/error validation.
- Modify `web/lib/auth/wecom.ts`: select the proxy client before direct WeCom logic.
- Modify `web/tests/auth-core.test.ts`: proxy environment validation tests.
- Modify `web/tests/wecom-client.test.ts`: Vercel proxy request and error mapping tests.
- Create `web/services/wecom-proxy/protocol.mjs`: request size, timestamp, HMAC, and JSON validation.
- Create `web/services/wecom-proxy/wecom.mjs`: fixed-host WeCom API client and token cache.
- Create `web/services/wecom-proxy/server.mjs`: localhost HTTP service and safe responses.
- Create `web/tests/wecom-proxy-service.test.mjs`: proxy protocol and upstream behavior tests.
- Create `web/services/wecom-proxy/deploy/hamark-wecom-proxy.service`: isolated systemd unit.
- Create `web/services/wecom-proxy/deploy/nginx.conf`: isolated HTTPS reverse proxy.
- Modify `web/.env.example` and `web/README.md`: production environment and deployment contract.

### Task 1: Vercel proxy configuration contract

- [ ] **Step 1: Write failing configuration tests**

Add cases to `web/tests/auth-core.test.ts` proving that proxy mode accepts an HTTPS URL and a 32-byte secret without `WECOM_SECRET`, rejects partial proxy configuration, rejects a short proxy secret, and rejects HTTP outside development.

Expected configuration shape:

```ts
{
  appUrl: "https://hamark.boga.plus",
  authSecret: "a".repeat(32),
  corpId: "wwcorp",
  agentId: "1000002",
  secret: null,
  proxy: {
    url: "https://hamark-wecom.boga.plus",
    secret: "p".repeat(32),
  },
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && node --import tsx --test tests/auth-core.test.ts`  
Expected: FAIL because `getWeComAuthConfig()` still requires `WECOM_SECRET` and has no proxy fields.

- [ ] **Step 3: Implement the configuration union**

Change `WeComAuthConfig` to include:

```ts
secret: string | null;
proxy: { url: string; secret: string } | null;
```

Use `getOptionalEnv()` for `WECOM_SECRET`, `WECOM_PROXY_URL`, and `WECOM_PROXY_SECRET`. Require both proxy variables together, require at least 32 UTF-8 bytes for the proxy secret, require HTTPS outside development, and require either a complete proxy configuration or `WECOM_SECRET`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd web && node --import tsx --test tests/auth-core.test.ts`  
Expected: all configuration tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/lib/auth/config.ts web/tests/auth-core.test.ts
git commit -m "feat: configure fixed IP WeCom proxy"
```

### Task 2: Signed Vercel proxy client

- [ ] **Step 1: Write failing client tests**

Extend `web/tests/wecom-client.test.ts` with proxy-mode cases that assert:

```ts
assert.equal(call.url, "https://hamark-wecom.boga.plus/v1/member-by-code");
assert.equal(call.init?.method, "POST");
assert.equal(call.init?.body, JSON.stringify({ code: "login-code" }));
assert.match(headers.get("x-hamark-timestamp") ?? "", /^\d+$/);
assert.match(headers.get("x-hamark-signature") ?? "", /^[a-f0-9]{64}$/);
assert.equal(fetcher.urls.some((url) => url.includes("qyapi.weixin.qq.com")), false);
```

Also cover stable proxy errors `AUTH_EXPIRED`, `MEMBER_NOT_ALLOWED`, `PROFILE_UNAVAILABLE`, malformed JSON, `401`, and `5xx` without leaking response bodies.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && node --import tsx --test tests/wecom-client.test.ts`  
Expected: FAIL because proxy mode is not implemented.

- [ ] **Step 3: Implement `web/lib/auth/wecom-proxy.ts`**

Expose one focused function:

```ts
export async function fetchMemberFromProxy(options: {
  code: string;
  proxy: NonNullable<WeComAuthConfig["proxy"]>;
  fetchImpl: typeof fetch;
  now: () => Date;
}): Promise<WeComMember>;
```

Serialize exactly `{"code":"..."}`, sign `${timestamp}.${rawBody}` with Node `createHmac("sha256", secret)`, set an 8-second timeout, validate JSON structure field by field, and map stable proxy errors to existing `AuthError` codes.

- [ ] **Step 4: Route `WeComClient` through the proxy**

At the start of `getMemberByCode`, use `fetchMemberFromProxy` when `config.proxy` is present. Keep direct mode for local tests, but make `buildTokenUrl` reject a null direct secret so production never silently falls back.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `cd web && node --import tsx --test tests/wecom-client.test.ts`  
Expected: all direct and proxy client tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/lib/auth/wecom-proxy.ts web/lib/auth/wecom.ts web/tests/wecom-client.test.ts
git commit -m "feat: call WeCom through signed proxy"
```

### Task 3: Fixed-host proxy service

- [ ] **Step 1: Write failing proxy service tests**

Create `web/tests/wecom-proxy-service.test.mjs` covering:

- known HMAC vector and constant-time rejection;
- timestamps older or newer than 60 seconds;
- bodies over 4 KiB and invalid `code` values;
- token retrieval and in-memory reuse;
- `getuserinfo`, `user/get`, and `department/simplelist` normalization;
- WeCom errors mapped to stable proxy errors;
- error messages and logs exclude Secret, token, and code.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && node --test tests/wecom-proxy-service.test.mjs`  
Expected: FAIL because the service modules do not exist.

- [ ] **Step 3: Implement protocol validation**

Create `web/services/wecom-proxy/protocol.mjs` with:

```js
export const MAX_BODY_BYTES = 4096;
export const MAX_CLOCK_SKEW_SECONDS = 60;
export function signBody(secret, timestamp, rawBody) { /* HMAC-SHA256 hex */ }
export function verifySignedBody({ secret, timestamp, signature, rawBody, nowSeconds }) { /* boolean */ }
export function parseMemberRequest(rawBody) { /* returns code or throws INVALID_REQUEST */ }
```

Perform length checks before `timingSafeEqual` and never include input values in thrown messages.

- [ ] **Step 4: Implement the WeCom upstream client**

Create `web/services/wecom-proxy/wecom.mjs` exporting `createWeComService({ corpId, secret, fetchImpl, now })`. Cache the token until five minutes before expiry and return:

```js
{
  userId,
  displayName,
  avatarUrl,
  email,
  departments: [{ id, name, isPrimary }],
}
```

Use exact WeCom endpoints, an 8-second timeout, and stable internal errors without raw upstream payloads.

- [ ] **Step 5: Implement the localhost server**

Create `web/services/wecom-proxy/server.mjs` using Node core `http`. Validate environment at startup, expose only `GET /health` and `POST /v1/member-by-code`, enforce body limits while streaming, verify signatures before parsing JSON, and return JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run: `cd web && node --test tests/wecom-proxy-service.test.mjs`  
Expected: all proxy service tests pass.

- [ ] **Step 7: Commit**

```bash
git add web/services/wecom-proxy web/tests/wecom-proxy-service.test.mjs
git commit -m "feat: add isolated WeCom proxy service"
```

### Task 4: Deployment and operator contract

- [ ] **Step 1: Add source-level deployment assertions**

Extend `web/tests/backend-adapters.test.mjs` to assert `.env.example` contains `WECOM_PROXY_URL` and `WECOM_PROXY_SECRET`, the systemd unit binds the expected environment file, and Nginx routes only `hamark-wecom.boga.plus` to `127.0.0.1:3201`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd web && node --test tests/backend-adapters.test.mjs`  
Expected: FAIL because deployment artifacts and documentation are missing.

- [ ] **Step 3: Add deployment files and documentation**

Add a hardened `hamark-wecom-proxy.service` using a dedicated user, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, and `Restart=on-failure`. Add an Nginx config for `hamark-wecom.boga.plus` with a 4 KiB body limit, short timeouts, rate limiting, no query-string access logging, and proxying only the health and member endpoints.

Update `.env.example` and `README.md` with exact Vercel/server variable ownership and the trusted IP `111.229.151.122`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd web && node --test tests/backend-adapters.test.mjs`  
Expected: all source-level deployment checks pass.

- [ ] **Step 5: Commit**

```bash
git add web/.env.example web/README.md web/services/wecom-proxy/deploy web/tests/backend-adapters.test.mjs
git commit -m "docs: add WeCom proxy deployment contract"
```

### Task 5: Full local verification

- [ ] **Step 1: Run static checks**

Run: `cd web && npm run lint && npx tsc --noEmit`  
Expected: both commands exit 0.

- [ ] **Step 2: Run the complete suite**

Run: `cd web && npm test`  
Expected: build succeeds and every test passes.

- [ ] **Step 3: Review secret exposure**

Run searches for `WECOM_SECRET`, `access_token`, and proxy request bodies across tracked deployment files and test output. Confirm no real secret values or log statements containing sensitive payloads exist.

### Task 6: Server, DNS, TLS, and Vercel deployment

- [ ] **Step 1: Deploy the isolated service**

Create user `hamark-wecom`, install the three service modules under `/opt/hamark-wecom-proxy`, place a mode-`0600` environment file at `/etc/hamark-wecom-proxy.env`, install the systemd unit, and start the service. Do not change ports `3000`, `3010`, or `3100`.

- [ ] **Step 2: Verify localhost isolation**

Run on the server:

```bash
curl -fsS http://127.0.0.1:3201/health
ss -ltnp
```

Expected: health returns `{"ok":true}` and port `3201` listens only on `127.0.0.1`.

- [ ] **Step 3: Configure DNS and TLS**

Create `hamark-wecom.boga.plus A 111.229.151.122`, install the isolated Nginx site, validate with `nginx -t`, issue the certificate with Certbot, and reload Nginx.

- [ ] **Step 4: Configure external systems**

Add `111.229.151.122` to the Hamark enterprise WeChat application's trusted IP list. Configure Vercel Production with `WECOM_PROXY_URL=https://hamark-wecom.boga.plus` and the generated proxy secret, remove Production `WECOM_SECRET`, then redeploy.

- [ ] **Step 5: Production verification**

Verify health, unsigned `401`, signed synthetic error handling, Nginx/service log redaction, and BOGACLAW/OpenClaw/Advault health. Complete one desktop QR login and one in-app login.

- [ ] **Step 6: Push final source**

```bash
git push origin main
```
