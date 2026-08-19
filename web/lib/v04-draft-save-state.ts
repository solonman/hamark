export const V04_AUTOSAVE_DEBOUNCE_MS = 2_500;
export const V04_SAVE_TIMEOUT_MS = 15_000;
export const V04_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type V04DraftSaveStatus =
  | "CLEAN"
  | "DIRTY"
  | "SAVING"
  | "SAVED"
  | "OFFLINE_LOCAL"
  | "CONFLICT"
  | "ERROR_RETRYABLE"
  | "ERROR_FATAL";

export type V04DraftSaveState = {
  status: V04DraftSaveStatus;
  editVersion: number;
  savedEditVersion: number;
  activeRequestToken: number;
  activeRequestEditVersion: number | null;
  savedAt: string | null;
  errorCode: string | null;
};

export type V04DraftSaveAction =
  | { type: "EDIT" }
  | { type: "SAVE_STARTED"; requestToken: number; editVersion: number }
  | { type: "SAVE_SUCCEEDED"; requestToken: number; editVersion: number; savedAt: string }
  | { type: "SAVE_FAILED"; requestToken: number; retryable: boolean; errorCode: string }
  | { type: "SAVE_OFFLINE"; requestToken: number }
  | { type: "SAVE_CONFLICT"; requestToken: number }
  | { type: "SERVER_CONFIRMED"; editVersion: number; savedAt: string }
  | { type: "RESET_ERROR" };

export function initialV04DraftSaveState(): V04DraftSaveState {
  return {
    status: "CLEAN",
    editVersion: 0,
    savedEditVersion: 0,
    activeRequestToken: 0,
    activeRequestEditVersion: null,
    savedAt: null,
    errorCode: null,
  };
}

export function reduceV04DraftSaveState(
  state: V04DraftSaveState,
  action: V04DraftSaveAction,
): V04DraftSaveState {
  switch (action.type) {
    case "EDIT":
      return {
        ...state,
        status: "DIRTY",
        editVersion: state.editVersion + 1,
        errorCode: null,
      };
    case "SAVE_STARTED":
      if (action.requestToken <= state.activeRequestToken || action.editVersion > state.editVersion) {
        return state;
      }
      return {
        ...state,
        status: action.editVersion === state.editVersion ? "SAVING" : "DIRTY",
        activeRequestToken: action.requestToken,
        activeRequestEditVersion: action.editVersion,
        errorCode: null,
      };
    case "SAVE_SUCCEEDED":
      if (
        action.requestToken !== state.activeRequestToken ||
        action.editVersion !== state.activeRequestEditVersion
      ) return state;
      return {
        ...state,
        status: action.editVersion === state.editVersion ? "SAVED" : "DIRTY",
        savedEditVersion: Math.max(state.savedEditVersion, action.editVersion),
        activeRequestEditVersion: null,
        savedAt: action.savedAt,
        errorCode: null,
      };
    case "SAVE_FAILED":
      if (action.requestToken !== state.activeRequestToken) return state;
      return {
        ...state,
        status: action.retryable ? "ERROR_RETRYABLE" : "ERROR_FATAL",
        activeRequestEditVersion: null,
        errorCode: action.errorCode,
      };
    case "SAVE_OFFLINE":
      if (action.requestToken !== state.activeRequestToken) return state;
      return { ...state, status: "OFFLINE_LOCAL", activeRequestEditVersion: null };
    case "SAVE_CONFLICT":
      if (action.requestToken !== state.activeRequestToken) return state;
      return { ...state, status: "CONFLICT", activeRequestEditVersion: null };
    case "SERVER_CONFIRMED":
      return {
        ...state,
        status: action.editVersion === state.editVersion ? "SAVED" : "DIRTY",
        savedEditVersion: Math.max(state.savedEditVersion, action.editVersion),
        savedAt: action.savedAt,
        errorCode: null,
      };
    case "RESET_ERROR":
      return {
        ...state,
        status: state.editVersion === state.savedEditVersion ? "SAVED" : "DIRTY",
        errorCode: null,
      };
  }
}

export type V04RecoveryIdentity = {
  userId: string;
  workspaceId: string;
  roundId: string;
  tabId: string;
  payloadSchemaVersion: string;
};

export type V04RecoveryRecord<TPayload = unknown> = {
  identity: V04RecoveryIdentity;
  serverRevision: number;
  serverHash: string;
  payload: TPayload;
  dirtyTargets: string[];
  writtenAt: string;
};

export type V04RecoveryDecision<TPayload = unknown> =
  | { kind: "NONE" | "EXPIRED" | "SERVER_MATCHES" }
  | { kind: "RESTORE_AVAILABLE"; record: V04RecoveryRecord<TPayload> }
  | { kind: "CONFLICT"; record: V04RecoveryRecord<TPayload> };

function safeKeyPart(value: string) {
  return encodeURIComponent(value);
}

export function v04RecoveryStorageKey(identity: V04RecoveryIdentity) {
  return [
    "hamark:v04:recovery",
    identity.userId,
    identity.workspaceId,
    identity.roundId,
    identity.tabId,
    identity.payloadSchemaVersion,
  ].map(safeKeyPart).join(":");
}

export function decideV04Recovery<TPayload>(
  record: V04RecoveryRecord<TPayload> | null,
  server: { revision: number; hash: string },
  now = new Date(),
): V04RecoveryDecision<TPayload> {
  if (!record) return { kind: "NONE" };
  const writtenAt = Date.parse(record.writtenAt);
  if (!Number.isFinite(writtenAt) || now.getTime() - writtenAt > V04_RECOVERY_TTL_MS) {
    return { kind: "EXPIRED" };
  }
  if (record.serverRevision === server.revision && record.serverHash === server.hash) {
    return record.dirtyTargets.length > 0
      ? { kind: "RESTORE_AVAILABLE", record }
      : { kind: "SERVER_MATCHES" };
  }
  return { kind: "CONFLICT", record };
}

export type V04RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function writeV04Recovery<TPayload>(
  storage: V04RecoveryStorage,
  record: V04RecoveryRecord<TPayload>,
) {
  // Rebuild from an explicit runtime allowlist. TypeScript types do not remove
  // extra object properties supplied by JavaScript callers.
  const safeRecord: V04RecoveryRecord<TPayload> = {
    identity: {
      userId: record.identity.userId,
      workspaceId: record.identity.workspaceId,
      roundId: record.identity.roundId,
      tabId: record.identity.tabId,
      payloadSchemaVersion: record.identity.payloadSchemaVersion,
    },
    serverRevision: record.serverRevision,
    serverHash: record.serverHash,
    payload: record.payload,
    dirtyTargets: [...record.dirtyTargets],
    writtenAt: record.writtenAt,
  };
  storage.setItem(v04RecoveryStorageKey(safeRecord.identity), JSON.stringify(safeRecord));
}

export function readV04Recovery<TPayload>(
  storage: V04RecoveryStorage,
  identity: V04RecoveryIdentity,
): V04RecoveryRecord<TPayload> | null {
  const value = storage.getItem(v04RecoveryStorageKey(identity));
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as V04RecoveryRecord<TPayload>;
    return JSON.stringify(parsed.identity) === JSON.stringify(identity) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearV04Recovery(
  storage: V04RecoveryStorage,
  identity: V04RecoveryIdentity,
) {
  storage.removeItem(v04RecoveryStorageKey(identity));
}
