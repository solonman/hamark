import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("production bundle contains the RE:VERSE library and worksheet", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../dist/client/.vite/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const homeFile = manifest["app/components/HomeClient.tsx"].file;
  const practiceFile =
    manifest["app/videos/[id]/practice/PracticeClient.tsx"].file;
  const detailFile = manifest["app/videos/[id]/VideoDetailClient.tsx"].file;
  const clientDirectory = new URL("../dist/client/assets/", import.meta.url);
  const clientFiles = (await readdir(clientDirectory)).filter((file) =>
    file.endsWith(".js"),
  );
  const [homeBundle, practiceBundle, detailBundle, serverBundle, clientChunks] = await Promise.all([
    readFile(new URL(`../dist/client/${homeFile}`, import.meta.url), "utf8"),
    readFile(new URL(`../dist/client/${practiceFile}`, import.meta.url), "utf8"),
    readFile(new URL(`../dist/client/${detailFile}`, import.meta.url), "utf8"),
    readFile(new URL("../dist/server/index.js", import.meta.url), "utf8"),
    Promise.all(
      clientFiles.map((file) =>
        readFile(new URL(file, clientDirectory), "utf8"),
      ),
    ),
  ]);
  const clientBundle = clientChunks.join("\n");

  assert.match(homeBundle, /看完一支片/);
  assert.match(homeBundle, /把创意重新拆开/);
  assert.match(homeBundle, /上传作品/);
  assert.match(homeBundle, /标注体系 V0\.2/);
  assert.match(practiceBundle, /逐镜脚本还原/);
  assert.match(clientBundle, /镜头组序号／名称/);
  assert.match(clientBundle, /创意点评／标注依据/);
  assert.match(practiceBundle, /创意构成 9 项/);
  assert.match(practiceBundle, /故事组织 10 项/);
  assert.match(practiceBundle, /V0\.2 预设选项/);
  assert.match(practiceBundle, /其他（自主输入）/);
  assert.match(practiceBundle, /修改约1秒自动保存/);
  assert.match(practiceBundle, /发布本次修订/);
  assert.match(practiceBundle, /对照视频 · 始终悬浮/);
  assert.match(clientBundle, /拖动表头边界调整列宽/);
  assert.match(clientBundle, /恢复默认列宽/);
  assert.match(detailBundle, /原位批改 · 100分/);
  assert.match(detailBundle, /替换原视频/);
  assert.match(detailBundle, /对照视频 · 随页面悬浮/);
  assert.match(detailBundle, /提交正式评分/);
  assert.match(detailBundle, /RUBRIC-V0\.4/);
  assert.match(detailBundle, /镜头组分段与顺序/);
  assert.match(serverBundle, /api\/videos\/:id\/annotation\/submit/);
  assert.match(serverBundle, /api\/videos\/:id\/replace/);
  assert.doesNotMatch(homeBundle, /Your site is taking shape|Starter Project/);
  assert.doesNotMatch(homeBundle, /react-loading-skeleton/);
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
