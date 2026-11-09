import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { LEGACY_REATTACH_KEY, REATTACH_KEY, ReattachTerminals, reattachKey } from '../src/state/reattachTerminals';

/** A `workspaceState` that several windows share, as VS Code keeps it: each update replaces the value. */
function memento(initial: Record<string, unknown> = {}): vscode.Memento {
  const values = new Map(Object.entries(initial));
  return {
    keys: () => [...values.keys()],
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as vscode.Memento;
}

const a = { session: 'cc-a', server: 'devdesk' };
const b = { session: 'cc-b', server: 'devdesk' };
const c = { session: 'cc-c', server: 'devdesk' };
const sessions = (r: ReattachTerminals<unknown>) => r.saved().map((o) => o.session);

describe('ReattachTerminals', () => {
  it('keeps the saved list while a restore waits: a close in the meantime removes only its own terminal', async () => {
    const state = memento();
    await new ReattachTerminals(state).opened({}, a);
    await new ReattachTerminals(state).opened({}, b);
    // The next window: it has not reattached anything yet when another terminal of its own opens and closes.
    const next = new ReattachTerminals<object>(state);
    const t = {};
    await next.opened(t, c);
    await next.closed(t, false);
    expect(sessions(next).sort()).toEqual(['cc-a', 'cc-b']);
  });

  it('keeps a terminal VS Code closed because the window closed or reloaded', async () => {
    const state = memento();
    const window = new ReattachTerminals<object>(state);
    const ta = {};
    const tb = {};
    await window.opened(ta, a);
    await window.opened(tb, b);
    await window.closed(ta, true);
    await window.closed(tb, true);
    expect(sessions(new ReattachTerminals(state)).sort()).toEqual(['cc-a', 'cc-b']);
  });

  it('forgets a terminal the user closed, unless another terminal of this window shows its session', async () => {
    const state = memento();
    const window = new ReattachTerminals<object>(state);
    const first = {};
    const second = {};
    await window.opened(first, a);
    await window.opened(second, a);
    await window.closed(first, false);
    expect(sessions(window)).toEqual(['cc-a']);
    await window.closed(second, false);
    expect(sessions(window)).toEqual([]);
    await window.closed({}, false); // not one of this window's
  });

  it("never loses another window's terminals on the same folder", async () => {
    const state = memento();
    const one = new ReattachTerminals<object>(state);
    const two = new ReattachTerminals<object>(state);
    const ta = {};
    await one.opened(ta, a);
    await two.opened({}, b);
    await one.closed(ta, false);
    expect(sessions(two)).toEqual(['cc-b']);
  });

  it('after a restore, forgets the gone ones, keeps the failed ones and those opened again meanwhile', async () => {
    const state = memento();
    const before = new ReattachTerminals<object>(state);
    for (const o of [a, b, c]) await before.opened({}, o);
    const next = new ReattachTerminals<object>(state);
    await next.opened({}, c);
    await next.restored(
      new Map([
        [reattachKey(a), 'gone'],
        [reattachKey(b), 'failed'],
        [reattachKey(c), 'gone'],
      ]),
    );
    expect(sessions(next).sort()).toEqual(['cc-b', 'cc-c']);
  });

  it('copies the list older versions saved, once', async () => {
    const state = memento({ [LEGACY_REATTACH_KEY]: [a, { session: 1 }, b] });
    expect(sessions(new ReattachTerminals(state)).sort()).toEqual(['cc-a', 'cc-b']);
    await state.update(REATTACH_KEY, []);
    expect(sessions(new ReattachTerminals(state))).toEqual([]);
  });
});
