import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION,
} from "../lib/v04-system-admin-bootstrap.ts";

test("SYSTEM_ADMIN bootstrap is one-time, same-origin, transactional and default closed", () => {
  const service = readFileSync(new URL("../lib/v04-system-admin-bootstrap.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/admin/v04-system-admin-bootstrap/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/admin/v04-schema/page.tsx", import.meta.url), "utf8");
  const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  assert.equal(V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION,
    "我确认仅恢复当前唯一稳定管理员的 SYSTEM_ADMIN 权限");
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(route, /mutation: true/);
  assert.match(route, /V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /active_system_admin_count/);
  assert.match(service, /active_name_count/);
  assert.match(service, /unique_active_user_id/);
  assert.match(service, /TARGET_APPLIED_EXACT/);
  assert.match(service, /schema_migration_operations/);
  assert.match(service, /operation_type.*SCHEMA_PREVIEW/s);
  assert.match(page, /inspectV04SystemAdminBootstrapCandidate/);
  assert.doesNotMatch(vercel, /V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED/);
  assert.doesNotMatch(service, /DELETE FROM|DROP TABLE|CONTRACT_ACTIVATE/);
});

test("bootstrap never accepts caller actor ids, names, SQL or credentials", () => {
  const client = readFileSync(new URL("../app/admin/v04-schema/V04SchemaAdminClient.tsx", import.meta.url), "utf8");
  assert.match(client, /BOOTSTRAP_SYSTEM_ADMIN/);
  assert.match(client, /targetCodeSha: props\.targetCodeSha/);
  assert.doesNotMatch(client, /actorUserId|displayName|DATABASE_URL|password|accessToken/);
});
