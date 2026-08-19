import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { V04ServiceError, v04ErrorResponse } from "../lib/v04-errors.ts";
import {
  assertV04PreviewToken,
  canonicalV04PreviewValue,
  hashV04PreviewValue,
  isV04PreviewSameOrigin,
  type V04MigrationPreview,
} from "../lib/v04-migration-preview.ts";

test("preview canonical hashing is stable across object insertion order", () => {
  const left = { z: 1, nested: { b: [2, 1], a: null }, a: "x" };
  const right = { a: "x", nested: { a: null, b: [2, 1] }, z: 1 };
  assert.equal(canonicalV04PreviewValue(left), canonicalV04PreviewValue(right));
  assert.equal(hashV04PreviewValue(left), hashV04PreviewValue(right));
  assert.notEqual(hashV04PreviewValue(left), hashV04PreviewValue({ ...right, z: 2 }));
});

test("preview token mismatch fails with stable STALE_PREVIEW semantics", async () => {
  const preview = { previewToken: "v04_preview_current" } as V04MigrationPreview;
  assert.doesNotThrow(() => assertV04PreviewToken(preview, "v04_preview_current"));
  assert.throws(() => assertV04PreviewToken(preview, "v04_preview_old"), (error) => {
    assert(error instanceof V04ServiceError);
    assert.equal(error.code, "STALE_PREVIEW");
    assert.equal(error.status, 409);
    return true;
  });
  const response = v04ErrorResponse(new V04ServiceError("STALE_PREVIEW", "stale"), "request-stale");
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "STALE_PREVIEW");
});

test("preview GET same-origin boundary accepts omitted Origin only on configured host", () => {
  const appUrl = "https://example.test";
  assert.equal(isV04PreviewSameOrigin(new Request("https://example.test/api/admin/v04-migration/preview"), appUrl), true);
  assert.equal(isV04PreviewSameOrigin(new Request("https://evil.test/api/admin/v04-migration/preview"), appUrl), false);
  assert.equal(isV04PreviewSameOrigin(new Request("https://example.test/api/admin/v04-migration/preview", {
    headers: { Origin: "https://evil.test" },
  }), appUrl), false);
  assert.equal(isV04PreviewSameOrigin(new Request("https://example.test/api/admin/v04-migration/preview", {
    headers: { "sec-fetch-site": "cross-site" },
  }), appUrl), false);
});

test("preview route is default closed, read-only, stable-admin protected and exposes no APPLY", () => {
  const route = readFileSync(new URL("../app/api/admin/v04-migration/preview/route.ts", import.meta.url), "utf8");
  const featureGuard = route.indexOf('process.env.V04_MIGRATION_PREVIEW_ENABLED !== "true"');
  const actorLookup = route.indexOf("requireV04Actor(request");
  assert(featureGuard >= 0 && actorLookup > featureGuard);
  assert.match(route, /isV04PreviewSameOrigin/);
  assert.match(route, /previewV04Migration/);
  assert.match(route, /mutation: false/);
  assert.match(route, /requireFeature: false/);
  assert.match(route, /Cache-Control/);
  assert.doesNotMatch(route, /export async function POST|INSERT INTO|UPDATE\s+|DELETE FROM|APPLYING|CONTRACT_ACTIVATE/);

  const service = readFileSync(new URL("../lib/v04-migration-preview.ts", import.meta.url), "utf8");
  assert.match(service, /role_key='SYSTEM_ADMIN'/);
  assert.match(service, /status='ACTIVE'/);
  assert.doesNotMatch(service, /\.run\(\)|INSERT INTO|UPDATE\s+[a-z_]+\s+SET|DELETE FROM/);
  for (const key of Array.from({ length: 11 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`)) {
    assert.match(service, new RegExp(`\\b${key}\\b`));
  }
});
