import assert from "node:assert/strict";
import test from "node:test";
import {
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
