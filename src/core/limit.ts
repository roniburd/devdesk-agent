/** A task queued in a priority pool; `promote()` moves a background task that has not started ahead of all others. */
export interface Queued<R> {
  promise: Promise<R>;
  promote(): void;
}

/**
 * A shared pool of `limit` slots where foreground tasks start before any queued background task (prefetching), and a
 * queued background task can be promoted once someone waits for it. Calling it runs `task` in the pool; `idle()`
 * settles once no task is running or queued.
 */
export type PriorityLimiter = (<R>(task: () => Promise<R>, background?: boolean) => Queued<R>) & { idle(): Promise<void> };

/**
 * `limit` slots (asked again each time a task could start, so it can change), of which background tasks may use only
 * `backgroundLimit()` (at most `limit`): foreground tasks (what someone waits for) still start on a busy machine.
 */
export function createPriorityLimiter(limit: number | (() => number), backgroundLimit?: () => number): PriorityLimiter {
  const total = typeof limit === 'number' ? () => limit : limit;
  const forBackground = () => Math.min(total(), backgroundLimit?.() ?? Infinity);
  let active = 0;
  const foreground: (() => void)[] = [];
  const backgroundQueue: (() => void)[] = [];
  let idleWaiters: (() => void)[] = [];
  const startNext = () => {
    for (;;) {
      const start = active < total() ? (foreground.shift() ?? (active < forBackground() ? backgroundQueue.shift() : undefined)) : undefined;
      if (!start) break;
      active++;
      start();
    }
    if (active === 0 && idleWaiters.length) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const isIdle = () => active === 0 && !foreground.length && !backgroundQueue.length;
  const run = <R>(task: () => Promise<R>, background = false): Queued<R> => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve));
    (background ? backgroundQueue : foreground).push(start);
    const promise = started.then(task).finally(() => {
      active--;
      startNext();
    });
    startNext();
    return {
      promise,
      promote: () => {
        const i = backgroundQueue.indexOf(start);
        if (i < 0) return;
        backgroundQueue.splice(i, 1);
        foreground.push(start);
      },
    };
  };
  return Object.assign(run, {
    idle: () => (isIdle() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))),
  });
}

/** `work` on each of `items`, at most `limit` at a time; the results in the items' order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
