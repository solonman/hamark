import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyV04GrayTestObjectState,
  V04_GRAY_TEST_OBJECT_CONFIRMATION,
  V04_GRAY_TEST_OBJECT_PREVIEW_STAGES,
  loadV04GrayTestObjectConfig,
  previewV04GrayTestObject,
} from "../lib/v04-gray-test-object.ts";
import { V04_GRAY_TEST_MEDIA, v04GrayTestMediaBytes } from "../lib/v04-gray-test-media.ts";
import { V04ServiceError } from "../lib/v04-errors.ts";

test("approved gray media is a frozen locally generated non-business clip", () => {
  const bytes = v04GrayTestMediaBytes();
  assert.equal(bytes.byteLength, V04_GRAY_TEST_MEDIA.fileSize);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), V04_GRAY_TEST_MEDIA.sha256);
  assert.equal(V04_GRAY_TEST_MEDIA.contentType, "video/mp4");
  assert.match(V04_GRAY_TEST_MEDIA.objectKey, /^test-only\/v04-gray\//);
  assert.match(V04_GRAY_TEST_MEDIA.testRunId, /^V04_GRAY_/);
});

test("only clean-create and exact-applied are legal across the target/object/ledger matrix", () => {
  const states = ["ABSENT", "EXACT", "DRIFT"] as const;
  const legal: string[] = [];
  for (const targetState of states) {
    for (const objectState of states) {
      for (const ledgerState of states) {
        for (const ledgerAppliedCount of [0, 1, 2]) {
          const outcome = classifyV04GrayTestObjectState({
            targetState, objectState, ledgerState, ledgerAppliedCount,
          });
          if (outcome !== "INCONSISTENT") {
            legal.push(`${targetState}/${objectState}/${ledgerState}/${ledgerAppliedCount}:${outcome}`);
          }
        }
      }
    }
  }
  assert.deepEqual(legal, [
    "ABSENT/ABSENT/ABSENT/0:CLEAN_CREATE",
    "EXACT/EXACT/EXACT/1:EXACT_APPLIED",
  ]);
});
test("gray media tool is independently closed and never enabled by deployment defaults", () => {
  assert.equal(loadV04GrayTestObjectConfig({}).enabled, false);
  assert.equal(loadV04GrayTestObjectConfig({ V04_GRAY_TEST_OBJECT_ENABLED: "false" }).enabled, false);
  assert.equal(loadV04GrayTestObjectConfig({ V04_GRAY_TEST_OBJECT_ENABLED: "true" }).enabled, true);
  const deployment = JSON.parse(readFileSync(
    new URL("../vercel.json", import.meta.url), "utf8",
  )) as { env?: Record<string, string> };
  assert.deepEqual(deployment.env, { V04_GRAY_TEST_OBJECT_ENABLED: "true" });
});

test("preview and apply routes are same-origin admin operations with no GET write path", () => {
  const previewRoute = readFileSync(new URL(
    "../app/api/admin/v04-gray-test-object/preview/route.ts", import.meta.url,
  ), "utf8");
  const applyRoute = readFileSync(new URL(
    "../app/api/admin/v04-gray-test-object/apply/route.ts", import.meta.url,
  ), "utf8");
  const page = readFileSync(new URL("../app/admin/v04-gray-test-object/page.tsx", import.meta.url), "utf8");
  for (const source of [previewRoute, applyRoute]) {
    assert.match(source, /V04_GRAY_TEST_OBJECT_ENABLED/);
    assert.match(source, /requireV04Actor\(request, \{ mutation: true, requireFeature: false \}\)/);
    assert.match(source, /Cache-Control/);
    assert.doesNotMatch(source, /export async function GET/);
  }
  assert.match(applyRoute, /v04IdempotencyKey/);
  assert.match(page, /assertV04PreviewAdmin/);
});

