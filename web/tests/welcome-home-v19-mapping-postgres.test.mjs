import assert from "node:assert/strict";
import test from "node:test";
import { runWelcomeHomeV19MappingVerification } from "../scripts/verify-welcome-home-v19-mapping.ts";

const enabled = Boolean(process.env.NODE_ENV === "test"
  && process.env.V04_TEST_DATABASE_URL && process.env.V04_TEST_RUN_ID);

test("welcome-home V1.9 mapping uses an isolated TEST_ONLY PostgreSQL vertical slice", {
  skip: enabled ? false : "V04 TEST_ONLY environment not provided",
}, async () => {
  const evidence = await runWelcomeHomeV19MappingVerification(process.env);
  for (const [key, value] of Object.entries(evidence)) assert.equal(value, true, key);
});
