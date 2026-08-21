import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the existing practice route defaults to V0.4 while keeping explicit V0.3/V0.2 compatibility", async () => {
  const source = await readFile(
    new URL("../app/videos/[id]/practice/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /query\.taxonomy === "V0\.4"/);
  assert.match(source, /process\.env\.V04_DEFAULT_UI_ENABLED === "true"/);
  assert.match(source, /explicitLegacy = query\.taxonomy === "V0\.2" \|\| query\.taxonomy === "V0\.3-PILOT"/);
  assert.match(source, /query\.taxonomy === "V0\.4" \|\| \(v04DefaultEnabled && !explicitLegacy\)/);
  assert.match(source, /process\.env\.V04_WORKFLOW_UI_ENABLED !== "true"/);
  assert.match(source, /notFound\(\)/);
  assert.match(source, /<V04VideoSessionProvider>/);
  assert.match(source, /<V04WorkspaceClient/);
  assert.match(source, /libraryHref: "\/"/);
  assert.match(source, /detailHref: `\/videos\/\$\{encodedId\}`/);
  assert.match(source, /workspaceHref: v04DefaultEnabled/);
  assert.match(source, /`\/videos\/\$\{encodedId\}\/practice`/);
  assert.match(source, /`\/videos\/\$\{encodedId\}\/practice\?taxonomy=V0\.4`/);
  assert.match(source, /query\.taxonomy === "V0\.2" \? "V0\.2" : "V0\.3-PILOT"/);
  assert.match(source, /<PracticeClient[\s\S]*taxonomyVersion=\{taxonomyVersion\}/);
});

test("V0.3 PracticeClient remains byte-identical while the server page gains the V0.4 branch", async () => {
  const content = await readFile(
    new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(content).digest("hex"),
    "80689400bd930b8f6bd0dfc565a01b7a238cc60dcb973f138060a8ca3ee053d7",
  );
});

test("deployment configuration keeps the V0.4 default surfaces closed during rollback", async () => {
  const source = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const deployment = JSON.parse(source);
  assert.equal(deployment.env.V04_DEFAULT_UI_ENABLED, undefined);
  assert.equal(deployment.env.V04_WORKFLOW_UI_ENABLED, undefined);
  assert.equal(deployment.env.V04_WORKFLOW_API_ENABLED, undefined);
  for (const forbidden of [
    "V04_GRAY_ROLLOUT_ENABLED",
    "V04_GRAY_IDENTITY_DIGEST_ENABLED",
    "V04_GRAY_TEST_OBJECT_ENABLED",
    "V04_MIGRATION_PREVIEW_ENABLED",
    "V04_SCHEMA_APPLY_ENABLED",
    "V04_CONTRACT_ACTIVATE_ENABLED",
  ]) assert.equal(forbidden in deployment.env, false);
});
