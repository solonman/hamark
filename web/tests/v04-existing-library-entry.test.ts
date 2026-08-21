import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { V04_UI_STATE_LABELS } from "../lib/v04-ui-model.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the existing video catalog feeds the standalone formal V1.9 library", async () => {
  const [page, library, home, deployment] = await Promise.all([
    source("../app/page.tsx"),
    source("../components/v04/V04LibraryClient.tsx"),
    source("../app/components/HomeClient.tsx"),
    source("../vercel.json"),
  ]);
  assert.match(page, /process\.env\.V04_LIBRARY_UI_ENABLED === "true"/);
  assert.match(page, /process\.env\.V04_DEFAULT_UI_ENABLED === "true"/);
  assert.match(page, /if \(v04DefaultEnabled && v04LibraryEnabled\)[\s\S]*<V04LibraryClient[\s\S]*formal/);
  assert.match(library, /fetch\("\/api\/videos"/);
  assert.match(library, /v04UiApi\.cards\(videos\.map\(\(video\) => video\.id\)/);
  assert.match(library, /const detailHref[\s\S]*formal[\s\S]*`\/videos\/\$\{encodeURIComponent\(videoId\)\}`/);
  assert.match(library, /const workspaceHref[\s\S]*formal[\s\S]*`\/videos\/\$\{encodeURIComponent\(videoId\)\}\/practice`/);
  assert.match(library, /video\.thumbnailUrl/);
  assert.match(library, /<UploadDialog/);
  assert.match(library, /\/admin\/v02-v03-batch-mapping/);
  assert.match(library, /<UserMenu user=\{user\}/);
  assert.match(library, /\?taxonomy=V0\.3-PILOT/);
  assert.match(library, /data-v04-page="library"/);
  assert.match(home, /<UploadDialog/);
  assert.match(deployment, /"V04_LIBRARY_UI_ENABLED": "true"/);
  assert.match(deployment, /"V04_DEFAULT_UI_ENABLED": "true"/);
  assert.deepEqual(Object.values(V04_UI_STATE_LABELS), [
    "尚未开始",
    "尚未完成",
    "已提交",
    "有修改未提交",
    "修改已提交",
  ]);
});

test("R4 does not change the legacy videos API or V0.3 editor", async () => {
  const [videosApi, practice] = await Promise.all([
    readFile(new URL("../app/api/videos/route.ts", import.meta.url)),
    readFile(new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url)),
  ]);
  assert.equal(createHash("sha256").update(videosApi).digest("hex"), "df2ecde0ca38ce307d651f639fbe43e3a9cf13a9b7f7d00d2ca0a82917f7984f");
  assert.equal(createHash("sha256").update(practice).digest("hex"), "80689400bd930b8f6bd0dfc565a01b7a238cc60dcb973f138060a8ca3ee053d7");
});
