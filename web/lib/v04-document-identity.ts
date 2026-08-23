const WORKSPACE_TAB_TOKEN = /^v04-workspace-[a-f0-9-]{36}$/;
const RECOVERY_TAB_ID = /^recovery-[a-f0-9-]{36}$/;

export type V04DocumentIdentity = {
  workspaceTabToken: string;
  recoveryTabId: string;
};

export type V04DocumentIdentityClaim = {
  identity: V04DocumentIdentity;
  persisted: boolean;
  collisionResolved: boolean;
  failClosed: boolean;
  release: () => void;
};

export type V04IdentityLock = { name: string };
export type V04IdentityLockManager = {
  request: <T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: V04IdentityLock | null) => Promise<T> | T,
  ) => Promise<T>;
};

type V04IdentityStorage = Pick<Storage, "getItem" | "setItem">;

function storageKey(caseId: string) {
  return `hamark:v04:document-identity:${encodeURIComponent(caseId)}`;
}

function legacyWorkspaceKey(caseId: string) {
  return `hamark:v04:workspace-tab:${encodeURIComponent(caseId)}`;
}

function validIdentity(value: unknown): value is V04DocumentIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<V04DocumentIdentity>;
  return typeof candidate.workspaceTabToken === "string" && WORKSPACE_TAB_TOKEN.test(candidate.workspaceTabToken) &&
    typeof candidate.recoveryTabId === "string" && RECOVERY_TAB_ID.test(candidate.recoveryTabId) &&
    candidate.workspaceTabToken.slice("v04-workspace-".length) ===
      candidate.recoveryTabId.slice("recovery-".length);
}

function freshIdentity(createId: () => string): V04DocumentIdentity {
  const id = createId().toLowerCase();
  const identity = {
    workspaceTabToken: `v04-workspace-${id}`,
    recoveryTabId: `recovery-${id}`,
  };
  if (!validIdentity(identity)) throw new Error("INVALID_V04_DOCUMENT_IDENTITY");
  return identity;
}

function readCandidate(caseId: string, storage: V04IdentityStorage, createId: () => string) {
  const serialized = storage.getItem(storageKey(caseId));
  if (serialized) {
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (validIdentity(parsed)) return parsed;
    } catch {
      // Replace an invalid non-credential session record with a safe pair.
    }
  }
  const legacyToken = storage.getItem(legacyWorkspaceKey(caseId));
  return legacyToken && WORKSPACE_TAB_TOKEN.test(legacyToken)
    ? {
        workspaceTabToken: legacyToken,
        recoveryTabId: `recovery-${legacyToken.slice("v04-workspace-".length)}`,
      }
    : freshIdentity(createId);
}

function writeIdentity(caseId: string, storage: V04IdentityStorage, identity: V04DocumentIdentity) {
  storage.setItem(storageKey(caseId), JSON.stringify(identity));
}

async function holdIdentityLock(
  lockManager: V04IdentityLockManager,
  identity: V04DocumentIdentity,
  timeoutMs: number,
  externalSignal?: AbortSignal,
) {
  let release!: () => void;
  let settle!: (acquired: boolean) => void;
  let reject!: (reason: unknown) => void;
  let cancelled = false;
  const controller = new AbortController();
  const held = new Promise<void>((resolve) => { release = resolve; });
  const decision = new Promise<boolean>((resolve, rejectDecision) => {
    settle = resolve;
    reject = rejectDecision;
  });
  const cancel = (reason: string) => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    release();
    reject(new Error(reason));
  };
  const cancelFromCaller = () => cancel("V04_DOCUMENT_IDENTITY_CANCELLED");
  if (externalSignal?.aborted) cancelFromCaller();
  else externalSignal?.addEventListener("abort", cancelFromCaller, { once: true });
  const timeout = setTimeout(() => cancel("V04_DOCUMENT_IDENTITY_LOCK_TIMEOUT"), timeoutMs);
  const cleanup = () => {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancelFromCaller);
  };
  let request: Promise<unknown>;
  try {
    request = lockManager.request(
      `hamark:v04:document-identity:${identity.workspaceTabToken}`,
      // Web Locks rejects with NotSupportedError when `signal` is combined with
      // `ifAvailable`. Cancellation runs through `cancelled` and `held` instead.
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        // A broken implementation may invoke the callback after the abort. It
        // must return immediately so a late grant cannot become a ghost owner.
        if (cancelled) return;
        if (!lock) {
          settle(false);
          return;
        }
        settle(true);
        await held;
      },
    );
  } catch (reason) {
    cleanup();
    cancelled = true;
    controller.abort();
    release();
    throw reason;
  }
  void request.catch(reject);
  try {
    const acquired = await decision;
    cleanup();
    return {
      acquired,
      release: acquired ? () => {
        cancelled = true;
        release();
      } : () => undefined,
    };
  } catch (reason) {
    cleanup();
    cancelled = true;
    controller.abort();
    release();
    throw reason;
  }
}

