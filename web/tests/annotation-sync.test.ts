import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  interpretSaveResponse,
  rebaseOntoServerRevision,
} from "../lib/annotation-sync.ts";

function readProjectFile(file: string) {
  return readFile(path.join(process.cwd(), file), "utf8");
}

test("a successful save reports the revision the server assigned", () => {
  const outcome = interpretSaveResponse(200, {
    annotationId: "annotation_1",
    revision: 8,
    updatedAt: "2026-08-07T10:00:00.000Z",
  });

  assert.deepEqual(outcome, {
    kind: "saved",
    annotationId: "annotation_1",
    revision: 8,
    updatedAt: "2026-08-07T10:00:00.000Z",
  });
});

test("a stale revision is reported as a conflict carrying the winning revision", () => {
  const outcome = interpretSaveResponse(409, {
    error: "这份作业已在其他页面更新，请刷新后继续。",
    code: "REVISION_CONFLICT",
    serverRevision: 12,
  });

  assert.equal(outcome.kind, "conflict");
  assert.equal(outcome.kind === "conflict" && outcome.serverRevision, 12);
});

test("a 409 without a usable server revision stays an ordinary failure", () => {
  assert.equal(interpretSaveResponse(409, { error: "冲突" }).kind, "failed");
  assert.equal(
    interpretSaveResponse(409, { code: "REVISION_CONFLICT" }).kind,
    "failed",
  );
});

test("other failures keep the server message", () => {
  const outcome = interpretSaveResponse(404, { error: "视频不存在或作业对象不一致。" });

  assert.deepEqual(outcome, {
    kind: "failed",
    message: "视频不存在或作业对象不一致。",
  });
  assert.equal(interpretSaveResponse(500, {}).kind, "failed");
  // A 2xx that is missing the fields the client needs is a failure, not a save.
  assert.equal(interpretSaveResponse(200, { revision: 3 }).kind, "failed");
});

test("rebasing keeps every local edit and only adopts the server revision", () => {
  const draft = { revision: 4, analysisTitle: "本页写的标题", shots: [1, 2] };
  const rebased = rebaseOntoServerRevision(draft, 12);

  assert.equal(rebased.revision, 12);
  assert.equal(rebased.analysisTitle, "本页写的标题");
  assert.deepEqual(rebased.shots, [1, 2]);
  assert.equal(draft.revision, 4, "the original draft must not be mutated");
});

test("a save conflict pauses autosave and asks the user which side wins", async () => {
  const client = await readProjectFile(
    "app/videos/[id]/practice/PracticeClient.tsx",
  );

  assert.match(client, /interpretSaveResponse\(response\.status, data\)/);
  assert.match(client, /outcome\.kind === "conflict"/);
  assert.match(client, /setConflict\(\{ serverRevision: outcome\.serverRevision \}\)/);

  // Autosave must not keep firing requests the server will reject every time.
  assert.match(client, /if \(!dirty \|\| saveState === "saving" \|\| conflict\) return;/);

  // Resolution is an explicit choice, never an automatic overwrite of the other page.
  assert.match(client, /保留本页内容并继续保存/);
  assert.match(client, /放弃本页修改，载入另一份/);
  assert.match(client, /rebaseOntoServerRevision\(current, conflict\.serverRevision\)/);
});

test("a blocked home navigation always tells the user why it stayed", async () => {
  const client = await readProjectFile(
    "app/videos/[id]/practice/PracticeClient.tsx",
  );

  const handler = client.slice(
    client.indexOf("function handleHomeNavigation"),
    client.indexOf("window.addEventListener(HOME_NAVIGATION_EVENT"),
  );

  assert.ok(handler.length > 0, "the home navigation handler must exist");
  // Every path that declines to navigate has to leave a message behind.
  assert.match(handler, /if \(!saved\) \{\s*\n\s*setNotice\(/);
  assert.match(handler, /if \(dirtyRef\.current\) \{\s*\n\s*setNotice\(/);
  assert.doesNotMatch(handler, /if \(!saved\) return;/);
});
