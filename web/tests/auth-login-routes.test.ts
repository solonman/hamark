import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  authErrorCode,
  authFlowForUserAgent,
  callbackErrorLocation,
  isTrustedOrigin,
} from "../lib/auth/routes.ts";

const config = {
  appUrl: "https://hamark.boga.plus",
  authSecret: "a".repeat(32),
  corpId: "wwcorp",
  agentId: "1000002",
  secret: "wecom-secret",
};

test("start selects in-app flow only for wxwork user agents", () => {
  assert.equal(authFlowForUserAgent("Mozilla/5.0 wxwork/4.1"), "IN_APP");
  assert.equal(authFlowForUserAgent("Mozilla/5.0 WXWORK/4.1"), "IN_APP");
  assert.equal(authFlowForUserAgent("Mozilla/5.0 Chrome/140"), "QR");
  assert.equal(authFlowForUserAgent(null), "QR");
});

test("logout rejects cross-origin requests", () => {
  assert.equal(isTrustedOrigin("https://hamark.boga.plus", config), true);
  assert.equal(isTrustedOrigin("https://evil.example", config), false);
  assert.equal(isTrustedOrigin(null, config), false);
});

test("callback errors redirect with stable codes and never include OAuth code", () => {
  assert.equal(callbackErrorLocation(config, "auth_expired", "secret-code"), "/login?error=auth_expired");
  assert.equal(callbackErrorLocation(config, "unknown", "secret-code"), "/login?error=service_unavailable");
  assert.equal(callbackErrorLocation(config, "auth_cancelled", null), "/login?error=auth_cancelled");
});

test("database startup errors are classified without exposing sensitive details", () => {
  assert.equal(authErrorCode({ code: "42P01", message: 'relation "oauth_states" does not exist' }), "database_schema_missing");
  assert.equal(authErrorCode({ code: "28P01", message: "password authentication failed" }), "database_password_invalid");
  assert.equal(authErrorCode(new Error("Tenant or user not found")), "database_pooler_identity_invalid");
  assert.equal(authErrorCode(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })), "database_unreachable");
  assert.equal(authErrorCode(new Error("Missing required environment variable: DATABASE_URL")), "auth_misconfigured");
  assert.equal(authErrorCode(new Error("unexpected database failure")), "service_unavailable");
});

test("WeCom start route converts startup failures into login errors", () => {
  const source = readFileSync(
    new URL("../app/api/auth/wecom/start/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /try\s*{/);
  assert.match(source, /catch \(error\)/);
  assert.match(source, /authErrorCode\(error\)/);
  assert.match(source, /request\.nextUrl\.clone\(\)/);
  assert.match(source, /loginUrl\.pathname = "\/login"/);
  assert.match(source, /loginUrl\.search = `\?error=\$\{authErrorCode\(error\)\}`/);
  assert.match(source, /NextResponse\.redirect\(loginUrl\)/);
});
