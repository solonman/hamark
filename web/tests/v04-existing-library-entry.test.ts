import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { V04_UI_STATE_LABELS } from "../lib/v04-ui-model.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("existing library remains the sole catalog and conditionally adds V0.4 projections", async () => {
  const [page, home, deployment] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/components/HomeClient.tsx"),
    source("../vercel.json"),
  ]);
  assert.match(page, /process\.env\.V04_LIBRARY_UI_ENABLED === "true"/);
  assert.match(home, /fetch\("\/api\/videos"/);
  assert.match(home, /v04UiApi\.cards\([\s\S]*nextVideos\.map\(\(video\) => video\.id\)/);
  assert.match(home, /v04LibraryEnabled \? \([\s\S]*<V04CardProjection/);
  assert.match(home, /\/videos\/\$\{encodedId\}#v04-analysis/);
  assert.match(home, /\/videos\/\$\{encodedId\}\/practice\?taxonomy=V0\.4/);
  assert.match(home, /V0\.4 状态暂时无法读取，片库仍可正常使用/);
  assert.match(home, /<UploadDialog/);
  assert.match(home, /video\.tags\.slice\(0, 4\)/);
  assert.doesNotMatch(deployment, /V04_LIBRARY_UI_ENABLED/);
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
