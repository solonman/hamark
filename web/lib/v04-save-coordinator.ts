import type { V04Change } from "./v04-contract";

export type V04PendingSave<TDraft> = {
  version: number;
  draft: TDraft;
};

export class V04LatestSaveCoordinator<TDraft> {
  private desired: V04PendingSave<TDraft> | null = null;
  private active: Promise<boolean> | null = null;
  private confirmedVersion = 0;

  get savedVersion() {
    return this.confirmedVersion;
  }

  get isRunning() {
    return this.active !== null;
  }

  stage(attempt: V04PendingSave<TDraft>) {
    if (!this.desired || attempt.version >= this.desired.version) this.desired = attempt;
  }

  markServerConfirmed(version: number) {
    this.confirmedVersion = Math.max(this.confirmedVersion, version);
  }

  resetFromServer(version = 0) {
    if (this.active) throw new Error("SAVE_IN_FLIGHT");
    this.desired = null;
    this.confirmedVersion = version;
  }

  private async drain(save: (attempt: V04PendingSave<TDraft>) => Promise<boolean>) {
    try {
      while (true) {
        while (this.desired && this.desired.version > this.confirmedVersion) {
          const target = this.desired;
          if (!await save(target)) return false;
          this.markServerConfirmed(target.version);
        }
        // A stage() scheduled by the save callback's final microtask must be
        // observed before this promise becomes externally resolved.
        await Promise.resolve();
        if (!this.desired || this.desired.version <= this.confirmedVersion) return true;
      }
    } finally {
      // Clear before the returned promise settles. This removes the window in
      // which a caller could receive an already-resolved active promise while
      // a newer staged edit remained undrained.
      this.active = null;
    }
  }

  flush(save: (attempt: V04PendingSave<TDraft>) => Promise<boolean>) {
    if (this.active) return this.active;
    this.active = this.drain(save);
    return this.active;
  }
}

export function shouldReleaseV04Lease(input: {
  saveStatus: string;
  saveInFlight: boolean;
  editVersion: number;
  savedVersion: number;
}) {
  return !input.saveInFlight && input.editVersion <= input.savedVersion &&
    (input.saveStatus === "CLEAN" || input.saveStatus === "SAVED");
}

export function canMutateV04Draft(input: {
  capability: boolean;
  restoring: boolean;
  submitting: boolean;
  navigating?: boolean;
}) {
  return input.capability && !input.restoring && !input.submitting && !input.navigating;
}

export function canStartV04Restore(input: {
  saveStatus: string;
  saveInFlight: boolean;
  submitting: boolean;
  restoring: boolean;
  editVersion: number;
  savedVersion: number;
}) {
  return !input.saveInFlight && !input.submitting && !input.restoring &&
    input.editVersion <= input.savedVersion &&
    (input.saveStatus === "CLEAN" || input.saveStatus === "SAVED");
}

export function canRecoverV04LeaseProof(input: {
  canAcquireLease: boolean;
  canEdit: boolean;
}) {
  return input.canAcquireLease || input.canEdit;
}

export type V04EditAccessRecoveryPlan = {
  state: "EDITABLE" | "ACQUIRE_NOW" | "WAIT_FOR_LEASE" | "DENIED";
  retryAfterMs: number | null;
};

export function planV04EditAccessRecovery(input: {
  logicalEmpty: boolean;
  canMaterialize: boolean;
  canEdit: boolean;
  canAcquireLease: boolean;
  member: boolean;
  leaseExpiresAt: string | null;
}, now = Date.now()): V04EditAccessRecoveryPlan {
  if (input.canEdit || (input.logicalEmpty && input.canMaterialize)) {
    return { state: "EDITABLE", retryAfterMs: null };
  }
  if (!input.member) return { state: "DENIED", retryAfterMs: null };
  if (input.canAcquireLease) return { state: "ACQUIRE_NOW", retryAfterMs: 250 };
  const expiresAt = input.leaseExpiresAt ? Date.parse(input.leaseExpiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt)) {
    return {
      state: "WAIT_FOR_LEASE",
      retryAfterMs: Math.min(30_000, Math.max(500, expiresAt - now + 250)),
    };
  }
  // A capability response can become stale after an earlier lease request or
  // network failure. Re-read periodically, but never attempt a mutation until
  // the fresh read model explicitly allows acquisition or exact-tab recovery.
  return { state: "WAIT_FOR_LEASE", retryAfterMs: 5_000 };
}

