export type UpdateReloadCoordinatorOptions = {
  dispatchNavigation: (continueNavigation: () => void) => boolean;
  isProtectedWorkspace: () => boolean;
  reload: () => void;
  schedule: (callback: () => void, delayMs: number) => number;
  clearScheduled: (handle: number) => void;
  fallbackDelayMs: number;
  takeoverTimeoutMs: number;
  onTakeoverTimedOut: () => void;
};

/**
 * Coordinates deploy-update reloads with whichever page is active when a
 * delayed fallback actually fires. A route transition can mount a workspace
 * after the first navigation event, so the fallback must dispatch again and
 * give that workspace's save coordinator ownership before reloading.
 */
export class UpdateReloadCoordinator {
  private scheduled: number | null = null;
  private started = false;
  private retired = false;
  private reloaded = false;

  constructor(private readonly options: UpdateReloadCoordinatorOptions) {}

  private clearTimer() {
    if (this.scheduled === null) return;
    this.options.clearScheduled(this.scheduled);
    this.scheduled = null;
  }

  private readonly continueNavigation = () => {
    if (this.retired || this.reloaded) return;
    this.reloaded = true;
    this.clearTimer();
    this.options.reload();
  };

  private waitForTakeover() {
    this.clearTimer();
    this.scheduled = this.options.schedule(() => {
      this.scheduled = null;
      if (this.retired || this.reloaded) return;
      // A failed/cancelled save only restores the button. Retire this attempt
      // first so a late async continuation can never reload behind the user.
      this.retired = true;
      this.options.onTakeoverTimedOut();
    }, this.options.takeoverTimeoutMs);
  }

  private dispatchOrProtect() {
    const navigationWasNotTakenOver = this.options.dispatchNavigation(
      this.continueNavigation,
    );
    if (!navigationWasNotTakenOver || this.options.isProtectedWorkspace()) {
      this.waitForTakeover();
      return;
    }
    this.continueNavigation();
  }

  request() {
    if (this.started || this.retired || this.reloaded) return false;
    this.started = true;
    const navigationWasNotTakenOver = this.options.dispatchNavigation(
      this.continueNavigation,
    );
    if (!navigationWasNotTakenOver || this.options.isProtectedWorkspace()) {
      this.waitForTakeover();
      return true;
    }

    this.scheduled = this.options.schedule(() => {
      this.scheduled = null;
      if (this.retired || this.reloaded) return;
      // Re-evaluate at execution time. The app may have navigated from a
      // readonly page into V0.3 or V1.9 while this delay was pending.
      this.dispatchOrProtect();
    }, this.options.fallbackDelayMs);
    return true;
  }

  dispose() {
    if (this.retired) return;
    this.retired = true;
    this.clearTimer();
  }
}
