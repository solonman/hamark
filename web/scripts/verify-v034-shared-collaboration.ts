import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applySchema } from "../db/bootstrap.ts";
import { getDbClient } from "../db/index.ts";
import { isFinalReviewer } from "../lib/admin.ts";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import {
  applyV03SharedBackfillCandidate,
  previewV03SharedBackfill,
} from "../lib/v03-shared-backfill.ts";
import { V03_SHARED_BACKFILL_CONFIRMATION } from "../lib/v03-shared-backfill-contract.ts";
import {
  loadCollaborationRevisionHistory,
  loadSharedV03Annotation,
  loadSharedV03ReadModel,
  restoreSharedV03FromBaseline,
  restoreSharedV03FromRelease,
  saveSharedV03Draft,
  V03CollaborationError,
} from "../lib/v03-collaboration.ts";
import type { CurrentUser } from "../lib/auth/types.ts";

const runId = `shared_${Date.now().toString(36)}`;
process.env.V033_TEST_RUN_ID = runId;
const prefix = `test_only_v033_${runId}`;
const videoId = `${prefix}_video`;
const emptyVideoId = `${prefix}_empty_video`;
const annotationId = `${prefix}_annotation`;
const reviewer = {
  id: "test_reviewer",
  identityKey: "reviewer@reverse.local",
  displayName: "演示同事",
  avatarUrl: null,
  email: "reviewer@reverse.local",
  departments: [],
} satisfies CurrentUser;
const peer = {
  id: "test_peer",
  identityKey: "peer@reverse.local",
  displayName: "协作同事",
  avatarUrl: null,
  email: "peer@reverse.local",
  departments: [],
} satisfies CurrentUser;
const expert = {
  id: "test_owner",
  identityKey: "demo@reverse.local",
  displayName: "老孙",
  avatarUrl: null,
  email: "demo@reverse.local",
  departments: [],
} satisfies CurrentUser;

function businessFingerprintSql() {
  return `SELECT
    (SELECT COUNT(*) FROM videos WHERE COALESCE(data_scope, 'BUSINESS') = 'BUSINESS') AS videos,
    (SELECT COUNT(*) FROM annotations a INNER JOIN videos v ON v.id = a.video_id
      WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS annotations,
    (SELECT COUNT(*) FROM annotation_snapshots s INNER JOIN videos v ON v.id = s.video_id
      WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS snapshots,
    (SELECT COUNT(*) FROM approved_analysis_releases r INNER JOIN videos v ON v.id = r.video_id
      WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS releases,
    (SELECT COUNT(*) FROM v03_collaboration_streams stream INNER JOIN videos v ON v.id = stream.video_id
      WHERE COALESCE(v.data_scope, 'BUSINESS') = 'BUSINESS') AS streams`;
}

async function runFixture(command: "prepare" | "cleanup") {
  const moduleUrl = new URL("./v033-test-fixture.ts", import.meta.url);
  const child = BunLikeSpawn(process.execPath, [
    "--env-file=.env.local",
    "--import", "tsx",
    fileURLToPath(moduleUrl),
    command,
  ], { ...process.env, V033_TEST_RUN_ID: runId });
  if (child.status !== 0) throw new Error(child.output || `fixture ${command} failed`);
}

