import test from "node:test";
import assert from "node:assert/strict";
import {
  decideV04FreshWorkspaceSync,
  decideV04FreshWorkspaceTransition,
  decideV04InternalNavigation,
  decideV04ManualSave,
  effectiveV04SaveStatus,
  ensureV04NavigationCoordinator,
  hasV04ServerDraftChanged,
  installV04NavigationTakeover,
  runV04DraftResume,
  runV04GuardedNavigation,
  runV04SubmissionAwareNavigation,
  shouldProtectV04Unload,
  V04GuardedNavigationCoordinator,
  V04SingleFlight,
  v04NavigationFailureMessage,
  type V04LocalDraftFacts,
} from "../lib/v04-workspace-lifecycle";
import {
  atomicallyClearConfirmedV04RecoveryRecords,
  classifyV04RecoveryConfirmation,
  clearSelectedV04RecoveryRecord,
  deriveV04SubmissionUiState,
  partitionV04RecoveryRecordsByOwner,
  planV04LiveDraftRebase,
  planV04ThreeWayChanges,
  planV04RecoveryMerge,
  shouldDisableV04Submission,
  V04LatestSaveCoordinator,
} from "../lib/v04-save-coordinator";
import { cloneV04UiDraft, emptyV04UiDraft } from "../lib/v04-ui-model";
import { evaluateV04FixturePublication } from "../lib/v04-ui-client-state";
import { isProtectedDraftWorkspacePath } from "../app/components/GlobalHomeButton";

function facts(overrides: Partial<V04LocalDraftFacts> = {}): V04LocalDraftFacts {
  return {
    saveStatus: "CLEAN",
    saveInFlight: false,
    editVersion: 0,
    savedVersion: 0,
    recoveryPending: false,
    ...overrides,
  };
}

test("deploy notifier blind fallback is forbidden on every draft workspace route", () => {
  assert.equal(isProtectedDraftWorkspacePath("/videos/video-a/practice"), true);
  assert.equal(isProtectedDraftWorkspacePath("/videos/video-a/practice/"), true);
  assert.equal(isProtectedDraftWorkspacePath("/v04-shadow/videos/aurora/workspace"), true);
  assert.equal(isProtectedDraftWorkspacePath("/videos/video-a"), false);
  assert.equal(isProtectedDraftWorkspacePath("/"), false);
});

test("fresh server sync compares the stable local base rather than an already-refreshed model", () => {
  const serverChanged = hasV04ServerDraftChanged(
    { revision: 0, hash: "base-0" },
    { revision: 1, hash: "server-1" },
  );
  assert.equal(serverChanged, true);
  assert.equal(decideV04FreshWorkspaceTransition({
    facts: facts({ saveStatus: "DIRTY", editVersion: 1 }),
    base: { revision: 0, hash: "base-0" },
    fresh: { revision: 1, hash: "server-1" },
  }), "PRESERVE_LOCAL_COMPARE");
  assert.equal(decideV04FreshWorkspaceTransition({
    facts: facts(),
    base: { revision: 0, hash: "base-0" },
    fresh: { revision: 1, hash: "server-1" },
  }), "SYNC_SERVER");
  assert.equal(decideV04FreshWorkspaceSync({
    ...facts({ saveStatus: "DIRTY", editVersion: 1 }),
    serverChanged: false,
  }), "PRESERVE_LOCAL");
});

test("a clean readonly tab adopts the other tab's saved draft and publication facts after reacquire", () => {
  const staleVisible = emptyV04UiDraft();
  const freshServer = cloneV04UiDraft(staleVisible);
  freshServer.commercialIntent = "B端已经保存";
  const staleMissing = evaluateV04FixturePublication(staleVisible).missing.length;
  const freshMissing = evaluateV04FixturePublication(freshServer).missing.length;
  assert.equal(freshMissing, staleMissing - 1);
  const decision = decideV04FreshWorkspaceTransition({
    facts: facts(),
    base: { revision: 0, hash: "base" },
    fresh: { revision: 1, hash: "fresh" },
  });
  const visible = decision === "SYNC_SERVER" ? freshServer : staleVisible;
  assert.equal(visible.commercialIntent, "B端已经保存");
  assert.equal(evaluateV04FixturePublication(visible).missing.length, freshMissing);

  const localDirty = cloneV04UiDraft(staleVisible);
  localDirty.creativeMotif = "A端未保存";
  assert.equal(decideV04FreshWorkspaceTransition({
    facts: facts({ saveStatus: "DIRTY", editVersion: 1 }),
    base: { revision: 0, hash: "base" },
    fresh: { revision: 1, hash: "fresh" },
  }), "PRESERVE_LOCAL_COMPARE");
  assert.equal(localDirty.creativeMotif, "A端未保存");
});

