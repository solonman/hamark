export type V04MetadataLoad = (signal: AbortSignal) => Promise<void>;

type Job = {
  controller: AbortController;
  run: V04MetadataLoad;
  started: boolean;
};

/**
 * Low-priority metadata loads share one slot so moving across library cards
 * cannot fan out competing video requests. Pending and active work are both
 * cancellable when a card leaves the page.
 */
export function createV04MetadataQueue(limit = 1) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("metadata queue limit must be positive");
  const pending: Job[] = [];
  const active = new Set<Job>();

  const pump = () => {
    while (active.size < limit) {
      const job = pending.shift();
      if (!job) return;
      if (job.controller.signal.aborted) continue;
      job.started = true;
      active.add(job);
      void Promise.resolve()
        .then(() => job.run(job.controller.signal))
        .finally(() => {
          active.delete(job);
          pump();
        });
    }
  };

  return {
    schedule(run: V04MetadataLoad) {
      const job: Job = { controller: new AbortController(), run, started: false };
      pending.push(job);
      pump();
      return () => {
        job.controller.abort();
        if (!job.started) {
          const index = pending.indexOf(job);
          if (index >= 0) pending.splice(index, 1);
        }
      };
    },
  };
}

export const v04MetadataQueue = createV04MetadataQueue(1);
