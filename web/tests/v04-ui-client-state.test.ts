import assert from "node:assert/strict";
import test from "node:test";
import { cloneV04UiDraft } from "../lib/v04-ui-model.ts";
import { V04_UI_CASES } from "../lib/v04-ui-fixture.ts";
import { V04_VOCABULARY_VERSION } from "../lib/v04-contract.ts";
import { deriveV04UiWorkState, evaluateV04FixturePublication, matchesV04LibraryQuery, moveV04Shot, nextV04Timecode, numberedV04Shots } from "../lib/v04-ui-client-state.ts";

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
});
