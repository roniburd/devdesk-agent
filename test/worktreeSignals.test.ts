import { describe, expect, it } from 'vitest';
import { type CardLike, packageForPath, sessionSignals } from '../src/core/worktreeSignals';

const card = (over: Partial<CardLike>): CardLike => ({ id: 's1', featureDir: '/ws/worktrees/a', cwd: '/ws/worktrees/a', state: 'working', detail: 'Thinking', updatedAt: 1, ...over });

describe('sessionSignals', () => {
  it('signals nothing for a card seen the first time, but reports activity', () => {
    const s = sessionSignals(new Map(), [card({ detail: 'Editing src/P/a.ts' }), card({ id: 's2', featureDir: '/ws', state: 'done' }), card({ id: 's3', featureDir: '/ws/worktrees/b', state: 'parked' })]);
    expect(s.touchedPaths).toEqual([]);
    expect(s.touchedWorktrees).toEqual([]);
    expect([...s.activity]).toEqual([['/ws/worktrees/a', 'busy'], ['/ws', 'session']]);
  });

  it('reports the file a session started editing, relative to its cwd or absolute', () => {
    const first = sessionSignals(new Map(), [card({})]);
    const s = sessionSignals(first.seen, [card({ detail: 'Editing src/P/a.ts', updatedAt: 2 })]);
    expect(s.touchedPaths).toEqual(['/ws/worktrees/a/src/P/a.ts']);
    const again = sessionSignals(s.seen, [card({ detail: 'Editing /ws/src/Q/b.ts', updatedAt: 3 })]);
    expect(again.touchedPaths).toEqual(['/ws/src/Q/b.ts']);
    // The same edit seen again, unchanged: nothing new.
    expect(sessionSignals(again.seen, [card({ detail: 'Editing /ws/src/Q/b.ts', updatedAt: 3 })]).touchedPaths).toEqual([]);
    // Editing the same file again (a later hook event): it changed again.
    expect(sessionSignals(again.seen, [card({ detail: 'Editing /ws/src/Q/b.ts', updatedAt: 4 })]).touchedPaths).toEqual(['/ws/src/Q/b.ts']);
  });

  it('reports the worktree a session finished a turn in', () => {
    const working = sessionSignals(new Map(), [card({ detail: 'Running Bash: make' })]);
    expect(sessionSignals(working.seen, [card({ state: 'done', detail: 'Finished', updatedAt: 2 })]).touchedWorktrees).toEqual(['/ws/worktrees/a']);
    const idle = sessionSignals(new Map(), [card({ state: 'done' })]);
    expect(sessionSignals(idle.seen, [card({ state: 'working', updatedAt: 2 })]).touchedWorktrees).toEqual([]);
  });
});

describe('packageForPath', () => {
  const dirs = ['/ws/src/P', '/ws/src/P/.claude/worktrees/x', '/ws/worktrees/a/src/P', '/ws/src/PQ'];
  it('finds the deepest package that contains the path', () => {
    expect(packageForPath('/ws/src/P/a.ts', dirs)).toBe('/ws/src/P');
    expect(packageForPath('/ws/src/P/.claude/worktrees/x/a.ts', dirs)).toBe('/ws/src/P/.claude/worktrees/x');
    expect(packageForPath('/ws/src/PQ/a.ts', dirs)).toBe('/ws/src/PQ');
    expect(packageForPath('/ws/worktrees/a/src/P', dirs)).toBe('/ws/worktrees/a/src/P');
    expect(packageForPath('/ws/README.md', dirs)).toBeUndefined();
  });
  it('maps a symlink-resolved path back to its worktree', () => {
    expect(packageForPath('/private/ws/src/P/a.ts', dirs, new Map([['/private/ws', '/ws']]))).toBe('/ws/src/P');
  });
});
