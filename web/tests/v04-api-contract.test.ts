import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { V04ServiceError, v04ErrorResponse } from "../lib/v04-errors.ts";

test("V0.4 dark routes fail closed before authentication or database access", () => {
  const source = readFileSync(new URL("../lib/v04-api.ts", import.meta.url), "utf8");
  const featureGuard = source.indexOf('process.env.V04_WORKFLOW_API_ENABLED !== "true"');
  const userLookup = source.indexOf("getCurrentUserFromRequest(request)");
  assert(featureGuard >= 0);
  assert(userLookup > featureGuard, "feature guard must run before user/database lookup");
  assert.match(source, /UNSUPPORTED_WORKFLOW/);
});

test("V0.4 API uses formal BUSINESS access after default release and retains gray fallback", () => {
  const source = readFileSync(new URL("../lib/v04-api.ts", import.meta.url), "utf8");
  assert.match(source, /process\.env\.V04_DEFAULT_UI_ENABLED === "true"/);
  assert.match(source, /assertV04DefaultAccess\(getDbClient\(\), user\.id, videoId\)/);
  assert.match(source, /assertV04GrayAccess\(getDbClient\(\), user\.id, videoId\)/);
});

test("V0.4 error contract distinguishes conflict, lease and rate-limit semantics", async () => {
  for (const [code, status] of [
    ["REVISION_CONFLICT", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["NO_CHANGES_TO_SUBMIT", 409],
    ["LEASE_REQUIRED", 423],
    ["LEASE_HELD_BY_OTHER", 423],
    ["LEASE_EXPIRED", 423],
    ["RATE_LIMITED", 429],
  ] as const) {
    const response = v04ErrorResponse(new V04ServiceError(code, code), `request-${code}`);
    assert.equal(response.status, status);
    const body = await response.json() as { error: { code: string; requestId: string; details: object } };
    assert.equal(body.error.code, code);
    assert.equal(body.error.requestId, `request-${code}`);
    assert.deepEqual(body.error.details, {});
  }
});