test("the service uses stable SYSTEM_ADMIN, fixed media, transaction lock, ledger and compensation", () => {
  const source = readFileSync(new URL("../lib/v04-gray-test-object.ts", import.meta.url), "utf8");
  assert.equal(V04_GRAY_TEST_OBJECT_CONFIRMATION,
    "我确认仅创建一个隐藏的 V0.4 TEST_ONLY 灰度测试视频");
  for (const marker of [
    "app_role_memberships",
    "active_system_admin_count",
    "pg_advisory_xact_lock",
    "admin_data_operations",
    "SAVEPOINT v04_gray_test_object_body",
    "ROLLBACK TO SAVEPOINT v04_gray_test_object_body",
    "data_scope",
    "TEST_ONLY",
    "test_run_id",
    "created_by_user_id",
    "ifNoneMatch",
    "creation-marker",
    "objectIsOwnedByOperation",
    "INCONSISTENT_TARGET_STATE",
    "bucket.delete",
    "SOFT_DELETE_90_DAYS_NO_IMMEDIATE_COS_DELETE",
  ]) assert.match(source, new RegExp(marker));
  assert.doesNotMatch(source, /app_admins|display_name\s*=|COALESCE\([^)]*data_scope[^)]*\)\s*=\s*'TEST_ONLY'/);
});

test("full operation token remains runtime-only and is never rendered or persisted", () => {
  const client = readFileSync(new URL(
    "../app/admin/v04-gray-test-object/V04GrayTestObjectClient.tsx", import.meta.url,
  ), "utf8");
  assert.match(client, /previewToken: preview\.previewToken/);
  assert.match(client, /Token 摘要/);
  assert.match(client, /preview\.previewTokenDigest\.slice/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|console\.|window\.location.*previewToken/);
  assert.doesNotMatch(client, /[>}\s]preview\.previewToken[<}]/);
});

test("browser-visible contracts never expose raw stable user ids", () => {
  const contract = readFileSync(new URL("../lib/v04-gray-test-object-contract.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL(
    "../app/admin/v04-gray-test-object/V04GrayTestObjectClient.tsx", import.meta.url,
  ), "utf8");
  const previewRoute = readFileSync(new URL(
    "../app/api/admin/v04-gray-test-object/preview/route.ts", import.meta.url,
  ), "utf8");
  const applyRoute = readFileSync(new URL(
    "../app/api/admin/v04-gray-test-object/apply/route.ts", import.meta.url,
  ), "utf8");
  for (const source of [contract, client, previewRoute, applyRoute]) {
    assert.doesNotMatch(source, /actorUserId|actor_user_id|stableUserId|displayName|display_name/);
  }
  assert.match(contract, /actorDigest: string/);
  assert.match(contract, /objectEtagDigest: string \| null/);
});

test("preview failures expose only stable non-sensitive stages", async () => {
  assert.deepEqual(V04_GRAY_TEST_OBJECT_PREVIEW_STAGES, [
    "DB_SYSTEM_FACTS_BEFORE",
    "DB_TARGET_VIDEO_BEFORE",
    "DB_BUSINESS_FINGERPRINT_BEFORE",
    "DB_LEDGER_FACTS_BEFORE",
    "OBJECT_FACTS",
    "DB_SYSTEM_FACTS_AFTER",
    "DB_TARGET_VIDEO_AFTER",
    "DB_BUSINESS_FINGERPRINT_AFTER",
    "DB_LEDGER_FACTS_AFTER",
  ]);
  const service = readFileSync(new URL("../lib/v04-gray-test-object.ts", import.meta.url), "utf8");
  const client = readFileSync(
    new URL("../app/admin/v04-gray-test-object/V04GrayTestObjectClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(service, /new V04ServiceError\([\s\S]*?"INTERNAL_ERROR"[\s\S]*?\{ stage \}/);
  assert.doesNotMatch(service, /error\.message|error\.stack|String\(error\)/);
  assert.match(client, /诊断：\$\{context\}/);
  assert.doesNotMatch(client, /console\.|localStorage|sessionStorage/);

  const sensitiveFailure = "database host and credential must never escape";
  const failingDb = {
    prepare() {
      return {
        bind() {
          return { first: async () => { throw new Error(sensitiveFailure); } };
        },
      };
    },
  } as unknown as Parameters<typeof previewV04GrayTestObject>[0];
  const unusedBucket = {} as Parameters<typeof previewV04GrayTestObject>[1];
  await assert.rejects(
    previewV04GrayTestObject(
      failingDb,
      unusedBucket,
      { userId: "runtime-only-stable-actor" },
      { tokenSecret: "runtime-only-test-secret" },
    ),
    (error) => {
      assert.ok(error instanceof V04ServiceError);
      assert.equal(error.code, "INTERNAL_ERROR");
      assert.equal(error.message, "操作未完成，请稍后重试。");
      assert.deepEqual(error.details, { stage: "DB_SYSTEM_FACTS_BEFORE" });
      assert.doesNotMatch(JSON.stringify(error), /host|credential|runtime-only/);
      return true;
    },
  );
});
