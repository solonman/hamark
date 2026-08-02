# WeCom Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-grade WeCom QR and in-app login, server-side sessions, user and department sync, and mandatory authentication for every page and business API.

**Architecture:** Keep authentication inside the existing Next.js monolith. Separate pure security and URL helpers, the WeCom HTTP client, the PostgreSQL auth repository, session/OAuth use cases, and Next.js routes so each boundary can be tested independently. Use opaque session cookies backed by hashed database records; use one-time OAuth state plus a browser nonce; use WeCom `UserId` as the stable identity.

**Tech Stack:** Next.js 16 App Router, TypeScript, Node Web Crypto, Supabase PostgreSQL through the existing `DbClient`, native `fetch`, Node test runner with `tsx`, Vercel.

---

## File Map

Create these focused modules:

- `web/lib/auth/types.ts`: shared auth, WeCom profile, session, and error types.
- `web/lib/auth/config.ts`: server-only environment parsing and auth constants.
- `web/lib/auth/security.ts`: random tokens, hashing, AES-GCM token encryption, identity keys, and safe return paths.
- `web/lib/auth/wecom.ts`: WeCom authorization URLs and HTTP API client.
- `web/lib/auth/store.ts`: auth persistence interface and PostgreSQL implementation.
- `web/lib/auth/session.ts`: cookie parsing, session creation, current-user lookup, page/API guards, logout.
- `web/lib/auth/login.ts`: OAuth transaction orchestration and user sync.
- `web/lib/auth/server.ts`: server-only composition of config, store, WeCom client, and login/session services.
- `web/app/login/page.tsx`: public login and controlled error page.
- `web/app/api/auth/wecom/start/route.ts`: create OAuth state and redirect.
- `web/app/api/auth/wecom/callback/route.ts`: consume state, complete login, set session cookie.
- `web/app/api/auth/me/route.ts`: minimal current-user JSON.
- `web/app/api/auth/logout/route.ts`: same-origin POST logout.
- `web/proxy.ts`: fast missing-cookie redirect/401 for protected paths.
- `web/app/components/UserMenu.tsx`: current-member display and logout action.
- `web/tests/auth-core.test.ts`: pure helper tests.
- `web/tests/wecom-client.test.ts`: URL, response parsing, timeout, and error mapping tests.
- `web/tests/auth-store-session.test.ts`: state/session behavior using an in-memory store.
- `web/tests/auth-login.test.ts`: callback orchestration and replay tests.
- `web/tests/auth-access.test.ts`: proxy and source-level full-route coverage checks.

Modify these existing files:

- `web/package.json`, `web/package-lock.json`: add `tsx` and include TypeScript tests.
- `web/db/supabase.sql`, `web/db/bootstrap.ts`, `web/db/index.ts`: add idempotent auth schema, RLS, and a transaction helper.
- `web/lib/current-user.ts`: remove demo fallback and expose authenticated identity helpers.
- `web/app/page.tsx`, `web/app/components/HomeClient.tsx`: require and display current user.
- `web/app/videos/[id]/page.tsx`, `web/app/videos/[id]/practice/page.tsx`: require a valid page session.
- All eight existing business API route files: replace header/demo identity with async session authentication.
- `web/app/globals.css`: login page and user-menu styles consistent with the current site.
- `web/.env.example`, `web/README.md`, `README_同事接手必读.md`: configuration and rollout instructions.

## Task 1: Test Runner and Auth Core

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/tests/auth-core.test.ts`
- Create: `web/lib/auth/types.ts`
- Create: `web/lib/auth/config.ts`
- Create: `web/lib/auth/security.ts`

- [ ] **Step 1: Install the TypeScript test loader**

Run:

```bash
cd web
npm install --save-dev tsx
```

Change the test script to:

```json
"test": "npm run build && node --import tsx --test tests/*.test.mjs tests/*.test.ts"
```

Expected: `tsx` appears in `devDependencies` and the lockfile remains valid under `npm ci --dry-run`.

- [ ] **Step 2: Write failing auth-core tests**

Create `web/tests/auth-core.test.ts` with tests that import the missing module and assert exact behavior:

```ts
import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(safeReturnTo("/api/auth/wecom/callback"), "/");
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
```

- [ ] **Step 3: Run the tests and confirm RED**

Run:

```bash
cd web
node --import tsx --test tests/auth-core.test.ts
```

Expected: FAIL because `lib/auth/security.ts` does not exist.

- [ ] **Step 4: Implement types, configuration, and security helpers**

Define these public contracts in `types.ts`:

```ts
export type AuthFlow = "QR" | "IN_APP";