export function canSubmitV04ServerDraft(input: {
  localPublicationReady: boolean;
  serverPublicationReady: boolean;
  saveCompleted: boolean;
  editVersion: number;
  savedVersion: number;
}) {
  return input.localPublicationReady && input.serverPublicationReady && input.saveCompleted &&
    input.editVersion <= input.savedVersion;
}

export function shouldDisableV04Submission(input: {
  canEdit: boolean;
  publicationReady: boolean;
  submitting: boolean;
  recoveryPending: boolean;
  noChangesToSubmit: boolean;
}) {
  return !input.canEdit || !input.publicationReady || input.submitting ||
    input.recoveryPending || input.noChangesToSubmit;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function planV04ThreeWayChanges(
  originalChanges: readonly V04Change[],
  currentValue: (targetKey: string) => unknown,
) {
  const changes: V04Change[] = [];
  const alreadyApplied: string[] = [];
  const conflicts: string[] = [];
  for (const change of originalChanges) {
    const current = currentValue(change.targetKey);
    if (sameValue(current, change.afterValue)) {
      alreadyApplied.push(change.targetKey);
    } else if (sameValue(current, change.beforeValue)) {
      changes.push({ ...change, beforeValue: structuredClone(current) });
    } else {
      conflicts.push(change.targetKey);
    }
  }
  return { changes, alreadyApplied, conflicts };
}

export function classifyV04RecoveryConfirmation(
  originalChanges: readonly V04Change[],
  currentValue: (targetKey: string) => unknown,
) {
  const plan = planV04ThreeWayChanges(originalChanges, currentValue);
  if (plan.conflicts.length) return "CONFLICT" as const;
  if (plan.changes.length) return "NOT_ABSORBED" as const;
  return "CONFIRMED" as const;
}

export function planV04RecoveryMerge(
  originalChanges: readonly V04Change[],
  serverValue: (targetKey: string) => unknown,
  localValue: (targetKey: string) => unknown,
) {
  const server = planV04ThreeWayChanges(originalChanges, serverValue);
  if (server.conflicts.length) {
    return { kind: "SERVER_CONFLICT" as const, conflicts: server.conflicts, changes: [] as V04Change[] };
  }
  const local = planV04ThreeWayChanges(originalChanges, localValue);
  if (local.conflicts.length) {
    return { kind: "LOCAL_CONFLICT" as const, conflicts: local.conflicts, changes: [] as V04Change[] };
  }
  return { kind: "MERGE" as const, conflicts: [] as string[], changes: local.changes };
}

export function atomicallyClearConfirmedV04RecoveryRecords<T>(
  records: readonly T[],
  isConfirmed: (record: T) => boolean,
  clearRecord: (record: T) => boolean,
  restoreRecord: (record: T) => boolean,
) {
  if (!records.every(isConfirmed)) return "UNCONFIRMED" as const;
  const cleared: T[] = [];
  for (const record of records) {
    if (!clearRecord(record)) {
      // localStorage has no transaction primitive. Restore any earlier entry
      // so UI state/ref and the complete recovery set stay fail-closed.
      for (const prior of cleared) restoreRecord(prior);
      return "STORAGE_FAILED" as const;
    }
    cleared.push(record);
  }
  return "CLEARED" as const;
}

export function clearSelectedV04RecoveryRecord<T>(
  records: readonly T[],
  selectedIndex: number,
  clearRecord: (record: T) => boolean,
) {
  const record = records[selectedIndex];
  if (!record || !clearRecord(record)) {
    return { status: "STORAGE_FAILED" as const, remaining: [...records] };
  }
  return {
    status: "CLEARED" as const,
    remaining: records.filter((_, index) => index !== selectedIndex),
  };
}

export async function runV04LeaseBoundMutationWithSingleRecovery<T>(input: {
  run: () => Promise<T>;
  leaseFailureCode: (reason: unknown) => string | null;
  invalidate: () => void;
  canReacquire: (code: string) => Promise<boolean>;
}) {
  try {
    return await input.run();
  } catch (reason) {
    const code = input.leaseFailureCode(reason);
    if (!code) throw reason;
    input.invalidate();
    if (!await input.canReacquire(code)) throw reason;
    return input.run();
  }
}
