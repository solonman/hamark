import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("formal default routes render V1.9 page roots instead of legacy shells", async () => {
  const [homePage, detailPage, library, detail, layout, globalHome] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/videos/[id]/page.tsx"),
    source("../components/v04/V04LibraryClient.tsx"),
    source("../components/v04/V04DetailClient.tsx"),
    source("../app/layout.tsx"),
    source("../app/components/GlobalHomeButton.tsx"),
  ]);
  assert.match(homePage, /if \(v04DefaultEnabled && v04LibraryEnabled\)[\s\S]*return \([\s\S]*<V04LibraryClient/);
  assert.match(detailPage, /if \(v04DefaultEnabled && v04DetailEnabled && !explicitLegacyView\)[\s\S]*return \([\s\S]*<V04DetailClient/);
  assert.match(library, /data-v04-page="library"/);
  assert.match(detail, /data-v04-page="detail"/);
  assert.match(library, /CREATIVE REVERSE-ENGINEERING LIBRARY/);
  assert.match(library, /data-v04-layout="two-column-banner"/);
  assert.match(detailPage, /showVideo/);
  assert.match(detailPage, /compatibilityLinks/);
  assert.match(detailPage, /\?view=legacy/);
  assert.doesNotMatch(detailPage, /embedded|showVideo=\{false\}|#v04-analysis/);
  assert.match(layout, /hideForV04Default=\{process\.env\.V04_DEFAULT_UI_ENABLED === "true"\}/);
  assert.match(globalHome, /if \(hideForV04Default && isFormalV04Surface\) return null/);
});

test("formal detail keeps the approved six readonly shot groups and responsive layout", async () => {
  const [detail, css] = await Promise.all([
    source("../components/v04/V04DetailClient.tsx"),
    source("../components/v04/V04Surface.module.css"),
  ]);
  assert.match(detail, /keys: \["startTime", "endTime", "shotScale"\][\s\S]*keys: \["cameraAngle", "cameraMovement"\][\s\S]*keys: \["visualContent"\][\s\S]*keys: \["screenCopy", "subtitleEffect"\][\s\S]*keys: \["dialogue", "voiceOver"\][\s\S]*keys: \["soundEffect", "music"\]/);
  assert.match(detail, /data-v04-readonly-layout="3-2-1-2-2-2"/);
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
  // 数据操作是管理员的后台工具，不该常驻在所有人都看的顶栏里；页面本身仍在，按地址进。
  assert.doesNotMatch(library, /\/admin\/v02-v03-batch-mapping/);
  // 站里有两种可反写的东西，上传按钮要说清楚上传的是哪一种。
  assert.match(library, /library === "VIDEO"[\s\S]*上传视频[\s\S]*上传报告/);
});

test("formal workspace keeps approved choice, comment and publication semantics", async () => {
  const [workspace, detail, shotEditor, detailPage, practicePage] = await Promise.all([
    source("../components/v04/V04WorkspaceClient.tsx"),
    source("../components/v04/V04DetailClient.tsx"),
    source("../components/v04/V04ShotEditor.tsx"),
    source("../app/videos/[id]/page.tsx"),
    source("../app/videos/[id]/practice/page.tsx"),
  ]);
  assert.match(workspace, /label="桥段辅助创意作用"[\s\S]*multiple max=\{3\}/);
  assert.match(workspace, /V04_UI_BRIDGE_OPTIONS\.filter\(\(option\) => !group\.primaryRole\.selectedOptionIds\.includes\(option\.optionId\)\)/);
  assert.match(workspace, /next\.auxiliaryRole = \{[\s\S]*selectedOptionIds: next\.auxiliaryRole\.selectedOptionIds\.filter/);
  assert.match(workspace, /facts\.mainMechanism/);
  assert.match(workspace, /path\.primaryDetails\./);
  assert.match(workspace, /path\.auxiliary:/);
  assert.match(shotEditor, /shot:\$\{shot\.id\}\.\$\{key\}/);
  assert.match(detail, /value\.advancedText/);
  assert.match(detail, /桥段创意作用/);
  assert.match(detail, /本桥段关键创意描述/);
  assert.match(detail, /data-v04-case-title title=\{item\.title\}>\{item\.title\}/);
  assert.match(workspace, /data-v04-case-title title=\{item\.title\}>\{item\.title\}/);
  assert.match(workspace, /const submitActionProps = \{/);
  assert.equal((workspace.match(/\.\.\.submitActionProps/g) ?? []).length, 2);
  assert.match(detailPage, /detailLabel: "只读成果"/);
  assert.match(practicePage, /detailLabel: "只读成果"/);
  assert.doesNotMatch(detailPage, /detailLabel: "案例成果"/);
  assert.doesNotMatch(practicePage, /detailLabel: "作品详情"/);
});