export type CurrentUser = {
  id: string;
  identityKey: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  departments: Array<{ id: string; name: string; isPrimary: boolean }>;
};

export type WeComMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
  departments: Array<{ id: string; name: string; isPrimary: boolean }>;
};

export class AuthError extends Error {
  constructor(
    public readonly code:
      | "auth_cancelled"
      | "auth_expired"
      | "member_not_allowed"
      | "profile_unavailable"
      | "service_unavailable"
      | "auth_misconfigured",
    message: string,
  ) {
    super(message);
  }
}
```

`config.ts` must call `getRequiredEnv()` and return `{ appUrl, authSecret, corpId, agentId, secret }`; validate `APP_URL` as HTTPS outside development and require the UTF-8 encoded `AUTH_SECRET` to contain at least 32 bytes.

Implement `security.ts` with Node Web Crypto:

```ts
export function randomToken(): string;
export async function hashToken(value: string): Promise<string>;
export function safeReturnTo(value: string | null | undefined): string;
export function buildIdentityKey(corpId: string, userId: string): string;
export async function encryptSecret(value: string, authSecret: string): Promise<{ ciphertext: string; iv: string }>;
export async function decryptSecret(value: { ciphertext: string; iv: string }, authSecret: string): Promise<string>;
```

Use 32 random bytes encoded as base64url, SHA-256 hex hashes, `wecom:${sha256(corpId + "\0" + userId)}` identity keys, HKDF-SHA-256 with info `hamark-wecom-token-v1`, and AES-256-GCM. `safeReturnTo` must reject auth routes and non-local URLs.

- [ ] **Step 5: Run auth-core tests and lint**

Run:

```bash
cd web
node --import tsx --test tests/auth-core.test.ts
npm run lint
```

Expected: all auth-core tests PASS and lint exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/tests/auth-core.test.ts web/lib/auth
git commit -m "Add authentication core utilities"
```

## Task 2: Authentication Database Schema and Store

**Files:**
- Modify: `web/db/supabase.sql`
- Modify: `web/db/bootstrap.ts`
- Modify: `web/db/index.ts`
- Create: `web/lib/auth/store.ts`
- Create: `web/tests/auth-store-session.test.ts`

- [ ] **Step 1: Write failing store contract tests**

Define an `InMemoryAuthStore` inside the test and write the expected contract before the production interface exists:

```ts
test("OAuth state is consumed exactly once", async () => {
  const store = new InMemoryAuthStore();
  await store.createOAuthState({ stateHash: "state", nonceHash: "nonce", returnTo: "/videos/1", flow: "QR", expiresAt: future });
  assert.equal((await store.consumeOAuthState("state", "nonce", now))?.returnTo, "/videos/1");
  assert.equal(await store.consumeOAuthState("state", "nonce", now), null);
});

test("expired and nonce-mismatched OAuth states are rejected", async () => {
  const store = new InMemoryAuthStore();
  await store.createOAuthState({ stateHash: "state", nonceHash: "nonce", returnTo: "/", flow: "QR", expiresAt: past });
  assert.equal(await store.consumeOAuthState("state", "nonce", now), null);
  assert.equal(await store.consumeOAuthState("state", "wrong", now), null);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run `node --import tsx --test tests/auth-store-session.test.ts`.

Expected: FAIL because `AuthStore` and its record types are missing.

- [ ] **Step 3: Add the idempotent schema**

Add `users`, `user_departments`, `auth_sessions`, `oauth_states`, and `wecom_app_tokens` exactly as defined in the design. Add these constraints:

```sql
UNIQUE (wecom_corp_id, wecom_user_id)
CHECK (status IN ('ACTIVE', 'DISABLED'))
CHECK (flow_type IN ('QR', 'IN_APP'))
```

Add indexes on session token hash and expiry, OAuth state hash and expiry, and user identity key. Append:

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE wecom_app_tokens ENABLE ROW LEVEL SECURITY;
```

Mirror every statement in `db/bootstrap.ts` so a fresh deployment initializes the same schema.

- [ ] **Step 4: Implement `AuthStore` and `PostgresAuthStore`**

Expose this interface:

