import assert from "node:assert/strict";
import test from "node:test";
import { parseV04SchemaTestConfig } from "../scripts/verify-v04-schema.ts";
import { runV04WorkflowVerification } from "../scripts/verify-v04-workflow.ts";

test("V0.4 workflow verifier fails closed without an explicit TEST_ONLY database", () => {
  assert.throws(() => parseV04SchemaTestConfig({ NODE_ENV: "development" }), /NODE_ENV=test/);
  assert.throws(() => parseV04SchemaTestConfig({
    NODE_ENV: "test",
    V04_TEST_RUN_ID: "stage1b_0819",
    V04_TEST_DATABASE_URL: "postgresql://user:pass@example.com/hamark_test",
  }), /loopback/);
});

const enabled = Boolean(
  process.env.NODE_ENV === "test" &&
  process.env.V04_TEST_RUN_ID &&
  process.env.V04_TEST_DATABASE_URL,
);

test("V0.4 workflow TEST_ONLY PostgreSQL vertical slice", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runV04WorkflowVerification(process.env);
  assert.equal(evidence.firstSubmissionNumber, 1);
  assert.equal(evidence.secondSubmissionNumber, 2);
  assert.equal(evidence.publicFingerprintUnchanged, true);
});
