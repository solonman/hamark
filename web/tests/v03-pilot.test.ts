import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import { validateAnnotation } from "../lib/annotation-validation.ts";
import type { AnnotationDraft } from "../lib/types.ts";

function completeV03(): AnnotationDraft {
  const draft = emptyAnnotation("video_1", "试点成员", "V0.3-PILOT");
  const groupId = "group_1";
  return {
    ...draft,
    analysisTitle: "V0.3 完整作业",
    commercialIntent: "让离家者重新认识归属感",
    creativeTheme: "每一次归来都是被接住",
    synopsis: "人物回家，最终被熟悉的关系接住。",
    thinkingChain: "从归属需求到关系按钮，再落到品牌陪伴。",
    summary: "母题、按钮、情感累积与品牌落点形成同一结构。",
    shotGroups: [{
      id: groupId,
      orderIndex: 0,
      title: "归来",
      primaryRole: "建立人物／关系",
      auxiliaryRoles: [],
      customRole: "",
      note: "建立人物与家的关系。",
    }],
    shots: [{
      id: "shot_1",
      orderIndex: 0,
      groupName: "归来",
      shotGroupId: groupId,
      shotNumber: "1",
      startTime: "",
      endTime: "",
      shotSize: "远景",
      cameraAngle: "平视",
      cameraMovement: "跟拍",
      visualContent: "车辆驶入庭院。",
      dialogue: "",
      voiceover: "",
      screenText: "",
      soundEffect: "",
      music: "",
      creativeComment: "",
    }],
    creativeStructure: {
      ...draft.creativeStructure!,
      creativeButton: "用家的反应把车辆的“到达”重新定义为“被接住”。",
      mechanismStatement: "通过连续累积熟悉关系，在归来时完成情感释放。",
      mechanismPrimary: "重复积累",
      realizationSkeleton: "离开—归途—家的反应—品牌进入。",
      brandProductLanding: "汽车是承载归来和家庭重连的具体载体。",
      storyReferenceType: "离别重逢",
      storyArchetype: "回归",
      primaryCreativePath: "LOVE",
      compositeStateReason: "拿掉情感累积创意会坍塌，其他表达只起增强作用。",
      formationPrimary: "CROSS_GROUP_ACCUMULATION",
      formationStatement: "创意由关系细节跨段累积，在结尾完成释放。",
      creativeCarriers: "归家动作、家人反应与车辆。",
      establishmentConditions: "观众能识别离开与归来的情感价值。",
      strengthSources: "表演细节、节奏和音乐的递进。",
      creativeGrade: "A",
      creativeGradeReason: "按钮清晰，品牌连接自然，但机制新鲜度仍可增强。",
      mainPathPayload: {
        emotionalBase: "家庭归属",
        emotionalAccumulation: "用多个日常细节递进。",
        emotionalGap: "离开导致的缺席。",
        emotionalRelease: "在归来时被家人的行动接住。",
        loveMainCarrier: "家人的关系反应。",
      },
    },
  };
}

test("V0.3 complete vertical draft publishes without requiring all 19 legacy answers", () => {
  const draft = completeV03();
  assert.deepEqual(validateAnnotation(draft), []);
  assert.ok(draft.fields.every((field) => field.answer === ""));
  assert.ok(draft.shots.every((shot) => !shot.startTime && !shot.endTime));
});

test("V0.3 validation requires bridge roles and path facts but not timecodes", () => {
  const draft = completeV03();
  draft.shotGroups![0].primaryRole = "";
  draft.creativeStructure!.mainPathPayload.emotionalBase = "";
  const blockers = validateAnnotation(draft);
  assert.ok(blockers.includes("桥段 1 主创意作用"));
  assert.ok(blockers.includes("主导路径·情感底板"));
  assert.ok(!blockers.some((blocker) => blocker.includes("时间")));
  assert.ok(!blockers.some((blocker) => /^A\d|^B\d/.test(blocker)));
});

test("V0.3 schema isolates versions without modifying snapshot payloads", async () => {
  const migration = await readFile(
    new URL("../db/migrations/2026-08-12-v03-pilot.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /annotations_video_author_taxonomy_idx/);
  assert.match(migration, /video_id, author_email, taxonomy_version/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS shot_groups/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS annotation_creative_structures/);
  assert.doesNotMatch(migration, /UPDATE\s+annotation_snapshots/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+annotation_snapshots/i);
});

test("V0.3 worksheet exposes the approved four-module order and version switch", async () => {
  const [practice, analysis, shotEditor] = await Promise.all([
    readFile(new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/V03AnalysisEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/V03ShotGroupEditor.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(practice, /01 逐镜脚本还原/);
  assert.match(analysis, /02.*全片事实与核心判断/s);
  assert.match(analysis, /03.*主导类型发生路径/s);
  assert.match(analysis, /04.*S／A／B／C 自评/s);
  assert.match(shotEditor, /桥段创意作用/);
  assert.match(shotEditor, /可选 0—2 项/);
  assert.match(practice, /V0\.3 试点/);
  assert.match(practice, /V0\.2 原版/);
});