test("one or two edits before the debounce flush before internal navigation", async () => {
  for (const editVersion of [1, 2]) {
    let current = facts({ saveStatus: "DIRTY", editVersion, savedVersion: 0 });
    let recoveries = 0;
    let flushes = 0;
    let navigations = 0;
    const result = await runV04GuardedNavigation({
      facts: () => current,
      preserveRecovery: () => { recoveries += 1; },
      flush: async () => {
        flushes += 1;
        current = facts({ saveStatus: "SAVED", editVersion, savedVersion: editVersion });
        return true;
      },
      navigate: () => { navigations += 1; },
    });
    assert.equal(result, "NAVIGATED");
    assert.deepEqual({ recoveries, flushes, navigations }, { recoveries: 1, flushes: 1, navigations: 1 });
  }
});

test("guarded navigation trusts confirmed coordinator facts while the reducer ref is one frame behind", async () => {
  const coordinator = new V04LatestSaveCoordinator<string>();
  let saveStatus: V04LocalDraftFacts["saveStatus"] = "SAVING";
  let navigations = 0;
  coordinator.stage({ version: 1, draft: "latest" });
  const result = await runV04GuardedNavigation({
    facts: () => facts({
      saveStatus,
      saveInFlight: coordinator.isRunning,
      editVersion: 1,
      savedVersion: coordinator.savedVersion,
    }),
    preserveRecovery: () => undefined,
    flush: () => coordinator.flush(async () => true),
    navigate: () => { navigations += 1; },
  });
  assert.equal(saveStatus, "SAVING", "the React reducer ref intentionally remains on its prior frame");
  assert.equal(coordinator.savedVersion, 1);
  assert.equal(result, "NAVIGATED");
  assert.equal(navigations, 1);

  saveStatus = "ERROR_RETRYABLE";
  const blocked = await runV04GuardedNavigation({
    facts: () => facts({ saveStatus, editVersion: 1, savedVersion: 1 }),
    preserveRecovery: () => undefined,
    flush: async () => true,
    navigate: () => { navigations += 1; },
  });
  assert.equal(blocked, "BLOCKED_SAVE_PENDING");
  assert.equal(navigations, 1);
});

test("failed navigation save and conflict preserve the page and recovery", async () => {
  let recoveries = 0;
  let navigations = 0;
  const failed = await runV04GuardedNavigation({
    facts: () => facts({ saveStatus: "ERROR_RETRYABLE", editVersion: 1 }),
    preserveRecovery: () => { recoveries += 1; },
    flush: async () => false,
    navigate: () => { navigations += 1; },
  });
  assert.equal(failed, "BLOCKED_SAVE_FAILED");
  assert.equal(recoveries, 1);
  assert.equal(navigations, 0);

  const conflict = await runV04GuardedNavigation({
    facts: () => facts({ saveStatus: "CONFLICT", editVersion: 1 }),
    preserveRecovery: () => { recoveries += 1; },
    flush: async () => true,
    navigate: () => { navigations += 1; },
  });
  assert.equal(conflict, "BLOCKED_CONFLICT");
  assert.equal(navigations, 0);
});

test("pagehide and reload protect dirty or saving work without disturbing clean pages", () => {
  assert.equal(shouldProtectV04Unload(facts()), false);
  assert.equal(shouldProtectV04Unload(facts({ saveStatus: "DIRTY", editVersion: 1 })), true);
  assert.equal(shouldProtectV04Unload(facts({ saveStatus: "SAVING", saveInFlight: true, editVersion: 1 })), true);
  assert.equal(decideV04InternalNavigation(facts()), "NAVIGATE");
});

test("online and foreground recovery are single-flight and never auto-save a conflict", async () => {
  const singleFlight = new V04SingleFlight();
  let current = facts({ saveStatus: "OFFLINE_LOCAL", editVersion: 1 });
  let acquires = 0;
  let flushes = 0;
  let releaseAcquire!: () => void;
  const gate = new Promise<void>((resolve) => { releaseAcquire = resolve; });
  const operation = () => runV04DraftResume({
    facts: () => current,
    acquire: async () => { acquires += 1; await gate; return true; },
    hasRecoveryConflict: () => false,
    flush: async () => {
      flushes += 1;
      current = facts({ saveStatus: "SAVED", editVersion: 1, savedVersion: 1 });
      return true;
    },
  });
  const online = singleFlight.run(operation);
  const visible = singleFlight.run(operation);
  assert.equal(online, visible);
  releaseAcquire();
  assert.equal(await online, true);
  assert.deepEqual({ acquires, flushes }, { acquires: 1, flushes: 1 });

  current = facts({ saveStatus: "DIRTY", editVersion: 2, savedVersion: 1 });
  const blocked = await runV04DraftResume({
    facts: () => current,
    acquire: async () => true,
    hasRecoveryConflict: () => true,
    flush: async () => { throw new Error("conflict must not auto-save"); },
  });
  assert.equal(blocked, false);
});

