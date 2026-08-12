import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisTargetValue,
  parseAnalysisTarget,
  resolveAnchoredReplacement,
} from "../lib/analysis-targets.ts";
import type { AnnotationDraft } from "../lib/types.ts";

const draft: AnnotationDraft = {
  id: "annotation_1",
  videoId: "video_1",
  authorName: "测试作者",
  taxonomyVersion: "V0.2",
  status: "SUBMITTED",
  revision: 2,
  analysisTitle: "测试作业",
  commercialIntent: "让家庭重新连接",
  creativeTheme: "欢迎回家",
  synopsis: "一辆车带一家人回家。",
  thinkingChain: "洞察到机制再到表达",
  shotCommentary: "旧版总结",
  summary: "完整总结",
  shots: [
    {
      id: "shot_1",
      orderIndex: 0,
      groupName: "归途",
      shotNumber: "1",
      startTime: "00:00",
      endTime: "00:03",
      shotSize: "远景",
      cameraAngle: "平视",
      cameraMovement: "跟拍",
      visualContent: "车辆驶入庭院",
      dialogue: "",
      voiceover: "回家了",
      screenText: "欢迎回家",
      soundEffect: "引擎声",
      music: "钢琴",
      creativeComment: "以归家动作承接品牌承诺",
    },
  ],
  fields: [{ code: "A1", answer: "归家母题", evidence: "结尾揭示" }],
  updatedAt: "2026-08-07T00:00:00.000Z",
};

test("analysis targets resolve only supported stable content items", () => {
  assert.deepEqual(parseAnalysisTarget("core:creative-theme"), {
    scope: "annotation",
    property: "creativeTheme",
    column: "creative_theme",
  });
  assert.equal(
    analysisTargetValue(draft, "shot:shot_1:visual-content"),
    "车辆驶入庭院",
  );
  assert.equal(analysisTargetValue(draft, "field:A1:evidence"), "结尾揭示");
  assert.equal(analysisTargetValue(draft, "core:shot-commentary"), "旧版总结");
  assert.equal(parseAnalysisTarget("field:A99:answer"), null);
  assert.equal(parseAnalysisTarget("shot:shot_1:unknown"), null);
});

test("anchored revisions change only the selected occurrence", () => {
  assert.equal(
    resolveAnchoredReplacement({
      currentValue: "回家，然后再次回家",
      selectedText: "回家",
      anchorStart: 7,
      anchorEnd: 9,
      replacementText: "团聚",
    }),
    "回家，然后再次团聚",
  );
  assert.equal(
    resolveAnchoredReplacement({
      currentValue: "回家，然后再次回家",
      selectedText: "回家",
      anchorStart: 0,
      anchorEnd: 2,
      replacementText: "归来",
    }),
    "归来，然后再次回家",
  );
});

test("stale ambiguous revisions fail instead of changing the wrong text", () => {
  assert.equal(
    resolveAnchoredReplacement({
      currentValue: "回家，然后再次回家",
      selectedText: "回家",
      anchorStart: 3,
      anchorEnd: 5,
      replacementText: "团聚",
    }),
    null,
  );
  assert.equal(
    resolveAnchoredReplacement({
      currentValue: "",
      selectedText: "",
      anchorStart: 0,
      anchorEnd: 0,
      replacementText: "新增内容",
    }),
    "新增内容",
  );
});

test("V0.3 bridge and creative-structure targets remain individually revisable", () => {
  const v03: AnnotationDraft = {
    ...draft,
    taxonomyVersion: "V0.3-PILOT",
    shotGroups: [{
      id: "group_1",
      orderIndex: 0,
      title: "归来",
      primaryRole: "建立人物／关系",
      auxiliaryRoles: [],
      customRole: "",
      note: "建立归属感",
    }],
    creativeStructure: {
      creativeButton: "把到达改写为被接住",
      mechanismStatement: "",
      mechanismPrimary: "",
      mechanismAuxiliary: ["反转重释"],
      mechanismCustom: "",
      realizationSkeleton: "",
      brandProductLanding: "",
      storyReferenceType: "",
      storyArchetype: "",
      primaryCreativePath: "LOVE",
      auxiliaryCreativePaths: [],
      compositeStateReason: "",
      formationPrimary: "",
      formationAuxiliary: [],
      formationStatement: "",
      formationRelatedGroupIds: [],
      creativeCarriers: "",
      establishmentConditions: "",
      strengthSources: "",
      acceptanceContract: "",
      audiovisualMechanism: "",
      informationReleaseTurning: "",
      creativeGrade: "",
      creativeGradeReason: "",
      creativeGradeVersion: "CREATIVE-GRADE-V0.1",
      mainPathPayload: { emotionalBase: "归属" },
      auxiliaryPathNotes: {},
      conditionFlags: {
        unconventionalWorld: false,
        audiovisualCarriesIdea: false,
        interestingLoadBearing: false,
      },
    },
  };
  assert.equal(analysisTargetValue(v03, "group:group_1:note"), "建立归属感");
  assert.equal(
    analysisTargetValue(v03, "structure:creative-button"),
    "把到达改写为被接住",
  );
  assert.equal(
    analysisTargetValue(v03, "structure:main-path:emotionalBase"),
    "归属",
  );
  assert.equal(
    analysisTargetValue(v03, "structure:primary-creative-path"),
    "LOVE",
  );
  assert.deepEqual(
    analysisTargetValue(v03, "structure:mechanism-auxiliary"),
    ["反转重释"],
  );
  assert.equal(
    parseAnalysisTarget("group:group_1:primary-role")?.scope,
    "shot-group-structured",
  );
});
