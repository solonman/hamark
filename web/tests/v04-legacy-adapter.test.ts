import assert from "node:assert/strict";
import test from "node:test";
import { emptyCreativeStructure } from "../lib/taxonomy-v0.3.ts";
import type { AnnotationDraft } from "../lib/types.ts";
import {
  adaptLegacyAnnotationToV04,
  legacyAdapterIssueSummary,
} from "../lib/v04-legacy-adapter.ts";

function legacyDraft(): AnnotationDraft {
  const structure = emptyCreativeStructure();
  structure.mechanismPrimary = "重复积累";
  structure.mechanismAuxiliary = ["对比冲突", "现有词表不适用／待形成新机制"];
  structure.mechanismCustom = "通过门的开合形成新的关系机制";
  structure.storyReferenceType = "离别重逢";
  structure.primaryCreativePath = "INTERESTING";
  structure.mainPathPayload = {
    originalExpectation: "只是普通回家",
    deviation: "家门不断变化",
    reveal: "原来每次开门都跨过多年",
    reinterpretation: "回看前文才理解时间",
    interestingMainCarrier: "门",
  };
  return {
    id: "annotation-legacy",
    videoId: "video-legacy",
    authorName: "Legacy Author",
    taxonomyVersion: "V0.3-PILOT",
    workflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT",
    status: "SUBMITTED",
    revision: 7,
    analysisTitle: "旧标题",
    commercialIntent: "建立归属感",
    creativeTheme: "欢迎回家",
    synopsis: "人物在多年后回家",
    thinkingChain: "由门推导时间变化",
    shotCommentary: "",
    summary: "旧总结",
    fields: [],
    shotGroups: [{
      id: "group-legacy",
      orderIndex: 0,
      title: "桥段一",
      primaryRole: "建立人物／关系",
      auxiliaryRoles: ["累积情感"],
      customRole: "",
      note: "建立人物和家的关系",
    }],
    shots: [{
      id: "shot-legacy",
      orderIndex: 0,
      groupName: "桥段一",
      shotNumber: "1",
      startTime: "00:00",
      endTime: "00:02",
      shotSize: "近景",
      cameraAngle: "平视",
      cameraMovement: "固定",
      visualContent: "人物推开家门",
      dialogue: "",
      voiceover: "欢迎回家",
      screenText: "欢迎回家",
      soundEffect: "开门声",
      music: "钢琴",
      creativeComment: "不能推断为字幕特效",
      shotGroupId: "group-legacy",
    }],
    creativeStructure: structure,
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

test("legacy V0.3 adapter preserves stable structure and maps only approved aliases", () => {
  const source = legacyDraft();
  const before = structuredClone(source);
  const first = adaptLegacyAnnotationToV04({
    sourceObjectId: "snapshot-legacy",
    sourceWorkflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT",
    annotation: source,
  });
  const second = adaptLegacyAnnotationToV04({
    sourceObjectId: "snapshot-legacy",
    sourceWorkflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT",
    annotation: source,
  });

  assert.deepEqual(source, before, "adapter must never mutate legacy payloads");
  assert.deepEqual(second, first, "same legacy facts must produce byte-stable display evidence");
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(first.payload.script.shotGroups[0].id, "group-legacy");
  assert.equal(first.payload.script.shotGroups[0].shots[0].id, "shot-legacy");
  assert.equal(first.payload.script.shotGroups[0].shots[0].subtitleEffect, "",
    "legacy subtitle effect is always empty and never inferred");
  assert.deepEqual(first.payload.script.shotGroups[0].primaryCreativeRole.selectedOptionIds,
    ["ESTABLISH_CHARACTER_RELATIONSHIP"]);
  assert.deepEqual(first.payload.factsAndCoreJudgement.mainMechanism.selectedOptionIds,
    ["REPETITION_CHANGES_MEANING"]);
  assert.deepEqual(first.payload.factsAndCoreJudgement.auxiliaryMechanism.selectedOptionIds,
    ["JUXTAPOSITION_CREATES_MEANING", "PENDING_NEW_MECHANISM"]);
  assert.equal(first.payload.factsAndCoreJudgement.auxiliaryMechanism.advancedText,
    "通过门的开合形成新的关系机制");
  assert.deepEqual(first.payload.factsAndCoreJudgement.storyReference.selectedOptionIds,
    ["FAREWELL_REUNION"]);
  assert.equal(first.payload.perceptionPath.primaryType, "FUN");
  assert.deepEqual(first.payload.perceptionPath.primaryDetails, {
    originalExpectation: "只是普通回家",
    deviation: "家门不断变化",
    reveal: "原来每次开门都跨过多年",
    reinterpretation: "回看前文才理解时间",
    mainCarrier: "门",
  });
});

test("legacy custom and unknown values remain separate evidence and are never guessed", () => {
  const source = legacyDraft();
  source.shotGroups![0].primaryRole = "__CUSTOM__";
  source.shotGroups![0].customRole = "自定义桥段作用";
  source.creativeStructure!.mechanismPrimary = "未知机制标签";
  source.creativeStructure!.mechanismCustom = "人类保留说明";
  source.creativeStructure!.storyReferenceType = "其他（自定义参照类型）";
  const result = adaptLegacyAnnotationToV04({
    sourceObjectId: "snapshot-custom",
    sourceWorkflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT",
    annotation: source,
  });

  const groupChoice = result.payload.script.shotGroups[0].primaryCreativeRole;
  assert.deepEqual(groupChoice.selectedOptionIds, []);
  assert.equal(groupChoice.customText, "自定义桥段作用");
  const mechanism = result.payload.factsAndCoreJudgement.mainMechanism;
  assert.deepEqual(mechanism.selectedOptionIds, []);
  assert.equal(mechanism.customText, "人类保留说明");
  assert.deepEqual(mechanism.legacyRawValue, {
    rawValues: ["未知机制标签"],
    customText: "人类保留说明",
    advancedText: "",
  });
  assert.deepEqual(result.payload.factsAndCoreJudgement.storyReference.selectedOptionIds, []);
  assert.equal(result.payload.factsAndCoreJudgement.storyReference.customText, "");
  const summary = legacyAdapterIssueSummary([result]);
  assert.equal(summary.byType.UNKNOWN_LEGACY_CHOICE, 1);
  assert.equal(summary.byType.CUSTOM_MARKER_WITHOUT_TEXT, 1);
});

test("legacy V0.2 adapter derives contiguous groups without inventing fixed choices", () => {
  const source = legacyDraft();
  source.taxonomyVersion = "V0.2";
  source.workflowVersion = "REVERSE-WORKFLOW-V0.2";
  source.shotGroups = undefined;
  source.creativeStructure = undefined;
  source.shots.push({
    ...source.shots[0], id: "shot-second", orderIndex: 1, shotGroupId: null,
  });
  source.fields = [
    { code: "A2", answer: "隐喻转译", evidence: "" },
    { code: "B2", answer: "家庭亲情", evidence: "" },
  ];
  const result = adaptLegacyAnnotationToV04({
    sourceObjectId: "snapshot-v02",
    sourceWorkflowVersion: "REVERSE-WORKFLOW-V0.2",
    annotation: source,
  });
  assert.equal(result.payload.script.shotGroups.length, 1);
  assert.equal(result.payload.script.shotGroups[0].shots.length, 2);
  assert.deepEqual(result.payload.script.shotGroups[0].primaryCreativeRole.selectedOptionIds, []);
  assert.deepEqual(result.payload.factsAndCoreJudgement.mainMechanism.selectedOptionIds,
    ["METAPHOR_TRANSLATION"]);
  assert.deepEqual(result.payload.factsAndCoreJudgement.storyReference.selectedOptionIds,
    ["FAMILY_AFFECTION"]);
  assert(result.payload.script.shotGroups[0].shots.every((shot) => shot.subtitleEffect === ""));
});
