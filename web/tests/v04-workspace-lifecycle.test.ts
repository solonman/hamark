import test from "node:test";
import assert from "node:assert/strict";
import {
  decideV04FreshWorkspaceSync,
  decideV04FreshWorkspaceTransition,
  decideV04InternalNavigation,
  hasV04ServerDraftChanged,
  installV04NavigationTakeover,
  runV04DraftResume,
  runV04GuardedNavigation,
  shouldProtectV04Unload,
  V04GuardedNavigationCoordinator,
  V04SingleFlight,
  type V04LocalDraftFacts,
} from "../lib/v04-workspace-lifecycle";
import {
  planV04ThreeWayChanges,
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
