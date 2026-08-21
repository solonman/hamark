import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptyCreativeStructure } from "../lib/taxonomy-v0.3.ts";
import type { AnnotationDraft, ShotDraft, ShotGroupDraft } from "../lib/types.ts";
import { emptyV04DraftPayload } from "../lib/v04-domain.ts";
import type { V04DraftPayloadV1 } from "../lib/v04-contract.ts";
import {
  compareWelcomeHomeV19Payloads,
  loadWelcomeHomeV19AuditConfig,
  WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
  WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT,
  WELCOME_HOME_V19_AUDIT_VIDEO_ID,
} from "../lib/welcome-home-v19-conflict-audit.ts";

const groupSizes = [4, 4, 3, 3, 3, 3, 3];
const populated = (index: number, count: number, label: string) =>
  index < count ? `${label}-${index + 1}` : "";

export function welcomeHomeV19SourceFixture(): AnnotationDraft {
  const groups: ShotGroupDraft[] = groupSizes.map((_, index) => ({
    id: `group-${index + 1}`,
    orderIndex: index,
    title: `桥段-${index + 1}`,
    primaryRole: "",
    auxiliaryRoles: [],
    customRole: "",
    note: `关键描述-${index + 1}`,
  }));
  const shots: ShotDraft[] = [];
  let globalIndex = 0;
  groupSizes.forEach((size, groupIndex) => {
    for (let localIndex = 0; localIndex < size; localIndex += 1) {
      const index = globalIndex++;
      shots.push({
        id: `shot-${index + 1}`,
        orderIndex: index,
        groupName: groups[groupIndex].title,
        shotNumber: String(index + 1),
        startTime: populated(index, 22, "开始"),
        endTime: populated(index, 22, "结束"),
        shotSize: populated(index, 22, "景别"),
        cameraAngle: populated(index, 10, "角度"),
        cameraMovement: "",
        visualContent: populated(index, 23, "画面"),
        dialogue: populated(index, 20, "对白"),
        voiceover: populated(index, 19, "旁白"),
        screenText: populated(index, 11, "字幕"),
        soundEffect: populated(index, 9, "声效"),
        music: populated(index, 17, "音乐"),
        creativeComment: "",
        shotGroupId: groups[groupIndex].id,
      });
    }
  });
  return {
    id: "annotation-source",
    videoId: WELCOME_HOME_V19_AUDIT_VIDEO_ID,
    authorName: "fixture-author",
    taxonomyVersion: "V0.3-PILOT",
    workflowVersion: "REVERSE-WORKFLOW-V0.3-PILOT",
    status: "DRAFT",
    revision: 153,
    analysisTitle: "",
    commercialIntent: "商业意图-source",
    creativeTheme: "创意母题-source",
    synopsis: "故事梗概-source",
    thinkingChain: "创意思维链-source",
    shotCommentary: "",
    summary: "评价理由-source",
    shots,
    shotGroups: groups,
    fields: [],
    creativeStructure: {
      ...emptyCreativeStructure(),
      creativeButton: "创意按钮-source",
      primaryCreativePath: "LOVE",
    },
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

export function welcomeHomeV19TargetFixture(
  source: AnnotationDraft,
  mode: "EMPTY" | "SAME",
): V04DraftPayloadV1 {
  const target = emptyV04DraftPayload();
  const value = (sourceValue: string) => mode === "SAME" ? sourceValue : "";
  target.script.shotGroups = (source.shotGroups ?? []).map((group) => ({
    id: group.id,
    orderIndex: group.orderIndex,
    bridgeName: value(group.title),
    primaryCreativeRole: target.factsAndCoreJudgement.mainMechanism,
    auxiliaryCreativeRole: target.factsAndCoreJudgement.auxiliaryMechanism,
    keyCreativeDescription: value(group.note),
    shots: source.shots.filter((shot) => shot.shotGroupId === group.id).map((shot) => ({
      id: shot.id,
      orderIndex: shot.orderIndex,
      startTime: value(shot.startTime),
      endTime: value(shot.endTime),
      shotScale: value(shot.shotSize),
      cameraAngle: value(shot.cameraAngle),
      cameraMovement: "",
      visualContent: value(shot.visualContent),
      screenCopy: value(shot.screenText),
      subtitleEffect: "",
      dialogue: value(shot.dialogue),
      voiceOver: value(shot.voiceover),
      soundEffect: value(shot.soundEffect),
      music: value(shot.music),
    })),
  }));
  target.factsAndCoreJudgement.commercialIntent = value(source.commercialIntent);
  target.factsAndCoreJudgement.storySynopsis = value(source.synopsis);
  target.factsAndCoreJudgement.creativeMotif = value(source.creativeTheme);
  target.factsAndCoreJudgement.tensionButton = value(source.creativeStructure?.creativeButton ?? "");
  target.factsAndCoreJudgement.creativeThinkingChain = value(source.thinkingChain);
  target.factsAndCoreJudgement.ratingReason = value(source.summary);
  target.perceptionPath.primaryType = mode === "SAME" ? "LOVE" : "";
  return target;
}

test("frozen direct-map contract contains exactly 19 field types and 196 instances", () => {
  assert.equal(WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT.length, 19);
  assert.equal(WELCOME_HOME_V19_AUDIT_FIELD_CONTRACT.reduce((sum, field) => sum + field[2], 0), 196);
  assert.equal(WELCOME_HOME_V19_AUDIT_CONTRACT_HASH,
    "d7419328e024179505a53c206fc524b1a14336c852c77e7f8e9b934f6d26978a");
  assert.equal(WELCOME_HOME_V19_AUDIT_VIDEO_ID, "video_e2d5dbab-fc35-4e81-9d8e-0ab1a0a90435");
});

test("same stable structure classifies all 196 source instances as empty or same", () => {
  const source = welcomeHomeV19SourceFixture();
  const empty = compareWelcomeHomeV19Payloads(source, welcomeHomeV19TargetFixture(source, "EMPTY"));
  assert.deepEqual(empty.stopReasons, []);
  assert.deepEqual(empty.totals, {
    TARGET_EMPTY: 196, TARGET_SAME: 0, TARGET_DIFFERENT: 0, UNADDRESSABLE: 0,
    expected: 196, sourceInstances: 196,
  });
  const same = compareWelcomeHomeV19Payloads(source, welcomeHomeV19TargetFixture(source, "SAME"));
  assert.deepEqual(same.stopReasons, []);
  assert.deepEqual(same.totals, {
    TARGET_EMPTY: 0, TARGET_SAME: 196, TARGET_DIFFERENT: 0, UNADDRESSABLE: 0,
    expected: 196, sourceInstances: 196,
  });
});

test("different values are preserved candidates and never become a stop reason", () => {
  const source = welcomeHomeV19SourceFixture();
  const target = welcomeHomeV19TargetFixture(source, "EMPTY");
  target.factsAndCoreJudgement.commercialIntent = "目标已有不同内容";
  target.factsAndCoreJudgement.storySynopsis = source.synopsis;
  const result = compareWelcomeHomeV19Payloads(source, target);
  assert.equal(result.totals.TARGET_DIFFERENT, 1);
  assert.equal(result.totals.TARGET_SAME, 1);
  assert.equal(result.totals.TARGET_EMPTY, 194);
  assert.deepEqual(result.stopReasons, []);
});

test("missing, duplicate, reordered or cross-group stable targets stop the audit", () => {
  const source = welcomeHomeV19SourceFixture();
  const variants: V04DraftPayloadV1[] = [];
  const missing = structuredClone(welcomeHomeV19TargetFixture(source, "EMPTY"));
  missing.script.shotGroups.pop();
  variants.push(missing);
  const duplicate = structuredClone(welcomeHomeV19TargetFixture(source, "EMPTY"));
  duplicate.script.shotGroups[0].shots.push(structuredClone(duplicate.script.shotGroups[0].shots[0]));
  variants.push(duplicate);
  const reordered = structuredClone(welcomeHomeV19TargetFixture(source, "EMPTY"));
  [reordered.script.shotGroups[0].orderIndex, reordered.script.shotGroups[1].orderIndex] = [1, 0];
  variants.push(reordered);
  const moved = structuredClone(welcomeHomeV19TargetFixture(source, "EMPTY"));
  const movedShot = moved.script.shotGroups[1].shots.shift()!;
  moved.script.shotGroups[0].shots.push(movedShot);
  variants.push(moved);
  for (const target of variants) {
    const result = compareWelcomeHomeV19Payloads(source, target);
    assert.equal(result.structure.stableLocatorsAligned, false);
    assert.ok(result.stopReasons.includes("STRUCTURE_DRIFT"));
  }
});

test("no target workspace is explicitly unaddressable and fail-closed", () => {
  const result = compareWelcomeHomeV19Payloads(welcomeHomeV19SourceFixture(), null);
  assert.equal(result.totals.UNADDRESSABLE, 196);
  assert.ok(result.stopReasons.includes("STRUCTURE_DRIFT"));
  assert.ok(result.stopReasons.includes("UNADDRESSABLE_INSTANCES"));
});

test("audit is default-off, strict GET-only, no-store and contains no mutation calls", () => {
  assert.equal(loadWelcomeHomeV19AuditConfig({}).enabled, false);
  assert.equal(loadWelcomeHomeV19AuditConfig({ V04_WELCOME_HOME_V19_AUDIT_ENABLED: "true" }).enabled, true);
  const service = readFileSync(new URL("../lib/welcome-home-v19-conflict-audit.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL(
    "../app/api/admin/welcome-home-v19-conflict-audit/route.ts", import.meta.url,
  ), "utf8");
  const page = readFileSync(new URL(
    "../app/admin/welcome-home-v19-conflict-audit/page.tsx", import.meta.url,
  ), "utf8");
  const client = readFileSync(new URL(
    "../app/admin/welcome-home-v19-conflict-audit/WelcomeHomeV19ConflictAuditClient.tsx",
    import.meta.url,
  ), "utf8");
  assert.match(service, /REPEATABLE READ READ ONLY/);
  assert.match(service, /role_key = 'SYSTEM_ADMIN'/);
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(route, /isV04PreviewSameOrigin/);
  assert.match(route, /Cache-Control.*no-store/s);
  assert.match(page, /requirePageUser/);
  assert.match(page, /assertWelcomeHomeV19AuditAdmin/);
  for (const sourceText of [service, route, page, client]) {
    assert.doesNotMatch(sourceText, /acquireLease|materializeV04|saveV04|submitV04|INSERT INTO|UPDATE\s+[^\n]+SET|DELETE FROM/);
  }
});

test("deployment opens only the fixed read-only audit and leaves data-operation flags closed", () => {
  const deployment = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(deployment.env.V04_WELCOME_HOME_V19_AUDIT_ENABLED, "true");
  for (const forbidden of [
    "V04_MIGRATION_PREVIEW_ENABLED",
    "V04_SCHEMA_APPLY_ENABLED",
    "V04_CONTRACT_ACTIVATE_ENABLED",
    "V04_SYSTEM_ADMIN_BOOTSTRAP_ENABLED",
    "V04_GRAY_TEST_OBJECT_ENABLED",
    "V04_GRAY_IDENTITY_DIGEST_ENABLED",
    "V04_GRAY_ROLLOUT_ENABLED",
  ]) assert.equal(forbidden in deployment.env, false, `${forbidden} must stay closed`);
});

test("browser response and client surface expose aggregates and digests, never content or identity", () => {
  const client = readFileSync(new URL(
    "../app/admin/welcome-home-v19-conflict-audit/WelcomeHomeV19ConflictAuditClient.tsx",
    import.meta.url,
  ), "utf8");
  for (const forbidden of [
    "payload_json", "sourceValue", "targetValue", "userId", "user_id", "email",
    "displayName", "identityKey", "holder_user_id", "lease_token", "cookie", "SQL",
  ]) assert.doesNotMatch(client, new RegExp(forbidden, "i"), forbidden);
  for (const allowed of ["fieldTypes", "TARGET_EMPTY", "TARGET_SAME", "TARGET_DIFFERENT", "UNADDRESSABLE", "previewDigest"]) {
    assert.match(client, new RegExp(allowed));
  }
});
