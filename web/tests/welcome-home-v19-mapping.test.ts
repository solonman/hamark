import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptyCreativeStructure } from "../lib/taxonomy-v0.3.ts";
import type { AnnotationDraft, ShotDraft, ShotGroupDraft } from "../lib/types.ts";
import { sharedContentFingerprint } from "../lib/v03-collaboration.ts";
import { emptyV04DraftPayload } from "../lib/v04-domain.ts";
import {
  loadWelcomeHomeV19MappingConfig,
  planWelcomeHomeV19Mapping,
  WELCOME_HOME_V19_MAPPING_CONFIRMATION,
  WELCOME_HOME_V19_MAPPING_OPERATION_TYPE,
} from "../lib/welcome-home-v19-mapping.ts";
import {
  WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
  WELCOME_HOME_V19_AUDIT_VIDEO_ID,
} from "../lib/welcome-home-v19-conflict-audit.ts";

const groupSizes = [4, 4, 3, 3, 3, 3, 3];
const populated = (index: number, count: number, label: string) => index < count ? `${label}-${index + 1}` : "";

function sourceFixture(): AnnotationDraft {
  const groups: ShotGroupDraft[] = groupSizes.map((_, index) => ({
    id: `group-${index + 1}`, orderIndex: index, title: `桥段-${index + 1}`,
    primaryRole: "", auxiliaryRoles: [], customRole: "", note: `关键描述-${index + 1}`,
  }));
  const shots: ShotDraft[] = [];
  let index = 0;
  groupSizes.forEach((size, groupIndex) => {
    for (let local = 0; local < size; local += 1) {
      const current = index++;
      shots.push({
        id: `shot-${current + 1}`, orderIndex: current,
        groupName: groups[groupIndex].title, shotGroupId: groups[groupIndex].id,
        shotNumber: String(current + 1), startTime: populated(current, 22, "开始"),
        endTime: populated(current, 22, "结束"), shotSize: populated(current, 22, "景别"),
        cameraAngle: populated(current, 10, "角度"), cameraMovement: "",
        visualContent: populated(current, 23, "画面"), dialogue: populated(current, 20, "对白"),
        voiceover: populated(current, 19, "旁白"), screenText: populated(current, 11, "字幕"),
        soundEffect: populated(current, 9, "声效"), music: populated(current, 17, "音乐"),
        creativeComment: "",
      });
    }
  });
  return {
    id: "annotation-source", videoId: WELCOME_HOME_V19_AUDIT_VIDEO_ID,
    authorName: "TEST_ONLY", taxonomyVersion: "V0.3-PILOT",
    workflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT", status: "DRAFT", revision: 153,
    analysisTitle: "", commercialIntent: "商业意图", creativeTheme: "创意母题",
    synopsis: "故事梗概", thinkingChain: "创意思维链", shotCommentary: "",
    summary: "评价理由", shots, shotGroups: groups, fields: [],
    creativeStructure: { ...emptyCreativeStructure(), creativeButton: "创意按钮", primaryCreativePath: "LOVE" },
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

test("fixed mapping initializes stable 7/23 structure and produces frozen 195 empty + 1 same plan", () => {
  const source = sourceFixture();
  const target = emptyV04DraftPayload();
  target.perceptionPath.primaryType = "LOVE";
  const plan = planWelcomeHomeV19Mapping(source, target);
  assert.equal(plan.initializedStructure, true);
  assert.equal(plan.payload.script.shotGroups.length, 7);
  assert.equal(plan.payload.script.shotGroups.flatMap((group) => group.shots).length, 23);
  assert.deepEqual(plan.before.totals, {
    TARGET_EMPTY: 195, TARGET_SAME: 1, TARGET_DIFFERENT: 0, UNADDRESSABLE: 0,
    expected: 196, sourceInstances: 196,
  });
  assert.equal(plan.appliedLocators.length, 195);
  assert.deepEqual(plan.after.totals, {
    TARGET_EMPTY: 0, TARGET_SAME: 196, TARGET_DIFFERENT: 0, UNADDRESSABLE: 0,
    expected: 196, sourceInstances: 196,
  });
  assert.ok(plan.payload.script.shotGroups.every((group) =>
    group.primaryCreativeRole.selectedOptionIds.length === 0
    && group.auxiliaryCreativeRole.selectedOptionIds.length === 0));
  assert.ok(plan.payload.script.shotGroups.flatMap((group) => group.shots)
    .every((shot) => shot.cameraMovement === "" && shot.subtitleEffect === ""));
});

test("mapping preserves a different target value and never overwrites it", () => {
  const source = sourceFixture();
  const empty = emptyV04DraftPayload();
  empty.perceptionPath.primaryType = "LOVE";
  const initialized = planWelcomeHomeV19Mapping(source, empty).payload;
  initialized.factsAndCoreJudgement.commercialIntent = "目标已有不同值";
  const result = planWelcomeHomeV19Mapping(source, initialized);
  assert.equal(result.before.totals.TARGET_DIFFERENT, 1);
  assert.equal(result.payload.factsAndCoreJudgement.commercialIntent, "目标已有不同值");
  assert.equal(result.appliedLocators.includes("facts.commercialIntent"), false);
});

test("canonical source fingerprint ignores JSON key order and workflow fields, not content drift", () => {
  const source = sourceFixture();
  const reordered = { ...structuredClone(source), updatedAt: "different", status: "SUBMITTED" as const };
  assert.equal(sharedContentFingerprint(source), sharedContentFingerprint(reordered));
  reordered.synopsis = "changed-content";
  assert.notEqual(sharedContentFingerprint(source), sharedContentFingerprint(reordered));
});

test("mapping tools are independently default-off and fixed to the frozen contract", () => {
  assert.deepEqual(loadWelcomeHomeV19MappingConfig({}), { previewEnabled: false, applyEnabled: false });
  assert.deepEqual(loadWelcomeHomeV19MappingConfig({
    V04_WELCOME_HOME_V19_MAPPING_PREVIEW_ENABLED: "true",
    V04_WELCOME_HOME_V19_MAPPING_APPLY_ENABLED: "true",
  }), { previewEnabled: true, applyEnabled: true });
  assert.equal(WELCOME_HOME_V19_MAPPING_OPERATION_TYPE, "WELCOME_HOME_V19_DIRECT_MAPPING_V1_1");
  assert.equal(WELCOME_HOME_V19_MAPPING_CONFIRMATION, "确认仅填充《欢迎回家》V1.9空白项");
  assert.equal(WELCOME_HOME_V19_AUDIT_CONTRACT_HASH, "d7419328e024179505a53c206fc524b1a14336c852c77e7f8e9b934f6d26978a");
});

test("admin routes are POST-only, same-origin and no-store; full token never renders or persists", () => {
  const previewRoute = readFileSync(new URL("../app/api/admin/welcome-home-v19-mapping/preview/route.ts", import.meta.url), "utf8");
  const applyRoute = readFileSync(new URL("../app/api/admin/welcome-home-v19-mapping/apply/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/admin/welcome-home-v19-mapping/page.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../app/admin/welcome-home-v19-mapping/WelcomeHomeV19MappingClient.tsx", import.meta.url), "utf8");
  for (const route of [previewRoute, applyRoute]) {
    assert.match(route, /export async function POST/);
    assert.doesNotMatch(route, /export async function GET/);
    assert.match(route, /mutation: true/);
    assert.match(route, /Cache-Control.*no-store/s);
  }
  assert.match(page, /requirePageUser/);
  assert.match(page, /assertWelcomeHomeV19AuditAdmin/);
  assert.doesNotMatch(client, /\{preview\.previewToken\}|localStorage|sessionStorage|console\./);
  assert.match(client, /Token 摘要/);
  const deployment = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal("V04_WELCOME_HOME_V19_MAPPING_PREVIEW_ENABLED" in deployment.env, false);
  assert.equal("V04_WELCOME_HOME_V19_MAPPING_APPLY_ENABLED" in deployment.env, false);
});