test("resume single-flight clears a rejected attempt so a direct retry can proceed", async () => {
  const singleFlight = new V04SingleFlight();
  let attempts = 0;
  await assert.rejects(singleFlight.run(async () => {
    attempts += 1;
    throw new Error("network");
  }), /network/);
  assert.equal(await singleFlight.run(async () => {
    attempts += 1;
    return true;
  }), true);
  assert.equal(attempts, 2);
});

test("lease reacquire preserves a different-field server save and stops a same-field conflict", () => {
  const localChanges = [{ targetKey: "facts.commercialIntent", beforeValue: "", afterValue: "A本地" }];
  const serverAfterOtherTab = new Map<string, unknown>([
    ["facts.commercialIntent", ""],
    ["facts.storySynopsis", "B已保存"],
  ]);
  const disjoint = planV04ThreeWayChanges(localChanges, (key) => serverAfterOtherTab.get(key));
  assert.equal(disjoint.conflicts.length, 0);
  assert.deepEqual(disjoint.changes.map((change) => change.targetKey), ["facts.commercialIntent"]);
  assert.equal(serverAfterOtherTab.get("facts.storySynopsis"), "B已保存");

  serverAfterOtherTab.set("facts.commercialIntent", "B同字段");
  const sameTarget = planV04ThreeWayChanges(localChanges, (key) => serverAfterOtherTab.get(key));
  assert.deepEqual(sameTarget.changes, []);
  assert.deepEqual(sameTarget.conflicts, ["facts.commercialIntent"]);
});

test("manual save followed by more editing and submit-time flush drain to the latest version", async () => {
  const coordinator = new V04LatestSaveCoordinator<string>();
  const saved: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  coordinator.stage({ version: 1, draft: "manual-v1" });
  const manual = coordinator.flush(async (attempt) => {
    if (attempt.version === 1) await firstGate;
    saved.push(attempt.draft);
    return true;
  });
  coordinator.stage({ version: 2, draft: "continued-v2" });
  const submitFlush = coordinator.flush(async (attempt) => {
    saved.push(attempt.draft);
    return true;
  });
  releaseFirst();
  assert.equal(await manual, true);
  assert.equal(await submitFlush, true);
  assert.deepEqual(saved, ["manual-v1", "continued-v2"]);
  assert.equal(coordinator.savedVersion, 2);
});

test("deploy-update navigation synchronously preserves recovery and drains edits made while saving", async () => {
  const target = new EventTarget();
  const navigation = new V04GuardedNavigationCoordinator();
  const saves = new V04LatestSaveCoordinator<string>();
  let current = facts({ saveStatus: "DIRTY", editVersion: 1 });
  let recoveries = 0;
  let flushCalls = 0;
  let reloads = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  saves.stage({ version: 1, draft: "first edit" });
  const cleanup = installV04NavigationTakeover(target, "update", {
    preserveRecovery: () => { recoveries += 1; },
    run: (reload) => {
      void navigation.run({
        facts: () => ({ ...current, saveInFlight: saves.isRunning, savedVersion: saves.savedVersion }),
        preserveRecovery: () => { recoveries += 1; },
        flush: () => {
          flushCalls += 1;
          return saves.flush(async (attempt) => {
            if (attempt.version === 1) {
              current = facts({ saveStatus: "SAVING", saveInFlight: true, editVersion: 2 });
              saves.stage({ version: 2, draft: "second edit while saving" });
              await firstGate;
            }
            return true;
          });
        },
        navigate: reload,
      });
    },
  });

  const first = new CustomEvent("update", { cancelable: true, detail: { continueNavigation: () => { reloads += 1; } } });
  const duplicate = new CustomEvent("update", { cancelable: true, detail: { continueNavigation: () => { reloads += 100; } } });
  assert.equal(target.dispatchEvent(first), false, "the workspace must take over the blind reload synchronously");
  assert.equal(target.dispatchEvent(duplicate), false, "a repeated click must also stay prevented");
  assert.equal(recoveries, 3,
    "each event gets an immediate local fallback and the single guarded flush refreshes it once");
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saves.savedVersion, 2);
  assert.equal(flushCalls, 1, "concurrent update clicks join one flush");
  assert.equal(reloads, 1, "only the first takeover may continue navigation once");
  cleanup();
  assert.equal(target.dispatchEvent(new CustomEvent("update", {
    cancelable: true,
    detail: { continueNavigation: () => { reloads += 1; } },
  })), true, "unmount removes the takeover listener");
  assert.equal(reloads, 1);
});