```ts
export interface AuthStore {
  createOAuthState(input: NewOAuthState): Promise<void>;
  consumeOAuthState(stateHash: string, nonceHash: string, now: string): Promise<OAuthStateRecord | null>;
  syncUser(corpId: string, member: WeComMember, identityKey: string, now: string): Promise<CurrentUser>;
  createSession(input: NewSession): Promise<void>;
  getSession(tokenHash: string, now: string): Promise<CurrentUser | null>;
  revokeSession(tokenHash: string, now: string): Promise<void>;
  getAppToken(corpId: string, agentId: string, now: string): Promise<EncryptedAppToken | null>;
  putAppToken(input: EncryptedAppToken): Promise<void>;
  withAppTokenRefreshLock<T>(corpId: string, agentId: string, operation: () => Promise<T>): Promise<T>;
}
```

`consumeOAuthState` must use one atomic SQL statement:

```sql
UPDATE oauth_states
SET consumed_at = ?
WHERE state_hash = ?
  AND browser_nonce_hash = ?
  AND consumed_at IS NULL
  AND expires_at > ?
RETURNING return_to, flow_type
```

Add this helper to `db/index.ts` and make `DbClient` accept either a pool or a checked-out pool client:

```ts
export async function withDbTransaction<T>(operation: (db: DbClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(new DbClient(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

`getSession` must join `auth_sessions`, `users`, and `user_departments`, reject revoked/expired/disabled rows, and return one `CurrentUser` with deduplicated departments. `syncUser()` must upsert the user, delete the prior department snapshot, insert the current snapshot, and read the final `CurrentUser` inside one `withDbTransaction()` call.

`withAppTokenRefreshLock()` must acquire `pg_advisory_xact_lock(hashtext(corpId || ':' || agentId))` inside a transaction before invoking `operation`. This makes every process recheck the cached token after acquiring the same application-scoped lock.

- [ ] **Step 5: Complete the in-memory contract implementation and turn GREEN**

Make the test store implement every `AuthStore` method with Maps and a serialized Promise queue for `withAppTokenRefreshLock()`. Add tests for user upsert stability, department replacement, session expiration, session revocation, and app-token expiry.

Run:

```bash
cd web
node --import tsx --test tests/auth-store-session.test.ts
npm run lint
```

Expected: PASS, with no lint errors.

- [ ] **Step 6: Commit**

```bash
git add web/db web/lib/auth/store.ts web/tests/auth-store-session.test.ts
git commit -m "Add WeCom auth persistence"
```

## Task 3: WeCom Client and Token Cache

**Files:**
- Create: `web/lib/auth/wecom.ts`
- Create: `web/tests/wecom-client.test.ts`

- [ ] **Step 1: Write failing WeCom client tests**

Use an injected `fetchImpl` and fake token store. Assert exact authorization parameters:

```ts
test("QR authorization URL contains the self-built app identifiers", () => {
  const url = new URL(buildWeComAuthorizationUrl(config, "QR", "state-token"));
  assert.equal(url.origin + url.pathname, "https://open.work.weixin.qq.com/wwopen/sso/qrConnect");
  assert.equal(url.searchParams.get("appid"), "wwcorp");
  assert.equal(url.searchParams.get("agentid"), "1000002");
  assert.equal(url.searchParams.get("redirect_uri"), "https://hamark.boga.plus/api/auth/wecom/callback");
  assert.equal(url.searchParams.get("state"), "state-token");
});

