import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the existing practice route exposes V0.4 only behind the dedicated disabled-by-default gate", async () => {
  const source = await readFile(
    new URL("../app/videos/[id]/practice/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /query\.taxonomy === "V0\.4"/);
  assert.match(source, /process\.env\.V04_WORKFLOW_UI_ENABLED !== "true"/);
  assert.match(source, /notFound\(\)/);
  assert.match(source, /<V04VideoSessionProvider>/);
  assert.match(source, /<V04WorkspaceClient/);
  assert.match(source, /libraryHref: "\/"/);
  assert.match(source, /detailHref: `\/videos\/\$\{encodedId\}`/);
  assert.match(source, /workspaceHref: `\/videos\/\$\{encodedId\}\/practice\?taxonomy=V0\.4`/);
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

test("deployment configuration does not enable the V0.4 workflow UI or API", async () => {
  const source = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  assert.doesNotMatch(source, /V04_WORKFLOW_UI_ENABLED/);
  assert.doesNotMatch(source, /V04_WORKFLOW_API_ENABLED/);
});
