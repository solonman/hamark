import assert from "node:assert/strict";
import test from "node:test";
import { runV04SystemAdminBootstrapVerification } from "../scripts/verify-v04-system-admin-bootstrap.ts";

const enabled = process.env.NODE_ENV === "test" && process.env.V04_TEST_DATABASE_URL && process.env.V04_TEST_RUN_ID;
test("SYSTEM_ADMIN bootstrap real PostgreSQL matrix is explicit and opt-in", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const result = await runV04SystemAdminBootstrapVerification(process.env);
  for (const value of Object.values(result)) assert.equal(value, true);
});
