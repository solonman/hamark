import assert from "node:assert/strict";
import test from "node:test";
import {
  claimV04DocumentIdentity,
  V04DocumentIdentityClaimRegistry,
  type V04DocumentIdentity,
  type V04IdentityLockManager,
} from "../lib/v04-document-identity.ts";
import {
  discoverV04Recoveries,
  writeV04Recovery,
  type V04RecoveryIdentity,
} from "../lib/v04-draft-save-state.ts";
import { planV04EditAccessRecovery } from "../lib/v04-save-coordinator.ts";

class MemoryStorage {
  constructor(private readonly values = new Map<string, string>()) {}
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clone() { return new MemoryStorage(new Map(this.values)); }
}

class LockHub implements V04IdentityLockManager {
  private readonly held = new Set<string>();
  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true; signal: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<T> | T,
  ) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

class HangingLocks implements V04IdentityLockManager {
  signal: AbortSignal | null = null;
  lateCallback: ((lock: { name: string } | null) => Promise<unknown> | unknown) | null = null;
  request<T>(
    _name: string,
    options: { mode: "exclusive"; ifAvailable: true; signal: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<T> | T,
  ) {
    this.signal = options.signal;
    this.lateCallback = callback as (lock: { name: string } | null) => Promise<unknown> | unknown;
    return new Promise<T>(() => undefined);
  }
}

const caseId = "video-document-identity";
const original: V04DocumentIdentity = {
  workspaceTabToken: "v04-workspace-123e4567-e89b-42d3-a456-426614174100",
  recoveryTabId: "recovery-123e4567-e89b-42d3-a456-426614174100",
};
const documentKey = `hamark:v04:document-identity:${encodeURIComponent(caseId)}`;

function seededStorage() {
  const storage = new MemoryStorage();
  storage.setItem(documentKey, JSON.stringify(original));
  return storage;
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `123e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, "0")}`;
}

test("a duplicated sessionStorage document atomically rotates workspace and recovery identities", async () => {
  const locks = new LockHub();
  const firstStorage = seededStorage();
  const duplicateStorage = firstStorage.clone();
  const first = await claimV04DocumentIdentity({
    caseId, storage: firstStorage, lockManager: locks,
    createId: ids("123e4567-e89b-42d3-a456-426614174101"),
  });
  const duplicate = await claimV04DocumentIdentity({
    caseId, storage: duplicateStorage, lockManager: locks,
    createId: ids(
      "123e4567-e89b-42d3-a456-426614174102",
      "123e4567-e89b-42d3-a456-426614174103",
    ),
  });
  assert.deepEqual(first.identity, original);
  assert.equal(duplicate.collisionResolved, true);
  assert.notEqual(duplicate.identity.workspaceTabToken, first.identity.workspaceTabToken);
  assert.notEqual(duplicate.identity.recoveryTabId, first.identity.recoveryTabId);
  assert.deepEqual(JSON.parse(duplicateStorage.getItem(documentKey)!), duplicate.identity,
    "both identifiers persist as one atomic document identity");
  first.release();
  duplicate.release();
});

test("simultaneous duplicated documents deterministically retain only one copied identity", async () => {
  const locks = new LockHub();
  const leftStorage = seededStorage();
  const rightStorage = leftStorage.clone();
  const [left, right] = await Promise.all([
    claimV04DocumentIdentity({
      caseId, storage: leftStorage, lockManager: locks,
      createId: ids("123e4567-e89b-42d3-a456-426614174110"),
    }),
    claimV04DocumentIdentity({
      caseId, storage: rightStorage, lockManager: locks,
      createId: ids(
        "123e4567-e89b-42d3-a456-426614174111",
        "123e4567-e89b-42d3-a456-426614174112",
      ),
    }),
  ]);
  assert.notEqual(left.identity.workspaceTabToken, right.identity.workspaceTabToken);
  assert.notEqual(left.identity.recoveryTabId, right.identity.recoveryTabId);
  assert.equal(Number(left.collisionResolved) + Number(right.collisionResolved), 1);
  left.release();
  right.release();
});

test("a real same-tab reload reuses the pair after the previous document exits", async () => {
  const locks = new LockHub();
  const storage = seededStorage();
  const beforeReload = await claimV04DocumentIdentity({
    caseId, storage, lockManager: locks,
    createId: ids("123e4567-e89b-42d3-a456-426614174120"),
  });
  beforeReload.release();
  await Promise.resolve();
  await Promise.resolve();
  const afterReload = await claimV04DocumentIdentity({
    caseId, storage, lockManager: locks,
    createId: ids("123e4567-e89b-42d3-a456-426614174121"),
  });
  assert.deepEqual(afterReload.identity, beforeReload.identity);
  assert.equal(afterReload.collisionResolved, false);
  afterReload.release();
});

test("unavailable or uncertain collision detection never reuses a cloned identity", async () => {
  const unavailable = await claimV04DocumentIdentity({
    caseId, storage: seededStorage(),
    lockManager: null,
    createId: ids(
      "123e4567-e89b-42d3-a456-426614174130",
    ),
  });
  assert.equal(unavailable.failClosed, true);
  assert.equal(unavailable.persisted, false);
  assert.notEqual(unavailable.identity.workspaceTabToken, original.workspaceTabToken);
  assert.notEqual(unavailable.identity.recoveryTabId, original.recoveryTabId);

  const failingLocks: V04IdentityLockManager = {
    request: () => { throw new Error("LOCK_MANAGER_FAILED"); },
  };
  const startedAt = Date.now();
  const uncertain = await claimV04DocumentIdentity({
    caseId, storage: seededStorage(),
    lockManager: failingLocks,
    createId: ids(
      "123e4567-e89b-42d3-a456-426614174132",
      "123e4567-e89b-42d3-a456-426614174133",
    ),
  });
  assert.equal(uncertain.failClosed, true, "a lock-manager error must choose a new memory identity");
  assert.notEqual(uncertain.identity.workspaceTabToken, original.workspaceTabToken);
  assert(Date.now() - startedAt < 100, "a synchronous lock error must clear its timer and fail immediately");
});

test("an always-unavailable lock manager stops after three atomic attempts", async () => {
  let attempts = 0;
  const unavailableLocks: V04IdentityLockManager = {
    request: async (_name, _options, callback) => {
      attempts += 1;
      return callback(null);
    },
  };
  const storage = seededStorage();
  const result = await claimV04DocumentIdentity({
    caseId, storage, lockManager: unavailableLocks,
    createId: ids(
      "123e4567-e89b-42d3-a456-426614174150",
      "123e4567-e89b-42d3-a456-426614174151",
      "123e4567-e89b-42d3-a456-426614174152",
    ),
  });
  assert.equal(attempts, 3);
  assert.equal(result.failClosed, true);
  assert.equal(result.persisted, false);
  assert.notEqual(result.identity.workspaceTabToken, original.workspaceTabToken);
  assert.deepEqual(JSON.parse(storage.getItem(documentKey)!), original,
    "failed lock attempts must not mutate the persisted candidate");
});

test("a hanging Web Lock request aborts promptly and a late callback cannot own the identity", async () => {
  const storage = seededStorage();
  const locks = new HangingLocks();
  const result = await claimV04DocumentIdentity({
    caseId, storage, lockManager: locks, lockTimeoutMs: 5,
    createId: ids("123e4567-e89b-42d3-a456-426614174135"),
  });
  assert.equal(result.failClosed, true);
  assert.equal(result.persisted, false);
  assert.equal(locks.signal?.aborted, true);
  assert.notEqual(result.identity.workspaceTabToken, original.workspaceTabToken);
  assert.deepEqual(JSON.parse(storage.getItem(documentKey)!), original,
    "an uncertain candidate is never written back as a claimed identity");
  await locks.lateCallback?.({ name: "late" });
  assert.equal(result.failClosed, true, "a late grant returns without creating an owner");

  const pendingLocks = new HangingLocks();
  const registry = new V04DocumentIdentityClaimRegistry((scope, signal) => claimV04DocumentIdentity({
    caseId: scope, storage: seededStorage(), lockManager: pendingLocks, lockTimeoutMs: 60_000, signal,
    createId: ids("123e4567-e89b-42d3-a456-426614174136"),
  }));
  const pending = registry.get(caseId);
  registry.dispose();
  await Promise.resolve();
  assert.equal(pendingLocks.signal?.aborted, true,
    "dispose must abort the pending browser lock without waiting for its timeout");
  await assert.rejects(pending, /V04_DOCUMENT_IDENTITY_CANCELLED/);
  await pendingLocks.lateCallback?.({ name: "late-after-dispose" });
});

test("rotated documents keep independent recovery keys and both copies stay discoverable", () => {
  const storage = new MemoryStorage();
  const identity = (tabId: string): V04RecoveryIdentity => ({
    userId: "user-test", workspaceId: "workspace-test", roundId: "round-test",
    tabId, payloadSchemaVersion: "V04_PAYLOAD_V1",
  });
  const base = {
    serverRevision: 2, serverHash: "a".repeat(64), dirtyTargets: ["facts.creativeMotif"],
    writtenAt: new Date().toISOString(), payload: { creativeMotif: "local" },
  };
  assert.equal(writeV04Recovery(storage, { ...base, identity: identity(original.recoveryTabId) }), true);
  const rotated = "recovery-123e4567-e89b-42d3-a456-426614174140";
  assert.equal(writeV04Recovery(storage, { ...base, identity: identity(rotated) }), true);
  const found = discoverV04Recoveries(storage, [{
    userId: "user-test", workspaceId: "workspace-test", roundId: "round-test",
    payloadSchemaVersion: "V04_PAYLOAD_V1",
  }]);
  assert.equal(found.available, true);
  if (found.available) assert.deepEqual(new Set(found.records.map((record) => record.identity.tabId)),
    new Set([original.recoveryTabId, rotated]));
});

test("a fail-closed temporary identity can rediscover the old draft and only takes over after the old lease is gone", async () => {
  const storage = new MemoryStorage();
  const createFirst = ids("123e4567-e89b-42d3-a456-426614174160");
  const createReentry = ids("123e4567-e89b-42d3-a456-426614174161");
  const first = await claimV04DocumentIdentity({
    caseId, storage: seededStorage(), lockManager: null, createId: createFirst,
  });
  const scope = (tabId: string): V04RecoveryIdentity => ({
    userId: "user-test", workspaceId: "workspace-test", roundId: "round-test",
    tabId, payloadSchemaVersion: "V04_PAYLOAD_V1",
  });
  assert.equal(writeV04Recovery(storage, {
    identity: scope(first.identity.recoveryTabId),
    serverRevision: 5,
    serverHash: "b".repeat(64),
    basePayload: { value: "server" },
    payload: { value: "latest-local" },
    dirtyTargets: ["facts.creativeMotif"],
    writtenAt: new Date().toISOString(),
  }), true);

  const reentry = await claimV04DocumentIdentity({
    caseId, storage: seededStorage(), lockManager: null, createId: createReentry,
  });
  assert.equal(first.failClosed, true);
  assert.equal(reentry.failClosed, true);
  assert.notEqual(reentry.identity.workspaceTabToken, first.identity.workspaceTabToken,
    "an uncertain reload must not impersonate the prior document lease");
  assert.notEqual(reentry.identity.recoveryTabId, first.identity.recoveryTabId);

  const found = discoverV04Recoveries(storage, [{
    userId: "user-test", workspaceId: "workspace-test", roundId: "round-test",
    payloadSchemaVersion: "V04_PAYLOAD_V1",
  }]);
  assert.equal(found.available, true);
  if (found.available) {
    assert.equal(found.records.length, 1);
    assert.deepEqual(found.records[0].dirtyTargets, ["facts.creativeMotif"]);
  }

  const now = Date.now();
  assert.deepEqual(planV04EditAccessRecovery({
    logicalEmpty: false, canMaterialize: false, canEdit: false,
    canAcquireLease: false, member: true,
    leaseExpiresAt: new Date(now + 20_000).toISOString(),
  }, now), { state: "WAIT_FOR_LEASE", retryAfterMs: 20_250 });
  assert.deepEqual(planV04EditAccessRecovery({
    logicalEmpty: false, canMaterialize: false, canEdit: false,
    canAcquireLease: true, member: true, leaseExpiresAt: null,
  }, now), { state: "ACQUIRE_NOW", retryAfterMs: 250 });
});

test("disposing an abort-aware pending claim rejects before a late result can become an owner", async () => {
  let resolveClaim!: (claim: Awaited<ReturnType<typeof claimV04DocumentIdentity>>) => void;
  let releases = 0;
  const registry = new V04DocumentIdentityClaimRegistry((_scope, signal) => new Promise((resolve, reject) => {
    resolveClaim = resolve;
    signal.addEventListener("abort", () => reject(new Error("V04_DOCUMENT_IDENTITY_CANCELLED")), { once: true });
  }));
  const pending = registry.get(caseId);
  registry.dispose();
  resolveClaim({
    identity: original, persisted: true, collisionResolved: false, failClosed: false,
    release: () => { releases += 1; },
  });
  await assert.rejects(pending, /V04_DOCUMENT_IDENTITY_CANCELLED/);
  assert.equal(releases, 0, "an aborted claim never acquires an owner that would need a later release");
  await assert.rejects(registry.get(caseId), /V04_DOCUMENT_IDENTITY_CANCELLED/);
});