test("deploy-update reload stays blocked for offline, error, conflict and lease-held save failures", async () => {
  for (const sample of [
    { saveStatus: "OFFLINE_LOCAL" as const, flush: false, expected: "BLOCKED_SAVE_FAILED" },
    { saveStatus: "ERROR_RETRYABLE" as const, flush: false, expected: "BLOCKED_SAVE_FAILED" },
    { saveStatus: "CONFLICT" as const, flush: true, expected: "BLOCKED_CONFLICT" },
  ]) {
    let reloads = 0;
    const result = await runV04GuardedNavigation({
      facts: () => facts({ saveStatus: sample.saveStatus, editVersion: 1 }),
      preserveRecovery: () => undefined,
      flush: async () => sample.flush,
      navigate: () => { reloads += 1; },
    });
    assert.equal(result, sample.expected);
    assert.equal(reloads, 0);
  }
});

test("clean deploy-update reloads immediately while an unmounted pending takeover never reloads late", async () => {
  let cleanReloads = 0;
  const clean = new V04GuardedNavigationCoordinator();
  assert.equal(await clean.run({
    facts: () => facts(),
    preserveRecovery: () => undefined,
    flush: async () => { throw new Error("clean drafts do not flush"); },
    navigate: () => { cleanReloads += 1; },
  }), "NAVIGATED");
  assert.equal(cleanReloads, 1);

  const pending = new V04GuardedNavigationCoordinator();
  let lateReloads = 0;
  let pendingFacts = facts({ saveStatus: "DIRTY", editVersion: 1, savedVersion: 0 });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const operation = pending.run({
    facts: () => pendingFacts,
    preserveRecovery: () => undefined,
    flush: async () => {
      await saveGate;
      pendingFacts = facts({ saveStatus: "SAVED", editVersion: 1, savedVersion: 1 });
      return true;
    },
    navigate: () => { lateReloads += 1; },
  });
  pending.dispose();
  releaseSave();
  assert.equal(await operation, "CANCELLED");
  assert.equal(lateReloads, 0);
});

test("submit success can immediately navigate to either formal header destination", async () => {
  const navigation = new V04GuardedNavigationCoordinator();
  const destinations: string[] = [];
  let submissions = 0;
  const confirmedSubmission = Promise.resolve().then(() => {
    submissions += 1;
    return true;
  });
  for (const destination of ["/", "/videos/video-test"]) {
    const result = await runV04SubmissionAwareNavigation({
      pendingSubmission: confirmedSubmission,
      runNavigation: () => navigation.run({
        // Model a React frame that still renders SAVING even though the one
        // authoritative coordinator has confirmed the submitted edit.
        facts: () => facts({ saveStatus: "SAVING", editVersion: 4, savedVersion: 4 }),
        preserveRecovery: () => undefined,
        flush: async () => { throw new Error("confirmed submission must not save again"); },
        navigate: () => { destinations.push(destination); },
      }),
    });
    assert.equal(result, "NAVIGATED");
  }
  assert.equal(submissions, 1, "both links observe the same confirmed immutable submission");
  assert.deepEqual(destinations, ["/", "/videos/video-test"]);
});

test("navigation waits for an in-flight idempotent submit and blocks a failed submit visibly", async () => {
  let settleSubmit!: (value: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { settleSubmit = resolve; });
  let navigations = 0;
  const operation = runV04SubmissionAwareNavigation({
    pendingSubmission: pending,
    runNavigation: async () => { navigations += 1; return "NAVIGATED"; },
  });
  assert.equal(navigations, 0);
  settleSubmit(true);
  assert.equal(await operation, "NAVIGATED");
  assert.equal(navigations, 1);

  const failed = await runV04SubmissionAwareNavigation({
    pendingSubmission: Promise.resolve(false),
    runNavigation: async () => { throw new Error("a failed submit must not leave"); },
  });
  assert.equal(failed, "BLOCKED_SUBMIT_FAILED");
  assert.match(v04NavigationFailureMessage(failed), /提交未完成/);
});

