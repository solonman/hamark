import type { V04DraftSaveStatus } from "./v04-draft-save-state";

export type V04LocalDraftFacts = {
  saveStatus: V04DraftSaveStatus;
  saveInFlight: boolean;
  editVersion: number;
  savedVersion: number;
  recoveryPending: boolean;
};

export function normalizeV04LocalDraftFacts(input: V04LocalDraftFacts): V04LocalDraftFacts {
  if (!input.saveInFlight && input.editVersion <= input.savedVersion &&
    (input.saveStatus === "DIRTY" || input.saveStatus === "SAVING")) {
    return { ...input, saveStatus: "SAVED" };
  }
  return input;
}

export function isV04LocalDraftClean(input: V04LocalDraftFacts) {
  input = normalizeV04LocalDraftFacts(input);
  return !input.saveInFlight && !input.recoveryPending &&
    input.editVersion <= input.savedVersion &&
    (input.saveStatus === "CLEAN" || input.saveStatus === "SAVED");
}

export function decideV04FreshWorkspaceSync(
  input: V04LocalDraftFacts & { serverChanged: boolean },
) {
  if (isV04LocalDraftClean(input)) return "SYNC_SERVER" as const;
  return input.serverChanged
    ? "PRESERVE_LOCAL_COMPARE" as const
    : "PRESERVE_LOCAL" as const;
}

export function hasV04ServerDraftChanged(
  base: { revision: number; hash: string },
  fresh: { revision: number; hash: string },
) {
  return base.revision !== fresh.revision || base.hash !== fresh.hash;
}

export function decideV04FreshWorkspaceTransition(input: {
  facts: V04LocalDraftFacts;
  base: { revision: number; hash: string };
  fresh: { revision: number; hash: string };
}) {
  return decideV04FreshWorkspaceSync({
    ...input.facts,
    serverChanged: hasV04ServerDraftChanged(input.base, input.fresh),
  });
}

export function decideV04InternalNavigation(input: V04LocalDraftFacts) {
  if (isV04LocalDraftClean(input)) return "NAVIGATE" as const;
  if (input.saveStatus === "CONFLICT") return "BLOCK_CONFLICT" as const;
  return "FLUSH_THEN_NAVIGATE" as const;
}

export function shouldProtectV04Unload(input: V04LocalDraftFacts) {
  return !isV04LocalDraftClean(input);
}

export function isV04DraftConfirmedAfterFlush(input: V04LocalDraftFacts) {
  input = normalizeV04LocalDraftFacts(input);
  if (input.saveInFlight || input.recoveryPending || input.editVersion > input.savedVersion) return false;
  return input.saveStatus !== "OFFLINE_LOCAL" && input.saveStatus !== "CONFLICT" &&
    input.saveStatus !== "ERROR_RETRYABLE" && input.saveStatus !== "ERROR_FATAL";
}

export function shouldRetryV04DraftOnResume(input: V04LocalDraftFacts) {
  if (input.saveStatus === "CONFLICT") return false;
  if (input.saveInFlight) return true;
  if (input.editVersion > input.savedVersion) return true;
  return input.saveStatus === "DIRTY" || input.saveStatus === "OFFLINE_LOCAL" ||
    input.saveStatus === "ERROR_RETRYABLE";
}

export class V04SingleFlight {
  private active: Promise<boolean> | null = null;

  run(operation: () => Promise<boolean>) {
    if (this.active) return this.active;
    const active = operation();
    this.active = active;
    const clear = () => { if (this.active === active) this.active = null; };
    void active.then(clear, clear);
    return active;
  }
}

export async function runV04GuardedNavigation(input: {
  facts: () => V04LocalDraftFacts;
  preserveRecovery: () => void;
  flush: () => Promise<boolean>;
  navigate: () => void;
  canNavigate?: () => boolean;
}) {
  const plan = decideV04InternalNavigation(input.facts());
  if (plan === "NAVIGATE") {
    if (input.canNavigate && !input.canNavigate()) return "CANCELLED" as const;
    input.navigate();
    return "NAVIGATED" as const;
  }
  if (plan === "BLOCK_CONFLICT") return "BLOCKED_CONFLICT" as const;
  input.preserveRecovery();
  if (!await input.flush()) return "BLOCKED_SAVE_FAILED" as const;
  if (!isV04DraftConfirmedAfterFlush(input.facts())) return "BLOCKED_SAVE_PENDING" as const;
  if (input.canNavigate && !input.canNavigate()) return "CANCELLED" as const;
  input.navigate();
  return "NAVIGATED" as const;
}

export type V04GuardedNavigationResult = Awaited<ReturnType<typeof runV04GuardedNavigation>>;

/**
 * Owns every navigation that may leave a V0.4 workspace, including the global
 * deploy-update reload event. Concurrent clicks join one operation, and an
 * unmounted workspace can cancel a late save response before it reloads.
 */
export class V04GuardedNavigationCoordinator {
  private active: Promise<V04GuardedNavigationResult> | null = null;
  private disposed = false;

  private async execute(input: Parameters<typeof runV04GuardedNavigation>[0]) {
    try {
      return await runV04GuardedNavigation({
        ...input,
        canNavigate: () => !this.disposed && (input.canNavigate?.() ?? true),
      });
    } finally {
      this.active = null;
    }
  }

  get isRunning() {
    return this.active !== null;
  }

  run(input: Parameters<typeof runV04GuardedNavigation>[0]) {
    if (this.disposed) return Promise.resolve("CANCELLED" as const);
    if (this.active) return this.active;
    const operation = this.execute(input);
    this.active = operation;
    return operation;
  }

  dispose() {
    this.disposed = true;
  }
}

export function installV04NavigationTakeover(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  eventName: string,
  input: {
    preserveRecovery: () => void;
    run: (navigate: () => void) => void;
  },
) {
  const handler = (rawEvent: Event) => {
    const event = rawEvent as CustomEvent<{ continueNavigation: () => void }>;
    event.preventDefault();
    input.preserveRecovery();
    input.run(event.detail.continueNavigation);
  };
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
}

export async function runV04DraftResume(input: {
  facts: () => V04LocalDraftFacts;
  acquire: () => Promise<boolean>;
  hasRecoveryConflict: () => boolean;
  flush: () => Promise<boolean>;
  forceAcquire?: boolean;
}) {
  if (!input.forceAcquire && !shouldRetryV04DraftOnResume(input.facts())) return true;
  if (!await input.acquire()) return false;
  if (input.hasRecoveryConflict()) return false;
  if (!shouldRetryV04DraftOnResume(input.facts())) return true;
  return input.flush();
}
