import assert from "node:assert/strict";
import test from "node:test";
import {
  applyV04ChangeSet,
  canonicalV04ChangeSet,
  decideV04ChangeSet,
  deriveV04WorkflowState,
  emptyV04DraftPayload,
  hashV04Payload,
  validateV04Publication,
} from "../lib/v04-domain.ts";
import type { V04Change } from "../lib/v04-contract.ts";

test("V0.4 five states use only draft and immutable submission facts", () => {
  const base = {
    currentDraftRevision: 0,
    currentDraftContentHash: "draft",
    latestSubmissionSourceRevision: null,
    latestSubmissionContentHash: null,
  };
  assert.equal(deriveV04WorkflowState({ ...base, hasAnyDraftData: false, successfulSubmissionCount: 0 }), "NOT_STARTED");
  assert.equal(deriveV04WorkflowState({ ...base, hasAnyDraftData: true, successfulSubmissionCount: 0 }), "INCOMPLETE");
  assert.equal(deriveV04WorkflowState({ ...base, hasAnyDraftData: true, successfulSubmissionCount: 1,
    latestSubmissionContentHash: "draft", latestSubmissionSourceRevision: 1 }), "SUBMITTED");
  assert.equal(deriveV04WorkflowState({ ...base, hasAnyDraftData: true, successfulSubmissionCount: 1,
    latestSubmissionContentHash: "old", latestSubmissionSourceRevision: 1 }), "MODIFIED_UNSUBMITTED");
  assert.equal(deriveV04WorkflowState({ ...base, hasAnyDraftData: true, successfulSubmissionCount: 2,
    latestSubmissionContentHash: "draft", latestSubmissionSourceRevision: 2 }), "MODIFICATION_SUBMITTED");
});

test("publication validator returns structured missing targets and accepts fixed/custom combinations", () => {
  const payload = emptyV04DraftPayload();
  const missing = validateV04Publication(payload);
  assert.equal(missing.publicationReady, false);
  assert(missing.missingItems.every((item) => item.moduleKey && item.scopeId && item.fieldKey && item.targetKey));
  assert(missing.missingItems.some((item) => item.targetKey === "script.shotGroups"));

  payload.script.shotGroups.push({
    id: "group-1", orderIndex: 0, bridgeName: "建立",
    primaryCreativeRole: { ...payload.factsAndCoreJudgement.mainMechanism, customText: "自定义作用" },
    auxiliaryCreativeRole: { ...payload.factsAndCoreJudgement.auxiliaryMechanism },
    keyCreativeDescription: "作用说明",
    shots: [{
      id: "shot-1", orderIndex: 0, startTime: "00:00", endTime: "00:01",
      shotScale: "近景", cameraAngle: "平视", cameraMovement: "固定", visualContent: "人物入场",
      screenCopy: "", subtitleEffect: "", dialogue: "", voiceOver: "", soundEffect: "", music: "",
    }],
  });
  Object.assign(payload.factsAndCoreJudgement, {
    commercialIntent: "品牌回家", storySynopsis: "回家", creativeMotif: "归属",
    tensionButton: "离开与返回", creativeThinkingChain: "从离开推到重逢",
    carrierExplanation: "故事承重", acceptanceContract: "真实生活",
    ratingReason: "完整", overallCreativeRating: "A", creativeCarriers: ["STORY"],
    mainMechanism: { ...payload.factsAndCoreJudgement.mainMechanism, customText: "自定义形成" },
    storyReference: { ...payload.factsAndCoreJudgement.storyReference, selectedOptionIds: ["FAMILY_AFFECTION"] },
  });
  payload.perceptionPath.primaryType = "LOVE";
  payload.perceptionPath.primaryDetails = {
    emotionalBase: "思念", accumulation: "反复", gapPressure: "分离",
    releaseMethod: "重逢", mainCarrier: "故事",
  };
  assert.equal(validateV04Publication(payload).publicationReady, true);

  payload.factsAndCoreJudgement.mainMechanism = {
    ...payload.factsAndCoreJudgement.mainMechanism,
    selectedOptionIds: ["PENDING_NEW_MECHANISM"], customText: "", advancedText: "",
  };
  assert(validateV04Publication(payload).missingItems.some(
    (item) => item.targetKey === "facts.mainMechanism.advancedText",
  ));
});

test("payload contract enforces fixed choice limits, vocabulary IDs and mutual exclusion", () => {
  const payload = emptyV04DraftPayload();
  payload.factsAndCoreJudgement.mainMechanism.selectedOptionIds = ["INSIGHT_RESONANCE"];
  payload.factsAndCoreJudgement.auxiliaryMechanism.selectedOptionIds = ["INSIGHT_RESONANCE"];
  assert.throws(() => validateV04Publication(payload), /CHOICE_RULE_VIOLATION/);
  payload.factsAndCoreJudgement.auxiliaryMechanism.selectedOptionIds = ["NOT_IN_VOCABULARY"];
  assert.throws(() => validateV04Publication(payload), /CHOICE_RULE_VIOLATION/);
});

test("change-set rebases only disjoint stable targets and applies exact before values", () => {
  const local: V04Change[] = [{
    targetKey: "facts.commercialIntent", targetLabel: "商业意图", valueType: "TEXT",
    beforeValue: "", afterValue: "新意图",
  }];
  assert.equal(decideV04ChangeSet(1, 1, local, []).kind, "APPLY");
  assert.equal(decideV04ChangeSet(1, 2, local, [{
    targetKey: "facts.storySynopsis", valueType: "TEXT",
  }]).kind, "REBASE");
  assert.equal(decideV04ChangeSet(1, 2, local, [{
    targetKey: "facts.commercialIntent", valueType: "TEXT",
  }]).kind, "CONFLICT");
  assert.equal(decideV04ChangeSet(1, 2, local, [{
    targetKey: "script.structure", valueType: "STRUCTURE",
  }]).kind, "CONFLICT");

  const payload = emptyV04DraftPayload();
  const next = applyV04ChangeSet(payload, local);
  assert.equal(next.factsAndCoreJudgement.commercialIntent, "新意图");
  assert.notEqual(hashV04Payload(payload), hashV04Payload(next));
  assert.throws(() => applyV04ChangeSet(next, local), /REVISION_CONFLICT/);
  assert.equal(canonicalV04ChangeSet(local), canonicalV04ChangeSet([...local].reverse()));
  assert.throws(() => canonicalV04ChangeSet([...local, { ...local[0] }]), /DUPLICATE_CHANGE_TARGET/);
});
