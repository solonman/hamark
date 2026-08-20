import assert from "node:assert/strict";
import test from "node:test";
import { runV04SchemaApplyVerification } from "../scripts/verify-v04-schema-apply.ts";

const enabled = Boolean(
  process.env.NODE_ENV === "test"
  && process.env.V04_TEST_DATABASE_URL
  && process.env.V04_TEST_RUN_ID,
);

test("V0.4 schema PREVIEW/APPLY real PostgreSQL matrix is explicit and opt-in", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runV04SchemaApplyVerification(process.env);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.pre1AReady, true);
  assert.equal(evidence.previewFactCount, 11);
  assert.equal(evidence.zeroWrite, true);
  assert.equal(evidence.applied, true);
  assert.equal(evidence.uniqueStableAdmin, true);
  assert.equal(evidence.catalogAndRlsExact, true);
  assert.equal(evidence.contractsDraft, true);
  assert.equal(evidence.vocabularyOptions, 60);
  assert.equal(evidence.concurrentSingleApply, true);
  assert.equal(evidence.idempotentReplay, true);
  assert.equal(evidence.failureLedgerPreserved, true);
  assert.equal(evidence.savepointRollback, true);
  assert.equal(evidence.staleApplyingReconciled, true);
  assert.equal(evidence.partialDriftRejected, true);
  assert.equal(evidence.publicFingerprintUnchanged, true);
});
