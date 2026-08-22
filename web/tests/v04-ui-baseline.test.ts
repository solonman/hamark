import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { V04_SHOT_FIELD_KEYS } from "../lib/v04-contract.ts";
import { V04_VOCABULARY_OPTIONS } from "../lib/v04-vocabulary.ts";
import { V04_UI_CASES, V04_UI_PROTOTYPE_HASHES } from "../lib/v04-ui-fixture.ts";
import { V04_WORKSPACE_TARGETS } from "../lib/v04-ui-client-state.ts";
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

test("tracked shadow runtime remains an adapter and does not create a second data truth", async () => {
  for (const relative of runtimeFiles) {
    const source = await readFile(new URL(`../${relative}`, import.meta.url), "utf8");
    for (const forbidden of ["DATABASE_URL", "getDbClient", "indexedDB"]) {
      assert.ok(!source.includes(forbidden), `${relative} contains ${forbidden}`);
    }
    if (relative !== "components/v04/V04WorkspaceClient.tsx") {
      assert.ok(!source.includes("localStorage"), `${relative} contains localStorage`);
    } else {
      assert.match(source, /writeV04Recovery\(storage/);
      assert.match(source, /discoverV04Recoveries<V04UiDraft, V04Payload>\(storage/);
      assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem|removeItem)\(/,
        "workspace recovery must pass through the credential-stripping recovery contract");
    }
  }
  const [library, cardsRoute, readModels] = await Promise.all([
    readFile(new URL("../components/v04/V04LibraryClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/analysis/v04/cards/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/v04-read-models.ts", import.meta.url), "utf8"),
  ]);
  assert.match(library, /fetch\("\/api\/videos"/);
  assert.match(library, /v04UiApi\.cards/);
  assert.match(cardsRoute, /getAll\("videoId"\)/);
  assert.match(readModels, /Projects V0\.4 state and capabilities onto video IDs/);
  assert.match(readModels, /return \{ projections \}/);
});

test("detail and workspace preserve V1.9 structural interaction contracts", async () => {
  const [detail, workspace, navigation, comments, clientState, shot, css] = await Promise.all([
    readFile(new URL("../components/v04/V04DetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04WorkspaceNavigation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04CommentDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/v04-ui-client-state.ts", import.meta.url), "utf8"),
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
  assert.match(workspace, /label="本桥段关键创意描述"[\s\S]*required=\{false\}/);
  assert.doesNotMatch(workspace, /locateMissing/);
  assert.match(navigation, /locateV04Target/);
  assert.match(comments, /locateV04Target/);
  assert.match(clientState, /focus\(\{ preventScroll: true \}\)/);
  assert.match(clientState, /data-v04-fixed-header/);
  assert.match(css, /\.surface \[data-v04-located="true"\]/);
  assert.match(css, /\.navChildren \{ display: flex; flex: none;/);
  for (const targetId of Object.values(V04_WORKSPACE_TARGETS)) {
    assert.ok(
      workspace.includes(`id="${targetId}"`)
        || workspace.includes(`V04_WORKSPACE_TARGETS.${Object.entries(V04_WORKSPACE_TARGETS).find(([, value]) => value === targetId)?.[0]}`),
      `${targetId} must be rendered by the workspace`,
    );
  }
  assert.match(workspace, /id=\{v04GroupTitleTargetId\(group\.id\)\}/);
  assert.match(workspace, /targetId=\{v04GroupPrimaryRoleTargetId\(group\.id\)\}/);
  assert.match(shot, /id=\{v04ShotFieldTargetId\(shot\.id, key\)\}/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.readingThree \{ grid-template-columns: repeat\(3/);
  assert.match(css, /\.readingTwo \{ grid-template-columns: repeat\(2/);
  assert.match(css, /\.readingThree, \.readingTwo, \.readingOne \{ grid-template-columns: 1fr; \}/);
});

test("observer workspace keeps local reading interactions while every mutation remains locked", async () => {
  const [workspace, navigation, choice, shot, comments, css] = await Promise.all([
    readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04WorkspaceNavigation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04ChoiceField.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04ShotEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04CommentDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/v04/V04Surface.module.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(workspace, /<fieldset[^>]*disabled=\{!canEdit\}/);
  assert.match(workspace, /aria-readonly=\{!canEdit\}/);
  assert.match(workspace, /const updateDraft[\s\S]*if \(!canEdit\) return;/);
  assert.match(workspace, /const manualSave[\s\S]*if \(!canEdit\) return;/);
  assert.match(workspace, /const submitDraft[\s\S]*if \(!canEdit\) return;/);
  assert.match(workspace, /onRestore=\{canEdit \? restoreVersion : undefined\}/);
  assert.match(workspace, /readOnly=\{!canEdit\}/);
  assert.match(workspace, /disabled=\{!canEdit\}[\s\S]*新增镜头/);
  assert.match(workspace, /disabled=\{!canEdit\}[\s\S]*提交并更新案例/);
  assert.match(workspace, /disabled=\{!canEdit\}[\s\S]*setExpertPreference/);

  assert.match(workspace, /第二模块[\s\S]*onClick=\{\(\) => toggleModule\(2\)\}/);
  assert.match(workspace, /第三模块[\s\S]*onClick=\{\(\) => toggleModule\(3\)\}/);
  assert.match(workspace, /publication\.missing\.map[\s\S]*onClick=\{\(\) => locate\(missing\.id\)\}/);
  assert.match(navigation, /onLocate\?: \(id: string\) => void/);
  assert.match(workspace, /<V04WorkspaceNavigation draft=\{draft\} onLocate=\{locate\}/);
  assert.match(workspace, /setCollapsed[\s\S]*locateV04Target\(id\)/);
  assert.match(comments, /onLocate\?: \(id: string\) => void/);
  assert.match(workspace, /<V04CommentDrawer[\s\S]*onLocate=\{locate\}[\s\S]*readOnly=\{!canEdit\}/);

  assert.match(choice, /className=\{styles\.choiceTrigger\}[\s\S]*onClick=\{\(\) => setOpen/);
  assert.doesNotMatch(choice, /className=\{styles\.choiceTrigger\}[^>]*disabled/);
  assert.match(choice, /disabled=\{readOnly\}/);
  assert.match(choice, /readOnly=\{readOnly\}/);
  assert.match(shot, /draggable=\{!readOnly\}/);
  assert.match(shot, /disabled=\{readOnly\}/);
  assert.match(shot, /readOnly=\{readOnly\}/);
  assert.match(css, /\.readOnlyEditor input\[readonly\]/);
  assert.match(workspace, /data-v04-edit-access-blocked/);
  assert.match(workspace, /刷新并重试编辑权/);
  assert.match(workspace, /const visibleSaveLabel = !hasDraftEditCapability/,
    "a readonly workspace must not present a stale server save label as editable success");
  assert.match(workspace, /当前为只读，取得编辑权后才能提交/,
    "publication completeness must not masquerade as submit readiness while edit access is absent");
  assert.match(workspace, /aria-describedby=\{!hasDraftEditCapability \? "v04-edit-access-message"/,
    "a focused readonly missing field must announce the adjacent access reason");
  assert.match(css, /\.editAccessBanner \{ position: sticky/,
    "a deep missing-field location keeps the readonly reason in the field viewport");
  assert.match(css, /\.readOnlyEditor input\[readonly\][^\n]*cursor: not-allowed/,
    "a located readonly field remains visibly readonly rather than imitating an editable focus target");
});

test("opening a logical empty V0.4 workspace stays zero-write until the first actual save", async () => {
  const workspace = await readFile(
    new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    workspace,
    /if \(!next\.logicalEmpty\) await requestEditAccess\(next, \{ initialRecoveryPending \}\)/,
  );
  assert.match(
    workspace,
    /const acquireLease[\s\S]*if \(current\.logicalEmpty\) \{[\s\S]*v04UiApi\.materialize[\s\S]*const commitSave/,
  );
  const firstMaterialize = workspace.indexOf("v04UiApi.materialize");
  const initialLoadEffect = workspace.indexOf("useEffect(() =>", firstMaterialize);
  assert.ok(firstMaterialize >= 0 && initialLoadEffect > firstMaterialize,
    "materialize must remain in the mutation path, before the initial read effect");
});