export async function claimV04DocumentIdentity(input: {
  caseId: string;
  storage: V04IdentityStorage | null;
  lockManager?: V04IdentityLockManager | null;
  createId?: () => string;
  lockTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<V04DocumentIdentityClaim> {
  if (input.signal?.aborted) throw new Error("V04_DOCUMENT_IDENTITY_CANCELLED");
  const createId = input.createId ?? (() => crypto.randomUUID());
  let lockManager = input.lockManager;
  if (lockManager === undefined) {
    try { lockManager = navigator.locks as V04IdentityLockManager; } catch { lockManager = null; }
  }
  let candidate: V04DocumentIdentity;
  try {
    if (!input.storage || !lockManager?.request) throw new Error("DOCUMENT_IDENTITY_CAPABILITY_UNAVAILABLE");
    candidate = readCandidate(input.caseId, input.storage, createId);
  } catch {
    return {
      identity: freshIdentity(createId), persisted: false, collisionResolved: false, failClosed: true,
      release: () => undefined,
    };
  }

  try {
    let activeIdentity = candidate;
    let ownership: Awaited<ReturnType<typeof holdIdentityLock>> | null = null;
    let collision = false;
    // A copied sessionStorage identity can never be treated as the original
    // tab. Web Locks is the atomic source of truth even if the original tab is
    // background-throttled and cannot answer messages or timers.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ownership = await holdIdentityLock(
        lockManager,
        activeIdentity,
        input.lockTimeoutMs ?? 1_500,
        input.signal,
      );
      if (ownership.acquired) break;
      collision = true;
      if (attempt < 2) activeIdentity = freshIdentity(createId);
    }
    if (!ownership?.acquired) throw new Error("V04_DOCUMENT_IDENTITY_LOCK_UNAVAILABLE");
    try {
      writeIdentity(input.caseId, input.storage, activeIdentity);
    } catch (reason) {
      ownership.release();
      throw reason;
    }
    return {
      identity: activeIdentity,
      persisted: true,
      collisionResolved: collision,
      failClosed: false,
      release: ownership.release,
    };
  } catch (reason) {
    if (input.signal?.aborted || (reason instanceof Error && reason.message === "V04_DOCUMENT_IDENTITY_CANCELLED")) {
      throw new Error("V04_DOCUMENT_IDENTITY_CANCELLED");
    }
    // Never reuse a candidate whose cross-document uniqueness could not be
    // proven. A fresh in-memory pair is safe and its recovery records remain
    // discoverable through the scoped localStorage scan.
    return {
      identity: freshIdentity(createId), persisted: false, collisionResolved: false, failClosed: true,
      release: () => undefined,
    };
  }
}

type V04PendingIdentityClaim = {
  promise: Promise<V04DocumentIdentityClaim>;
  release: () => void;
  abort: () => void;
  cancelled: boolean;
};

export class V04DocumentIdentityClaimRegistry {
  private readonly claims = new Map<string, V04PendingIdentityClaim>();
  private disposed = false;

  constructor(
    private readonly start: (caseId: string, signal: AbortSignal) => Promise<V04DocumentIdentityClaim>,
  ) {}

  get(caseId: string) {
    if (this.disposed) return Promise.reject(new Error("V04_DOCUMENT_IDENTITY_CANCELLED"));
    const existing = this.claims.get(caseId);
    if (existing) return existing.promise;
    const entry: V04PendingIdentityClaim = {
      promise: Promise.resolve(null as unknown as V04DocumentIdentityClaim),
      release: () => undefined,
      abort: () => undefined,
      cancelled: false,
    };
    const controller = new AbortController();
    entry.abort = () => controller.abort();
    entry.promise = this.start(caseId, controller.signal).then((claim) => {
      if (this.disposed || entry.cancelled) {
        claim.release();
        throw new Error("V04_DOCUMENT_IDENTITY_CANCELLED");
      }
      entry.release = claim.release;
      return claim;
    });
    this.claims.set(caseId, entry);
    return entry.promise;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.claims.values()) {
      entry.cancelled = true;
      entry.abort();
      entry.release();
    }
    this.claims.clear();
  }
}
