import assert from "node:assert/strict";
import test from "node:test";
import {
  applyV04ChangeSet,
  applyV04ChangeSetLastWriteWins,
  emptyV04ChoiceValue,
  emptyV04DraftPayload,
} from "../lib/v04-domain.ts";
import type { V04Change, V04DraftPayloadV1 } from "../lib/v04-contract.ts";

function payloadWithShot(): V04DraftPayloadV1 {
  const payload = emptyV04DraftPayload();
  payload.script.shotGroups.push({
    id: "bridge-1",
    orderIndex: 0,
    bridgeName: "乱世重逢",
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "",
    shots: [{
      id: "shot-1",
      orderIndex: 0,
      startTime: "00:00",
      endTime: "00:04",
      shotScale: "",
      cameraAngle: "",
      cameraMovement: "",
      visualContent: "码头",
      screenCopy: "",
      subtitleEffect: "",
      dialogue: "",
      voiceOver: "",
      soundEffect: "",
      music: "",
    }],
  });
  return payload;
}

const change = (targetKey: string, beforeValue: unknown, afterValue: unknown): V04Change => ({
  targetKey,
  targetLabel: targetKey,
  valueType: "TEXT",
  beforeValue,
  afterValue,
});

test("a stale before-value never costs the editor the keystroke they just made", () => {
  const payload = payloadWithShot();
  // The stored value moved on (a second tab of the same editor saved first),
  // so the recorded before-value no longer matches.
  const stale = [change("shot:shot-1.visualContent", "旧的画面", "雨夜码头")];

  assert.throws(() => applyV04ChangeSet(payload, stale), /REVISION_CONFLICT/);

  const result = applyV04ChangeSetLastWriteWins(payload, stale);
  assert.equal(result.payload.script.shotGroups[0].shots[0].visualContent, "雨夜码头");
  assert.deepEqual(result.skippedTargets, []);
  assert.equal(result.appliedChanges.length, 1);
  assert.equal(payload.script.shotGroups[0].shots[0].visualContent, "码头", "input stays untouched");
});

test("a target whose shot was removed is reported instead of failing the whole save", () => {
  const payload = payloadWithShot();
  const changes = [
    change("shot:shot-1.visualContent", "码头", "雨夜码头"),
    change("shot:shot-gone.visualContent", "", "写给已删除镜头"),
    change("facts.commercialIntent", "", "把手表定义为爱情信物"),
  ];

  const result = applyV04ChangeSetLastWriteWins(payload, changes);

  assert.deepEqual(result.skippedTargets, ["shot:shot-gone.visualContent"]);
  assert.equal(result.appliedChanges.length, 2, "the two live targets still land");
  assert.equal(result.payload.script.shotGroups[0].shots[0].visualContent, "雨夜码头");
  assert.equal(result.payload.factsAndCoreJudgement.commercialIntent, "把手表定义为爱情信物");
});

test("applied changes are exactly the ones an audit trail should record", () => {
  const payload = payloadWithShot();
  const result = applyV04ChangeSetLastWriteWins(payload, [
    change("shot:shot-gone.dialogue", "", "无处可写"),
    change("facts.storySynopsis", "", "战乱年代的聚散"),
  ]);

  assert.deepEqual(
    result.appliedChanges.map((item) => item.targetKey),
    ["facts.storySynopsis"],
  );
  assert.equal(result.skippedTargets.length, 1);
});
