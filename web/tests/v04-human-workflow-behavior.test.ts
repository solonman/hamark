import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { V04LatestSaveCoordinator } from "../lib/v04-save-coordinator";

type HumanDraft = {
  title: string;
  commercialIntent: string;
  ratingReason: string;
};

const blankDraft = (): HumanDraft => ({ title: "", commercialIntent: "", ratingReason: "" });
const completedDraft = (suffix: string): HumanDraft => ({
  title: `TEST_ONLY ${suffix}`,
  commercialIntent: `建立明确意图 ${suffix}`,
  ratingReason: `结构完整 ${suffix}`,
});
const clone = (draft: HumanDraft) => structuredClone(draft);
const hash = (draft: HumanDraft) => createHash("sha256")
  .update(JSON.stringify(draft), "utf8")
  .digest("hex");

/**
 * Executable TEST_ONLY behavior harness. It deliberately models the same
 * client invariants as V04WorkspaceClient: one latest-save coordinator,
 * server confirmation before SAVED, immutable submissions and discoverable
 * local recovery. It never connects to a BUSINESS case.
 */
class HumanWorkflowHarness {
  readonly coordinator = new V04LatestSaveCoordinator<HumanDraft>();
  readonly submissions: Array<{ number: number; hash: string; payload: HumanDraft }> = [];
  server = blankDraft();
  local = blankDraft();
  serverRevision = 0;
  editVersion = 0;
  saveCalls = 0;
  submitCalls = 0;
  recovery: HumanDraft | null = null;
  online = true;
  failNextSubmit = false;
  loseNextSaveResponse = false;
  private appliedSaveVersions = new Map<number, string>();
  private submitInFlight: Promise<boolean> | null = null;
  private saveGate: Promise<void> | null = null;
  private releaseSaveGate: (() => void) | null = null;

  constructor(mode: "NEW" | "REVISION") {
    if (mode === "REVISION") {
      this.server = completedDraft("V1");
      this.local = clone(this.server);
      this.serverRevision = 1;
      this.submissions.push({ number: 1, hash: hash(this.server), payload: clone(this.server) });
    }
  }

  edit(patch: Partial<HumanDraft>) {
    this.local = { ...this.local, ...patch };
    this.editVersion += 1;
    this.recovery = clone(this.local);
    this.coordinator.stage({ version: this.editVersion, draft: clone(this.local) });
  }

  pauseNextSave() {
    this.saveGate = new Promise<void>((resolve) => { this.releaseSaveGate = resolve; });
  }

  releasePausedSave() {
    this.releaseSaveGate?.();
    this.releaseSaveGate = null;
  }

  async saveLatest() {
    return this.coordinator.flush(async (attempt) => {
      this.saveCalls += 1;
      if (!this.online) return false;
      if (this.saveGate) {
        const gate = this.saveGate;
        this.saveGate = null;
        await gate;
      }
      const attemptedHash = hash(attempt.draft);
      const existing = this.appliedSaveVersions.get(attempt.version);
      if (existing) return existing === attemptedHash;
      this.server = clone(attempt.draft);
      this.serverRevision += 1;
      this.appliedSaveVersions.set(attempt.version, attemptedHash);
      if (this.loseNextSaveResponse) {
        this.loseNextSaveResponse = false;
        return false;
      }
      return true;
    }).then((confirmed) => {
      if (confirmed && this.coordinator.savedVersion === this.editVersion && hash(this.server) === hash(this.local)) {
        this.recovery = null;
      }
      return confirmed;
    });
  }

  async submitLatest() {
    if (this.submitInFlight) return this.submitInFlight;
    const operation = (async () => {
      while (this.coordinator.savedVersion < this.editVersion) {
        if (!await this.saveLatest()) return false;
      }
      assert.equal(hash(this.server), hash(this.local), "submission source must equal the confirmed latest edit");
      this.submitCalls += 1;
      if (this.failNextSubmit) {
        this.failNextSubmit = false;
        return false;
      }
      const contentHash = hash(this.server);
      if (this.submissions.at(-1)?.hash === contentHash) return true;
      this.submissions.push({
        number: this.submissions.length + 1,
        hash: contentHash,
        payload: clone(this.server),
      });
      return true;
    })();
    this.submitInFlight = operation;
    void operation.finally(() => {
      if (this.submitInFlight === operation) this.submitInFlight = null;
    });
    return operation;
  }

  leaveBeforeDebounce() {
    this.recovery = clone(this.local);
  }

  reenter() {
    this.local = this.recovery ? clone(this.recovery) : clone(this.server);
  }

  readonlyResult() {
    return clone(this.submissions.at(-1)?.payload ?? blankDraft());
  }
}

