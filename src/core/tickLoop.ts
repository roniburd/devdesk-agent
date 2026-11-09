export interface TickLoopOptions {
  /** The rest between the end of one tick and the start of the next; 0 or less stops the loop. */
  intervalMs: () => number;
  /** False pauses the loop (view hidden, window in the background); asked again on every update(). */
  active: () => boolean;
  /** One tick; its promise settles when its work is done. */
  tick: () => Promise<void>;
  /** A tick still running after this long counts as done, so one hung tick does not stop the loop. */
  maxTickMs?: number;
  /** Told when a tick fails, or is given up on after `maxTickMs`. */
  onProblem?: (message: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface TickLoop {
  /** Call when `active()` or `intervalMs()` may have changed: pauses, resumes or reschedules. */
  update(): void;
  /** True while a tick runs. */
  readonly running: boolean;
  dispose(): void;
}

/**
 * Runs `tick` again `intervalMs()` after the previous tick has finished (never two at once, unlike setInterval), only
 * while `active()`. Resuming after a pause waits only what is left of the rest since the last tick ended: a pause
 * longer than the interval ticks at once. The first tick comes one interval after creation.
 */
export function tickLoop(o: TickLoopOptions): TickLoop {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const maxTickMs = o.maxTickMs ?? 5 * 60_000;
  let timer: unknown;
  let running = false;
  let disposed = false;
  let lastEnd = now();

  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  const run = async () => {
    timer = undefined;
    if (disposed || !o.active() || o.intervalMs() <= 0) return;
    running = true;
    let giveUp: unknown;
    try {
      await Promise.race([
        o.tick(),
        new Promise<void>((resolve) => {
          giveUp = setTimer(() => {
            o.onProblem?.(`tick still running after ${Math.round(maxTickMs / 1000)}s; scheduling the next one anyway`);
            resolve();
          }, maxTickMs);
        }),
      ]);
    } catch (err) {
      o.onProblem?.(`tick failed: ${(err as Error).message}`);
    } finally {
      clearTimer(giveUp);
      running = false;
      lastEnd = now();
      update();
    }
  };

  const update = () => {
    cancel();
    if (disposed || running) return; // a running tick reschedules when it ends
    const interval = o.intervalMs();
    if (interval <= 0 || !o.active()) return;
    timer = setTimer(() => void run(), Math.max(0, interval - (now() - lastEnd)));
  };

  update();
  return {
    update,
    get running() {
      return running;
    },
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}
