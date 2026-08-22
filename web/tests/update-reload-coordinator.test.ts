import test from "node:test";
import assert from "node:assert/strict";
import { UpdateReloadCoordinator } from "../lib/update-reload-coordinator";

class FakeScheduler {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();

  schedule = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  clear = (id: number) => {
    this.tasks.delete(id);
  };

  run(delayMs: number) {
    const entry = [...this.tasks.entries()].find(([, task]) => task.delayMs === delayMs);
    assert.ok(entry, `missing ${delayMs}ms task`);
    this.tasks.delete(entry[0]);
    entry[1].callback();
  }
}

type PageMode = "READONLY" | "V04_DIRTY" | "V04_UNMOUNTED" | "V03_DIRTY";

function harness(initialMode: PageMode = "READONLY") {
  const scheduler = new FakeScheduler();
  let mode = initialMode;
  let pendingContinuation: (() => void) | null = null;
  let reloads = 0;
  let dispatches = 0;
  let retries = 0;
  const coordinator = new UpdateReloadCoordinator({
    dispatchNavigation: (continueNavigation) => {
      dispatches += 1;
      if (mode === "V04_DIRTY" || mode === "V03_DIRTY") {
        pendingContinuation = continueNavigation;
        return false;
      }
      return true;
    },
    isProtectedWorkspace: () => mode === "V04_DIRTY" || mode === "V04_UNMOUNTED",
    reload: () => { reloads += 1; },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clear,
    fallbackDelayMs: 2500,
    takeoverTimeoutMs: 10_000,
    onTakeoverTimedOut: () => { retries += 1; },
  });
  return {
    coordinator,
    scheduler,
    setMode: (next: PageMode) => { mode = next; },
    continueAfterSave: () => pendingContinuation?.(),
    facts: () => ({ reloads, dispatches, retries }),
  };
}

test("a readonly-page timer re-dispatches after entering a dirty V1.9 workspace", () => {
  const app = harness();
  assert.equal(app.coordinator.request(), true);
  assert.deepEqual(app.facts(), { reloads: 0, dispatches: 1, retries: 0 });

  app.setMode("V04_DIRTY");
  app.scheduler.run(2500);
  assert.deepEqual(app.facts(), { reloads: 0, dispatches: 2, retries: 0 });
  app.continueAfterSave();
  app.continueAfterSave();
  assert.deepEqual(app.facts(), { reloads: 1, dispatches: 2, retries: 0 });
});

test("the delayed re-dispatch lets the frozen V0.3 listener finish its save", () => {
  const app = harness();
  app.coordinator.request();
  app.setMode("V03_DIRTY");
  app.scheduler.run(2500);
  assert.equal(app.facts().reloads, 0);
  app.continueAfterSave();
  assert.equal(app.facts().reloads, 1);
});

test("a V1.9 workspace root without a mounted listener fails closed", () => {
  const app = harness();
  app.coordinator.request();
  app.setMode("V04_UNMOUNTED");
  app.scheduler.run(2500);
  assert.deepEqual(app.facts(), { reloads: 0, dispatches: 2, retries: 0 });
  app.scheduler.run(10_000);
  assert.deepEqual(app.facts(), { reloads: 0, dispatches: 2, retries: 1 });
});

test("a page that remains readonly reloads after the execution-time recheck", () => {
  const app = harness();
  app.coordinator.request();
  app.scheduler.run(2500);
  assert.deepEqual(app.facts(), { reloads: 1, dispatches: 2, retries: 0 });
});

test("duplicate requests, disposal, and late continuations cannot reload twice", () => {
  const app = harness("V04_DIRTY");
  assert.equal(app.coordinator.request(), true);
  assert.equal(app.coordinator.request(), false);
  assert.equal(app.facts().dispatches, 1);
  app.coordinator.dispose();
  app.continueAfterSave();
  assert.equal(app.facts().reloads, 0);
  assert.equal(app.scheduler.tasks.size, 0);
});

test("a timed-out takeover retires its late continuation", () => {
  const app = harness("V04_DIRTY");
  app.coordinator.request();
  app.scheduler.run(10_000);
  app.continueAfterSave();
  assert.deepEqual(app.facts(), { reloads: 0, dispatches: 1, retries: 1 });
});
