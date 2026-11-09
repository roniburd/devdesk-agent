/**
 * Async results by key that stay valid until `invalidate()`: every `get` of a key in the same epoch shares one load
 * (running or finished), so overlapping refreshes never start the same work twice. `load` gets `isCurrent`, which turns
 * false once the cache is invalidated; a load still queued then should call `get` again to join the current epoch's
 * load instead of doing outdated work. Loads that wait for a slot in a pool should go through `getPooled`, which joins
 * only after giving the slot back.
 */
export class LoadCache<T> {
  private epoch = 0;
  private readonly entries = new Map<string, { epoch: number; promise: Promise<T>; done?: boolean }>();
  /** The last value each key's load resolved to, kept across invalidate() until a newer load resolves. */
  private readonly settled = new Map<string, T>();

  /** The last loaded value of `key` (possibly from before the last invalidate()), if any load of it has resolved. */
  peek(key: string): T | undefined {
    return this.settled.get(key);
  }

  /** Whether `key` has a value no drop() or invalidate() made outdated, so get() returns it without waiting. */
  isFresh(key: string): boolean {
    const entry = this.entries.get(key);
    return !!entry?.done && entry.epoch === this.epoch;
  }

  /** Later `get`s load again; loads already running finish for whoever awaits them. */
  invalidate(): void {
    this.epoch++;
  }

  /** Settles once every load started so far has settled (and isFresh sees it). */
  async allSettled(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((e) => e.promise));
  }

  get(key: string, load: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.epoch === this.epoch) return entry.promise;
    const epoch = this.epoch;
    // Not current once invalidated, or once this key was dropped (another load of it may have started since).
    let loading: { epoch: number; promise: Promise<T>; done?: boolean } | undefined;
    const promise = load(() => epoch === this.epoch && (loading === undefined || this.entries.get(key) === loading));
    loading = { epoch, promise };
    this.entries.set(key, loading);
    promise.then(
      (value) => {
        const entry = this.entries.get(key);
        if (!entry || entry !== loading) return;
        entry.done = true;
        this.settled.set(key, value);
      },
      () => undefined,
    );
    return promise;
  }

  /**
   * The next `get` of `key` loads it again (it changed). A load of it still waiting for a slot rejoins that newer
   * load instead of running (see getPooled); one already running finishes for whoever awaits it, but does not replace
   * the last value. That value stays for peek() until the new load resolves.
   */
  drop(key: string): void {
    this.entries.delete(key);
  }

  /** Forgets every key not in `keep` (packages that are gone). */
  retain(keep: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key);
    for (const key of this.settled.keys()) if (!keep.has(key)) this.settled.delete(key);
  }
}

const STALE = Symbol('stale');

/**
 * `cache.get(key)` where the work runs in a slot pool (`start` queues a task for a slot). A load invalidated while it
 * waited gives its slot back before joining the current load: joining while holding it would let the loads queued
 * before a refresh take every slot and wait forever for loads queued behind them.
 */
export function getPooled<T>(
  cache: LoadCache<T>,
  key: string,
  start: (task: () => Promise<T | typeof STALE>) => Promise<T | typeof STALE>,
  work: () => Promise<T>,
): Promise<T> {
  const load = (isCurrent: () => boolean): Promise<T> =>
    start(async () => (isCurrent() ? work() : STALE)).then((result) => (result === STALE ? cache.get(key, load) : result));
  return cache.get(key, load);
}