test("recovery confirmation distinguishes absorbed, pending and conflicting local copies", () => {
  const changes = [{ targetKey: "facts.commercialIntent", beforeValue: "", afterValue: "已填写" }];
  assert.equal(classifyV04RecoveryConfirmation(changes, () => "已填写"), "CONFIRMED");
  assert.equal(classifyV04RecoveryConfirmation(changes, () => ""), "NOT_ABSORBED");
  assert.equal(classifyV04RecoveryConfirmation(changes, () => "服务器不同值"), "CONFLICT");

  let flushes = 0;
  let navigations = 0;
  return runV04GuardedNavigation({
    facts: () => facts({ recoveryPending: true, editVersion: 1, savedVersion: 1 }),
    preserveRecovery: () => undefined,
    flush: async () => { flushes += 1; return true; },
    navigate: () => { navigations += 1; },
  }).then((result) => {
    assert.equal(result, "BLOCKED_RECOVERY");
    assert.deepEqual({ flushes, navigations }, { flushes: 0, navigations: 0 });
    assert.match(v04NavigationFailureMessage(result), /恢复副本/);
  });
});

test("a mounted page recovery stays a durability copy after choosing the server draft", () => {
  type Recovery = {
    key: string;
    before: string;
    after: string;
  };
  const oldReopenedCopy: Recovery = { key: "old-document", before: "server", after: "old-local" };
  const cleared = clearSelectedV04RecoveryRecord([oldReopenedCopy], 0, () => true);
  assert.equal(cleared.status, "CLEARED");
  assert.deepEqual(cleared.remaining, [], "choosing the server draft removes the selected old copy first");

  const currentPageCopy: Recovery = { key: "current-document", before: "server", after: "new-local" };
  const beforeSave = partitionV04RecoveryRecordsByOwner(
    [currentPageCopy],
    currentPageCopy,
    (record) => record.key,
  );
  assert.equal(beforeSave.current, currentPageCopy);
  assert.deepEqual(beforeSave.historical, [],
    "this page's dirty fallback must never reappear as a reopened recovery prompt");
  assert.equal(classifyV04RecoveryConfirmation([{
    targetKey: "facts.creativeMotif",
    targetLabel: "创意母题",
    valueType: "TEXT",
    beforeValue: currentPageCopy.before,
    afterValue: currentPageCopy.after,
  }], () => "server"), "NOT_ABSORBED");
  assert.equal(effectiveV04SaveStatus(facts({
    saveStatus: "ERROR_RETRYABLE",
    editVersion: 1,
    savedVersion: 0,
    recoveryPending: beforeSave.historical.length > 0,
  })), "ERROR_RETRYABLE", "a failed save is visible as unsaved, not as a historical recovery conflict");
  assert.equal(decideV04ManualSave(facts({
    saveStatus: "ERROR_RETRYABLE",
    editVersion: 1,
    savedVersion: 0,
    recoveryPending: beforeSave.historical.length > 0,
  })), "SAVE", "the same mounted page may retry its one serialized save path");

  const stored = new Set([currentPageCopy.key]);
  assert.equal(atomicallyClearConfirmedV04RecoveryRecords(
    [currentPageCopy],
    () => true,
    (record) => stored.delete(record.key),
    (record) => { stored.add(record.key); return true; },
  ), "CLEARED");
  assert.equal(stored.size, 0, "server confirmation clears the mounted page fallback");
});

test("a slow v1 confirmation advances the live base without swallowing v2", () => {
  const v1 = [{
    targetKey: "facts.creativeMotif", targetLabel: "创意母题", valueType: "TEXT" as const,
    beforeValue: "", afterValue: "第一段输入",
  }];
  const v2 = [{
    targetKey: "facts.creativeMotif", targetLabel: "创意母题", valueType: "TEXT" as const,
    beforeValue: "", afterValue: "第一段输入后继续填写",
  }, {
    targetKey: "facts.storySynopsis", targetLabel: "故事梗概", valueType: "TEXT" as const,
    beforeValue: "", afterValue: "第二个字段",
  }];
  const server = new Map<string, unknown>([
    ["facts.creativeMotif", "第一段输入"],
    ["facts.storySynopsis", ""],
  ]);
  const rebased = planV04LiveDraftRebase(v2, v1, (targetKey) => server.get(targetKey));
  assert.deepEqual(rebased.conflicts, []);
  assert.deepEqual(rebased.changes.map((change) => ({
    targetKey: change.targetKey,
    beforeValue: change.beforeValue,
    afterValue: change.afterValue,
  })), [{
    targetKey: "facts.creativeMotif",
    beforeValue: "第一段输入",
    afterValue: "第一段输入后继续填写",
  }, {
    targetKey: "facts.storySynopsis",
    beforeValue: "",
    afterValue: "第二个字段",
  }]);

  server.set("facts.creativeMotif", "另一编辑端内容");
  assert.deepEqual(
    planV04LiveDraftRebase(v2, v1, (targetKey) => server.get(targetKey)).conflicts,
    ["facts.creativeMotif"],
    "an unrelated same-target update remains fail-closed",
  );
});

