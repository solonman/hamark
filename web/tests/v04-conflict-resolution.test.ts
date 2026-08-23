import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyV04ChoiceValue,
  emptyV04DraftPayload,
  summarizeV04PayloadContent,
  v04ValueConflictTargets,
} from "../lib/v04-domain.ts";
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

test("a history version says what it holds before it can replace the draft", async () => {
  const { describeV04ContentSummary, describeV04RestoreLoss } =
    await import("../lib/v04-history-versions.ts");

  const empty = summarizeV04PayloadContent(emptyV04DraftPayload());
  assert.deepEqual(empty, { bridgeCount: 0, shotCount: 0, filledFieldCount: 0, empty: true });
  assert.match(describeV04ContentSummary(empty), /空白版本/,
    "an empty initial baseline must never look like a full version in the list");

  const filled = payloadWithScript();
  filled.factsAndCoreJudgement.commercialIntent = "商业意图";
  filled.perceptionPath.primaryType = "LOVE";
  const summary = summarizeV04PayloadContent(filled);
  assert.equal(summary.bridgeCount, 1);
  assert.equal(summary.shotCount, 2);
  assert.equal(summary.filledFieldCount, 5, "bridge name, two shot lines, one fact and the path type");
  assert.equal(summary.empty, false);
  assert.match(describeV04ContentSummary(summary), /1 个桥段 · 2 个镜头 · 5 项已填/);
  assert.match(describeV04ContentSummary(null), /未读取/);

  assert.match(describeV04RestoreLoss(summary, empty), /少 1 个桥段、2 个镜头、5 项已填内容/,
    "restoring a smaller version must state what it would take away first");
  assert.equal(describeV04RestoreLoss(empty, summary), "",
    "restoring a richer version needs no loss warning");
  assert.equal(describeV04RestoreLoss(summary, null), "");
});

test("history events are ordered by the instant they happened, not by their raw timestamp text", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/v04-read-models.ts", import.meta.url), "utf8");
  const history = source.slice(source.indexOf("export async function loadV04HistoryReadModel"));
  assert.doesNotMatch(history, /createdAt: String\(row\.created_at\)/,
    "driver Date objects stringify to a weekday-first form that sorts before nothing sensible");
  assert.match(history, /createdAt: isoEventTime\(row\.created_at\)/);
  assert.match(history, /toSorted\(\(left, right\) => Date\.parse\(left\.createdAt\) - Date\.parse\(right\.createdAt\)\)/);
  assert.match(history, /currentSummary: summarizeV04PayloadContent\(payload\)/,
    "the drawer compares each version against the live draft, so the live summary travels with it");
  assert.match(history, /contentSummary: contentSummaryOf\(payload_json\)/);
});

test("restoring a smaller history version takes an explicit second confirmation", async () => {
  const { readFile } = await import("node:fs/promises");
  const drawer = await readFile(
    new URL("../components/v04/V04HistoryDrawer.tsx", import.meta.url), "utf8");
  assert.match(drawer, /describeV04ContentSummary\(event\.contentSummary\)/,
    "every restorable version states its own content before it can be chosen");
  assert.match(drawer, /当前工作稿：/, "the live draft is shown for comparison");
  assert.match(drawer, /describeV04RestoreLoss\(currentSummary, event\.contentSummary\)/);
  assert.match(drawer, /if \(loss\) setConfirming\(event\.id\); else startRestore\(event\)/,
    "a content-losing restore must stop at a named warning instead of running on the first click");
  assert.match(drawer, /确认恢复此版本/);
  assert.match(drawer, /当前工作稿也会继续留在本列表中/,
    "restore is additive, and the page must say so where the decision is made");
});
