import assert from "node:assert/strict";
import test from "node:test";
import {
  clearV04Recovery,
  decideV04Recovery,
  initialV04DraftSaveState,
  readV04Recovery,
  reduceV04DraftSaveState,
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
