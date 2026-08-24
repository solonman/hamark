import assert from "node:assert/strict";
import test from "node:test";
import { describeV19Diff, diffV19AgainstBase } from "../lib/v19-base-diff.ts";
import { emptyV04ChoiceValue, emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1, V04ShotPayload } from "../lib/v04-contract.ts";

function blankShot(id: string, orderIndex: number): V04ShotPayload {
  return {
    id, orderIndex, startTime: "", endTime: "", shotScale: "", cameraAngle: "",
    cameraMovement: "", visualContent: "", screenCopy: "", subtitleEffect: "",
    dialogue: "", voiceOver: "", soundEffect: "", music: "",
  };
}

function fixturePayload(): V04DraftPayloadV1 {
  const payload = emptyV04DraftPayload();
  payload.script.shotGroups.push({
    id: "group-1", orderIndex: 0, bridgeName: "建立",
    primaryCreativeRole: { ...emptyV04ChoiceValue(), selectedOptionIds: ["INSIGHT_RESONANCE"] },
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "作用说明",
    shots: [
      { ...blankShot("shot-1", 0), startTime: "00:00", endTime: "00:04", visualContent: "人物入场" },
      { ...blankShot("shot-2", 1), startTime: "00:05", endTime: "00:09", visualContent: "环境展示" },
    ],
  });
  payload.factsAndCoreJudgement.commercialIntent = "品牌回家";
  payload.factsAndCoreJudgement.storySynopsis = "回家";
  return payload;
}

test("diffV19AgainstBase returns null when there is no base", () => {
  assert.equal(diffV19AgainstBase(fixturePayload(), null), null);
});

test("diffV19AgainstBase reports zero counts for an unchanged payload", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  const diff = diffV19AgainstBase(current, base);
  assert.ok(diff);
  assert.equal(diff!.counts.changedFields, 0);
  assert.equal(diff!.counts.newShots, 0);
  assert.equal(diff!.counts.newBridges, 0);
  assert.equal(diff!.changedFields.size, 0);
  assert.equal(diff!.newShotIds.size, 0);
  assert.equal(diff!.newBridgeIds.size, 0);
});

test("diffV19AgainstBase reports a changed text field with the BASE value under the stable key", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  current.factsAndCoreJudgement.commercialIntent = "全新意图";
  const diff = diffV19AgainstBase(current, base);
  assert.ok(diff);
  assert.equal(diff!.counts.changedFields, 1);
  assert.equal(diff!.changedFields.get("facts.commercialIntent"), "品牌回家");
});

test("diffV19AgainstBase detects a changed choice value regardless of key order", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  const group = current.script.shotGroups[0];
  // Same logical value as base's primaryCreativeRole, but rebuilt with keys
  // in a different order plus one real change (extra selected option).
  group.primaryCreativeRole = {
    vocabularyVersion: base.script.shotGroups[0].primaryCreativeRole.vocabularyVersion,
    customText: "",
    selectedOptionIds: ["INSIGHT_RESONANCE", "STRUCTURAL_SURPRISE"],
    advancedText: "",
  };
  const diff = diffV19AgainstBase(current, base);
  assert.ok(diff);
  assert.equal(diff!.counts.changedFields, 1);
  assert.deepEqual(
    diff!.changedFields.get("shotGroup:group-1.primaryCreativeRole"),
    base.script.shotGroups[0].primaryCreativeRole,
  );
});

test("diffV19AgainstBase does not flag a choice value whose keys are merely reordered", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  const original = current.script.shotGroups[0].primaryCreativeRole;
  current.script.shotGroups[0].primaryCreativeRole = {
    advancedText: original.advancedText,
    customText: original.customText,
    vocabularyVersion: original.vocabularyVersion,
    selectedOptionIds: [...original.selectedOptionIds],
  };
  const diff = diffV19AgainstBase(current, base);
  assert.ok(diff);
  assert.equal(diff!.counts.changedFields, 0);
});

test("diffV19AgainstBase counts a brand-new bridge once, with its shots as new, and does not also list its fields as changed", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  current.script.shotGroups.push({
    id: "group-2", orderIndex: 1, bridgeName: "转折",
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "新桥段说明",
    shots: [
      { ...blankShot("shot-3", 0), startTime: "00:10", endTime: "00:14", visualContent: "反转出现" },
    ],
  });
  const diff = diffV19AgainstBase(current, base);
  assert.ok(diff);
  assert.equal(diff!.counts.newBridges, 1);
  assert.equal(diff!.counts.newShots, 1);
  assert.equal(diff!.counts.changedFields, 0);
  assert.ok(diff!.newBridgeIds.has("group-2"));
  assert.ok(diff!.newShotIds.has("shot-3"));
  for (const key of diff!.changedFields.keys()) {
    assert.ok(!key.startsWith("shotGroup:group-2."));
    assert.ok(!key.startsWith("shot:shot-3."));
  }
});

test("diffV19AgainstBase counts a brand-new shot inside an existing bridge as new, not changed", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  current.script.shotGroups[0].shots.push({
    ...blankShot("shot-3", 2), startTime: "00:10", endTime: "00:14", visualContent: "新增镜头",
  });
  const diff = diffV19AgainstBase(current, base);
  assert.ok(diff);
  assert.equal(diff!.counts.newBridges, 0);
  assert.equal(diff!.counts.newShots, 1);
  assert.equal(diff!.counts.changedFields, 0);
  assert.ok(diff!.newShotIds.has("shot-3"));
  for (const key of diff!.changedFields.keys()) {
    assert.ok(!key.startsWith("shot:shot-3."));
  }
});

test("describeV19Diff renders the Chinese summary, and empty string for a null diff", () => {
  const base = fixturePayload();
  const current = structuredClone(base);
  current.factsAndCoreJudgement.commercialIntent = "全新意图";
  current.script.shotGroups.push({
    id: "group-2", orderIndex: 1, bridgeName: "转折",
    primaryCreativeRole: emptyV04ChoiceValue(),
    auxiliaryCreativeRole: emptyV04ChoiceValue(),
    keyCreativeDescription: "新桥段说明",
    shots: [{ ...blankShot("shot-3", 0), startTime: "00:10", endTime: "00:14" }],
  });
  const diff = diffV19AgainstBase(current, base);
  assert.equal(describeV19Diff(diff), "相比基版：修改 1 项 · 新增 1 个镜头 · 新增 1 个桥段");
  assert.equal(describeV19Diff(null), "");
});