test("in-app URL uses snsapi_base and the same callback", () => {
  const url = buildWeComAuthorizationUrl(config, "IN_APP", "state-token");
  assert.match(url, /^https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize\?/);
  assert.match(url, /scope=snsapi_base/);
  assert.match(url, /#wechat_redirect$/);
});
```

Add cases for token cache hit, refresh five minutes before expiry, `getuserinfo` without `UserId`, member API errors, missing avatar/email, department-name lookup, abort timeout, and redacted `AuthError` messages.

- [ ] **Step 2: Run the tests and confirm RED**

Run `node --import tsx --test tests/wecom-client.test.ts`.

Expected: FAIL because `wecom.ts` does not exist.

- [ ] **Step 3: Implement authorization URLs and HTTP client**

Expose:

```ts
export function buildWeComAuthorizationUrl(config: AuthConfig, flow: AuthFlow, state: string): string;

export class WeComClient {
  constructor(options: { config: AuthConfig; store: AuthStore; fetchImpl?: typeof fetch; now?: () => Date });
  getMemberByCode(code: string): Promise<WeComMember>;
}
```

Use these server endpoints:

```text
GET https://qyapi.weixin.qq.com/cgi-bin/gettoken
GET https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo
GET https://qyapi.weixin.qq.com/cgi-bin/user/get
GET https://qyapi.weixin.qq.com/cgi-bin/department/simplelist
```

Every fetch gets an `AbortSignal.timeout(8000)`. Parse `errcode`; map invalid/expired code to `auth_expired`, invisible member to `member_not_allowed`, missing required profile to `profile_unavailable`, and network/5xx responses to `service_unavailable`. Never interpolate Secret, code, token, or full response JSON into error messages.

Encrypt cached app tokens with `encryptSecret()`, persist expiry from `expires_in`, and refresh when less than 300 seconds remain. On refresh, enter `withAppTokenRefreshLock()`, read the cache again, and only call `gettoken` if the second read is still stale. Deduplicate departments by ID and fall back to `部门 {id}` only when the member is valid but the name endpoint omits a visible name.

- [ ] **Step 4: Run client tests and lint**

Run:

```bash
cd web
node --import tsx --test tests/wecom-client.test.ts
npm run lint
```

Expected: all WeCom client tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/auth/wecom.ts web/tests/wecom-client.test.ts
git commit -m "Add WeCom OAuth client"
```

## Task 4: Session Service and Login Use Case

**Files:**
- Create: `web/lib/auth/session.ts`
- Create: `web/lib/auth/login.ts`
- Create: `web/lib/auth/server.ts`
- Modify: `web/tests/auth-store-session.test.ts`
- Create: `web/tests/auth-login.test.ts`

- [ ] **Step 1: Write failing session and login tests**

Test a fake store and fake WeCom client:

```ts
test("createSession stores only the token hash", async () => {
  const result = await createSession(store, user, now);
  assert.equal(store.sessions[0].tokenHash, await hashToken(result.token));
  assert.notEqual(store.sessions[0].tokenHash, result.token);
  assert.equal(result.expiresAt.toISOString(), "2026-08-03T00:00:00.000Z");
});

test("completeWeComLogin consumes state before exchanging code", async () => {
  const result = await completeWeComLogin(deps, { code: "code", state: "state", nonce: "nonce" });
  assert.equal(result.returnTo, "/videos/1");
  assert.equal(result.user.identityKey, expectedIdentityKey);
  assert.deepEqual(events, ["consume-state", "get-member", "sync-user", "create-session"]);
});

test("replayed state never reaches WeCom", async () => {
  await completeWeComLogin(deps, validInput);
  await assert.rejects(() => completeWeComLogin(deps, validInput), { code: "auth_expired" });
  assert.equal(wecomCalls, 1);
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
cd web
node --import tsx --test tests/auth-store-session.test.ts tests/auth-login.test.ts
```

Expected: FAIL because session and login modules are missing.

- [ ] **Step 3: Implement session primitives**

Expose:

```ts
export const SESSION_COOKIE = "hamark_session";
export const OAUTH_NONCE_COOKIE = "hamark_oauth_nonce";
export async function createSession(store: AuthStore, user: CurrentUser, now?: Date): Promise<{ token: string; expiresAt: Date }>;
export async function getUserForToken(store: AuthStore, token: string | null, now?: Date): Promise<CurrentUser | null>;
export async function revokeToken(store: AuthStore, token: string | null, now?: Date): Promise<void>;
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string;
export function clearedSessionCookie(secure: boolean): string;
```

Use 24-hour absolute expiry. Cookie serialization must encode values, use `Path=/; HttpOnly; SameSite=Lax`, include `Secure` in production, and include an explicit `Expires`.

- [ ] **Step 4: Implement login orchestration**

Expose:

```ts
export async function beginWeComLogin(deps, input: { flow: AuthFlow; returnTo: string }): Promise<{ authorizationUrl: string; nonce: string; nonceExpiresAt: Date }>;
export async function completeWeComLogin(deps, input: { code: string; state: string; nonce: string | null }): Promise<{ user: CurrentUser; token: string; expiresAt: Date; returnTo: string }>;
```

`beginWeComLogin` hashes state and nonce before storage, stores a ten-minute expiry, and returns only the raw values needed by redirect/Cookie. `completeWeComLogin` hashes inputs, atomically consumes state first, rejects missing values as `auth_expired`, loads the WeCom member, builds the stable identity key, syncs user and department snapshot, then creates a new session.

`server.ts` must be marked `import "server-only"` and lazily compose one `PostgresAuthStore`, `AuthConfig`, and `WeComClient` per warm process:

```ts
export function getAuthServices(): {
  config: AuthConfig;
  store: AuthStore;
  wecom: WeComClient;
};
```

Routes and guards import this factory; tests continue injecting fakes directly into the session and login functions.

- [ ] **Step 5: Run tests and lint**

Run:

```bash
cd web
node --import tsx --test tests/auth-store-session.test.ts tests/auth-login.test.ts
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/auth/session.ts web/lib/auth/login.ts web/lib/auth/server.ts web/tests/auth-store-session.test.ts web/tests/auth-login.test.ts
git commit -m "Add secure WeCom login sessions"
```

## Task 5: Login and Authentication Routes

**Files:**
- Create: `web/app/login/page.tsx`
- Create: `web/app/api/auth/wecom/start/route.ts`
- Create: `web/app/api/auth/wecom/callback/route.ts`
- Create: `web/app/api/auth/me/route.ts`
- Create: `web/app/api/auth/logout/route.ts`
- Modify: `web/app/globals.css`
- Create: `web/tests/auth-login-routes.test.ts`

- [ ] **Step 1: Write failing route-policy tests**

Test the pure route helpers or injected handlers for these cases:

```ts
test("start selects in-app flow only for wxwork user agents", () => {
  assert.equal(authFlowForUserAgent("Mozilla/5.0 wxwork/4.1"), "IN_APP");
  assert.equal(authFlowForUserAgent("Mozilla/5.0 Chrome/140"), "QR");
});

test("logout rejects cross-origin requests", () => {
  assert.equal(isTrustedOrigin("https://hamark.boga.plus", config), true);
  assert.equal(isTrustedOrigin("https://evil.example", config), false);
});
```

Add a callback test proving errors redirect only to `/login?error=<stable-code>` and do not include the incoming OAuth code.

- [ ] **Step 2: Run route tests and confirm RED**

Run `node --import tsx --test tests/auth-login-routes.test.ts`.

Expected: FAIL because route policy helpers and routes are missing.

- [ ] **Step 3: Implement start and callback routes**

`start/route.ts` must:

```ts
const flow = authFlowForUserAgent(request.headers.get("user-agent"));
const result = await beginWeComLogin(deps, {
  flow,
  returnTo: safeReturnTo(request.nextUrl.searchParams.get("return_to")),
});
const response = NextResponse.redirect(result.authorizationUrl);
response.cookies.set(OAUTH_NONCE_COOKIE, result.nonce, oauthNonceCookieOptions(result.nonceExpiresAt));
return response;
```

`callback/route.ts` must read `code`, `state`, and nonce Cookie, call `completeWeComLogin`, set a fresh session Cookie, clear nonce, and redirect to `returnTo`. Catch only `AuthError` for controlled redirects; unexpected errors log a request ID and redirect with `service_unavailable` without exposing exception details.

- [ ] **Step 4: Implement login, me, and logout**

`/login` maps stable error codes to concise Chinese messages. It reads the request user agent with `headers()`; when `/wxwork/i` matches and no controlled error is being displayed, it server-redirects to `/api/auth/wecom/start?return_to=...`. Desktop browsers render an action linking to that same start route. Because the start route also derives the flow from the request user agent, clients cannot choose an arbitrary authorization endpoint.

`GET /api/auth/me` returns:

```json
{
  "user": {
    "displayName": "成员姓名",
    "avatarUrl": null,
    "departments": [{ "id": "2", "name": "创意部", "isPrimary": true }]
  }
}
```

`POST /api/auth/logout` compares the request `Origin` to `APP_URL`, returns `403` on mismatch, revokes the current token, clears Cookie, and returns `{ "ok": true, "redirectTo": "/login" }`.

- [ ] **Step 5: Add login styles**

Use the existing wordmark, neutral background, black primary action, and restrained green WeCom accent. Keep the login surface centered, max-width 420px, radius no greater than 8px, and ensure the button and error text fit at 320px width. Do not expose feature explanations or configuration details in the UI.

- [ ] **Step 6: Run focused tests, lint, and build**

Run:

```bash
cd web
node --import tsx --test tests/auth-login-routes.test.ts
npm run lint
npm run build
```

Expected: route tests PASS, lint exits 0, and Next build lists `/login` and four auth API routes.

- [ ] **Step 7: Commit**

```bash
git add web/app/login web/app/api/auth web/app/globals.css web/tests/auth-login-routes.test.ts
git commit -m "Add WeCom login routes and page"
```

## Task 6: Enforce Authentication Across the Application

**Files:**
- Create: `web/proxy.ts`
- Modify: `web/lib/current-user.ts`
- Modify: `web/app/page.tsx`
- Modify: `web/app/videos/[id]/page.tsx`
- Modify: `web/app/videos/[id]/practice/page.tsx`
- Modify: `web/app/api/videos/route.ts`
- Modify: `web/app/api/videos/[id]/route.ts`
- Modify: `web/app/api/videos/[id]/content/route.ts`
- Modify: `web/app/api/videos/[id]/replace/route.ts`
- Modify: `web/app/api/videos/[id]/stream/route.ts`
- Modify: `web/app/api/videos/[id]/annotation/route.ts`
- Modify: `web/app/api/videos/[id]/annotation/submit/route.ts`
- Modify: `web/app/api/analyses/[snapshotId]/score/route.ts`
- Create: `web/tests/auth-access.test.ts`

- [ ] **Step 1: Write failing full-route coverage tests**

Create a test that enumerates every `web/app/api/**/route.ts` file and fails unless auth routes are allowlisted or the source invokes `requireApiUser`. Also assert every business page invokes `requirePageUser` and `current-user.ts` contains neither `demo@reverse.local` nor `演示用户`.

```ts
const publicRoutes = new Set([
  "app/api/auth/wecom/start/route.ts",
  "app/api/auth/wecom/callback/route.ts",
]);
for (const route of businessRoutes) {
  assert.match(await readFile(route, "utf8"), /requireApiUser\(/, `${route} must enforce a database session`);
}
```

- [ ] **Step 2: Run access tests and confirm RED**

Run `node --import tsx --test tests/auth-access.test.ts`.

Expected: FAIL listing every currently unprotected business route and page.

- [ ] **Step 3: Implement page and API guards**

Replace `currentUserFromRequest()` with:

```ts
export async function getCurrentUserFromRequest(request: Request): Promise<CurrentUser | null>;
export async function requireApiUser(request: Request): Promise<CurrentUser | Response>;
export async function requirePageUser(returnTo: string): Promise<CurrentUser>;
```

`requireApiUser` returns `Response.json({ error: "请先登录", loginUrl }, { status: 401 })` when invalid. Each business route must call it before schema, database, or COS access:

```ts
const user = await requireApiUser(request);
if (user instanceof Response) return user;
```

Replace every `user.email` identity comparison/write with `user.identityKey` and every `user.name` display write with `user.displayName`.

Each server page calls `await requirePageUser(exactPath)` before rendering. Dynamic pages use the resolved route parameter to construct the exact return path.

- [ ] **Step 4: Implement `proxy.ts` fast-path protection**

Allow only `/login`, `/api/auth/wecom/start`, `/api/auth/wecom/callback`, `/_next/*`, `/favicon.svg`, and `/og.png`. For missing Cookie:

- page requests redirect to `/login?return_to=<path+query>`;
- business API requests return JSON `401`;
- present Cookie continues to the server, where the database guard remains authoritative.

Use a matcher that excludes static files by extension while still protecting video stream and content APIs.

- [ ] **Step 5: Run access tests and all existing backend tests**

Run:

```bash
cd web
node --import tsx --test tests/auth-access.test.ts tests/backend-adapters.test.mjs
npm run lint
```

Expected: PASS, and source search returns no demo identity fallback.

- [ ] **Step 6: Commit**

```bash
git add web/proxy.ts web/lib/current-user.ts web/app web/tests/auth-access.test.ts
git commit -m "Require authenticated sessions across the app"
```

## Task 7: Current User Interface and Session Expiry Handling

**Files:**
- Create: `web/app/components/UserMenu.tsx`
- Modify: `web/app/components/HomeClient.tsx`
- Modify: `web/app/page.tsx`
- Modify: `web/app/globals.css`
- Modify: `web/tests/source-content.test.mjs`

- [ ] **Step 1: Write failing UI source tests**

Assert that the home page passes authenticated user display data, `HomeClient` renders `UserMenu`, and the user menu sends POST to `/api/auth/logout` rather than using a logout GET link.

- [ ] **Step 2: Run source tests and confirm RED**

Run `node --test tests/source-content.test.mjs`.

Expected: FAIL because `UserMenu` does not exist.

- [ ] **Step 3: Implement current-user UI**

Pass this serializable shape from `page.tsx`:

```ts
{
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  departmentName: user.departments.find((item) => item.isPrimary)?.name ?? user.departments[0]?.name ?? null,
}
```

`UserMenu` displays the avatar when present, otherwise a stable first-character fallback, plus member name. The popover displays department and one logout action. Logout uses `fetch("/api/auth/logout", { method: "POST" })`, redirects to the returned path, and disables the action while pending.

Update existing client fetch error paths so any `401` invokes:

```ts
window.location.assign(`/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
```

Apply this to home loading and upload; detail/practice clients must use a shared `redirectOnUnauthorized(response)` helper if they issue business API requests directly.

- [ ] **Step 4: Add responsive styles**

Fit search, upload, and member menu in the existing header without overlap at desktop widths. At mobile widths, keep the wordmark and member button in the first row, and move search/upload to a stable second row. Use an 8px-or-smaller menu radius, fixed avatar dimensions, and visible keyboard focus.

- [ ] **Step 5: Run UI tests and full build**

Run:

```bash
cd web
node --test tests/source-content.test.mjs
npm run lint
npm run build
```

Expected: PASS and no TypeScript/build errors.

- [ ] **Step 6: Commit**

```bash
git add web/app/components web/app/page.tsx web/app/globals.css web/tests/source-content.test.mjs
git commit -m "Show authenticated WeCom member controls"
```

## Task 8: Configuration, Migration, and Production Verification

**Files:**
- Modify: `web/.env.example`
- Modify: `web/README.md`
- Modify: `README_同事接手必读.md`
- Modify: `web/tests/backend-adapters.test.mjs`

- [ ] **Step 1: Write failing configuration source tests**

Assert `.env.example` contains exactly the five auth variable names with non-secret placeholders, README documents callback domain configuration, and neither file contains a real CorpID, Secret, token, or session value.

- [ ] **Step 2: Run the configuration tests and confirm RED**

Run `node --test tests/backend-adapters.test.mjs`.

Expected: FAIL because auth environment configuration is undocumented.

- [ ] **Step 3: Document environment and rollout**

Append:

```env
APP_URL=https://hamark.boga.plus
AUTH_SECRET=replace-with-at-least-32-random-bytes-base64url
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=replace-with-wecom-app-secret
```

Document:

- Vercel variables must be set for Production; Preview receives separate values only when its exact callback domain is also registered in WeCom;
- `AUTH_SECRET` generation command: `openssl rand -base64 48 | tr -d '\n'`;
- callback URL: `https://hamark.boga.plus/api/auth/wecom/callback`;
- trusted domain: `hamark.boga.plus`;
- application visible scope controls login eligibility;
- run the new SQL in Supabase before deploying auth code;
- no demo-user fallback remains.

- [ ] **Step 4: Run clean-install and complete verification**

Run:

```bash
cd web
npm ci
npm ci --dry-run --os=linux --cpu=x64 --libc=glibc
npm test
npm run lint
git diff --check
```

Expected: clean install succeeds, Linux lockfile validation reports no missing dependencies, Next production build succeeds, all tests pass, lint exits 0, and diff check is clean.

- [ ] **Step 5: Perform local auth-boundary smoke checks**

Start the app with non-production test values and a reachable test database. Verify:

```text
GET /                      -> 307 /login without a session
GET /api/videos            -> 401 JSON without a session
GET /login                 -> 200
GET /api/auth/wecom/start  -> redirect to an official WeCom host
POST /api/auth/logout with wrong Origin -> 403
```

Do not claim real login success until the user configures actual Vercel and WeCom values and scans the production QR code.

- [ ] **Step 6: Commit**

```bash
git add web/.env.example web/README.md README_同事接手必读.md web/tests/backend-adapters.test.mjs
git commit -m "Document WeCom authentication deployment"
```

- [ ] **Step 7: Push and production handoff**

Push the implementation commits to `origin/main`. Report the exact commit, then provide only the remaining secret-dependent actions:

1. Run `web/db/supabase.sql` in Supabase SQL Editor.
2. Set the five Vercel environment variables.
3. Configure WeCom trusted domain, callback domain, and visible scope.
4. Redeploy and perform one desktop QR login plus one in-app login.

Do not print or request `WECOM_SECRET` or `AUTH_SECRET` in chat.
