import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source contains the RE:VERSE library and worksheet flows", async () => {
  const [
    home,
    practice,
    detail,
    shotTable,
    taxonomyEditor,
    reviewPanel,
    reviewRubric,
  ] =
    await Promise.all([
      readFile(
        new URL("../app/components/HomeClient.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/videos/[id]/practice/PracticeClient.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/components/ResizableShotTable.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/videos/[id]/practice/TaxonomyFieldEditor.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/videos/[id]/ReviewPanel.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../lib/review-rubric.ts", import.meta.url), "utf8"),
    ]);

  assert.match(home, /看完一支片/);
  assert.match(home, /把创意重新拆开/);
  assert.match(home, /上传作品/);
  assert.match(home, /标注体系 V0\.2/);
  assert.match(practice, /逐镜脚本还原/);
  assert.match(shotTable, /镜头组序号／名称/);
  assert.match(shotTable, /创意点评／标注依据/);
  assert.match(practice, /创意构成 9 项/);
  assert.match(practice, /故事组织 10 项/);
  assert.match(taxonomyEditor, /V0\.2 预设选项/);
  assert.match(taxonomyEditor, /其他（自主输入）/);
  assert.match(practice, /修改约1秒自动保存/);
  assert.match(practice, /发布本次修订/);
  assert.match(practice, /对照视频 · 始终悬浮/);
  assert.match(shotTable, /拖动表头边界调整列宽/);
  assert.match(shotTable, /恢复默认列宽/);
  assert.match(detail, /原位批改 · 100分/);
  assert.match(detail, /替换原视频/);
  assert.match(detail, /对照视频 · 随页面悬浮/);
  assert.match(reviewPanel, /提交正式评分/);
  assert.match(reviewRubric, /RUBRIC-V0\.4/);
  assert.match(reviewRubric, /镜头组分段与顺序/);
  assert.doesNotMatch(home, /Your site is taking shape|Starter Project/);
  assert.doesNotMatch(home, /react-loading-skeleton/);
});

test("home renders authenticated user controls and handles logout securely", async () => {
  const [page, home, userMenu] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/UserMenu.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /displayName: user\.displayName/);
  assert.match(home, /<UserMenu user=\{user\}/);
  assert.match(
    home,
    /<nav className="header-actions"[\s\S]*上传作品[\s\S]*<UserMenu user=\{user\} \/>[\s\S]*<\/nav>/,
  );
  assert.ok(userMenu.includes('fetch("/api/auth/logout", { method: "POST" })'));
  assert.doesNotMatch(userMenu, /href=["']\/api\/auth\/logout/);
});

test("client mutations redirect to login on unauthorized business API responses", async () => {
  const [upload, detail, practice, review] = await Promise.all([
    readFile(new URL("../app/components/UploadDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/ReviewPanel.tsx", import.meta.url), "utf8"),
  ]);

  for (const source of [upload, detail, practice, review]) {
    assert.match(source, /redirectOnUnauthorized\(/);
  }
});

test("home keeps the current screen when its background library request is unauthorized", async () => {
  const home = await readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(home, /if \(redirectOnUnauthorized\(response\)\) return;/);
  assert.match(home, /登录状态已失效/);
});

test("video uploads go directly to COS and are completed through a small API request", async () => {
  const [upload, createRoute, completeRoute] = await Promise.all([
    readFile(new URL("../app/components/UploadDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[id]/complete/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(createRoute, /createPresignedPutUrl/);
  assert.match(upload, /data\.uploadUrl/);
  assert.match(upload, /\/api\/videos\/\$\{data\.videoId\}\/complete/);
  assert.doesNotMatch(upload, /\/api\/videos\/\$\{data\.videoId\}\/content/);
  assert.match(completeRoute, /getVideoBucket\(\)\.head/);
  assert.match(completeRoute, /created_by_email !== user\.identityKey/);
  assert.match(completeRoute, /status = 'READY'/);
});

test("video playback uses a signed COS URL and the library does not preload streams", async () => {
  const [home, detail] = await Promise.all([
    readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /src=\{video\.playbackUrl\}/);
  assert.doesNotMatch(home, /\/api\/videos\/\$\{video\.id\}\/stream/);
  assert.doesNotMatch(home, /preload="metadata"/);
});

test("V0.2 taxonomy preserves all appendix fields and preset values", async () => {
  const taxonomy = JSON.parse(
    await readFile(new URL("../lib/taxonomy-v0.2.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(
    taxonomy.map((field) => field.code),
    [
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "B1",
      "B2",
      "B3",
      "B4",
      "B5",
      "B6",
      "B7",
      "B8",
      "B9",
      "B10",
    ],
  );
  assert.equal(
    taxonomy.reduce((total, field) => total + field.options.length, 0),
    196,
  );
  assert.equal(taxonomy[0].options[0].value, "有爱");
  assert.equal(
    taxonomy.find((field) => field.code === "A2").options.at(-1).value,
    "其他（自定义机制）",
  );
  assert.equal(
    taxonomy.find((field) => field.code === "B10").options.at(-1).value,
    "行动号召",
  );
});

test("social preview asset is a 1200 by 630 PNG", async () => {
  const png = await readFile(new URL("../public/og.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
