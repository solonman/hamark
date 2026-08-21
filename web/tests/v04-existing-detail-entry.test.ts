import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the formal video route renders standalone V1.9 detail and keeps explicit legacy paths", async () => {
  const [page, detail, v04Detail, deployment] = await Promise.all([
    source("../app/videos/[id]/page.tsx"),
    source("../app/videos/[id]/VideoDetailClient.tsx"),
    source("../components/v04/V04DetailClient.tsx"),
    source("../vercel.json"),
  ]);
  assert.match(page, /process\.env\.V04_DETAIL_UI_ENABLED === "true"/);
  assert.match(page, /process\.env\.V04_DEFAULT_UI_ENABLED === "true"/);
  assert.match(page, /if \(v04DefaultEnabled && v04DetailEnabled && !explicitLegacyView\)/);
  assert.match(page, /<V04VideoSessionProvider>[\s\S]*<V04DetailClient[\s\S]*showVideo/);
  assert.doesNotMatch(page, /<V04DetailClient[\s\S]*embedded/);
  assert.match(page, /workspaceHref: `\/videos\/\$\{encodedId\}\/practice`/);
  assert.match(page, /practice\?taxonomy=V0\.3-PILOT/);
  assert.match(page, /practice\?taxonomy=V0\.2/);
  assert.match(page, /managementHref: `\/videos\/\$\{encodedId\}\?view=legacy`/);
  assert.match(page, /v04DetailEnabled=\{v04DetailEnabled && !v04DefaultEnabled\}/);
  assert.match(detail, /v04DetailEnabled \? \(/);
  assert.match(deployment, /"V04_DETAIL_UI_ENABLED": "true"/);
  assert.match(deployment, /"V04_DEFAULT_UI_ENABLED": "true"/);
  assert.match(v04Detail, /!draft \? <section[\s\S]*尚无已提交成果/);
  assert.match(v04Detail, /versionView === "EXPERT"[\s\S]*expertPreferredSubmission/);
  assert.match(v04Detail, /最新提交 V/);
  assert.match(v04Detail, /专家优选 V/);
  assert.match(v04Detail, /showVideo \? <V04VideoPlayer/);
  assert.doesNotMatch(v04Detail, /v04UiApi\.(save|submit|restore|materialize)/);
});

test("R3 preserves the existing V0.3 editor and legacy video catalog API byte for byte", async () => {
  const [practice, videosApi] = await Promise.all([
    readFile(new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url)),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url)),
  ]);
  assert.equal(createHash("sha256").update(practice).digest("hex"), "80689400bd930b8f6bd0dfc565a01b7a238cc60dcb973f138060a8ca3ee053d7");
  assert.equal(createHash("sha256").update(videosApi).digest("hex"), "df2ecde0ca38ce307d651f639fbe43e3a9cf13a9b7f7d00d2ca0a82917f7984f");
});
