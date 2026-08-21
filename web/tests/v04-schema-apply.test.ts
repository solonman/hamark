import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  V04_SCHEMA_BUNDLE_HASH,
  V04_SCHEMA_VERSION,
  v04ExpectedTargetDataFingerprint,
} from "../lib/v04-schema-catalog.ts";
import { V04_SCHEMA_APPLY_CONFIRMATION } from "../lib/v04-schema-admin-contract.ts";

test("V0.4 schema bundle and expected target fingerprint are deterministic", () => {
  assert.equal(V04_SCHEMA_VERSION, "V04_SCHEMA_1A_V1");
  assert.match(V04_SCHEMA_BUNDLE_HASH, /^[a-f0-9]{64}$/);
  const left = v04ExpectedTargetDataFingerprint({
    actorUserId: "user_test_admin",
    targetBusinessHash: "business_hash",
  });
  const right = v04ExpectedTargetDataFingerprint({
    targetBusinessHash: "business_hash",
    actorUserId: "user_test_admin",
  });
  assert.equal(left, right);
  assert.notEqual(left, v04ExpectedTargetDataFingerprint({
    actorUserId: "user_other_admin",
    targetBusinessHash: "business_hash",
  }));
});

test("schema APPLY route is POST-only, default closed and reuses stable actor protection", () => {
  const route = readFileSync(new URL("../app/api/admin/v04-migration/apply/route.ts", import.meta.url), "utf8");
  const featureGuard = route.indexOf('process.env.V04_SCHEMA_APPLY_ENABLED !== "true"');
  const actorLookup = route.indexOf("requireV04Actor(request");
  assert(featureGuard >= 0 && actorLookup > featureGuard);
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(route, /mutation: true/);
  assert.match(route, /requireFeature: false/);
  assert.match(route, /v04IdempotencyKey/);
  assert.match(route, /Cache-Control/);
});

test("schema APPLY service binds preview, code SHA, backup evidence and one stable admin", () => {
  const source = readFileSync(new URL("../lib/v04-schema-apply.ts", import.meta.url), "utf8");
  assert.equal(V04_SCHEMA_APPLY_CONFIRMATION, "我确认仅安装 V0.4 DRAFT schema，不回填业务数据");
  for (const invariant of [
    "assertV04PreviewToken",
    "V04_SCHEMA_BUNDLE_HASH",
    "targetCodeSha",
    "backupReference",
    "backupVerifiedAt",
    "READ COMMITTED",
    "pg_advisory_xact_lock",
    "SAVEPOINT v04_schema_apply_body",
    "ROLLBACK TO SAVEPOINT v04_schema_apply_body",
    "schema_migration_operations",
    "SYSTEM_ADMIN",
    "TARGET_APPLIED_EXACT",
    "digestV04PreviewToken",
    "withoutRuntimePreviewToken",
  ]) assert.match(source, new RegExp(invariant));
  assert.match(source, /Number\(activeAdminCount\?\.count \?\? 0\) !== 1/);
  assert.match(source, /validated\.previewTokenDigest, currentPreview\.sourceHash/);
  assert.doesNotMatch(source, /previewToken:\s*validated\.previewToken/);
  assert.doesNotMatch(source, /CONTRACT_ACTIVATE|npm run db:migrate|DELETE FROM|DROP TABLE/);
});

test("admin page never auto-runs PREVIEW or APPLY and vercel keeps both gates closed", () => {
  const page = readFileSync(new URL("../app/admin/v04-schema/page.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../app/admin/v04-schema/V04SchemaAdminClient.tsx", import.meta.url), "utf8");
  const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  assert.match(page, /requirePageUser/);
  assert.match(page, /assertV04PreviewAdmin/);
  assert.match(page, /V04_MIGRATION_PREVIEW_ENABLED/);
  assert.match(page, /V04_SCHEMA_APPLY_ENABLED/);
  assert.match(client, /onClick=\{\(\) => void runPreview\(\)\}/);
  assert.match(client, /onClick=\{\(\) => void applySchema\(\)\}/);
  assert.match(client, /disabled=\{!canApply \|\| applying\}/);
  assert.match(client, /Token 摘要/);
  assert.match(client, /preview\.previewTokenDigest\.slice\(0, 16\)/);
  assert.match(client, /previewToken:\s*preview\.previewToken/,
    "the complete token must remain available only for the in-memory APPLY request");
  assert.match(client, /runPreview\(preview\.previewToken\)/,
    "same-window replay must compare the complete token only in memory");
  assert.doesNotMatch(client, /<dd[^>]*>\{preview\.previewToken\}<\/dd>|encodeURIComponent\([^)]*previewToken|localStorage|sessionStorage|console\./);
  assert.doesNotMatch(client, /useEffect|setInterval/);
  const previewRoute = readFileSync(new URL("../app/api/admin/v04-migration/preview/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(previewRoute, /searchParams|get\(["']previewToken["']\)/,
    "the runtime token must never be accepted through a URL");
  assert.doesNotMatch(vercel, /V04_MIGRATION_PREVIEW_ENABLED|V04_SCHEMA_APPLY_ENABLED|V04_CONTRACT_ACTIVATE_ENABLED/);
});
