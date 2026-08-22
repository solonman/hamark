export const V04_AUTOSAVE_DEBOUNCE_MS = 2_500;
export const V04_SAVE_TIMEOUT_MS = 15_000;
export const V04_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_TAB_ID_PATTERN = /^recovery-[a-f0-9-]{36}$/;

export async function runV04WithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = V04_SAVE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function isV04LeaseFailure(code: string) {
  return code === "LEASE_REQUIRED" || code === "LEASE_EXPIRED" ||
    code === "LEASE_HELD_BY_OTHER";
}

export function v04SaveFailureMessage(code: string) {
  switch (code) {
    case "LEASE_HELD_BY_OTHER":
      return "另一个编辑端已取得编辑权。你的本地草稿已保留，不会覆盖服务器内容。";
    case "LEASE_REQUIRED":
    case "LEASE_EXPIRED":
      return "编辑权已失效，系统将安全重新取得后再保存一次。";
    case "REVISION_CONFLICT":
      return "服务器工作稿已被其他编辑更新。你的本地草稿已保留，请先对照服务器版本。";
    case "REQUEST_TIMEOUT":
      return "保存超时，本地草稿已保留。可直接重试，系统会沿用同一变更集，不会重复写入。";
    case "NETWORK_ERROR":
      return "网络暂不可用，内容已保留在本机恢复副本中。";
    case "PUBLICATION_INCOMPLETE":
      return "服务器复核发现仍有必填项未保存，请完成并保存后再提交。";
    case "NO_CHANGES_TO_SUBMIT":
      return "当前工作稿与最新提交版一致，无需重复提交。";
    default:
      return "操作未完成，本地内容已保留，可直接重试。";
  }
}

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
  | { type: "RECOVERY_DISCOVERED"; conflict: boolean; savedAt: string }
  | { type: "SERVER_CONFIRMED"; editVersion: number; savedAt: string }
  | { type: "RESET_FROM_SERVER"; savedAt: string }
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
    case "RECOVERY_DISCOVERED":
      return {
        ...state,
        status: action.conflict ? "CONFLICT" : "DIRTY",
        activeRequestEditVersion: null,
        savedAt: action.savedAt,
        errorCode: "RECOVERY_PENDING",
      };
    case "SERVER_CONFIRMED":
      return {
        ...state,
        status: action.editVersion === state.editVersion ? "SAVED" : "DIRTY",
        savedEditVersion: Math.max(state.savedEditVersion, action.editVersion),
        savedAt: action.savedAt,
        errorCode: null,
      };
    case "RESET_FROM_SERVER":
      return {
        ...initialV04DraftSaveState(),
        status: "SAVED",
        savedAt: action.savedAt,
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

export type V04RecoveryRecord<TPayload = unknown, TBasePayload = unknown> = {
  identity: V04RecoveryIdentity;
  serverRevision: number;
  serverHash: string;
  basePayload?: TBasePayload;
  payload: TPayload;
  dirtyTargets: string[];
  writtenAt: string;
};

export type V04RecoveryDecision<TPayload = unknown, TBasePayload = unknown> =
  | { kind: "NONE" | "EXPIRED" | "SERVER_MATCHES" }
  | { kind: "RESTORE_AVAILABLE"; record: V04RecoveryRecord<TPayload, TBasePayload> }
  | { kind: "CONFLICT"; record: V04RecoveryRecord<TPayload, TBasePayload> };

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

export function decideV04Recovery<TPayload, TBasePayload = unknown>(
  record: V04RecoveryRecord<TPayload, TBasePayload> | null,
  server: { revision: number; hash: string },
  now = new Date(),
): V04RecoveryDecision<TPayload, TBasePayload> {
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
export type V04RecoveryEnumerableStorage = V04RecoveryStorage & Pick<Storage, "key" | "length">;
export type V04RecoveryScope = Omit<V04RecoveryIdentity, "tabId">;

export function getOrCreateV04RecoveryTabId(
  storage: Pick<Storage, "getItem" | "setItem">,
  scope: string,
  createId: () => string = () => crypto.randomUUID(),
) {
  const key = `hamark:v04:recovery-tab:${encodeURIComponent(scope)}`;
  const existing = storage.getItem(key);
  if (existing && RECOVERY_TAB_ID_PATTERN.test(existing)) return existing;
  const created = `recovery-${createId().toLowerCase()}`;
  if (!RECOVERY_TAB_ID_PATTERN.test(created)) throw new Error("INVALID_RECOVERY_TAB_ID");
  storage.setItem(key, created);
  return created;
}

export function getOrCreateV04RecoveryTabIdSafely(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  scope: string,
  createId: () => string = () => crypto.randomUUID(),
) {
  try {
    if (!storage) throw new Error("RECOVERY_SESSION_STORAGE_UNAVAILABLE");
    return { tabId: getOrCreateV04RecoveryTabId(storage, scope, createId), persisted: true };
  } catch {
    const tabId = `recovery-${createId().toLowerCase()}`;
    if (!RECOVERY_TAB_ID_PATTERN.test(tabId)) throw new Error("INVALID_RECOVERY_TAB_ID");
    return { tabId, persisted: false };
  }
}

function isSameRecoveryScope(identity: V04RecoveryIdentity, scope: V04RecoveryScope) {
  return identity.userId === scope.userId &&
    identity.workspaceId === scope.workspaceId &&
    identity.roundId === scope.roundId &&
    identity.payloadSchemaVersion === scope.payloadSchemaVersion;
}

export function discoverV04Recoveries<TPayload, TBasePayload = unknown>(
  storage: V04RecoveryEnumerableStorage,
  scopes: readonly V04RecoveryScope[],
  now = new Date(),
): { available: true; records: V04RecoveryRecord<TPayload, TBasePayload>[] } | { available: false; records: [] } {
  try {
    const records: V04RecoveryRecord<TPayload, TBasePayload>[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith("hamark%3Av04%3Arecovery:") && !key?.startsWith("hamark:v04:recovery:")) {
        continue;
      }
      const value = storage.getItem(key);
      if (!value) continue;
      let parsed: V04RecoveryRecord<TPayload, TBasePayload>;
      try {
        parsed = JSON.parse(value) as V04RecoveryRecord<TPayload, TBasePayload>;
      } catch {
        continue;
      }
      if (!parsed?.identity || !scopes.some((scope) => isSameRecoveryScope(parsed.identity, scope))) continue;
      const writtenAt = Date.parse(parsed.writtenAt);
      if (!Number.isFinite(writtenAt) || now.getTime() - writtenAt > V04_RECOVERY_TTL_MS) continue;
      records.push(parsed);
    }
    records.sort((left, right) => Date.parse(right.writtenAt) - Date.parse(left.writtenAt));
    return { available: true, records };
  } catch {
    return { available: false, records: [] };
  }
}

export function writeV04Recovery<TPayload, TBasePayload = unknown>(
  storage: V04RecoveryStorage,
  record: V04RecoveryRecord<TPayload, TBasePayload>,
) {
  // Rebuild from an explicit runtime allowlist. TypeScript types do not remove
  // extra object properties supplied by JavaScript callers.
  const safeRecord: V04RecoveryRecord<TPayload, TBasePayload> = {
    identity: {
      userId: record.identity.userId,
      workspaceId: record.identity.workspaceId,
      roundId: record.identity.roundId,
      tabId: record.identity.tabId,
      payloadSchemaVersion: record.identity.payloadSchemaVersion,
    },
    serverRevision: record.serverRevision,
    serverHash: record.serverHash,
    ...(record.basePayload === undefined ? {} : { basePayload: record.basePayload }),
    payload: record.payload,
    dirtyTargets: [...record.dirtyTargets],
    writtenAt: record.writtenAt,
  };
  try {
    storage.setItem(v04RecoveryStorageKey(safeRecord.identity), JSON.stringify(safeRecord));
    return true;
  } catch {
    return false;
  }
}

export function readV04Recovery<TPayload, TBasePayload = unknown>(
  storage: V04RecoveryStorage,
  identity: V04RecoveryIdentity,
): V04RecoveryRecord<TPayload, TBasePayload> | null {
  try {
    const value = storage.getItem(v04RecoveryStorageKey(identity));
    if (!value) return null;
    const parsed = JSON.parse(value) as V04RecoveryRecord<TPayload, TBasePayload>;
    return JSON.stringify(parsed.identity) === JSON.stringify(identity) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearV04Recovery(
  storage: V04RecoveryStorage,
  identity: V04RecoveryIdentity,
) {
  try {
    storage.removeItem(v04RecoveryStorageKey(identity));
    return true;
  } catch {
    return false;
  }
}