test("document generation hides only this live page and keeps every foreign recovery visible", () => {
  const records = [
    { generation: "document-current", writtenAt: "new" },
    { generation: "document-other-tab", writtenAt: "other" },
    { generation: "document-old-mount", writtenAt: "old" },
    { generation: "document-current", writtenAt: "duplicate-write-time" },
  ];
  const partitioned = partitionV04RecoveryRecordsByOwner(
    records,
    records[0],
    (record) => record.generation,
  );
  assert.equal(partitioned.current?.generation, "document-current");
  assert.deepEqual(partitioned.historical.map((record) => record.generation), [
    "document-other-tab",
    "document-old-mount",
  ], "other tabs and prior mounts remain visible while repeated current-generation writes dedupe");
});

test("a newer or unresolved recovery fact always outranks an older SAVED timestamp", () => {
  const serverSaved = facts({
    saveStatus: "SAVED",
    editVersion: 3,
    savedVersion: 3,
    recoveryPending: true,
  });
  assert.equal(effectiveV04SaveStatus(serverSaved), "RECOVERY_PENDING");
  assert.equal(decideV04ManualSave(serverSaved), "BLOCK_RECOVERY");
  assert.equal(decideV04InternalNavigation(serverSaved), "BLOCK_RECOVERY");

  const reactFrameBehind = facts({
    saveStatus: "DIRTY",
    editVersion: 3,
    savedVersion: 3,
    recoveryPending: true,
  });
  assert.equal(effectiveV04SaveStatus(reactFrameBehind), "RECOVERY_PENDING",
    "normalization must never turn a pending recovery back into SAVED");
});

test("fill, manual save, fresh confirmation, leave and re-enter read the server value with no recovery", async () => {
  const change = {
    targetKey: "facts.creativeMotif", targetLabel: "创意母题", valueType: "TEXT" as const,
    beforeValue: "", afterValue: "服务器已确认的最新填写",
  };
  const server = new Map<string, unknown>([[change.targetKey, change.beforeValue]]);
  const recoveryStorage = new Set(["current-tab-recovery"]);
  const coordinator = new V04LatestSaveCoordinator<typeof change>();
  coordinator.stage({ version: 1, draft: change });
  assert.equal(await coordinator.flush(async (attempt) => {
    server.set(attempt.draft.targetKey, attempt.draft.afterValue);
    return true;
  }), true);
  assert.equal(classifyV04RecoveryConfirmation([change], (key) => server.get(key)), "CONFIRMED");
  const clearance = atomicallyClearConfirmedV04RecoveryRecords(
    [...recoveryStorage],
    () => classifyV04RecoveryConfirmation([change], (key) => server.get(key)) === "CONFIRMED",
    (record) => recoveryStorage.delete(record),
    (record) => { recoveryStorage.add(record); return true; },
  );
  assert.equal(clearance, "CLEARED");
  assert.equal(recoveryStorage.size, 0);
  const reentered = facts({
    saveStatus: "SAVED", editVersion: 0, savedVersion: 0, recoveryPending: false,
  });
  assert.equal(effectiveV04SaveStatus(reentered), "SAVED");
  assert.equal(server.get(change.targetKey), "服务器已确认的最新填写");
});

test("independent recovery copies merge only non-overlapping targets and retain same-target conflicts", () => {
  const server = new Map<string, unknown>([["facts.x", "x0"], ["facts.y", "y0"]]);
  const local = new Map(server);
  const first = [{
    targetKey: "facts.x", targetLabel: "X", valueType: "TEXT" as const,
    beforeValue: "x0", afterValue: "x-from-a",
  }];
  const second = [{
    targetKey: "facts.y", targetLabel: "Y", valueType: "TEXT" as const,
    beforeValue: "y0", afterValue: "y-from-b",
  }];
  const mergeA = planV04RecoveryMerge(first, (key) => server.get(key), (key) => local.get(key));
  assert.equal(mergeA.kind, "MERGE");
  for (const change of mergeA.changes) local.set(change.targetKey, change.afterValue);
  const mergeB = planV04RecoveryMerge(second, (key) => server.get(key), (key) => local.get(key));
  assert.equal(mergeB.kind, "MERGE");
  for (const change of mergeB.changes) local.set(change.targetKey, change.afterValue);
  assert.deepEqual(Object.fromEntries(local), { "facts.x": "x-from-a", "facts.y": "y-from-b" });

  const sameTarget = planV04RecoveryMerge(
    [{
      targetKey: "facts.x", targetLabel: "X", valueType: "TEXT" as const,
      beforeValue: "x0", afterValue: "x-from-other-tab",
    }],
    (key) => server.get(key),
    (key) => local.get(key),
  );
  assert.equal(sameTarget.kind, "LOCAL_CONFLICT");
  assert.deepEqual(sameTarget.conflicts, ["facts.x"]);

  server.set("facts.y", "server-new-y");
  const serverConflict = planV04RecoveryMerge(second, (key) => server.get(key), (key) => local.get(key));
  assert.equal(serverConflict.kind, "SERVER_CONFLICT");
  assert.deepEqual(serverConflict.conflicts, ["facts.y"]);
});

