import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { V04ServiceError, v04ErrorResponse } from "../lib/v04-errors.ts";
import {
  assertV04PreviewToken,
  canonicalV04PreviewValue,
  compareV04SchemaObjects,
  hashV04PreviewValue,
  isV04PreviewSameOrigin,
  V04_FROZEN_SCHEMA_OBJECT_EXPECTATION,
  v04PreviewTimeWindow,
  type V04MigrationPreview,
} from "../lib/v04-migration-preview.ts";

test("preview canonical hashing is stable across object insertion order", () => {
  const left = { z: 1, nested: { b: [2, 1], a: null }, a: "x" };
  const right = { a: "x", nested: { a: null, b: [2, 1] }, z: 1 };
  assert.equal(canonicalV04PreviewValue(left), canonicalV04PreviewValue(right));
  assert.equal(hashV04PreviewValue(left), hashV04PreviewValue(right));
  assert.notEqual(hashV04PreviewValue(left), hashV04PreviewValue({ ...right, z: 2 }));
});

test("preview token enforces the fixed 30-minute window and stable STALE_PREVIEW semantics", async () => {
  const startsAt = new Date("2026-08-19T12:30:00.000Z");
  const window = v04PreviewTimeWindow(startsAt);
  assert.deepEqual(window, {
    startsAt: "2026-08-19T12:30:00.000Z",
    expiresAt: "2026-08-19T13:00:00.000Z",
  });
  assert.deepEqual(v04PreviewTimeWindow(new Date("2026-08-19T12:59:59.999Z")), window);
  assert.deepEqual(v04PreviewTimeWindow(new Date(window.expiresAt)), {
    startsAt: "2026-08-19T13:00:00.000Z",
    expiresAt: "2026-08-19T13:30:00.000Z",
  });

  const preview = {
    previewToken: "v04_preview_current",
    expiresAt: window.expiresAt,
  } as V04MigrationPreview;
  assert.doesNotThrow(() => assertV04PreviewToken(
    preview,
    "v04_preview_current",
    new Date("2026-08-19T12:59:59.999Z"),
  ));
  for (const now of [new Date(window.expiresAt), new Date("2026-08-19T13:00:00.001Z")]) {
    assert.throws(() => assertV04PreviewToken(preview, "v04_preview_current", now), (error) => {
      assert(error instanceof V04ServiceError);
      assert.equal(error.code, "STALE_PREVIEW");
      assert.equal(error.details.reason, "EXPIRED");
      return true;
    });
  }
  assert.throws(() => assertV04PreviewToken(
    preview,
    "v04_preview_old",
    new Date("2026-08-19T12:45:00.000Z"),
  ), (error) => {
    assert(error instanceof V04ServiceError);
    assert.equal(error.code, "STALE_PREVIEW");
    assert.equal(error.status, 409);
    assert.equal(error.details.reason, "FACTS_CHANGED");
    return true;
  });
  const response = v04ErrorResponse(new V04ServiceError("STALE_PREVIEW", "stale"), "request-stale");
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "STALE_PREVIEW");
});

test("schema object comparison detects arbitrary names, same-name definition drift and policy lifecycle", () => {
  const frozen = structuredClone(V04_FROZEN_SCHEMA_OBJECT_EXPECTATION);
  assert.equal(frozen.indexes.length, 5);
  assert.equal(frozen.triggers.length, 19);
  assert.equal(frozen.policies.length, 0, "the frozen bootstrap intentionally uses implicit deny RLS");

  const extraIndex = { tableName: "collaboration_workspaces", objectName: "anything_goes", signature: "extra" };
  const extraTrigger = { tableName: "app_role_memberships", objectName: "totally_custom", signature: "extra" };
  const drifted = compareV04SchemaObjects({
    indexes: [
      ...frozen.indexes.slice(1),
      { ...frozen.indexes[0], signature: "changed" },
      extraIndex,
    ],
    triggers: [
      ...frozen.triggers.slice(1),
      { ...frozen.triggers[0], signature: "changed" },
      extraTrigger,
    ],
    policies: [{ tableName: "collaboration_workspaces", objectName: "unexpected", signature: "extra" }],
  }, frozen);
  assert.deepEqual(drifted.indexes.changed, [
    `${frozen.indexes[0].tableName}.${frozen.indexes[0].objectName}`,
  ]);
  assert.deepEqual(drifted.indexes.extra, ["collaboration_workspaces.anything_goes"]);
  assert.deepEqual(drifted.triggers.changed, [
    `${frozen.triggers[0].tableName}.${frozen.triggers[0].objectName}`,
  ]);
  assert.deepEqual(drifted.triggers.extra, ["app_role_memberships.totally_custom"]);
  assert.deepEqual(drifted.policies.extra, ["collaboration_workspaces.unexpected"]);

  const expectedPolicy = {
    tableName: "collaboration_workspaces",
    objectName: "future_frozen_policy",
    signature: "using-false",
  };
  const missingPolicy = compareV04SchemaObjects(frozen, {
    ...frozen,
    policies: [expectedPolicy],
  });
  assert.deepEqual(missingPolicy.policies.missing, ["collaboration_workspaces.future_frozen_policy"]);
  const changedPolicy = compareV04SchemaObjects({
    ...frozen,
    policies: [{ ...expectedPolicy, signature: "using-true" }],
  }, {
    ...frozen,
    policies: [expectedPolicy],
  });
  assert.deepEqual(changedPolicy.policies.changed, ["collaboration_workspaces.future_frozen_policy"]);
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
  const capabilityProbe = service.indexOf("role_memberships_available");
  const stableMembershipLookup = service.indexOf("FROM app_role_memberships");
  assert(capabilityProbe >= 0 && stableMembershipLookup > capabilityProbe);
  assert.match(service, /role_key='SYSTEM_ADMIN'/);
  assert.match(service, /status='ACTIVE'/);
  assert.match(service, /authorizationMode: "PRE_1A_PREVIEW_ONLY"/);
  assert.match(service, /active_name_count/);
  assert.match(service, /unique_active_user_id !== actor\.userId/);
  assert.match(service, /catalogColumnSet\.has\("workflow_contract_versions\.status"\)/);
  assert.doesNotMatch(service, /\.run\(\)|INSERT INTO|UPDATE\s+[a-z_]+\s+SET|DELETE FROM/);
  for (const key of Array.from({ length: 11 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`)) {
    assert.match(service, new RegExp(`\\b${key}\\b`));
  }
});

test("Gate B deployment enables only the read-only V0.4 PREVIEW switch", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as { env?: Record<string, string> };
  assert.deepEqual(vercel.env, {
    V04_MIGRATION_PREVIEW_ENABLED: "true",
  });
  for (const forbidden of [
    "APPLY",
    "ACTIVATE",
    "WORKFLOW_API_ENABLED",
    "MATERIALIZE",
  ]) {
    assert.equal(
      Object.keys(vercel.env ?? {}).some((key) => key.includes(forbidden)),
      false,
    );
  }

  const route = readFileSync(
    new URL("../app/api/admin/v04-migration/preview/route.ts", import.meta.url),
    "utf8",
  );
  const service = readFileSync(
    new URL("../lib/v04-migration-preview.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /export async function GET/);
  assert.match(route, /isV04PreviewSameOrigin/);
  assert.match(service, /role_key='SYSTEM_ADMIN'/);
  assert.doesNotMatch(route, /export async function POST|schema_migration_operations|CONTRACT_ACTIVATE/);
});
