import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  V04_CONTRACT_ACTIVATE_CONFIRMATION,
  V04_CONTRACT_RETIRE_CONFIRMATION,
  V04_GATE_ONE_BASELINE,
} from "../lib/v04-contract-activation.ts";

test("contract lifecycle route is POST-only, same-origin protected and default closed", () => {
  const route = readFileSync(new URL("../app/api/admin/v04-contract/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/admin/v04-schema/page.tsx", import.meta.url), "utf8");
  const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(route, /V04_CONTRACT_ACTIVATE_ENABLED/);
  assert.match(route, /requireV04Actor\(request, \{ mutation: true, requireFeature: false \}\)/);
  assert.match(route, /v04IdempotencyKey/);
  assert.match(route, /Cache-Control/);
  assert.match(page, /V04_CONTRACT_ACTIVATE_ENABLED/);
  assert.doesNotMatch(vercel, /V04_CONTRACT_ACTIVATE_ENABLED/);
});

test("contract lifecycle service binds Gate 1 evidence and changes exactly three frozen contracts", () => {
  const source = readFileSync(new URL("../lib/v04-contract-activation.ts", import.meta.url), "utf8");
  assert.equal(V04_CONTRACT_ACTIVATE_CONFIRMATION,
    "我确认仅激活三份 V0.4 冻结合同，不回填、不开放默认入口");
  assert.equal(V04_CONTRACT_RETIRE_CONFIRMATION,
    "我确认仅停用三份 V0.4 合同并保留全部历史数据");
  assert.match(V04_GATE_ONE_BASELINE.bundleHash, /^[a-f0-9]{64}$/);
  for (const invariant of [
    "pg_advisory_xact_lock",
    "schema_migration_operations",
    "CONTRACT_ACTIVATE",
    "SAVEPOINT v04_contract_lifecycle_body",
    "ROLLBACK TO SAVEPOINT v04_contract_lifecycle_body",
    "annotation_taxonomy_versions",
    "annotation_vocabulary_versions",
    "workflow_contract_versions",
    "expectedContractStatus",
    "actorSystemAdmin",
    "vocabularyOptions",
    "sourceHash",
    "targetHash",
    "nonTargetHash",
    "digestV04PreviewToken",
  ]) assert.match(source, new RegExp(invariant));
  assert.doesNotMatch(source, /DELETE FROM|DROP TABLE|npm run db:migrate|display_name\s*=|INSERT INTO annotations|INSERT INTO collaboration_workspaces/);
});

test("admin UI requires explicit activation or retirement phrase and never leaks runtime preview token", () => {
  const client = readFileSync(new URL("../app/admin/v04-schema/V04SchemaAdminClient.tsx", import.meta.url), "utf8");
  assert.match(client, /ACTIVATE_CONTRACTS/);
  assert.match(client, /RETIRE_CONTRACTS/);
  assert.match(client, /targetCodeSha: props\.targetCodeSha/);
  assert.match(client, /gateOneEvidenceReference: contractEvidence\.trim\(\)/);
  assert.match(client, /contractConfirmation !==/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|console\.|actorUserId|displayName|DATABASE_URL/);
  assert.doesNotMatch(client, /<dd[^>]*>\{preview\.previewToken\}<\/dd>/);
});

test("migration preview supports explicit DRAFT, ACTIVE and RETIRED postchecks without changing the default", () => {
  const source = readFileSync(new URL("../lib/v04-migration-preview.ts", import.meta.url), "utf8");
  assert.match(source, /expectedContractStatus\?: "DRAFT" \| "ACTIVE" \| "RETIRED"/);
  assert.match(source, /options\.expectedContractStatus \?\? "DRAFT"/);
  assert.match(source, /taxonomyActive/);
  assert.match(source, /workflowRetired/);
  assert.match(source, /V04_CONTRACT_NOT_/);
});
