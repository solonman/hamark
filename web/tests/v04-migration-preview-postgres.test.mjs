import assert from "node:assert/strict";
import test from "node:test";
import {
  runV04MigrationPreviewVerification,
} from "../scripts/verify-v04-migration-preview.ts";

const enabled = Boolean(
  process.env.NODE_ENV === "test" &&
  process.env.V04_TEST_DATABASE_URL &&
  process.env.V04_TEST_RUN_ID,
);

test("V0.4 migration PREVIEW real PostgreSQL matrix is explicit and opt-in", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runV04MigrationPreviewVerification(process.env);
  assert.equal(evidence.preview11, true);
  assert.equal(evidence.zeroWrite, true);
  assert.equal(evidence.stalePreviewRejected, true);
  assert.equal(evidence.publicFingerprintUnchanged, true);
});
