import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateAnnotation } from "../lib/annotation-validation.ts";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import type { AnnotationDraft } from "../lib/types.ts";

function readProjectFile(file: string) {
  return readFile(path.join(process.cwd(), file), "utf8");
}

function completeDraft(): AnnotationDraft {
  const draft = emptyAnnotation("video_1", "李四");
  return {
    ...draft,
    analysisTitle: "标题",
    commercialIntent: "意图",
    creativeTheme: "母题",
    synopsis: "梗概",
    thinkingChain: "思维链",
    shots: [{ ...newShot(), visualContent: "开场画面" }],
    fields: draft.fields.map((field) => ({ ...field, answer: "答案" })),
  };
}

function newShot() {
  return {
    id: "shot_1",
    orderIndex: 0,
    groupName: "镜头组 1",
    shotNumber: "1",
    startTime: "",
    endTime: "",
    shotSize: "",
    cameraAngle: "",
    cameraMovement: "",
    visualContent: "",
    dialogue: "",
    voiceover: "",
    screenText: "",
    soundEffect: "",
    music: "",
    creativeComment: "",
  };
}

test("an untouched draft reports every publish blocker by name", () => {
  const blockers = validateAnnotation(emptyAnnotation("video_1", "李四"));

  assert.equal(blockers.length, 25);
  assert.ok(blockers.includes("分析标题"));
  assert.ok(blockers.includes("创意思维链"));
  assert.ok(blockers.includes("至少一个有画面内容的镜头"));
  assert.ok(blockers.includes("A1 主导价值感受"));
  assert.ok(blockers.includes("B10 结尾类型"));
});

test("a finished draft reports no publish blocker", () => {
  assert.deepEqual(validateAnnotation(completeDraft()), []);
});

test("the worksheet and the submit route share one validation rule", async () => {
  const [server, submitRoute, client] = await Promise.all([
    readProjectFile("lib/annotation-server.ts"),
    readProjectFile("app/api/videos/[id]/annotation/submit/route.ts"),
    readProjectFile("app/videos/[id]/practice/PracticeClient.tsx"),
  ]);

  // Both sides must import the shared rule rather than keep private copies that drift.
  assert.match(server, /export \{ validateAnnotation \} from "\.\/annotation-validation"/);
  assert.match(submitRoute, /validateAnnotation/);
  assert.match(client, /from "@\/lib\/annotation-validation"/);
  assert.doesNotMatch(client, /missing\.push\(/);
});

test("publish failures are reported at the button, not only at the top of the page", async () => {
  const client = await readProjectFile(
    "app/videos/[id]/practice/PracticeClient.tsx",
  );

  // The blockers and the failure notice render inside the submit panel itself.
  assert.match(client, /className="submit-panel" ref=\{submitPanelRef\}/);
  assert.match(client, /submit-blockers/);
  assert.match(client, /submit-feedback/);
  assert.match(client, /还有 \{publishBlockers\.length\} 项未完成，暂时不能发布/);

  // Both publish buttons refuse to fire a request the server is certain to reject.
  const disabledGuards = client.match(/publishBlockers\.length > 0/g) ?? [];
  assert.equal(disabledGuards.length, 2);

  // Anything that still fails scrolls its reason into view.
  assert.match(client, /submitPanelRef\.current\?\.scrollIntoView/);
  assert.match(client, /revealSubmitFeedback\(\);\s*\n\s*return;/);
});

test("a failed save keeps its error visible through the next keystroke", async () => {
  const client = await readProjectFile(
    "app/videos/[id]/practice/PracticeClient.tsx",
  );

  assert.match(client, /if \(saveStateRef\.current !== "error"\) \{/);
  // The save indicator must not let `dirty` mask a failure, which made the
  // "自动保存失败" branch unreachable during autosave failures.
  const indicator = client.slice(client.indexOf('className={`save-indicator'));
  assert.ok(
    indicator.indexOf('saveState === "error"') < indicator.indexOf("dirty"),
    "the error branch must be evaluated before the dirty branch",
  );
});
