import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { hostKey, MementoEntries } from '../src/state/mementoState';

/** A Memento like VS Code's: `update` sets the value at once, `get` returns the same object until then. */
function memento(): vscode.Memento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as vscode.Memento & { values: Map<string, unknown> };
}

const isString = (v: unknown): v is string => typeof v === 'string';

describe('MementoEntries', () => {
  it("saves only this window's changes on top of what another window saved since", async () => {
    const m = memento();
    const entries = new MementoEntries(m, 'k', isString);
    await entries.apply(new Map([['a', '1']]));
    // Another window writes b.
    await m.update('k', [...(m.get<[string, string][]>('k') ?? []), ['b', '2']]);
    await entries.apply(new Map([['a', undefined], ['c', '3']]));
    expect(m.values.get('k')).toEqual([['c', '3'], ['b', '2']]);
    expect([...entries.get()]).toEqual([['c', '3'], ['b', '2']]);
  });

  it('saves an empty map when nothing is saved yet, and nothing for no changes after that', async () => {
    const m = memento();
    const entries = new MementoEntries(m, 'k', isString, 2);
    expect(entries.saved).toBe(false);
    await entries.apply(new Map());
    expect(entries.saved).toBe(true);
    expect(m.values.get('k')).toEqual([]);
    await entries.apply(new Map([['a', '1'], ['b', '2'], ['c', '3']]));
    const saved = m.values.get('k');
    await entries.apply(new Map());
    expect(m.values.get('k')).toBe(saved);
    expect(saved).toEqual([['a', '1'], ['b', '2']]);
  });

  it('drops saved entries that are not valid', () => {
    const m = memento();
    m.values.set('k', [['a', '1'], ['b', 2], 'junk', ['c', '3']]);
    expect([...new MementoEntries(m, 'k', isString).get().keys()]).toEqual(['a', 'c']);
  });
});

describe('hostKey', () => {
  it('names the host', () => {
    expect(hostKey('devdesk.sessions.seen', 'devbox-1')).toBe('devdesk.sessions.seen@devbox-1');
  });
});
