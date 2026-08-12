import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analysisTargetValue } from "../lib/analysis-targets.ts";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import { validateApprovalCandidate } from "../lib/annotation-validation.ts";
import { resolveReviewEntry } from "../lib/review-entry.ts";
import {
  canonicalRevisionValue,
  materializeRevisionEvents,
  sha256Text,
  type RevisionEventRecord,
} from "../lib/review-workflow.ts";
import {
  bridgeRoles,
  formationOptions,
  mainPathFields,
  mechanismChoicesFor,
} from "../lib/taxonomy-v0.3.ts";

function validPayload() {
  const payload = emptyAnnotation("test_only_video", "TEST_ONLY 作者", "V0.3-PILOT");
  const groupId = "test_only_group";
  payload.id = "test_only_annotation";
  payload.analysisTitle = "TEST_ONLY 结构验证";
  payload.commercialIntent = "商业意图";
  payload.creativeTheme = "创意母题";
  payload.synopsis = "故事梗概";
  payload.thinkingChain = "创意思维链";
  payload.summary = "全篇创意总结";
  payload.shotGroups = [{
    id: groupId, orderIndex: 0, title: "桥段一", primaryRole: bridgeRoles[0],
    auxiliaryRoles: [bridgeRoles[1]], customRole: "", note: "说明",
  }];
  payload.shots = [{
    id: "test_only_shot", orderIndex: 0, groupName: "桥段一", shotNumber: "1",
    startTime: "", endTime: "", shotSize: "中景", cameraAngle: "平视",
    cameraMovement: "固定", visualContent: "画面内容", dialogue: "", voiceover: "",
    screenText: "", soundEffect: "", music: "", creativeComment: "桥段作用", shotGroupId: groupId,
  }];
  Object.assign(payload.creativeStructure!, {
    creativeButton: "创意按钮",
    mechanismStatement: "创意机制具体句",
    mechanismPrimary: "反转重释",
    mechanismAuxiliary: ["隐喻转译"],
    creativeRealizationPath: "创意兑现路径",
    realizationSkeleton: "创意兑现路径",
    brandProductLanding: "品牌落点",
    storyReferenceType: "故事参照",
    storyArchetype: "故事原型",
    primaryCreativePath: "LOVE",
    auxiliaryCreativePaths: ["INTERESTING"],
    compositeStateReason: "复合态判断",
    formationPrimary: formationOptions[0].value,
    formationAuxiliary: [],
    formationStatement: "全片形成说明",
    formationRelatedGroupIds: [],
    creativeCarriers: "承重载体",
    establishmentConditions: "成立条件",
    strengthSources: "强度来源",
    creativeGrade: "A",
    creativeGradeReason: "等级理由",
    mainPathPayload: Object.fromEntries(mainPathFields.LOVE.map((field) => [field.key, field.label])),
    auxiliaryPathNotes: { INTERESTING: "增强作用" },
  });
  return payload;
}

test("V0.3.3 approval validator accepts a legal candidate and reports dependent fields", () => {
  const payload = validPayload();
  assert.deepEqual(validateApprovalCandidate(payload), []);
  payload.creativeStructure!.auxiliaryCreativePaths = ["LOVE"];
  payload.creativeStructure!.formationPrimary = "LOCAL_TRIGGER";
  const issues = validateApprovalCandidate(payload);
  assert.ok(issues.some((issue) => issue.targetKey === "structure:auxiliary-creative-paths"));
  assert.ok(issues.some((issue) => issue.targetKey === "structure:formation-related-groups"));
});

test("V0.3.3 materializes replace, whole-unit replace, insert and delete without mutating source", async () => {
  const base = validPayload();
  base.commercialIntent = "甲乙丙";
  base.creativeTheme = "旧母题";
  base.synopsis = "开始结束";
  base.thinkingChain = "前删除后";
  const events: RevisionEventRecord[] = [
    { id: "r1", target_key: "core:commercial-intent", edit_type: "RANGE_REPLACE", anchor_start: 1, anchor_end: 2, original_text: "乙", original_text_hash: await sha256Text("乙"), replacement_text: "新" },
    { id: "r2", target_key: "core:creative-theme", edit_type: "UNIT_REPLACE", anchor_start: 0, anchor_end: 3, original_text: "旧母题", original_text_hash: await sha256Text("旧母题"), replacement_text: "新母题更长" },
    { id: "r3", target_key: "core:story-synopsis", edit_type: "INSERT", anchor_start: 2, anchor_end: 2, original_text: "", original_text_hash: await sha256Text(""), replacement_text: "—中间—" },
    { id: "r4", target_key: "core:thinking-chain", edit_type: "DELETE", anchor_start: 1, anchor_end: 3, original_text: "删除", original_text_hash: await sha256Text("删除"), replacement_text: "" },
  ];
  const result = await materializeRevisionEvents(base, events);
  assert.equal(result.commercialIntent, "甲新丙");
  assert.equal(result.creativeTheme, "新母题更长");
  assert.equal(result.synopsis, "开始—中间—结束");
  assert.equal(result.thinkingChain, "前后");
  assert.equal(base.commercialIntent, "甲乙丙");
});

