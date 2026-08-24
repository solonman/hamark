import assert from "node:assert/strict";
import test from "node:test";
import { emptyV04DraftPayload } from "../lib/v04-domain.ts";
import { v04PayloadToUiDraft, v04UiDraftToPayload } from "../lib/v04-ui-model.ts";
import { preserveV19UntouchedPerceptionPath } from "../lib/v19-ui-model.ts";
import type { V04DraftPayloadV1 } from "../lib/v04-contract.ts";

function roundTrip(payload: V04DraftPayloadV1): V04DraftPayloadV1 {
  return v04UiDraftToPayload(v04PayloadToUiDraft(payload), payload);
}

test("the draft round-trip alone would invent a perception type nobody chose", () => {
  const unset = emptyV04DraftPayload();
  assert.equal(unset.perceptionPath.primaryType, "");
  // This is the behaviour being guarded against, stated plainly: the UI draft
  // has no representation for 未选择, so the round-trip fills one in.
  assert.equal(roundTrip(unset).perceptionPath.primaryType, "LOVE");
});

test("an untouched perception path stays unset through an autosave", () => {
  const unset = emptyV04DraftPayload();
  const saved = preserveV19UntouchedPerceptionPath(roundTrip(unset), unset);

  assert.equal(saved.perceptionPath.primaryType, "");
  assert.deepEqual(saved.perceptionPath.primaryDetails, {});
  assert.deepEqual(saved.perceptionPath.auxiliaryTypes, []);
});

test("editing an unrelated field never writes a perception type", () => {
  const before = emptyV04DraftPayload();
  const draft = v04PayloadToUiDraft(before);
  draft.commercialIntent = "把手表重新定义为爱情信物";

  const saved = preserveV19UntouchedPerceptionPath(v04UiDraftToPayload(draft, before), before);

  assert.equal(saved.factsAndCoreJudgement.commercialIntent, "把手表重新定义为爱情信物");
  assert.equal(saved.perceptionPath.primaryType, "", "the unrelated edit must not answer module 3");
});

test("a path becomes real as soon as it carries an answer", () => {
  const before = emptyV04DraftPayload();
  const draft = v04PayloadToUiDraft(before);
  draft.primaryPath = "FUN";
  draft.primaryPathAnswers.FUN[0] = "原本以为只是一次普通通勤";

  const saved = preserveV19UntouchedPerceptionPath(v04UiDraftToPayload(draft, before), before);

  assert.equal(saved.perceptionPath.primaryType, "FUN");
  assert.equal(
    Object.values(saved.perceptionPath.primaryDetails).some((value) => value.trim().length > 0),
    true,
  );
});

test("an auxiliary path alone also makes the answer real", () => {
  const before = emptyV04DraftPayload();
  const draft = v04PayloadToUiDraft(before);
  draft.auxiliaryPaths = ["PERCEPTION"];
  draft.auxiliaryPathDetails.PERCEPTION = { description: "雨声骤静", role: "放大情感峰值" };

  const saved = preserveV19UntouchedPerceptionPath(v04UiDraftToPayload(draft, before), before);

  assert.equal(saved.perceptionPath.primaryType, "LOVE");
  assert.equal(saved.perceptionPath.auxiliaryTypes.length, 1);
});

test("a path already chosen is never rewritten or cleared", () => {
  const before = emptyV04DraftPayload();
  before.perceptionPath.primaryType = "PERCEPTION";
  const draft = v04PayloadToUiDraft(before);
  draft.commercialIntent = "无关字段的编辑";

  const saved = preserveV19UntouchedPerceptionPath(v04UiDraftToPayload(draft, before), before);

  assert.equal(saved.perceptionPath.primaryType, "PERCEPTION");
});
