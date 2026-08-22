import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("formal V0.4 workspace uses one serialized save path for autosave, manual save and submit flush", async () => {
  const source = await readFile(
    new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /V04LatestSaveCoordinator/);
  assert.match(source, /const requestSave[\s\S]*saveCoordinatorRef\.current\.flush\(commitSaveAttempt\)/);
  assert.match(source, /V04_AUTOSAVE_DEBOUNCE_MS[\s\S]*requestSave\(cloneV04UiDraft\(draftRef\.current\)/);
  assert.match(source, /const manualSave[\s\S]*requestSave\(cloneV04UiDraft\(draftRef\.current\)/);
  assert.match(source, /const submitDraft[\s\S]*await requestSave\(cloneV04UiDraft\(draftRef\.current\)/);
  assert.doesNotMatch(source, /const submitDisabled =[^\n]*saveMachine\.status === "SAVING"/,
    "clicking submit during an autosave must join and flush the active coordinator rather than becoming unavailable");
  assert.equal((source.match(/v04UiApi\.save<SaveResult>/g) ?? []).length, 1,
    "all draft saves must share one mutation call site");
  assert.match(source, /changeSetIdsRef[\s\S]*changeSetId[\s\S]*changeSetIdsRef\.current\.delete/);
  assert.match(source, /submitInFlightRef[\s\S]*submitKeysRef[\s\S]*idempotencyKey/);
});

test("formal V0.4 workspace invalidates stale leases, preserves local recovery and exposes actionable status", async () => {
  const source = await readFile(
    new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /heartbeatLease[\s\S]*isV04LeaseFailure[\s\S]*clearLeaseProof[\s\S]*canRecoverV04LeaseProof/);
  assert.match(source, /const requestEditAccess[\s\S]*refreshWorkspace\(\)[\s\S]*canRecoverV04LeaseProof[\s\S]*acquireLease/,
    "initial lease failures must become a visible, retryable edit-access state instead of being swallowed");
  assert.match(source, /planV04EditAccessRecovery[\s\S]*window\.setTimeout[\s\S]*resumeDraft\(true\)/,
    "a readonly page must refresh and reacquire after a stale lease expires");
  assert.match(source, /runV04LeaseBoundMutationWithSingleRecovery/,
    "a save may reacquire and retry the lease exactly once through the tested coordinator");
  assert.match(source, /!current\.viewerCapabilities\.canAcquireLease && !current\.viewerCapabilities\.canEdit/,
    "a same-tab refresh that still holds the lease may POST to rotate its lost proof");
  assert.match(source, /const resumeDraft[\s\S]*runV04DraftResume[\s\S]*requestEditAccess/,
    "timer, heartbeat, online and foreground recovery share one single-flight coordinator");
  assert.match(source, /draftBaseRevisionRef[\s\S]*draftBaseHashRef[\s\S]*decideV04FreshWorkspaceTransition/,
    "fresh server comparison must retain the revision/hash on which the local draft was based");
  assert.match(source, /serverRevision: draftBaseRevisionRef\.current[\s\S]*serverHash: draftBaseHashRef\.current/,
    "a recovery copy must record the original server base rather than relabeling a stale draft as fresh");
  assert.match(source, /getWorkspaceSession\(videoId\)\.then\(\(session\)[\s\S]*tabToken\.current = session\.tabToken[\s\S]*recoveryTabIdRef\.current = session\.recoveryTabId[\s\S]*return loadWorkspace\(\)/,
    "the atomic document identity must be claimed before the first workspace GET");
  assert.match(source, /discoverV04Recoveries[\s\S]*RECOVERY_DISCOVERED[\s\S]*setModel\(next\)/,
    "initial load must publish recovery facts before exposing the server model as saved");
  assert.match(source, /resolveV04InitialRecoveryState[\s\S]*RECOVERY_INTEGRITY_FAILED[\s\S]*SERVER_CONFIRMED/,
    "initial recovery storage and cleanup must resolve through one fail-closed decision before SAVED");
  assert.match(source, /recoveryIntegrityBlocked[\s\S]*重试恢复核验/,
    "storage integrity failures must stay visible and offer an explicit retry");
  assert.match(source, /writeV04Recovery\(storage/);
  assert.match(source, /discoverV04Recoveries<V04UiDraft, V04Payload>\(storage/);
  assert.match(source, /initialRecoveryScanCompleteRef\.current[\s\S]*resolveInitialRecoveryIntegrity/,
    "a mounted workspace must not rediscover its own active durability copy after refresh");
  assert.match(source, /initialWorkspaceLoadCompleteRef\.current[\s\S]*firstLoad[\s\S]*reconcileFreshWorkspace\(previous, next/,
    "a same-mount effect refresh must reconcile server facts without replaying first-load draft initialization");
  assert.match(source, /currentOwnedRecoveryRef[\s\S]*partitionV04RecoveryRecordsByOwner/,
    "current-page recovery ownership must stay separate from reopened recovery prompts");
  assert.match(source, /恢复本地草稿/);
  assert.match(source, /对照服务器/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.match(source, /role="alert" aria-live="assertive"/);
  assert.match(source, /className=\{styles\.inlineActionError\}/);
  assert.match(source, /data-v04-edit-access-blocked[\s\S]*当前字段暂时只读[\s\S]*重新尝试编辑/,
    "the reason and recovery action remain visible beside a located readonly field");
  assert.match(source, /visibleSaveLabel[\s\S]*只读 · 正在恢复编辑状态/,
    "a lease-less readonly page must not continue to claim that all local edits are saved");
  assert.match(source, /deriveV04SubmissionUiState[\s\S]*otherEditor:[\s\S]*data-submit-state/,
    "both submission controls must derive a visible shared state from the same facts");
  assert.equal((source.match(/\{submitUi\.buttonLabel\}/g) ?? []).length, 2,
    "fixed-header and module-four controls show the same stateful label");
  assert.match(source, /pagehide/);
  assert.match(source, /beforeunload/);
  assert.match(source, /addEventListener\("online"/);
  assert.match(source, /const onHistoryTraversal[\s\S]*persistRecovery[\s\S]*addEventListener\("popstate"/,
    "browser history traversal must synchronously preserve a local recovery copy without a fragile history loop");
  assert.match(source, /visibilitychange/);
  assert.match(source, /releaseLeaseKeepalive/);
  assert.match(source, /shouldReleaseV04Lease/);
  assert.match(source, /basePayload:[\s\S]*planV04ThreeWayChanges/);
  assert.match(source, /本机恢复记录无法完整读取或安全清理/);
  assert.equal((source.match(/onClick=\{\(event\) => navigateWithSavedDraft\(event,/g) ?? []).length, 3,
    "the brand, case library and readonly-result exits must all flush through the guarded navigation path");
});

test("formal V0.4 mutations use the 15 second abort boundary and never submit after a failed flush", async () => {
  const source = await readFile(
    new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /runV04WithTimeout\(\(signal\) => v04UiApi\.save/);
  assert.match(source, /runV04WithTimeout\(\(signal\) => v04UiApi\.submit/);
  const flushGuard = source.indexOf("if (!await requestSave");
  const submission = source.indexOf("v04UiApi.submit", flushGuard);
  assert(flushGuard >= 0 && submission > flushGuard,
    "submit must be downstream of a successful latest-draft flush");
  assert.match(source, /serverPublication[\s\S]*canSubmitV04ServerDraft\(\{[\s\S]*serverPublicationReady: serverPublication\.ready/);
});

test("server save and submit keep lease, idempotency, immutable snapshot, pointer and audit inside one transaction", async () => {
  const source = await readFile(
    new URL("../lib/v04-workspace-service.ts", import.meta.url),
    "utf8",
  );
  const saveStart = source.indexOf("export async function saveV04Draft");
  const submitStart = source.indexOf("export async function submitV04Draft");
  const saveSource = source.slice(saveStart, submitStart);
  const nextExport = source.indexOf("export async function", submitStart + 20);
  const submitSource = source.slice(submitStart, nextExport > submitStart ? nextExport : undefined);
  assert.match(saveSource, /return db\.withTransaction\(async \(transaction\) =>/);
  assert.match(saveSource, /requireValidLease\(transaction/);
  assert.match(saveSource, /change_set_id = \?/);
  assert.match(saveSource, /INSERT INTO annotation_snapshots/);
  assert.match(saveSource, /INSERT INTO collaboration_revision_events/);
  assert.match(saveSource, /UPDATE collaboration_workspaces\s+SET[\s\S]*current_working_snapshot_id/);
  assert.match(saveSource, /insertAudit\(transaction/);
  assert.match(submitSource, /return db\.withTransaction\(async \(transaction\) =>/);
  assert.match(submitSource, /requireValidLease\(transaction/);
  assert.match(submitSource, /idempotency_key = \?/);
  assert.match(submitSource, /validateV04Publication/);
  assert.match(submitSource, /INSERT INTO annotation_submission_snapshots/);
  assert.match(submitSource, /UPDATE collaboration_workspaces\s+SET[\s\S]*latest_submission_snapshot_id/);
  assert.match(submitSource, /insertAudit\(transaction/);
});

test("lease proof recovery and history restore remain bounded and idempotent", async () => {
  const [workspace, service] = await Promise.all([
    readFile(new URL("../components/v04/V04WorkspaceClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/v04-workspace-service.ts", import.meta.url), "utf8"),
  ]);
  assert.match(service, /sameStableTab[\s\S]*V04_LEASE_PROOF_RECOVERED/);
  assert.match(service, /holder_user_id === actor\.userId[\s\S]*session_id === actor\.sessionId[\s\S]*tab_token_hash === tabHash/);
  assert.match(workspace, /restoreInFlightRef[\s\S]*saveCoordinatorRef\.current\.isRunning/);
  assert.match(workspace, /restoreKeysRef[\s\S]*idempotencyKey[\s\S]*runV04WithTimeout\(\(signal\) => v04UiApi\.restore/);
  assert.match(workspace, /RESET_FROM_SERVER/);
  assert.match(workspace, /当前仍有未确认修改或保存\/提交正在进行/);
});
