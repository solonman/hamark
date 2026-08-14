import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import {
  diffSharedDraft,
  normalizeSharedDraft,
} from "../lib/v03-collaboration.ts";

function draft() {
  const value = emptyAnnotation("test_only_shared_video", "TEST_ONLY 来源作者", "V0.3-PILOT");
  value.id = "test_only_shared_annotation";
  value.revision = 7;
  value.analysisTitle = "TEST_ONLY 公共 V0.3";
  value.commercialIntent = "旧商业意图";
  value.shotGroups = [{
    id: "test_only_group_1", orderIndex: 0, title: "桥段一",
    primaryRole: "", auxiliaryRoles: [], customRole: "", note: "旧作用",
  }];
  value.shots = [{
    id: "test_only_shot_1", orderIndex: 0, groupName: "桥段一", shotNumber: "1",
    startTime: "", endTime: "", shotSize: "中景", cameraAngle: "平视",
    cameraMovement: "固定", visualContent: "旧画面", dialogue: "", voiceover: "",
    screenText: "", soundEffect: "", music: "", creativeComment: "",
    shotGroupId: "test_only_group_1",
  }];
  return value;
}

test("shared draft diff records stable unit before/after without mutating source", () => {
  const before = draft();
  const input = structuredClone(before);
  input.commercialIntent = "新商业意图";
  input.shots[0].visualContent = "新画面";
  const after = normalizeSharedDraft(input, before, 8, "2026-08-13T00:00:00.000Z");
  const changes = diffSharedDraft(before, after);
  assert.deepEqual(
    changes.filter((change) => ["core:commercial-intent", "shot:test_only_shot_1:visual-content"].includes(change.targetKey))
      .map((change) => [change.targetKey, change.beforeValue, change.afterValue]),
    [
      ["core:commercial-intent", "旧商业意图", "新商业意图"],
      ["shot:test_only_shot_1:visual-content", "旧画面", "新画面"],
    ],
  );
  assert.equal(before.commercialIntent, "旧商业意图");
  assert.equal(before.shots[0].visualContent, "旧画面");
});

test("V0.3 shared schema is additive and enforces one active stream and round", async () => {
  const migration = await readFile(
    new URL("../db/migrations/2026-08-13-v03-shared-collaboration.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /UNIQUE \(video_id, taxonomy_version\)/);
  assert.match(migration, /v03_collaboration_rounds_one_active_idx/);
  assert.match(migration, /v03_collaboration_revision_events/);
  assert.match(migration, /before_value_json JSONB NOT NULL/);
  assert.match(migration, /after_value_json JSONB NOT NULL/);
  assert.doesNotMatch(migration, /DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+annotations/i);
});

test("logical workspace GET stays read-only and first save materializes one shared stream", async () => {
  const [route, service, practice, detail, home, videosRoute] = await Promise.all([
    readFile(new URL("../app/api/videos/[id]/annotation/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/v03-collaboration.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/practice/PracticeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/HomeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /loadSharedV03ReadModel/);
  assert.match(route, /emptyAnnotation\(id, user\.displayName, V03_TAXONOMY_VERSION\)/);
  assert.match(route, /logicalWorkspaceEmpty/);
  assert.doesNotMatch(route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST")), /seedV03From/);
  assert.doesNotMatch(route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST")), /INSERT INTO|UPDATE\s+annotations|DELETE FROM/i);
  assert.match(service, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(service, /SHARED_V03_INITIALIZED/);
  assert.match(service, /'EMPTY_INITIAL'/);
  assert.match(service, /FOR UPDATE OF stream/);
  assert.match(service, /REVISION_CONFLICT/);
  assert.match(service, /v03_collaboration_revision_events/);
  assert.match(practice, /CURRENT PUBLIC V0\.3/);
  assert.match(practice, /开始公共 V0\.3 逆向工程/);
  assert.match(practice, /首次保存时建立公共工作稿/);
  assert.match(detail, /当前公共 V0\.3/);
  assert.match(detail, /开始 V0\.3 逆向工程/);
  assert.match(detail, /继续 V0\.3 逆向工程/);
  assert.match(service, /loadLegacyV03Fallback/);
  assert.match(service, /LEGACY_V03_FALLBACK/);
  assert.match(practice, /待接入共享主线 · 只读/);
  assert.match(detail, /既有 V0\.3 · 待接入共享主线/);
  assert.doesNotMatch(detail, /管理员接入共享主线/);
  assert.match(home, /开始 V0\.3 逆向工程/);
  assert.match(home, /继续 V0\.3 逆向工程/);
  assert.match(videosRoute, /has_v03_content/);
  assert.doesNotMatch(practice, /MY REVERSE-ENGINEERING NOTES/);
});

test("all active members can comment and directly revise; only experts finalize and restore", async () => {
  const [comments, revisions, review, releaseRestore, baselineRestore, ui] = await Promise.all([
    readFile(new URL("../app/api/analyses/[snapshotId]/comments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyses/[snapshotId]/suggestions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyses/[snapshotId]/review/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/approved-standards/[releaseId]/restore/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v03-baselines/[baselineId]/restore/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/videos/[id]/VideoDetailClient.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(comments, /正式批注由终审者发起/);
  assert.match(revisions, /saveSharedV03Draft/);
  assert.doesNotMatch(revisions, /只有终审者可以直接修订/);
  assert.match(review, /isFinalReviewer\(user\)/);
  assert.match(review, /canWithdraw: false/);
  assert.match(review, /公共 V0\.3 不再由个人撤回/);
  assert.match(review, /v03_collaboration_rounds/);
  assert.match(releaseRestore, /isFinalReviewer\(user\)/);
  assert.match(releaseRestore, /RESTORE_AS_NEW_ROUND/);
  assert.match(baselineRestore, /isFinalReviewer\(user\)/);
  assert.match(baselineRestore, /RESTORE_BASELINE_AS_NEW_ROUND/);
  assert.match(ui, /canFinalizeSharedV03/);
  assert.match(ui, /从 R\{release\.releaseNumber\} 创建恢复轮/);
});

test("controlled backfill requires schema gate, preview token, transaction lock and content invariants", async () => {
  const [service, route, bootstrap, schema] = await Promise.all([
    readFile(new URL("../lib/v03-shared-backfill.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/v03-shared-backfill/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/v03-shared-schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /isAppAdmin\(user\)/);
  assert.match(route, /requireSameOriginMutation/);
  assert.match(route, /INSTALL_SCHEMA/);
  assert.match(route, /isV03SharedSchemaReady/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /PREVIEW_STALE/);
  assert.match(service, /annotationPayloadHash/);
  assert.match(service, /HISTORY_CHANGED/);
  assert.match(service, /admin_data_operations/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS v03_collaboration_streams/);
  assert.doesNotMatch(schema, /INSERT INTO annotations|UPDATE annotations|DELETE FROM annotations/);
  assert.doesNotMatch(bootstrap, /V03_SHARED_STREAM_BACKFILL/);
});
