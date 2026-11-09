import { describe, expect, it } from 'vitest';
import { idleReloadsPerTick, oldestFirst } from '../src/core/idleReloads';

const MIN = 60_000;

describe('idle reloads', () => {
  it('reloads enough per tick to get through every idle package in half the reload interval', () => {
    // 600 packages, a tick every 20s, every 10 minutes: 15 ticks in 5 minutes, 40 per tick.
    expect(idleReloadsPerTick(600, 20_000, 10 * MIN)).toBe(40);
    expect(idleReloadsPerTick(10, 20_000, 10 * MIN)).toBe(1);
    expect(idleReloadsPerTick(1, 20_000, 10 * MIN)).toBe(1);
  });
  it('has no limit without a tick or a reload interval', () => {
    expect(idleReloadsPerTick(600, 0, 10 * MIN)).toBe(Infinity);
    expect(idleReloadsPerTick(600, 20_000, 0)).toBe(Infinity);
  });
  it('no idle packages, no reloads', () => {
    expect(idleReloadsPerTick(0, 20_000, 10 * MIN)).toBe(0);
  });
  it('picks the packages loaded longest ago', () => {
    const due = [{ id: 'b', startedAt: 20 }, { id: 'a', startedAt: 10 }, { id: 'c', startedAt: 30 }];
    expect(oldestFirst(due, 2).map((d) => d.id)).toEqual(['a', 'b']);
    expect(oldestFirst(due, Infinity).map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });
});
