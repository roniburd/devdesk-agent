import { describe, expect, it } from 'vitest';
import { createPriorityLimiter } from '../src/core/limit';
import { getPooled, LoadCache } from '../src/core/loadCache';

describe('LoadCache', () => {
  it('isFresh: a value loaded since the last drop or invalidate, while peek keeps the older one', async () => {
    const cache = new LoadCache<number>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let loads = 0;
    const load = async () => {
      await gate;
      return ++loads;
    };
    const first = cache.get('k', load);
    expect(cache.isFresh('k')).toBe(false);
    release();
    await first;
    expect(cache.isFresh('k')).toBe(true);
    cache.drop('k');
    expect(cache.isFresh('k')).toBe(false);
    expect(cache.peek('k')).toBe(1);
    await cache.get('k', load);
    expect(cache.isFresh('k')).toBe(true);
    cache.invalidate();
    expect(cache.isFresh('k')).toBe(false);
    expect(cache.peek('k')).toBe(2);
  });

  it('shares one load per key until invalidated', async () => {
    const cache = new LoadCache<number>();
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
    expect([a, b, await cache.get('k', load)]).toEqual([1, 1, 1]);
    cache.invalidate();
    expect(await cache.get('k', load)).toBe(2);
    expect(await cache.get('other', load)).toBe(3);
  });

  it('tells a load whether its epoch is still current', async () => {
    const cache = new LoadCache<string>();
    let isCurrent: () => boolean = () => true;
    void cache.get('k', async (current) => {
      isCurrent = current;
      return 'old';
    });
    expect(isCurrent()).toBe(true);
    cache.invalidate();
    expect(isCurrent()).toBe(false);
  });

  it('lets a load queued before an invalidate join the current load', async () => {
    const cache = new LoadCache<string>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const load = async (isCurrent: () => boolean): Promise<string> => {
      await gate; // waiting for a free slot
      if (!isCurrent()) return cache.get('k', load);
      runs++;
      return 'fresh';
    };
    const stale = cache.get('k', load);
    cache.invalidate();
    const current = cache.get('k', load);
    release();
    expect(await stale).toBe('fresh');
    expect(await current).toBe('fresh');
    expect(runs).toBe(1);
  });

  it('peeks at the last resolved value, kept across invalidate until a newer load resolves', async () => {
    const cache = new LoadCache<number>();
    expect(cache.peek('k')).toBeUndefined();
    await cache.get('k', async () => 1);
    expect(cache.peek('k')).toBe(1);
    cache.invalidate();
    let release!: () => void;
    const next = cache.get('k', () => new Promise<number>((r) => (release = () => r(2))));
    expect(cache.peek('k')).toBe(1);
    release();
    await next;
    expect(cache.peek('k')).toBe(2);
    cache.retain(new Set());
    expect(cache.peek('k')).toBeUndefined();
  });

  it('loads one key again after drop, keeping its last value for peek, and other keys as loaded', async () => {
    const cache = new LoadCache<number>();
    let n = 0;
    const load = async () => ++n;
    expect(await cache.get('a', load)).toBe(1);
    expect(await cache.get('b', load)).toBe(2);
    cache.drop('a');
    expect(cache.peek('a')).toBe(1);
    expect(await cache.get('a', load)).toBe(3);
    expect(cache.peek('a')).toBe(3);
    expect(await cache.get('b', load)).toBe(2);
  });

  it('tells a load of a dropped key that it is no longer current', async () => {
    const cache = new LoadCache<number>();
    let current: (() => boolean) | undefined;
    void cache.get('a', async (isCurrent) => {
      current = isCurrent;
      return 1;
    });
    expect(current?.()).toBe(true);
    cache.drop('a');
    expect(current?.()).toBe(false);
  });

  it('forgets keys that are not retained', async () => {
    const cache = new LoadCache<number>();
    let loads = 0;
    const load = async () => ++loads;
    await cache.get('a', load);
    await cache.get('b', load);
    cache.retain(new Set(['a']));
    expect(await cache.get('a', load)).toBe(1);
    expect(await cache.get('b', load)).toBe(3);
  });
});

describe('getPooled', () => {
  it('does not deadlock when loads queued before an invalidate fill every slot', async () => {
    const cache = new LoadCache<string>();
    const pool = createPriorityLimiter(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = (key: string, epoch: string) =>
      getPooled(cache, key, (task) => pool(task, true).promise, async () => {
        await gate;
        return `${key}${epoch}`;
      });
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const first = keys.map((k) => load(k, '1'));
    await new Promise((r) => setTimeout(r, 0)); // a and b take the two slots
    cache.invalidate(); // a refresh while three loads still wait for a slot
    const second = keys.map((k) => load(k, '2'));
    release();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 1000));
    // The two that had started keep their result; the ones still queued join the newer load.
    expect(await Promise.race([Promise.all([...first, ...second]), timeout])).toEqual(['a1', 'b1', 'c2', 'd2', 'e2', 'a2', 'b2', 'c2', 'd2', 'e2']);
  });
});
