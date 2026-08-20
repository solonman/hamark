import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decideV04ShadowAccess, isV04ShadowEnabled, parseV04ShadowReviewerUserIds } from "../lib/v04-shadow-access.ts";

test("V0.4 shadow is disabled by default and fails closed", () => {
  assert.equal(isV04ShadowEnabled(undefined), false);
  assert.deepEqual(decideV04ShadowAccess({ stableUserId: "user-a" }), { allowed: false, reason: "SHADOW_DISABLED" });
});

test("shadow access accepts only an exact stable user id", () => {
  assert.deepEqual([...parseV04ShadowReviewerUserIds(" user-a,user-b,user-a ")], ["user-a", "user-b"]);
  assert.deepEqual(decideV04ShadowAccess({ enabled: "true", reviewerUserIds: "user-a,user-b", stableUserId: "user-b" }), { allowed: true, reason: "STABLE_USER_ALLOWLIST" });
  assert.deepEqual(decideV04ShadowAccess({ enabled: "true", reviewerUserIds: "user-a,user-b", stableUserId: "User B" }), { allowed: false, reason: "STABLE_USER_NOT_ALLOWED" });
});

test("shadow layout gates before auth and uses no display-name fallback", async () => {
  const source = await readFile(new URL("../app/v04-shadow/layout.tsx", import.meta.url), "utf8");
  const flagPosition = source.indexOf('process.env.V04_UI_SHADOW_ENABLED !== "true"');
  const authPosition = source.indexOf("requirePageUser(");
  assert.ok(flagPosition >= 0 && authPosition > flagPosition);
  assert.match(source, /stableUserId:\s*user\.id/);
  assert.doesNotMatch(source, /displayName|identityKey/);
  assert.match(source, /notFound\(\)/);
});
