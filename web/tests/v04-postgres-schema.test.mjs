import assert from "node:assert/strict";
import test from "node:test";
import {
  parseV04SchemaTestConfig,
  runV04SchemaVerification,
} from "../scripts/verify-v04-schema.ts";

test("V0.4 PostgreSQL verification fails closed without an explicit TEST_ONLY environment", () => {
  assert.throws(() => parseV04SchemaTestConfig({ NODE_ENV: "development" }), /NODE_ENV=test/);
  assert.throws(() => parseV04SchemaTestConfig({ NODE_ENV: "test" }), /V04_TEST_DATABASE_URL/);
  assert.throws(() => parseV04SchemaTestConfig({
    NODE_ENV: "test",
    V04_TEST_RUN_ID: "stage1a_0819",
    V04_TEST_DATABASE_URL: "postgresql://user:pass@example.com/hamark_test",
  }), /loopback/);
  assert.throws(() => parseV04SchemaTestConfig({
    NODE_ENV: "test",
    V04_TEST_RUN_ID: "stage1a_0819",
    V04_TEST_DATABASE_URL: "postgresql://user:pass@127.0.0.1/hamark",
  }), /contain test/);
  assert.throws(() => parseV04SchemaTestConfig({
    NODE_ENV: "test",
    V04_TEST_RUN_ID: "unsafe.run",
    V04_TEST_DATABASE_URL: "postgresql://user:pass@127.0.0.1/hamark_test",
  }), /V04_TEST_RUN_ID/);
});

const hasExplicitPostgresEnvironment = Boolean(
  process.env.NODE_ENV === "test" &&
  process.env.V04_TEST_RUN_ID &&
  process.env.V04_TEST_DATABASE_URL,
);

test("V0.4 real PostgreSQL matrix is explicit and opt-in", {
  skip: hasExplicitPostgresEnvironment ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runV04SchemaVerification(process.env);
  assert.equal(evidence.E1, true);
  assert.equal(evidence.E2, true);
  assert.equal(evidence.D1, true);
});
