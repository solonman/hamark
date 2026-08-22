import assert from "node:assert/strict";
import test from "node:test";
import {
  clearV04Recovery,
  decideV04Recovery,
  discoverV04Recoveries,
  getOrCreateV04RecoveryTabId,
  getOrCreateV04RecoveryTabIdSafely,
  initialV04DraftSaveState,
  isV04LeaseFailure,
  readV04Recovery,
  reduceV04DraftSaveState,
  runV04WithTimeout,
  v04SaveFailureMessage,
  v04RecoveryStorageKey,
  V04_AUTOSAVE_DEBOUNCE_MS,
  V04_RECOVERY_TTL_MS,
  writeV04Recovery,
} from "../lib/v04-draft-save-state.ts";

test("V0.4 save reducer keeps latest edit dirty when an older request resolves", () => {
  let state = initialV04DraftSaveState();
  state = reduceV04DraftSaveState(state, { type: "EDIT" });
  state = reduceV04DraftSaveState(state, {
    type: "SAVE_STARTED", requestToken: 1, editVersion: 1,
  });
  assert.equal(state.status, "SAVING");
  state = reduceV04DraftSaveState(state, { type: "EDIT" });
  assert.equal(state.status, "DIRTY");
  state = reduceV04DraftSaveState(state, {
    type: "SAVE_SUCCEEDED", requestToken: 1, editVersion: 1,
    savedAt: "2026-08-19T12:00:00.000Z",
  });
  assert.equal(state.status, "DIRTY");
  assert.equal(state.savedEditVersion, 1);

  state = reduceV04DraftSaveState(state, {
    type: "SAVE_STARTED", requestToken: 2, editVersion: 2,
  });
  state = reduceV04DraftSaveState(state, {
    type: "SAVE_SUCCEEDED", requestToken: 1, editVersion: 1,
    savedAt: "2026-08-19T12:00:01.000Z",
  });
  assert.equal(state.status, "SAVING", "stale response must be ignored");
  state = reduceV04DraftSaveState(state, {
    type: "SAVE_SUCCEEDED", requestToken: 2, editVersion: 2,
    savedAt: "2026-08-19T12:00:02.000Z",
  });
  assert.equal(state.status, "SAVED");
  assert.equal(state.savedEditVersion, 2);
});

test("closed-tab recovery is discoverable by safe scope and independent tab copies never overwrite", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const scope = {
    userId: "user-a", workspaceId: "workspace-a", roundId: "round-a",
    payloadSchemaVersion: "AD_VIDEO_PAYLOAD_V1",
  };
  const tabA = { ...scope, tabId: "recovery-123e4567-e89b-42d3-a456-426614174000" };
  const tabB = { ...scope, tabId: "recovery-123e4567-e89b-42d3-a456-426614174001" };
  assert.equal(writeV04Recovery(storage, {
    identity: tabA, serverRevision: 4, serverHash: "hash-4", basePayload: { x: "x0", y: "y0" },
    payload: { x: "x-from-a" }, dirtyTargets: ["facts.x"], writtenAt: "2026-08-22T10:00:00.000Z",
  }), true);
  assert.equal(writeV04Recovery(storage, {
    identity: tabB, serverRevision: 5, serverHash: "hash-5", basePayload: { x: "x0", y: "y1" },
    payload: { y: "y-from-b" }, dirtyTargets: ["facts.y"], writtenAt: "2026-08-22T10:01:00.000Z",
  }), true);

  const reopened = discoverV04Recoveries(storage, [scope], new Date("2026-08-22T10:02:00.000Z"));
  assert.equal(reopened.available, true);
  assert.deepEqual(reopened.records.map((record) => record.identity.tabId), [tabB.tabId, tabA.tabId]);
  assert.deepEqual(reopened.records.map((record) => record.dirtyTargets), [["facts.y"], ["facts.x"]]);
  assert.equal(values.size, 2, "discovery must not merge, replace or delete another tab's copy");
});

test("unavailable browser storage is fail-safe and returns an ephemeral recovery identity", () => {
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
    key: () => { throw new Error("blocked"); },
    get length() { throw new Error("blocked"); },
  };
  const firstUuid = "123e4567-e89b-42d3-a456-426614174002";
  const fallback = getOrCreateV04RecoveryTabIdSafely(broken, "scope", () => firstUuid);
  assert.deepEqual(fallback, { tabId: `recovery-${firstUuid}`, persisted: false });
  assert.equal(discoverV04Recoveries(broken, []).available, false);
  assert.equal(writeV04Recovery(broken, {
    identity: {
      userId: "user-a", workspaceId: "workspace-a", roundId: "round-a",
      tabId: fallback.tabId, payloadSchemaVersion: "AD_VIDEO_PAYLOAD_V1",
    },
    serverRevision: 0, serverHash: "hash", payload: {}, dirtyTargets: [],
    writtenAt: "2026-08-22T10:00:00.000Z",
  }), false);
});

