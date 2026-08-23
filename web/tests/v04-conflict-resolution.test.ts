import assert from "node:assert/strict";
import test from "node:test";
import { emptyV04ChoiceValue, emptyV04DraftPayload, v04ValueConflictTargets } from "../lib/v04-domain.ts";
import { planV04ConflictResolution } from "../lib/v04-ui-model.ts";
import { summarizeV04ConflictDifferences } from "../lib/v04-conflict-resolution.ts";
import type { V04DraftPayloadV1 } from "../lib/v04-contract.ts";

const SHOT_FIELDS = {
  startTime: "", endTime: "", shotScale: "", cameraAngle: "", cameraMovement: "",
  visualContent: "", screenCopy: "", subtitleEffect: "", dialogue: "",
  voiceOver: "", soundEffect: "", music: "",
};

function payloadWithScript(): V04DraftPayloadV1 {
  const payload = emptyV04DraftPayload();
  payload.script.shotGroups = [{
    id: "group-1",
    orderIndex: 0,
    bridgeName: "深夜归来",
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "",
    shots: [
      { id: "shot-1", orderIndex: 0, ...SHOT_FIELDS, visualContent: "雨夜的门灯" },
      { id: "shot-2", orderIndex: 1, ...SHOT_FIELDS, visualContent: "父亲推门下车" },
    ],
  }];
  return payload;
}

test("a save only conflicts on the targets whose original value actually drifted", () => {
  const server = emptyV04DraftPayload();
  server.factsAndCoreJudgement.commercialIntent = "同事写的意图";
  server.factsAndCoreJudgement.storySynopsis = "共同的梗概";
  const changes = [
    {
      targetKey: "facts.commercialIntent", targetLabel: "商业意图", valueType: "TEXT" as const,
      beforeValue: "", afterValue: "我的意图",
    },
    {
      targetKey: "facts.creativeMotif", targetLabel: "创意母题", valueType: "TEXT" as const,
      beforeValue: "", afterValue: "我的母题",
    },
  ];
  assert.deepEqual(v04ValueConflictTargets(server, changes), ["facts.commercialIntent"],
    "a moved-on workspace must not report every edited target as conflicting");
  assert.deepEqual(v04ValueConflictTargets(emptyV04DraftPayload(), changes), [],
    "matching original values rebase instead of conflicting");
  assert.deepEqual(
    v04ValueConflictTargets(emptyV04DraftPayload(), [{
      targetKey: "shot:missing.visualContent", targetLabel: "画面内容", valueType: "TEXT" as const,
      beforeValue: "", afterValue: "新内容",
    }]),
    ["shot:missing.visualContent"],
    "a target that no longer exists is itself a conflict",
  );
});

test("resolving a conflict keeps both sides' untouched work in either direction", () => {
  const base = emptyV04DraftPayload();
  base.factsAndCoreJudgement.commercialIntent = "原意图";

  const local = structuredClone(base);
  local.factsAndCoreJudgement.commercialIntent = "我的意图";
  local.factsAndCoreJudgement.creativeMotif = "我的母题";

  const server = structuredClone(base);
  server.factsAndCoreJudgement.commercialIntent = "同事的意图";
  server.factsAndCoreJudgement.tensionButton = "同事的张力按钮";

  const conflictTargets = ["facts.commercialIntent"];
  const takeServer = planV04ConflictResolution({ server, base, local, conflictTargets, prefer: "SERVER" });
  assert.equal(takeServer.payload.factsAndCoreJudgement.commercialIntent, "同事的意图");
  assert.equal(takeServer.payload.factsAndCoreJudgement.creativeMotif, "我的母题",
    "a non-conflicting local edit survives taking the server value");
  assert.equal(takeServer.payload.factsAndCoreJudgement.tensionButton, "同事的张力按钮",
    "a server edit this page never touched is never reverted");
  assert.deepEqual(takeServer.droppedTargets, ["facts.commercialIntent"]);

  const keepLocal = planV04ConflictResolution({ server, base, local, conflictTargets, prefer: "LOCAL" });
  assert.equal(keepLocal.payload.factsAndCoreJudgement.commercialIntent, "我的意图");
  assert.equal(keepLocal.payload.factsAndCoreJudgement.creativeMotif, "我的母题");
  assert.equal(keepLocal.payload.factsAndCoreJudgement.tensionButton, "同事的张力按钮");
  assert.deepEqual(keepLocal.droppedTargets, []);
});

test("the perception path type and its detail fields resolve as one answer", () => {
  const base = emptyV04DraftPayload();
  const local = structuredClone(base);
  local.perceptionPath.primaryType = "FUN";
  local.perceptionPath.primaryDetails = { originalExpectation: "我的原始预期" };

  const server = structuredClone(base);
  server.perceptionPath.primaryType = "LOVE";
  server.perceptionPath.primaryDetails = { emotionalBase: "同事的情感底板" };

  const resolved = planV04ConflictResolution({
    server, base, local,
    conflictTargets: ["path.primaryType"],
    prefer: "SERVER",
  });
  assert.equal(resolved.payload.perceptionPath.primaryType, "LOVE");
  assert.deepEqual(resolved.payload.perceptionPath.primaryDetails, { emotionalBase: "同事的情感底板" },
    "details of a discarded path must not survive next to the server's type");
});

test("an edit whose bridge or shot the server removed is reported instead of throwing", () => {
  const base = payloadWithScript();
  const local = structuredClone(base);
  local.script.shotGroups[0].shots[1].visualContent = "我改写的第二镜";
  local.factsAndCoreJudgement.creativeMotif = "我的母题";

  const server = structuredClone(base);
  server.script.shotGroups[0].shots.splice(1, 1);

  const resolved = planV04ConflictResolution({
    server, base, local,
    conflictTargets: ["shot:shot-2.visualContent"],
    prefer: "LOCAL",
  });
  assert.deepEqual(resolved.unaddressableTargets, ["shot:shot-2.visualContent"]);
  assert.equal(resolved.payload.factsAndCoreJudgement.creativeMotif, "我的母题",
    "the replayable part of the draft still lands on the server version");
});

test("a composite conflict target is broken down to the fields that actually differ", () => {
  const server = payloadWithScript();
  const local = structuredClone(server);
  local.script.shotGroups[0].shots[0].visualContent = "我改写的门灯";
  local.script.shotGroups[0].shots.push({
    id: "shot-3", orderIndex: 2, ...SHOT_FIELDS, visualContent: "我新增的镜头",
  });

  const summary = summarizeV04ConflictDifferences(
    "script.structure",
    server.script.shotGroups,
    local.script.shotGroups,
  );
  const paths = summary.differences.map((difference) => difference.path);
  assert.equal(summary.differences.length, 2,
    "only the leaves that disagree are listed, not the whole script");
  assert(paths.some((path) => path.includes("画面内容")), "a changed shot field is named in Chinese");
  assert(paths.some((path) => path.includes("镜头 3")), "a shot only one side has is listed too");
  const changed = summary.differences.find((difference) => difference.path.includes("画面内容"));
  assert.equal(changed?.serverText, "雨夜的门灯");
  assert.equal(changed?.localText, "我改写的门灯");

  const primaryDetails = summarizeV04ConflictDifferences(
    "path.primaryDetails",
    { emotionalBase: "服务器底板" },
    { emotionalBase: "本地底板" },
  );
  assert.deepEqual(primaryDetails.differences, [{
    path: "情感底板", serverText: "服务器底板", localText: "本地底板",
  }]);
});