test("V0.3.3 applies a dependent path change set as one materialized candidate", async () => {
  const base = validPayload();
  const events: RevisionEventRecord[] = [];
  const pushStructured = async (id: string, key: string, original: string | string[], replacement: string | string[]) => {
    events.push({ id, target_key: key, edit_type: "UNIT_REPLACE", anchor_start: -1, anchor_end: -1,
      original_text: "", original_text_hash: await sha256Text(canonicalRevisionValue(original)),
      replacement_text: Array.isArray(replacement) ? replacement.join(" · ") : replacement,
      value_type: Array.isArray(original) ? "MULTI_SELECT" : "SINGLE_SELECT",
      original_value_json: canonicalRevisionValue(original), replacement_value_json: canonicalRevisionValue(replacement) });
  };
  await pushStructured("p1", "structure:primary-creative-path", "LOVE", "SUBSTANCE");
  await pushStructured("p2", "structure:auxiliary-creative-paths", ["INTERESTING"], ["LOVE"]);
  for (const field of mainPathFields.SUBSTANCE) {
    events.push({ id: field.key, target_key: `structure:main-path:${field.key}`, edit_type: "UNIT_REPLACE",
      anchor_start: 0, anchor_end: 0, original_text: "", original_text_hash: await sha256Text(""),
      replacement_text: `新路径·${field.label}` });
  }
  events.push({ id: "note", target_key: "structure:aux-path:LOVE", edit_type: "UNIT_REPLACE",
    anchor_start: 0, anchor_end: 0, original_text: "", original_text_hash: await sha256Text(""),
    replacement_text: "情感作为辅助增强" });
  const result = await materializeRevisionEvents(base, events);
  assert.equal(result.creativeStructure!.primaryCreativePath, "SUBSTANCE");
  assert.deepEqual(result.creativeStructure!.auxiliaryCreativePaths, ["LOVE"]);
  assert.equal(validateApprovalCandidate(result).length, 0);
});

test("V0.3.3 version identity matrix makes history read-only and active standard author-only for new round", () => {
  const author = { round: null, isAuthor: true, isFinalReviewer: false, canReview: false, canReturn: false, canApprove: false, canWithdraw: false, activeReleaseNumber: 3 };
  assert.equal(resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", versionIdentity: "ACTIVE_STANDARD", review: author }), "AUTHOR_NEW_ROUND");
  assert.equal(resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", versionIdentity: "HISTORICAL_STANDARD", review: author }), "APPROVED_READ_ONLY");
  assert.equal(resolveReviewEntry({ taxonomyVersion: "V0.3-PILOT", versionIdentity: "PUBLIC_SUBMISSION", review: { ...author, isAuthor: false, canReview: true } }), "ENTER_REVIEW");
});

test("V0.3.3 display mapping deduplicates legacy mechanism labels without changing physical current value", () => {
  const choices = mechanismChoicesFor(["重复积累"]);
  assert.equal(choices.filter((choice) => choice.label === "重复变义").length, 1);
  assert.equal(choices.find((choice) => choice.label === "重复变义")?.value, "重复积累");
});

test("V0.3.3 removes duplicate reinterpretation and system-managed shot-number targets", () => {
  assert.equal(mainPathFields.INTERESTING.filter((field) => field.key === "reinterpretation").length, 1);
  const payload = validPayload();
  assert.equal(analysisTargetValue(payload, `shot:${payload.shots[0].id}:number`), null);
});

test("V0.3.3 safety migration is additive and legacy verifiers are hard-disabled", async () => {
  const migration = await readFile(new URL("../db/migrations/2026-08-12-v033-chain-safety.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+annotation_snapshots/i);
  for (const file of ["verify-v03-local.ts", "verify-v031-local.ts", "verify-v032-local.ts"]) {
    const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.match(source, /旧验证脚本已停用/);
    assert.doesNotMatch(source, /video_1329|approved_analysis_releases|expertCreativeGrade/);
  }
});
