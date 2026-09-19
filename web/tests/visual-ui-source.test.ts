// 读源码断言公共视觉库前端几条不容妥协的规则：不走 innerHTML、复用共享浮层组件、
// 首页页签接入、详情页门禁顺序、深色岛标注。做法同 tests/source-content.test.mjs
// （读文件正则匹配），这一层测的是"有没有按规矩接"，不是纯函数的输入输出。

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const VISUAL_DIR = new URL("../components/visual/", import.meta.url);

async function readVisualComponentSources(): Promise<Map<string, string>> {
  const dir = await readdir(VISUAL_DIR);
  const entries = await Promise.all(
    dir
      .filter((name) => name.endsWith(".tsx"))
      .map(async (name) => [name, await readFile(new URL(name, VISUAL_DIR), "utf8")] as const),
  );
  return new Map(entries);
}

test("components/visual never uses dangerouslySetInnerHTML (案例简介按纯文本渲染)", async () => {
  const sources = await readVisualComponentSources();
  assert(sources.size > 0, "expected at least one component under components/visual");
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${name} must not use dangerouslySetInnerHTML`);
  }
});

test("案例简介按 React 文本子节点渲染（不经过任何 HTML 解析）", async () => {
  const detail = await readFile(new URL("VisualCaseClient.tsx", VISUAL_DIR), "utf8");
  assert.match(detail, /<p className=\{styles\.prose\}>\{detail\.textBody\}<\/p>/);
});

test("列表、详情都复用共享的 LibraryToast 与 DeleteConfirmDialog，不各写一份", async () => {
  const [card, library, detail] = await Promise.all([
    readFile(new URL("VisualCard.tsx", VISUAL_DIR), "utf8"),
    readFile(new URL("VisualLibrary.tsx", VISUAL_DIR), "utf8"),
    readFile(new URL("VisualCaseClient.tsx", VISUAL_DIR), "utf8"),
  ]);

  assert.match(card, /import DeleteConfirmDialog from "@\/components\/shared\/DeleteConfirmDialog";/);
  assert.match(card, /<DeleteConfirmDialog/);

  assert.match(library, /import \{ LibraryToastStack, useLibraryToast \} from "@\/components\/shared\/LibraryToast";/);
  assert.match(library, /<LibraryToastStack toasts=\{toasts\} \/>/);

  assert.match(detail, /import DeleteConfirmDialog from "@\/components\/shared\/DeleteConfirmDialog";/);
  assert.match(detail, /<DeleteConfirmDialog/);
  assert.match(detail, /import \{ LibraryToastStack, useLibraryToast \} from "@\/components\/shared\/LibraryToast";/);
  assert.match(detail, /<LibraryToastStack toasts=\{toasts\} \/>/);
});

test("V04LibraryClient 有「公共视觉库」页签，切过去把 ?library=VISUAL 写回地址栏", async () => {
  const source = await readFile(new URL("../components/v04/V04LibraryClient.tsx", import.meta.url), "utf8");

  assert.match(source, /type LibraryTab = "VIDEO" \| "REPORT" \| "VISUAL";/);
  assert.match(source, />公共视觉库<\/button>/);
  assert.match(source, /library === "VISUAL"/);
  // setLibrary 把 REPORT/VISUAL 都写回 URL，VIDEO 时删掉这个参数。
  assert.match(source, /if \(next === "REPORT" \|\| next === "VISUAL"\) url\.searchParams\.set\("library", next\);/);
  // 挂载时从 URL 读回初始页签，同样认 VISUAL。
  assert.match(source, /initial === "REPORT" \|\| initial === "VISUAL"/);
  // 上传按钮跟着页签走：VISUAL 页签下是「上传案例」，开关关着时 disabled。
  assert.match(source, />上传案例<\/button>/);
  assert.match(source, /公共视觉库建设中，暂不能上传/);
  // 视频库、报告库的既有分支必须原样还在，页签是新加的第三条分支，不是替换。
  assert.match(source, /library === "VIDEO"/);
  assert.match(source, /reportLibraryEnabled/);
});

test("公共视觉库详情页先查总开关（notFound），再 requirePageUser 门禁", async () => {
  const source = await readFile(new URL("../app/visual/[id]/page.tsx", import.meta.url), "utf8");
  const notFoundIndex = source.indexOf("if (!isVisualFeatureEnabled()) notFound();");
  const requireUserIndex = source.indexOf("requirePageUser(");
  assert(notFoundIndex >= 0, "expected the feature-flag notFound() guard");
  assert(requireUserIndex >= 0, "expected a requirePageUser(...) call");
  assert(notFoundIndex < requireUserIndex, "the feature flag must be checked before requirePageUser");
});

test("封面、舞台、对话框素材格、大图查看区都标了 data-v04-scheme=\"dark\"（深色岛）", async () => {
  const [card, detail, uploadDialog] = await Promise.all([
    readFile(new URL("VisualCard.tsx", VISUAL_DIR), "utf8"),
    readFile(new URL("VisualCaseClient.tsx", VISUAL_DIR), "utf8"),
    readFile(new URL("VisualUploadDialog.tsx", VISUAL_DIR), "utf8"),
  ]);

  // 卡片封面：就绪（Link）与上传未完成（button）两种都是深色岛。
  const cardMatches = card.match(/data-v04-scheme="dark"/g) ?? [];
  assert.equal(cardMatches.length, 2, "VisualCard should mark both the ready cover link and the busy cover button as dark islands");

  // 详情页：舞台（videoShell）与大图查看区。
  assert.match(detail, /className=\{v04\.videoShell\} data-v04-scheme="dark"/);
  assert.match(detail, /className=\{styles\.viewerBody\} data-v04-scheme="dark"/);

  // 上传对话框：素材格。
  assert.match(uploadDialog, /styles\.mediaTile[\s\S]{0,80}data-v04-scheme="dark"/);
});
