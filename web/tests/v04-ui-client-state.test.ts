import assert from "node:assert/strict";
import test from "node:test";
import { cloneV04UiDraft } from "../lib/v04-ui-model.ts";
import { v04UiDraftToPayload } from "../lib/v04-ui-model.ts";
import { V04_UI_CASES, V04_UI_PATHS } from "../lib/v04-ui-fixture.ts";
import { V04_VOCABULARY_VERSION } from "../lib/v04-contract.ts";
import { validateV04Publication } from "../lib/v04-domain.ts";
import { deriveV04UiWorkState, evaluateV04FixturePublication, listV04WorkspaceTargetIds, matchesV04LibraryQuery, moveV04Shot, nextV04Timecode, numberedV04Shots, v04StableTargetToDomId } from "../lib/v04-ui-client-state.ts";

test("five workflow labels derive only from draft and immutable submission facts", () => {
  assert.equal(deriveV04UiWorkState({ hasAnyDraftData: false, successfulSubmissionCount: 0, hasUnsubmittedChanges: false }), "NOT_STARTED");
  assert.equal(deriveV04UiWorkState({ hasAnyDraftData: true, successfulSubmissionCount: 0, hasUnsubmittedChanges: true }), "INCOMPLETE");
  assert.equal(deriveV04UiWorkState({ hasAnyDraftData: true, successfulSubmissionCount: 1, hasUnsubmittedChanges: false }), "SUBMITTED");
  assert.equal(deriveV04UiWorkState({ hasAnyDraftData: true, successfulSubmissionCount: 1, hasUnsubmittedChanges: true }), "MODIFIED_UNSUBMITTED");
  assert.equal(deriveV04UiWorkState({ hasAnyDraftData: true, successfulSubmissionCount: 2, hasUnsubmittedChanges: false }), "MODIFICATION_SUBMITTED");
});

test("search is NFKC and composition-safe caller can retain committed query", () => {
  assert.equal(matchesV04LibraryQuery(V04_UI_CASES[0], "ＭＩＴＳＵＢＩＳＨＩ"), true);
  assert.equal(matchesV04LibraryQuery(V04_UI_CASES[0], "家庭"), true);
  assert.equal(matchesV04LibraryQuery(V04_UI_CASES[0], "不存在"), false);
});

test("shot numbering, time carry and movement preserve stable ids", () => {
  const groups = cloneV04UiDraft(V04_UI_CASES[0].draft).shotGroups;
  assert.deepEqual(numberedV04Shots(groups).map((item) => item.displayNumber), [1, 2, 3]);
  assert.equal(nextV04Timecode("00:59"), "01:00");
  assert.equal(nextV04Timecode("bad"), "");
  const moved = moveV04Shot(groups, "shot-aurora-03", "bridge-aurora-01", 1);
  assert.deepEqual(numberedV04Shots(moved).map((item) => item.stableId), ["shot-aurora-01", "shot-aurora-03", "shot-aurora-02"]);
});

test("fixed-only, custom-only, combined and pending mechanism publication rules", () => {
  const fixed = cloneV04UiDraft(V04_UI_CASES[0].draft);
  assert.equal(evaluateV04FixturePublication(fixed).ready, true);
  const custom = cloneV04UiDraft(fixed);
  custom.storyReference = { selectedOptionIds: [], customText: "自定义参照", vocabularyVersion: V04_VOCABULARY_VERSION };
  assert.equal(evaluateV04FixturePublication(custom).ready, true);
  const combined = cloneV04UiDraft(fixed);
  combined.storyReference.customText = "额外参照";
  assert.equal(evaluateV04FixturePublication(combined).ready, true);
  const pending = cloneV04UiDraft(fixed);
  pending.primaryMechanism = { selectedOptionIds: ["PENDING_NEW_MECHANISM"], customText: "", advancedText: "", vocabularyVersion: V04_VOCABULARY_VERSION };
  const result = evaluateV04FixturePublication(pending);
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.id === "field-primaryMechanism-advanced"));
  const workspaceTargets = listV04WorkspaceTargetIds(pending);
  assert.ok(result.missing.every((item) => workspaceTargets.has(item.id)), "every missing item points to a rendered workspace target");
});

test("bridge creative description remains optional and does not enter publication count", () => {
  const draft = cloneV04UiDraft(V04_UI_CASES[0].draft);
  const before = evaluateV04FixturePublication(draft);
  draft.shotGroups.forEach((group) => { group.creativeDescription = ""; });
  const after = evaluateV04FixturePublication(draft);
  assert.equal(after.ready, before.ready);
  assert.deepEqual(after.missing, before.missing);
});

test("approved perception labels stay bound to the existing backend keys", () => {
  assert.deepEqual(V04_UI_PATHS.map((path) => path.fields), [
    ["情感底板", "情感如何累积", "情感缺口／压力", "情感释放方式", "主要承重元素"],
    ["原始预期", "偏离／异常", "揭示／反转", "重新理解", "主要承重元素"],
    ["感知规则／装置", "重复与变化", "音画／文画关系", "高潮／兑现方式", "主要承重元素"],
  ]);
});

test("advanced mechanism comments and pending items resolve to their real stable controls", () => {
  assert.equal(v04StableTargetToDomId("facts.mainMechanism.advancedText"), "field-primaryMechanism-advanced");
  assert.equal(v04StableTargetToDomId("facts.auxiliaryMechanism.advancedText"), "field-auxiliaryMechanism-advanced");
  assert.equal(v04StableTargetToDomId("facts.mainMechanism"), "field-primaryMechanism");
});

test("client publication gate matches server for zero groups, pending auxiliary mechanism and auxiliary path details", () => {
  const variants = [
    (draft: typeof V04_UI_CASES[number]["draft"]) => { draft.shotGroups = []; },
    (draft: typeof V04_UI_CASES[number]["draft"]) => { draft.auxiliaryMechanism = { selectedOptionIds: ["PENDING_NEW_MECHANISM"], customText: "", advancedText: "", vocabularyVersion: V04_VOCABULARY_VERSION }; },
    (draft: typeof V04_UI_CASES[number]["draft"]) => { draft.auxiliaryPaths = ["FUN"]; draft.auxiliaryPathDetails.FUN = { description: "", role: "" }; },
  ];
  for (const mutate of variants) {
    const draft = cloneV04UiDraft(V04_UI_CASES[0].draft);
    mutate(draft);
    const client = evaluateV04FixturePublication(draft);
    const server = validateV04Publication(v04UiDraftToPayload(draft));
    assert.equal(client.ready, server.publicationReady);
    assert.equal(client.ready, false);
  }
});