function BunLikeSpawn(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

await applySchema();
const db = getDbClient();
const businessBefore = JSON.stringify(await db.prepare(businessFingerprintSql()).first());

try {
  await runFixture("prepare");
  const emptyCounts = async () => db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM annotations WHERE video_id = ?) AS annotations,
      (SELECT COUNT(*) FROM v03_collaboration_streams WHERE video_id = ?) AS streams,
      (SELECT COUNT(*) FROM v03_collaboration_rounds round
        INNER JOIN v03_collaboration_streams stream ON stream.id = round.stream_id
        WHERE stream.video_id = ?) AS rounds,
      (SELECT COUNT(*) FROM v03_collaboration_baselines baseline
        INNER JOIN v03_collaboration_streams stream ON stream.id = baseline.stream_id
        WHERE stream.video_id = ?) AS baselines`,
  ).bind(emptyVideoId, emptyVideoId, emptyVideoId, emptyVideoId)
    .first<Record<string, number>>();
  const beforeEmptyGet = JSON.stringify(await emptyCounts());
  assert.equal(
    await loadSharedV03ReadModel(emptyVideoId, db),
    null,
    "a new video must expose a logical empty workspace without materializing data",
  );
  assert.equal(
    JSON.stringify(await emptyCounts()),
    beforeEmptyGet,
    "reading the logical empty workspace must write zero rows",
  );

  const initialDraft = (actor: CurrentUser, commercialIntent: string) => {
    const payload = emptyAnnotation(emptyVideoId, actor.displayName, "V0.3-PILOT");
    const groupId = `${prefix}_empty_group`;
    payload.analysisTitle = "TEST_ONLY 新案例公共反写";
    payload.commercialIntent = commercialIntent;
    payload.shotGroups = [{
      id: groupId,
      orderIndex: 0,
      title: "桥段 1",
      primaryRole: "",
      auxiliaryRoles: [],
      customRole: "",
      note: "",
    }];
    payload.shots = [{
      id: `${prefix}_empty_shot`,
      orderIndex: 0,
      groupName: "桥段 1",
      shotNumber: "1",
      startTime: "",
      endTime: "",
      shotSize: "",
      cameraAngle: "",
      cameraMovement: "",
      visualContent: "TEST_ONLY 首次填写画面",
      dialogue: "",
      voiceover: "",
      screenText: "",
      soundEffect: "",
      music: "",
      creativeComment: "",
      shotGroupId: groupId,
    }];
    return payload;
  };
  const simultaneous = await Promise.allSettled([
    saveSharedV03Draft({
      videoId: emptyVideoId,
      payload: initialDraft(reviewer, "普通成员一首次填写。"),
      actor: reviewer,
    }),
    saveSharedV03Draft({
      videoId: emptyVideoId,
      payload: initialDraft(peer, "普通成员二并发首次填写。"),
      actor: peer,
    }),
  ]);
  const firstSuccesses = simultaneous.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof saveSharedV03Draft>>> =>
      result.status === "fulfilled",
  );
  const firstConflicts = simultaneous.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(firstSuccesses.length, 1, "concurrent first saves must have one winner");
  assert.equal(firstConflicts.length, 1, "concurrent first saves must return one conflict");
  assert(
    firstConflicts[0].reason instanceof V03CollaborationError &&
      firstConflicts[0].reason.code === "REVISION_CONFLICT",
    "the losing first save must get the existing optimistic-lock conflict",
  );
  const createdCounts = await emptyCounts();
  assert.deepEqual(
    {
      annotations: Number(createdCounts?.annotations ?? 0),
      streams: Number(createdCounts?.streams ?? 0),
      rounds: Number(createdCounts?.rounds ?? 0),
      baselines: Number(createdCounts?.baselines ?? 0),
    },
    { annotations: 1, streams: 1, rounds: 1, baselines: 1 },
    "first save must atomically materialize exactly one canonical workspace",
  );
  const emptyShared = await loadSharedV03Annotation(emptyVideoId, db);
  assert(emptyShared, "the materialized workspace must be readable by every member");
  assert.equal(emptyShared.collaboration.roundBaseType, "EMPTY_INITIAL");
  assert.equal(emptyShared.annotation.revision, 1);
  const peerContinuation = structuredClone(emptyShared.annotation);
  peerContinuation.synopsis = "第二位普通成员继续填写同一份公共工作稿。";
  const continuedByPeer = await saveSharedV03Draft({
    videoId: emptyVideoId,
    payload: peerContinuation,
    actor: peer,
  });
  assert.equal(continuedByPeer.annotation.revision, 2);
  assert.equal(
    (await loadSharedV03Annotation(emptyVideoId, db))?.annotation.synopsis,
    peerContinuation.synopsis,
  );

  const preApplyFallback = await loadSharedV03ReadModel(videoId, db);
  assert(preApplyFallback, "schema installed + stream absent must still expose legacy V0.3");
  assert.equal(preApplyFallback.pendingSharedBackfill, true);
  assert.equal(preApplyFallback.mutableAvailable, false);
  assert.equal(preApplyFallback.annotation.id, annotationId);
  assert(preApplyFallback.annotation.shots.length > 0, "legacy fallback must be nonempty");
  assert.equal(
    await loadSharedV03ReadModel(`${prefix}_without_v03`, db),
    null,
    "stream absent + no legacy V0.3 must stay an explicit empty model",
  );
  const preview = await previewV03SharedBackfill(db);
  const candidate = preview.candidates.find((item) => item.videoId === videoId);
  assert(candidate, "TEST_ONLY candidate must be discoverable");
  assert.equal(candidate.status, "READY");
  assert(candidate.previewToken);

  await assert.rejects(
    applyV03SharedBackfillCandidate({
      actor: expert,
      candidateKey: candidate.candidateKey,
      previewToken: candidate.previewToken,
      confirmation: V03_SHARED_BACKFILL_CONFIRMATION,
      db,
      failAfterCreateForTest: true,
    }),
    /TEST_ONLY 强制回滚/,
  );
  assert.equal(await loadSharedV03Annotation(videoId, db), null, "forced rollback must leave no stream");

  const applied = await applyV03SharedBackfillCandidate({
    actor: expert,
    candidateKey: candidate.candidateKey,
    previewToken: candidate.previewToken,
    confirmation: V03_SHARED_BACKFILL_CONFIRMATION,
    db,
  });
  assert.equal(applied.canonicalAnnotationId, annotationId);
  const repeated = await applyV03SharedBackfillCandidate({
    actor: expert,
    candidateKey: candidate.candidateKey,
    previewToken: candidate.previewToken,
    confirmation: V03_SHARED_BACKFILL_CONFIRMATION,
    db,
  });
  assert.equal(repeated.alreadyApplied, true, "shared backfill must be replay-safe");

  const sameForAll = [
    await loadSharedV03Annotation(videoId, db),
    await loadSharedV03Annotation(videoId, db),
    await loadSharedV03Annotation(videoId, db),
  ];
  assert(sameForAll.every((item) => item?.annotation.id === annotationId));
  assert(sameForAll.every((item) => item?.annotation.shots.length === 3));
  const postApplyShared = await loadSharedV03ReadModel(videoId, db);
  assert(postApplyShared?.collaboration, "applied work must switch to the shared path");
  assert.equal(postApplyShared.pendingSharedBackfill, false);

  const first = sameForAll[0]!;
  const reviewerDraft = structuredClone(first.annotation);
  reviewerDraft.commercialIntent = "普通成员一直接修订公共商业意图。";
  const savedByReviewer = await saveSharedV03Draft({
    videoId,
    payload: reviewerDraft,
    actor: reviewer,
  });
  const stalePeerDraft = structuredClone(first.annotation);
  stalePeerDraft.synopsis = "这份本地输入必须在 409 后继续由调用端保留。";
  await assert.rejects(
    saveSharedV03Draft({ videoId, payload: stalePeerDraft, actor: peer }),
    (error) => error instanceof V03CollaborationError &&
      error.code === "REVISION_CONFLICT" && error.serverRevision === savedByReviewer.annotation.revision,
  );
  const peerDraft = structuredClone(savedByReviewer.annotation);
  peerDraft.synopsis = "普通成员二直接修订共享故事梗概。";
  const savedByPeer = await saveSharedV03Draft({ videoId, payload: peerDraft, actor: peer });
  const history = await loadCollaborationRevisionHistory(videoId);
  assert(history.revisions.some((event) =>
    event.actorName === reviewer.displayName && event.targetKey === "core:commercial-intent" &&
    event.beforeValue !== event.afterValue));
  assert(history.revisions.some((event) =>
    event.actorName === peer.displayName && event.targetKey === "core:story-synopsis" &&
    event.baseRevision === savedByReviewer.annotation.revision));

  assert.equal(await isFinalReviewer(reviewer), false);
  assert.equal(await isFinalReviewer(peer), false);
  assert.equal(await isFinalReviewer(expert), true);

  const release = await db.prepare(
    `SELECT id, payload_json FROM approved_analysis_releases
    WHERE video_id = ? AND status = 'ACTIVE'`,
  ).bind(videoId).first<{ id: string; payload_json: unknown }>();
  assert(release, "fixture release must remain available");
  const releaseBefore = JSON.stringify(release.payload_json);
  const restored = await restoreSharedV03FromRelease({ releaseId: release.id, actor: expert });
  assert(restored.roundNumber > first.collaboration.roundNumber);
  const releaseAfter = await db.prepare(
    `SELECT payload_json FROM approved_analysis_releases WHERE id = ?`,
  ).bind(release.id).first<{ payload_json: unknown }>();
  assert.equal(JSON.stringify(releaseAfter?.payload_json), releaseBefore, "restore must not mutate release payload");

  const baseline = await db.prepare(
    `SELECT baseline.id, baseline.payload_json
    FROM v03_collaboration_baselines baseline
    INNER JOIN v03_collaboration_streams stream ON stream.id = baseline.stream_id
    WHERE stream.video_id = ? AND baseline.id = stream.initial_baseline_id`,
  ).bind(videoId).first<{ id: string; payload_json: unknown }>();
  assert(baseline, "immutable initial baseline must remain available");
  const baselineBefore = JSON.stringify(baseline.payload_json);
  const baselineRestored = await restoreSharedV03FromBaseline({
    baselineId: baseline.id,
    actor: expert,
  });
  assert(baselineRestored.roundNumber > restored.roundNumber);
  const baselineAfter = await db.prepare(
    `SELECT payload_json FROM v03_collaboration_baselines WHERE id = ?`,
  ).bind(baseline.id).first<{ payload_json: unknown }>();
  assert.equal(
    JSON.stringify(baselineAfter?.payload_json),
    baselineBefore,
    "restore must not mutate the initial baseline payload",
  );

  await db.prepare(`UPDATE annotations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(annotationId).run();
  const fallback = await loadSharedV03ReadModel(videoId, db);
  assert(fallback, "immutable fallback must remain readable after mutable row is soft-deleted");
  assert.equal(fallback.mutableAvailable, false);
  assert(fallback.annotation.shots.length > 0);
  await db.prepare(`UPDATE annotations SET deleted_at = NULL WHERE id = ?`).bind(annotationId).run();

  const businessDuring = JSON.stringify(await db.prepare(businessFingerprintSql()).first());
  assert.equal(businessDuring, businessBefore, "TEST_ONLY collaboration must not alter business fingerprint");
  console.log(JSON.stringify({
    ok: true,
    runId,
    videoId,
    sharedAnnotationId: annotationId,
    reviewerRevision: savedByReviewer.annotation.revision,
    peerRevision: savedByPeer.annotation.revision,
    conflictProtected: true,
    logicalEmptyGetWrites: 0,
    concurrentFirstSaveUnique: true,
    secondMemberContinuedRevision: continuedByPeer.annotation.revision,
    expertOnly: true,
    immutableReleasePreserved: true,
    immutableInitialBaselinePreserved: true,
    softDeleteFallbackReadable: true,
    businessFingerprintUnchanged: true,
  }, null, 2));
} finally {
  await runFixture("cleanup");
  const businessAfter = JSON.stringify(await db.prepare(businessFingerprintSql()).first());
  assert.equal(businessAfter, businessBefore, "cleanup must restore the business fingerprint");
}
