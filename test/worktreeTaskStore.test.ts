import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KEEP_MISSING_MS, type WorktreeTask, withWorktreeTask } from '../src/core/worktreeTasks';

vi.mock('vscode', () => {
  class EventEmitter {
    private listeners: Array<() => void> = [];
    event = (l: () => void) => (this.listeners.push(l), { dispose() {} });
    fire() {
      for (const l of this.listeners) l();
    }
    dispose() {}
  }
  return {
    EventEmitter,
    workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }), workspaceFolders: [], isTrusted: true },
    window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, dispose() {} }), showErrorMessage: () => Promise.resolve() },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    ProgressLocation: {},
  };
});

const { WorktreeTaskStore } = await import('../src/worktreeSessions');

const task = (dir: string, createdAt = Date.now()): WorktreeTask => ({ task: `task ${dir}`, worktree: 'w', kind: 'claude', dir, createdAt });

describe('withWorktreeTask', () => {
  it('adds the task and drops records of missing worktrees once they are old', () => {
    const now = 10 * KEEP_MISSING_MS;
    const tasks = { '/here': task('/here', 0), '/gone-old': task('/gone-old', now - KEEP_MISSING_MS), '/gone-new': task('/gone-new', now - 1000) };
    const next = withWorktreeTask(tasks, task('/added', now), now, (dir) => dir === '/here');
    expect(Object.keys(next).sort()).toEqual(['/added', '/gone-new', '/here']);
  });
});

describe('WorktreeTaskStore', () => {
  it('keeps every window’s saves made at once, and another window sees them without a reload', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wt-tasks-'));
    const dirs = Array.from({ length: 6 }, (_, i) => join(base, `w${i}`));
    for (const d of dirs) mkdirSync(d);
    const file = join(base, 'storage', 'worktree-tasks.json');
    const a = new WorktreeTaskStore(file);
    const b = new WorktreeTaskStore(file);
    await Promise.all([a.load(), b.load()]);
    let bChanged = 0;
    b.onDidChange(() => bChanged++);
    await Promise.all(dirs.map((d, i) => (i % 2 ? a : b).save(task(d))));
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual([...dirs].sort());
    const extra = join(base, 'extra');
    mkdirSync(extra);
    const before = bChanged;
    await a.save(task(extra));
    await vi.waitFor(() => expect(Object.keys(b.all())).toContain(extra), { timeout: 3000 });
    expect(bChanged).toBeGreaterThan(before);
    a.dispose();
    b.dispose();
  });
});
