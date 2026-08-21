import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DbClient } from "../db/index.ts";
import { V04ServiceError, v04ErrorResponse } from "../lib/v04-errors.ts";
import {
  assertV04PreviewToken,
  canonicalV04PreviewValue,
  compareV04SchemaObjects,
  digestV04PreviewToken,
  hashV04PreviewValue,
  isV04PreviewSameOrigin,
  V04_FROZEN_SCHEMA_OBJECT_EXPECTATION,
  V04_MIGRATION_PREVIEW_STAGES,
  v04PreviewTimeWindow,
  previewV04Migration,
  type V04MigrationPreview,
  type V04MigrationPreviewStage,
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
    previewTokenDigest: digestV04PreviewToken("v04_preview_current"),
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
      assert.equal(error.details.currentPreviewTokenDigest, preview.previewTokenDigest);
      assert.doesNotMatch(JSON.stringify(error.details), /v04_preview_current/);
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
    assert.equal(error.details.currentPreviewTokenDigest, preview.previewTokenDigest);
    assert.doesNotMatch(JSON.stringify(error.details), /v04_preview_current/);
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

test("preview database failures expose only a fixed diagnostic stage and never write", async () => {
  const secret = "password=do-not-leak SELECT private_customer_data";

  function diagnosticDb(failingStage: V04MigrationPreviewStage) {
    let writes = 0;
    let scopedHashReads = 0;
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (sql.includes("role_memberships_available")) {
              if (failingStage === "ADMIN_CAPABILITY") throw new Error(secret);
              return {
                role_memberships_available: true,
                users_available: true,
                legacy_admins_available: true,
              };
            }
            if (sql.includes("FROM app_role_memberships")) {
              if (failingStage === "ADMIN_LEGACY_MAPPING") throw new Error(secret);
              return { allowed: 1 };
            }
            if (sql.includes("scope_row")) {
              scopedHashReads += 1;
              if (failingStage === "BUSINESS_FACTS" && scopedHashReads === 1) {
                throw new Error(secret);
              }
              if (failingStage === "ZERO_WRITE_CHECK" && scopedHashReads === 3) {
                throw new Error(secret);
              }
              return { row_count: 0, aggregate_hash: "d41d8cd98f00b204e9800998ecf8427e" };
            }
            return null;
          },
          async all() {
            const stage = sql.includes("FROM pg_class c JOIN pg_namespace")
              ? "CATALOG_TABLES"
              : sql.includes("FROM information_schema.columns")
                ? "CATALOG_COLUMNS"
                : sql.includes("FROM pg_index")
                  ? "CATALOG_INDEXES"
                  : sql.includes("FROM pg_trigger")
                    ? "CATALOG_TRIGGERS"
                    : sql.includes("FROM pg_policies")
                      ? "CATALOG_POLICIES"
                      : null;
            if (stage === failingStage) throw new Error(secret);
            if (stage === "CATALOG_TABLES" && failingStage === "SCHEMA_DRIFT") {
              return { results: [{ table_name: null, rls_enabled: true }] };
            }
            if (stage === "CATALOG_TABLES"
              && ["BUSINESS_FACTS", "ZERO_WRITE_CHECK"].includes(failingStage)) {
              return { results: [{ table_name: "annotations", rls_enabled: true }] };
            }
            return { results: [] };
          },
          async run() {
            writes += 1;
            throw new Error("PREVIEW must never write");
          },
        };
        return statement;
      },
    } as unknown as DbClient;
    return { db, writes: () => writes };
  }

  assert.deepEqual(V04_MIGRATION_PREVIEW_STAGES, [
    "ADMIN_CAPABILITY",
    "ADMIN_LEGACY_MAPPING",
    "CATALOG_TABLES",
    "CATALOG_COLUMNS",
    "CATALOG_INDEXES",
    "CATALOG_TRIGGERS",
    "CATALOG_POLICIES",
    "SCHEMA_DRIFT",
    "BUSINESS_FACTS",
    "ZERO_WRITE_CHECK",
  ]);
  for (const stage of V04_MIGRATION_PREVIEW_STAGES) {
    const fixture = diagnosticDb(stage);
    let caught: unknown;
    try {
      await previewV04Migration(fixture.db, { userId: "user_test_admin", displayName: "Test Admin" });
      assert.fail(`expected ${stage} to fail`);
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof V04ServiceError);
    assert.equal(caught.code, "INTERNAL_ERROR");
    assert.equal(caught.message, "只读 PREVIEW 暂时无法完成，请稍后重试。");
    assert.deepEqual(caught.details, { stage });
    assert.doesNotMatch(JSON.stringify(caught.details), /password|SELECT|customer/i);
    const response = v04ErrorResponse(caught, "request-diagnostic");
    const serialized = JSON.stringify(await response.json());
    assert.match(serialized, new RegExp(`\\"stage\\":\\"${stage}\\"`));
    assert.match(serialized, /request-diagnostic/);
    assert.doesNotMatch(serialized, /password|SELECT|customer|stack/i);
    assert.equal(fixture.writes(), 0);
  }
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
  assert.match(service, /"CATALOG_TABLES"/);
  assert.match(service, /"CATALOG_POLICIES"/);
  assert.match(service, /"SCHEMA_DRIFT"/);
  assert.match(service, /\{ stage \}/);
  assert.match(service, /catalogColumnSet\.has\("workflow_contract_versions\.status"\)/);
  assert.doesNotMatch(service, /\.run\(\)|INSERT INTO|UPDATE\s+[a-z_]+\s+SET|DELETE FROM/);
  for (const key of Array.from({ length: 11 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`)) {
    assert.match(service, new RegExp(`\\b${key}\\b`));
  }
});

test("Gate B closure keeps PREVIEW closed while only the contract lifecycle gate is short-opened", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as { env?: Record<string, string> };
  assert.equal(vercel.env?.V04_MIGRATION_PREVIEW_ENABLED, undefined);
  assert.equal(vercel.env?.V04_CONTRACT_ACTIVATE_ENABLED, "true");
  for (const forbidden of [
    "PREVIEW",
    "APPLY",
    "ACTIVATE",
    "WORKFLOW_API_ENABLED",
    "MATERIALIZE",
  ]) {
    assert.equal(
      Object.keys(vercel.env ?? {})
        .filter((key) => key !== "V04_CONTRACT_ACTIVATE_ENABLED")
        .some((key) => key.includes(forbidden)),
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