test("V0.4 save timeout aborts the in-flight request and lease failures stay explicit", async () => {
  let aborted = false;
  await assert.rejects(runV04WithTimeout((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("aborted", "AbortError"));
    });
  }), 5), /aborted/);
  assert.equal(aborted, true);
  assert.equal(isV04LeaseFailure("LEASE_REQUIRED"), true);
  assert.equal(isV04LeaseFailure("LEASE_EXPIRED"), true);
  assert.equal(isV04LeaseFailure("LEASE_HELD_BY_OTHER"), true);
  assert.equal(isV04LeaseFailure("REVISION_CONFLICT"), false);
  assert.match(v04SaveFailureMessage("LEASE_HELD_BY_OTHER"), /本地草稿已保留/);
  assert.match(v04SaveFailureMessage("REQUEST_TIMEOUT"), /同一变更集/);
});

test("V0.4 save reducer distinguishes offline, retryable, fatal and conflict states", () => {
  const started = reduceV04DraftSaveState(
    reduceV04DraftSaveState(initialV04DraftSaveState(), { type: "EDIT" }),
    { type: "SAVE_STARTED", requestToken: 1, editVersion: 1 },
  );
  assert.equal(reduceV04DraftSaveState(started, {
    type: "SAVE_OFFLINE", requestToken: 1,
  }).status, "OFFLINE_LOCAL");
  assert.equal(reduceV04DraftSaveState(started, {
    type: "SAVE_CONFLICT", requestToken: 1,
  }).status, "CONFLICT");
  assert.equal(reduceV04DraftSaveState(started, {
    type: "SAVE_FAILED", requestToken: 1, retryable: true, errorCode: "TIMEOUT",
  }).status, "ERROR_RETRYABLE");
  assert.equal(reduceV04DraftSaveState(started, {
    type: "SAVE_FAILED", requestToken: 1, retryable: false, errorCode: "INVALID",
  }).status, "ERROR_FATAL");
});

test("V0.4 recovery copies use five dimensions, expire and never carry credentials", () => {
  assert.equal(V04_AUTOSAVE_DEBOUNCE_MS, 2_500);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const identity = {
    userId: "user-a", workspaceId: "workspace-a", roundId: "round-a",
    tabId: "tab-a", payloadSchemaVersion: "AD_VIDEO_PAYLOAD_V1",
  };
  const record = {
    identity, serverRevision: 2, serverHash: "hash-2", payload: { value: "draft" },
    dirtyTargets: ["facts.storySynopsis"], writtenAt: "2026-08-19T12:00:00.000Z",
  };
  writeV04Recovery(storage, {
    ...record,
    sessionToken: "must-not-persist",
    leaseToken: "must-not-persist",
    credential: "must-not-persist",
  } as typeof record);
  const key = v04RecoveryStorageKey(identity);
  assert(values.has(key));
  assert(!values.get(key)?.match(/sessionToken|leaseToken|credential|must-not-persist/i));
  assert.deepEqual(readV04Recovery(storage, identity), record);
  assert.equal(decideV04Recovery(record, { revision: 2, hash: "hash-2" },
    new Date("2026-08-19T12:01:00.000Z")).kind, "RESTORE_AVAILABLE");
  assert.equal(decideV04Recovery(record, { revision: 3, hash: "hash-3" },
    new Date("2026-08-19T12:01:00.000Z")).kind, "CONFLICT");
  assert.equal(decideV04Recovery(record, { revision: 2, hash: "hash-2" },
    new Date(Date.parse(record.writtenAt) + V04_RECOVERY_TTL_MS + 1)).kind, "EXPIRED");
  clearV04Recovery(storage, identity);
  assert.equal(readV04Recovery(storage, identity), null);
});

test("V0.4 recovery tab identity survives reload without persisting lease or session proof", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const first = getOrCreateV04RecoveryTabId(storage, "user-a:video-a", () => uuid);
  const reloaded = getOrCreateV04RecoveryTabId(storage, "user-a:video-a", () => {
    assert.fail("reload should reuse the recovery-only tab id");
  });
  assert.equal(first, `recovery-${uuid}`);
  assert.equal(reloaded, first);
  const serialized = JSON.stringify([...values]);
  assert.doesNotMatch(serialized, /lease|sessionToken|credential/i);
});

test("an older confirmed save never clears a recovery copy that contains a newer local edit", () => {
  const record = {
    identity: {
      userId: "user-a", workspaceId: "workspace-a", roundId: "round-a",
      tabId: "recovery-123e4567-e89b-42d3-a456-426614174000",
      payloadSchemaVersion: "AD_VIDEO_PAYLOAD_V1",
    },
    serverRevision: 7,
    serverHash: "server-v7",
    basePayload: { facts: { storySynopsis: "server-v7" } },
    payload: { facts: { storySynopsis: "newer local v2" } },
    dirtyTargets: ["facts.storySynopsis"],
    writtenAt: "2026-08-22T08:00:00.000Z",
  };
  assert.equal(decideV04Recovery(record, {
    revision: 7,
    hash: "server-v7",
  }, new Date("2026-08-22T08:00:01.000Z")).kind, "RESTORE_AVAILABLE",
  "matching the older server base is not proof that the newer local version was saved");
  assert.equal(decideV04Recovery(record, {
    revision: 8,
    hash: "server-v8-partial-save",
  }, new Date("2026-08-22T08:00:01.000Z")).kind, "CONFLICT",
  "a partial server advance preserves the newest local copy for three-way comparison");
});
