import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitV04ServerDraft,
  canMutateV04Draft,
  canRecoverV04LeaseProof,
  canStartV04Restore,
  planV04EditAccessRecovery,
  planV04ThreeWayChanges,
  runV04LeaseBoundMutationWithSingleRecovery,
  shouldReleaseV04Lease,
  V04LatestSaveCoordinator,
} from "../lib/v04-save-coordinator.ts";

test("V0.4 save coordinator serializes writes and always drains the latest staged edit", async () => {
  const coordinator = new V04LatestSaveCoordinator<{ value: string }>();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  coordinator.stage({ version: 1, draft: { value: "first" } });
  const flush = coordinator.flush(async (attempt) => {
    order.push(`start:${attempt.version}:${attempt.draft.value}`);
    if (attempt.version === 1) await firstBlocked;
    order.push(`end:${attempt.version}:${attempt.draft.value}`);
    return true;
  });
  coordinator.stage({ version: 2, draft: { value: "stale-middle" } });
  coordinator.stage({ version: 3, draft: { value: "latest" } });
  const submitFlush = coordinator.flush(async () => {
    assert.fail("a submit flush must join the active autosave instead of starting a second writer");
  });
  assert.equal(submitFlush, flush);
  assert.equal(coordinator.isRunning, true);
  releaseFirst();
  assert.equal(await flush, true);
  assert.deepEqual(order, [
    "start:1:first", "end:1:first", "start:3:latest", "end:3:latest",
  ]);
  assert.equal(coordinator.savedVersion, 3);
  assert.equal(coordinator.isRunning, false);
});

test("three-way save keeps unrelated server edits, stops same-target conflicts and drains v2", () => {
  const change = (targetKey: string, beforeValue: unknown, afterValue: unknown) => ({
    targetKey, targetLabel: targetKey, valueType: "TEXT" as const, beforeValue, afterValue,
  });
  const localX = [change("facts.x", "x0", "x1")];
  const serverAfterB = new Map<string, unknown>([["facts.x", "x0"], ["facts.y", "y1"]]);
  const rebased = planV04ThreeWayChanges(localX, (key) => serverAfterB.get(key));
  assert.deepEqual(rebased.conflicts, []);
  assert.deepEqual(rebased.changes.map((entry) => entry.targetKey), ["facts.x"]);
  assert.equal(serverAfterB.get("facts.y"), "y1", "B's unrelated field never enters A's change-set");

  const sameTarget = planV04ThreeWayChanges(localX, () => "x-from-b");
  assert.deepEqual(sameTarget.changes, []);
  assert.deepEqual(sameTarget.conflicts, ["facts.x"]);

  const v2 = [localX[0], change("facts.z", "z0", "z1")];
  const afterV1 = new Map<string, unknown>([["facts.x", "x1"], ["facts.z", "z0"]]);
  const drained = planV04ThreeWayChanges(v2, (key) => afterV1.get(key));
  assert.deepEqual(drained.alreadyApplied, ["facts.x"]);
  assert.deepEqual(drained.changes.map((entry) => entry.targetKey), ["facts.z"]);
  assert.deepEqual(drained.conflicts, []);
});

test("V0.4 save coordinator preserves a failed edit for an idempotent retry", async () => {
  const coordinator = new V04LatestSaveCoordinator<{ value: string }>();
  const calls: number[] = [];
  coordinator.stage({ version: 1, draft: { value: "draft" } });
  assert.equal(await coordinator.flush(async (attempt) => {
    calls.push(attempt.version);
    return false;
  }), false);
  assert.equal(coordinator.savedVersion, 0);
  assert.equal(await coordinator.flush(async (attempt) => {
    calls.push(attempt.version);
    return true;
  }), true);
  assert.deepEqual(calls, [1, 1]);
  assert.equal(coordinator.savedVersion, 1);
});

test("V0.4 save coordinator accepts a new stage at the completed-flush boundary", async () => {
  const coordinator = new V04LatestSaveCoordinator<{ value: string }>();
  const saved: string[] = [];
  const persist = async (attempt: { version: number; draft: { value: string } }) => {
    saved.push(attempt.draft.value);
    return true;
  };
  coordinator.stage({ version: 1, draft: { value: "first" } });
  await coordinator.flush(persist);
  coordinator.stage({ version: 2, draft: { value: "boundary-latest" } });
  assert.equal(await coordinator.flush(persist), true);
  assert.deepEqual(saved, ["first", "boundary-latest"]);
  assert.equal(coordinator.savedVersion, 2);
});

test("V0.4 leave policy releases only a clean confirmed draft", () => {
  assert.equal(shouldReleaseV04Lease({
    saveStatus: "SAVED", saveInFlight: false, editVersion: 3, savedVersion: 3,
  }), true);
  assert.equal(shouldReleaseV04Lease({
    saveStatus: "CLEAN", saveInFlight: false, editVersion: 0, savedVersion: 0,
  }), true);
  for (const sample of [
    { saveStatus: "DIRTY", saveInFlight: false, editVersion: 4, savedVersion: 3 },
    { saveStatus: "SAVING", saveInFlight: true, editVersion: 4, savedVersion: 3 },
    { saveStatus: "SAVED", saveInFlight: true, editVersion: 3, savedVersion: 3 },
    { saveStatus: "SAVED", saveInFlight: false, editVersion: 4, savedVersion: 3 },
  ]) assert.equal(shouldReleaseV04Lease(sample), false);
});

