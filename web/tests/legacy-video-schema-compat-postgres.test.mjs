import assert from "node:assert/strict";
import test from "node:test";
import { runLegacyVideoSchemaCompatibilityVerification } from "../scripts/verify-legacy-schema-compat.ts";

const enabled = Boolean(
  process.env.NODE_ENV === "test" &&
  process.env.V04_TEST_DATABASE_URL &&
  process.env.V04_TEST_RUN_ID,
);

test("legacy video routes work before and after the 1A schema", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runLegacyVideoSchemaCompatibilityVerification(process.env);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.pre1A, true);
  assert.equal(evidence.latest, true);
  assert.equal(evidence.singleBranchWrites, true);
  assert.equal(evidence.stableIdentityFallbackSafe, true);
});