test("confirmed recovery storage, ref and state advance as one fail-closed decision", () => {
  const records = ["one", "two"] as const;
  const storage = new Set<string>(records);
  let submissions = 0;
  const confirmed = atomicallyClearConfirmedV04RecoveryRecords(
    records,
    () => true,
    (record) => storage.delete(record),
    (record) => { storage.add(record); return true; },
  );
  if (confirmed === "CLEARED") submissions += 1;
  assert.equal(confirmed, "CLEARED");
  assert.equal(submissions, 1);
  assert.deepEqual([...storage], []);

  for (const unresolved of ["NOT_ABSORBED", "CONFLICT"] as const) {
    const unresolvedStorage = new Set<string>(records);
    let unresolvedSubmissions = 0;
    const result = atomicallyClearConfirmedV04RecoveryRecords(
      records,
      (record) => record !== "two" && unresolved === "NOT_ABSORBED",
      (record) => unresolvedStorage.delete(record),
      (record) => { unresolvedStorage.add(record); return true; },
    );
    if (result === "CLEARED") unresolvedSubmissions += 1;
    assert.equal(result, "UNCONFIRMED");
    assert.equal(unresolvedSubmissions, 0);
    assert.deepEqual([...unresolvedStorage], [...records]);
  }

  const failedStorage = new Set<string>(records);
  let failedSubmissions = 0;
  const storageFailure = atomicallyClearConfirmedV04RecoveryRecords(
    records,
    () => true,
    (record) => record === "two" ? false : failedStorage.delete(record),
    (record) => { failedStorage.add(record); return true; },
  );
  if (storageFailure === "CLEARED") failedSubmissions += 1;
  assert.equal(storageFailure, "STORAGE_FAILED");
  assert.equal(failedSubmissions, 0);
  assert.deepEqual([...failedStorage].sort(), [...records].sort(), "an earlier delete is rolled back");
});

test("submission and keep-server controls stay fail-closed while recovery is pending", () => {
  assert.equal(shouldDisableV04Submission({
    canEdit: true,
    publicationReady: true,
    submitting: false,
    recoveryPending: true,
    noChangesToSubmit: false,
  }), true);
  assert.equal(shouldDisableV04Submission({
    canEdit: true,
    publicationReady: true,
    submitting: false,
    recoveryPending: false,
    noChangesToSubmit: false,
  }), false);

  const records = ["local-copy"];
  const failed = clearSelectedV04RecoveryRecord(records, 0, () => false);
  assert.equal(failed.status, "STORAGE_FAILED");
  assert.deepEqual(failed.remaining, records, "prompt state stays aligned with retained storage");
  const cleared = clearSelectedV04RecoveryRecord(records, 0, () => true);
  assert.equal(cleared.status, "CLEARED");
  assert.deepEqual(cleared.remaining, []);
});

test("fixed-header and module-four submission controls share one truthful human state", () => {
  const common = {
    canEdit: true,
    editAccessPending: false,
    otherEditor: false,
    publicationReady: true,
    submitting: false,
    busy: false,
    recoveryPending: false,
    recoveryIntegrityBlocked: false,
    noChangesToSubmit: false,
    outcome: "IDLE" as const,
    submissionNumber: 1,
  };
  assert.deepEqual(deriveV04SubmissionUiState(common), {
    state: "READY",
    disabled: false,
    buttonLabel: "提交并更新案例",
    headline: "可以提交并更新案例",
    reason: "提交会先串行保存最新修改，再创建不可变版本；保存失败时绝不会提交。",
  });
  assert.equal(deriveV04SubmissionUiState({ ...common, submitting: true }).buttonLabel,
    "正在保存并提交…");
  assert.equal(deriveV04SubmissionUiState({
    ...common,
    noChangesToSubmit: true,
    outcome: "SUCCEEDED",
    submissionNumber: 2,
  }).headline, "提交成功 · V2");
  assert.equal(deriveV04SubmissionUiState({
    ...common,
    noChangesToSubmit: true,
    outcome: "SUCCEEDED",
  }).buttonLabel, "当前内容已提交");
  assert.deepEqual(deriveV04SubmissionUiState({
    ...common,
    outcome: "FAILED",
    errorMessage: "网络暂不可用",
  }), {
    state: "RETRY",
    disabled: false,
    buttonLabel: "重试提交",
    headline: "提交未完成 · 可重试",
    reason: "网络暂不可用",
  });
});

