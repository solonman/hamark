import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("formal default routes render V1.9 page roots instead of legacy shells", async () => {
  const [homePage, detailPage, library, detail] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/videos/[id]/page.tsx"),
    source("../components/v04/V04LibraryClient.tsx"),
    source("../components/v04/V04DetailClient.tsx"),
  ]);
  assert.match(homePage, /if \(v04DefaultEnabled && v04LibraryEnabled\)[\s\S]*return \([\s\S]*<V04LibraryClient/);
  assert.match(detailPage, /if \(v04DefaultEnabled && v04DetailEnabled && !explicitLegacyView\)[\s\S]*return \([\s\S]*<V04DetailClient/);
  assert.match(library, /data-v04-page="library"/);
  assert.match(detail, /data-v04-page="detail"/);
  assert.match(library, /formal \? "V1\.9" : "V0\.4 SHADOW"/);
  assert.match(detailPage, /showVideo/);
  assert.match(detailPage, /compatibilityLinks/);
  assert.match(detailPage, /\?view=legacy/);
  assert.doesNotMatch(detailPage, /embedded|showVideo=\{false\}|#v04-analysis/);
});

test("formal detail keeps the approved six readonly shot groups and responsive layout", async () => {
  const [detail, css] = await Promise.all([
    source("../components/v04/V04DetailClient.tsx"),
    source("../components/v04/V04Surface.module.css"),
  ]);
  assert.match(detail, /\["startTime", "endTime", "shotScale"\], \["cameraAngle", "cameraMovement"\], \["visualContent"\],[\s\S]*\["screenCopy", "subtitleEffect"\], \["dialogue", "voiceOver"\], \["soundEffect", "music"\]/);
  assert.match(detail, /index === 0 \? styles\.readingThree : index === 2 \? styles\.readingOne : styles\.readingTwo/);
  assert.match(css, /\.readingThree \{ grid-template-columns: repeat\(3/);
  assert.match(css, /\.readingTwo \{ grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.readingThree, \.readingTwo, \.readingOne \{ grid-template-columns: 1fr; \}/);
});

test("formal library uses real media and preserves upload, admin, search and tags", async () => {
  const library = await source("../components/v04/V04LibraryClient.tsx");
  assert.match(library, /fetch\("\/api\/videos", \{ cache: "no-store"/);
  assert.match(library, /video\.thumbnailUrl/);
  assert.match(library, /video\.createdByName/);
  assert.match(library, /matchesV04LibraryQuery/);
  assert.match(library, /item\.tags\.map/);
  assert.match(library, /<UploadDialog/);
  assert.match(library, /isAdmin \? <Link href="\/admin\/v02-v03-batch-mapping"/);
});