test("submit and restore lock draft mutation while a clean restore alone may start", () => {
  assert.equal(canMutateV04Draft({ capability: true, restoring: false, submitting: false }), true);
  assert.equal(canMutateV04Draft({ capability: true, restoring: true, submitting: false }), false);
  assert.equal(canMutateV04Draft({ capability: true, restoring: false, submitting: true }), false);
  assert.equal(canMutateV04Draft({ capability: true, restoring: false, submitting: false, navigating: true }), false);
  assert.equal(canStartV04Restore({
    saveStatus: "SAVED", saveInFlight: false, submitting: false, restoring: false,
    editVersion: 3, savedVersion: 3,
  }), true);
  for (const sample of [
    { saveStatus: "DIRTY", saveInFlight: false, submitting: false, restoring: false, editVersion: 4, savedVersion: 3 },
    { saveStatus: "SAVING", saveInFlight: true, submitting: false, restoring: false, editVersion: 4, savedVersion: 3 },
    { saveStatus: "SAVED", saveInFlight: false, submitting: true, restoring: false, editVersion: 3, savedVersion: 3 },
    { saveStatus: "SAVED", saveInFlight: false, submitting: false, restoring: true, editVersion: 3, savedVersion: 3 },
  ]) assert.equal(canStartV04Restore(sample), false);
});

test("lease proof recovery accepts only an acquirable or exact same-tab editable read model", () => {
  assert.equal(canRecoverV04LeaseProof({ canAcquireLease: true, canEdit: false }), true);
  assert.equal(canRecoverV04LeaseProof({ canAcquireLease: false, canEdit: true }), true,
    "same-tab refresh/lost response may rotate its own proof");
  assert.equal(canRecoverV04LeaseProof({ canAcquireLease: false, canEdit: false }), false,
    "another tab or user remains fail-closed");
});

test("a publication-missing readonly workspace retries only after a fresh capability allows editing", () => {
  const now = Date.parse("2026-08-22T05:00:00.000Z");
  const held = planV04EditAccessRecovery({
    logicalEmpty: false,
    canMaterialize: false,
    canEdit: false,
    canAcquireLease: false,
    member: true,
    leaseExpiresAt: "2026-08-22T05:00:20.000Z",
  }, now);
  assert.deepEqual(held, { state: "WAIT_FOR_LEASE", retryAfterMs: 20_250 },
    "another editing endpoint remains fail-closed while the missing field is readonly");

  const released = planV04EditAccessRecovery({
    logicalEmpty: false,
    canMaterialize: false,
    canEdit: false,
    canAcquireLease: true,
    member: true,
    leaseExpiresAt: null,
  }, now + 21_000);
  assert.deepEqual(released, { state: "ACQUIRE_NOW", retryAfterMs: 250 },
    "a fresh no-holder read model automatically reacquires instead of leaving the field readonly");

  const denied = planV04EditAccessRecovery({
    logicalEmpty: false,
    canMaterialize: false,
    canEdit: false,
    canAcquireLease: false,
    member: false,
    leaseExpiresAt: null,
  }, now);
  assert.deepEqual(denied, { state: "DENIED", retryAfterMs: null },
    "lack of membership never becomes a retry or permission expansion");
});

test("expired lease invalidates once, reacquires at most once and preserves the same change-set", async () => {
  const changeSetId = "change-tab-a-edit-7";
  let invalidations = 0;
  let runs = 0;
  const seenChangeSets: string[] = [];
  const result = await runV04LeaseBoundMutationWithSingleRecovery({
    run: async () => {
      runs += 1;
      seenChangeSets.push(changeSetId);
      if (runs === 1) throw Object.assign(new Error("expired"), { code: "LEASE_EXPIRED" });
      return "saved";
    },
    leaseFailureCode: (reason) => (reason as { code?: string }).code ?? null,
    invalidate: () => { invalidations += 1; },
    canReacquire: async () => true,
  });
  assert.equal(result, "saved");
  assert.equal(runs, 2);
  assert.equal(invalidations, 1);
  assert.deepEqual(seenChangeSets, [changeSetId, changeSetId]);
});

test("another holder and server publication gaps block retry/submit without losing local eligibility facts", async () => {
  let runs = 0;
  await assert.rejects(runV04LeaseBoundMutationWithSingleRecovery({
    run: async () => {
      runs += 1;
      throw Object.assign(new Error("held"), { code: "LEASE_HELD_BY_OTHER" });
    },
    leaseFailureCode: (reason) => (reason as { code?: string }).code ?? null,
    invalidate: () => undefined,
    canReacquire: async () => false,
  }), /held/);
  assert.equal(runs, 1);
  assert.equal(canSubmitV04ServerDraft({
    localPublicationReady: true,
    serverPublicationReady: false,
    saveCompleted: false,
    editVersion: 14,
    savedVersion: 0,
  }), false, "local 0-missing must not override a server 14-missing draft");
  assert.equal(canSubmitV04ServerDraft({
    localPublicationReady: true,
    serverPublicationReady: true,
    saveCompleted: true,
    editVersion: 14,
    savedVersion: 14,
  }), true);
});