test("submission UI fails closed with a visible natural-language reason", () => {
  const common = {
    canEdit: true,
    editAccessPending: false,
    otherEditor: false,
    publicationReady: true,
    submitting: false,
    busy: false,
    recoveryPending: false,
    recoveryIntegrityBlocked: false,
    noChangesToSubmit: false,
    outcome: "IDLE" as const,
    submissionNumber: 0,
  };
  for (const state of [
    deriveV04SubmissionUiState({ ...common, publicationReady: false }),
    deriveV04SubmissionUiState({ ...common, recoveryPending: true }),
    deriveV04SubmissionUiState({ ...common, canEdit: false, editAccessPending: true }),
    deriveV04SubmissionUiState({ ...common, canEdit: false, otherEditor: true }),
  ]) {
    assert.equal(state.disabled, true);
    assert(state.buttonLabel.length > 0);
    assert(state.reason.length > 0);
    assert.doesNotMatch(`${state.buttonLabel}${state.headline}${state.reason}`, /租约|token|编辑权/);
  }
});

test("an active update takeover drains once and honors the latest distinct link target", async () => {
  const navigation = new V04GuardedNavigationCoordinator();
  let releaseSave!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let current = facts({ saveStatus: "DIRTY", editVersion: 1 });
  const destinations: string[] = [];
  const update = navigation.run({
    facts: () => current,
    preserveRecovery: () => undefined,
    flush: async () => {
      await gate;
      current = facts({ saveStatus: "SAVED", editVersion: 1, savedVersion: 1 });
      return true;
    },
    navigate: () => { destinations.push("reload"); },
  });
  const library = navigation.run({
    facts: () => current,
    preserveRecovery: () => undefined,
    flush: async () => true,
    navigate: () => { destinations.push("library"); },
    navigationKey: "library",
  });
  const detail = navigation.run({
    facts: () => current,
    preserveRecovery: () => undefined,
    flush: async () => true,
    navigate: () => { destinations.push("detail"); },
    navigationKey: "detail",
  });
  releaseSave();
  assert.deepEqual(await Promise.all([update, library, detail]), ["NAVIGATED", "NAVIGATED", "NAVIGATED"]);
  assert.deepEqual(destinations, ["detail"], "the latest explicit link replaces the stale reload destination");
});

test("a retired coordinator and a throwing router callback cannot swallow later links", async () => {
  const retired = new V04GuardedNavigationCoordinator();
  retired.dispose();
  const current = ensureV04NavigationCoordinator(retired);
  assert.notEqual(current, retired);
  assert.equal(current.isDisposed, false);

  const failed = await runV04SubmissionAwareNavigation({
    pendingSubmission: null,
    runNavigation: () => current.run({
      facts: () => facts(),
      preserveRecovery: () => undefined,
      flush: async () => true,
      navigate: () => { throw new Error("router failed"); },
    }),
  });
  assert.equal(failed, "NAVIGATION_FAILED");
  assert.equal(current.isRunning, false);
  assert.match(v04NavigationFailureMessage(failed), /跳转未完成/);

  let navigations = 0;
  assert.equal(await current.run({
    facts: () => facts(),
    preserveRecovery: () => undefined,
    flush: async () => true,
    navigate: () => { navigations += 1; },
  }), "NAVIGATED");
  assert.equal(navigations, 1);
});

test("every prevented-navigation outcome has a visible reason", () => {
  for (const result of [
    "BLOCKED_RECOVERY",
    "BLOCKED_CONFLICT",
    "BLOCKED_SAVE_FAILED",
    "BLOCKED_SAVE_PENDING",
    "BLOCKED_SUBMIT_FAILED",
    "CANCELLED",
    "NAVIGATION_FAILED",
  ] as const) {
    assert.notEqual(v04NavigationFailureMessage(result), "", result);
  }
  assert.equal(v04NavigationFailureMessage("NAVIGATED"), "");
});
