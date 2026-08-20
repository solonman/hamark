import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCommentBody } from "../lib/analysis-comments.ts";
import { emptyV04DraftPayload } from "../lib/v04-domain.ts";
import { resolveV04CommentTarget } from "../lib/v04-read-models.ts";

test("V0.4 comments resolve only stable targets in the V0.4 payload", () => {
  const payload = emptyV04DraftPayload();
  payload.factsAndCoreJudgement.creativeMotif = "归来";
  payload.script.shotGroups = [{
    id: "group-1", orderIndex: 0, bridgeName: "开场",
    primaryCreativeRole: payload.factsAndCoreJudgement.mainMechanism,
    auxiliaryCreativeRole: payload.factsAndCoreJudgement.auxiliaryMechanism,
    keyCreativeDescription: "", shots: [{
      id: "shot-1", orderIndex: 0, startTime: "00:00", endTime: "00:01",
      shotScale: "近景", cameraAngle: "平视", cameraMovement: "固定",
      visualContent: "人物推门", screenCopy: "欢迎", subtitleEffect: "淡入",
      dialogue: "", voiceOver: "回家", soundEffect: "开门", music: "钢琴",
    }],
  }];
  assert.equal(resolveV04CommentTarget(payload, "facts.creativeMotif")?.value, "归来");
  assert.equal(resolveV04CommentTarget(payload, "shot:shot-1.subtitleEffect")?.value, "淡入");
  assert.equal(resolveV04CommentTarget(payload, "shot:shot-1.unknown"), null);
  assert.equal(resolveV04CommentTarget(payload, "facts.unknown"), null);
});

test("V0.4 comment mutation input uses the shared normalized target and body contract", () => {
  assert.ok(validateCommentBody("").error);
  assert.equal(validateCommentBody("  需要补充创意母题  ").body, "需要补充创意母题");
  const source = readFileSync(new URL("../app/api/videos/[id]/analysis/v04/comments/route.ts", import.meta.url), "utf8");
  assert.match(source, /\^\[a-z0-9:\._-\]\+\$\/i/);
});

test("V0.4 comment routes bind current working snapshots and never accept caller snapshot ids", () => {
  const createSource = readFileSync(new URL("../app/api/videos/[id]/analysis/v04/comments/route.ts", import.meta.url), "utf8");
  const updateSource = readFileSync(new URL("../app/api/videos/[id]/analysis/v04/comments/[commentId]/route.ts", import.meta.url), "utf8");
  assert.match(createSource, /current_working_snapshot_id/);
  assert.match(createSource, /workflow_version = \?/);
  assert.doesNotMatch(createSource, /body\.snapshotId|body\.submissionId/);
  assert.match(createSource, /V04_COMMENT_CREATED/);
  assert.match(updateSource, /V04_COMMENT_STATUS_UPDATED/);
  assert.match(createSource, /afterCommentInsert/);
  assert.match(updateSource, /afterCommentUpdate/);
});
