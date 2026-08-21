import assert from "node:assert/strict";
import test from "node:test";
import { runWelcomeHomeV19ConflictAuditVerification } from
  "../scripts/verify-welcome-home-v19-conflict-audit.ts";

const enabled = Boolean(
  process.env.NODE_ENV === "test"
  && process.env.V04_TEST_DATABASE_URL
  && process.env.V04_TEST_RUN_ID,
);

test("welcome-home V1.9 conflict audit real PostgreSQL matrix is explicit and TEST_ONLY", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runWelcomeHomeV19ConflictAuditVerification(process.env);
  for (const value of Object.values(evidence)) assert.equal(value, true);
});