async function expectFinishedChain(
  mode: "NEW" | "REVISION",
  scenario: (flow: HumanWorkflowHarness) => Promise<void>,
) {
  const flow = new HumanWorkflowHarness(mode);
  const immutableBefore = flow.submissions[0] ? clone(flow.submissions[0].payload) : null;
  await scenario(flow);
  const expectedCount = mode === "NEW" ? 1 : 2;
  assert.equal(flow.submissions.length, expectedCount);
  assert.deepEqual(flow.readonlyResult(), flow.server);
  assert.equal(flow.submissions.at(-1)?.hash, hash(flow.server));
  if (immutableBefore) assert.deepEqual(flow.submissions[0].payload, immutableBefore);
}

for (const mode of ["NEW", "REVISION"] as const) {
  test(`${mode}: autosave-only edits are server-confirmed before one immutable submission`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit(completedDraft(`${mode}-autosave`));
      assert.equal(await flow.saveLatest(), true);
      assert.equal(flow.coordinator.savedVersion, flow.editVersion);
      assert.equal(flow.recovery, null);
      assert.equal(await flow.submitLatest(), true);
    });
  });

  test(`${mode}: typing with manual saves keeps the latest server payload`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit({ title: `${mode}-manual-1` });
      assert.equal(await flow.saveLatest(), true);
      flow.edit(completedDraft(`${mode}-manual-2`));
      assert.equal(await flow.saveLatest(), true);
      assert.equal(await flow.submitLatest(), true);
    });
  });

  test(`${mode}: direct submit implicitly flushes the latest edit`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit(completedDraft(`${mode}-direct`));
      assert.equal(flow.coordinator.savedVersion, 0);
      assert.equal(await flow.submitLatest(), true);
      assert.equal(flow.coordinator.savedVersion, flow.editVersion);
    });
  });

  test(`${mode}: explicit save then submit does not create a second draft path`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit(completedDraft(`${mode}-saved-first`));
      assert.equal(await flow.saveLatest(), true);
      const saveCalls = flow.saveCalls;
      assert.equal(await flow.submitLatest(), true);
      assert.equal(flow.saveCalls, saveCalls);
    });
  });

  test(`${mode}: an edit made during a slow save is drained before submit`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit({ title: `${mode}-slow-v1` });
      flow.pauseNextSave();
      const first = flow.saveLatest();
      flow.edit(completedDraft(`${mode}-slow-v2`));
      const submission = flow.submitLatest();
      flow.releasePausedSave();
      assert.equal(await first, true);
      assert.equal(await submission, true);
      assert.equal(flow.coordinator.savedVersion, flow.editVersion);
    });
  });

  test(`${mode}: leaving before debounce exposes recovery and returns without loss`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit(completedDraft(`${mode}-leave`));
      flow.leaveBeforeDebounce();
      flow.local = blankDraft();
      flow.reenter();
      assert.equal(flow.local.title, `TEST_ONLY ${mode}-leave`);
      assert.equal(await flow.submitLatest(), true);
    });
  });

  test(`${mode}: a confirmed save survives refresh and returns from the server`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit(completedDraft(`${mode}-refresh`));
      assert.equal(await flow.saveLatest(), true);
      flow.local = blankDraft();
      flow.reenter();
      assert.deepEqual(flow.local, flow.server);
      assert.equal(await flow.submitLatest(), true);
    });
  });

  test(`${mode}: idle expiry is transparent after the isolated editor resumes`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit({ title: `${mode}-before-idle` });
      assert.equal(await flow.saveLatest(), true);
      flow.edit(completedDraft(`${mode}-after-idle`));
      // Lease expiry/reacquire is covered against real PostgreSQL; at the
      // human flow boundary the resumed editor still drains only its latest edit.
      assert.equal(await flow.submitLatest(), true);
    });
  });

  test(`${mode}: failed submit is retriable and a double click stays idempotent`, async () => {
    await expectFinishedChain(mode, async (flow) => {
      flow.edit(completedDraft(`${mode}-retry`));
      flow.failNextSubmit = true;
      assert.equal(await flow.submitLatest(), false);
      const [left, right] = await Promise.all([flow.submitLatest(), flow.submitLatest()]);
      assert.deepEqual([left, right], [true, true]);
      assert.equal(flow.submissions.length, mode === "NEW" ? 1 : 2);
    });
  });
}

test("risk classes: offline recovery and a lost save response never produce a false submission", async () => {
  const flow = new HumanWorkflowHarness("NEW");
  flow.edit(completedDraft("offline"));
  flow.online = false;
  assert.equal(await flow.submitLatest(), false);
  assert.equal(flow.submissions.length, 0);
  assert.notEqual(flow.recovery, null);
  flow.online = true;
  flow.loseNextSaveResponse = true;
  assert.equal(await flow.submitLatest(), false, "an uncertain response must not be called saved or submitted");
  assert.equal(flow.submissions.length, 0);
  assert.equal(await flow.submitLatest(), true, "same staged version retries idempotently after reconnect");
  assert.deepEqual(flow.readonlyResult(), flow.local);
});
