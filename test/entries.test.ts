import { describe, expect, it } from 'vitest';
import { applyEntries, changedEntries } from '../src/core/entries';

describe('applyEntries', () => {
  it("keeps other windows' entries and applies only the changed ones", () => {
    const saved: [string, string][] = [['a', '1'], ['b', '2'], ['c', '3']];
    expect(applyEntries(saved, new Map([['b', '9'], ['c', undefined], ['d', '4']]))).toEqual([['b', '9'], ['d', '4'], ['a', '1']]);
  });

  it('caps the entries, keeping the changed ones first', () => {
    expect(applyEntries([['a', 1], ['b', 2]], new Map([['c', 3]]), 2)).toEqual([['c', 3], ['a', 1]]);
  });
});

describe('changedEntries', () => {
  it('lists what was set, changed and removed', () => {
    const before = new Map([['a', 1], ['b', 2]]);
    const next = new Map([['a', 1], ['b', 3], ['c', 4]]);
    expect([...changedEntries(before, next)]).toEqual([['b', 3], ['c', 4]]);
    expect([...changedEntries(next, new Map([['a', 1]]))]).toEqual([['b', undefined], ['c', undefined]]);
  });
});
