import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { V04_SHOT_FIELD_KEYS } from "../lib/v04-contract.ts";
import { V04_VOCABULARY_OPTIONS } from "../lib/v04-vocabulary.ts";
import { V04_UI_CASES, V04_UI_PROTOTYPE_HASHES } from "../lib/v04-ui-fixture.ts";
import { V04_UI_MODULES, V04_UI_SHOT_FIELDS } from "../lib/v04-ui-model.ts";

const runtimeFiles = [
  "app/v04-shadow/layout.tsx", "app/v04-shadow/page.tsx", "app/v04-shadow/videos/[id]/page.tsx", "app/v04-shadow/videos/[id]/workspace/page.tsx",
  "components/v04/V04LibraryClient.tsx", "components/v04/V04DetailClient.tsx", "components/v04/V04WorkspaceClient.tsx", "components/v04/V04VideoSessionProvider.tsx",
  "components/v04/V04VideoPlayer.tsx", "components/v04/V04WorkspaceNavigation.tsx", "components/v04/V04ShotEditor.tsx", "components/v04/V04ChoiceField.tsx",
  "components/v04/V04HistoryDrawer.tsx", "components/v04/V04CommentDrawer.tsx", "components/v04/V04AiAssistPanel.tsx",
  "lib/v04-shadow-access.ts", "lib/v04-ui-model.ts", "lib/v04-ui-fixture.ts", "lib/v04-ui-client-state.ts",
];

test("V1.9 baseline freezes 13 core hashes and verifies local prototype when present", async () => {
  assert.equal(Object.keys(V04_UI_PROTOTYPE_HASHES).length, 13);
  const prototypeRoot = "/Users/boga/.codex/worktrees/cb41/视频创意脚本系统/prototypes/v04-stage0";
  try { await access(prototypeRoot); } catch { return; }
  for (const [relative, expected] of Object.entries(V04_UI_PROTOTYPE_HASHES)) {
    const content = await readFile(path.join(prototypeRoot, relative));
    assert.equal(createHash("sha256").update(content).digest("hex"), expected, relative);
  }
});

test("fixture UI carries three pages, four modules, 12 shot fields and approved vocab counts", () => {
  assert.equal(V04_UI_CASES.length, 3);
  assert.equal(V04_UI_MODULES.length, 4);
  assert.deepEqual(V04_UI_SHOT_FIELDS.map((item) => item.key), [...V04_SHOT_FIELD_KEYS]);
  assert.equal(V04_VOCABULARY_OPTIONS.filter((item) => item.fieldKey === "bridgeCreativeRole").length, 24);
  assert.equal(V04_VOCABULARY_OPTIONS.filter((item) => item.fieldKey === "generalMechanism").length, 15);
  assert.equal(V04_VOCABULARY_OPTIONS.filter((item) => item.fieldKey === "storyReferenceType").length, 21);
  assert.equal(V04_UI_CASES[0].draft.shotGroups[0].shots[0].subtitleEffect.length > 0, true);
});

test("tracked shadow runtime is fixture-only and contains no production API or database access", async () => {
  for (const relative of runtimeFiles) {
    const source = await readFile(new URL(`../${relative}`, import.meta.url), "utf8");
    for (const forbidden of ["fetch(", "XMLHttpRequest", '"/api/', "DATABASE_URL", "getDbClient", "localStorage", "indexedDB"]) {
      assert.ok(!source.includes(forbidden), `${relative} contains ${forbidden}`);
    }
  }
});

test("detail and workspace preserve V1.9 structural interaction contracts", async () => {
  const [detail, workspace, shot, css] = await Promise.all([
    readFile(new URL("../components/v04/V04DetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04ShotEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /\["startTime", "endTime", "shotScale"\][\s\S]*\["cameraAngle", "cameraMovement"\][\s\S]*\["visualContent"\][\s\S]*\["screenCopy", "subtitleEffect"\][\s\S]*\["dialogue", "voiceOver"\][\s\S]*\["soundEffect", "music"\]/);
  assert.match(workspace, /第一模块｜脚本反写/);
  assert.match(workspace, /第二模块｜全片事实与核心判断/);
  assert.match(workspace, /第三模块｜主导感知类型发生路径/);
  assert.match(workspace, /第四模块｜提交/);
  assert.match(shot, /data-shot-drag-handle/);
  assert.match(shot, /跨桥段移动/);
  assert.doesNotMatch(shot, /<article[^>]*draggable/);
  assert.match(workspace, /onDrop=/);
  assert.match(workspace, /moveShotTo/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.readingThree \{ grid-template-columns: repeat\(3/);
  assert.match(css, /\.readingTwo \{ grid-template-columns: repeat\(2/);
  assert.match(css, /\.readingThree, \.readingTwo, \.readingOne \{ grid-template-columns: 1fr; \}/);
});
