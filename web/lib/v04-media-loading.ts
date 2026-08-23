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

/** 只读成果页顶部展示位与页面顶栏之间的判定基线（顶栏 70px + 一点余量）。 */
export const V04_DETAIL_DOCK_HEADER_OFFSET = 86;
const V04_DETAIL_DOCK_VISIBLE_RATIO = 0.4;

/**
 * 只读成果页向下滚动、顶部展示位只剩不到四成还露在顶栏下方时，播放器收进右下角。
 * 展示位的高度由调用方原地保留，所以判定只看展示位在视口里的位置：收起动作本身
 * 不会改变这个位置，也就不会在临界点上反复收起、展开。
 */
export function shouldDockV04DetailPlayer(
  heroTop: number,
  heroHeight: number,
  headerOffset = V04_DETAIL_DOCK_HEADER_OFFSET,
) {
  return heroTop + heroHeight * V04_DETAIL_DOCK_VISIBLE_RATIO < headerOffset;
}
