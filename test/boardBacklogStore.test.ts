import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type BacklogItem, backlogItemBelongs, parseBacklog, serializeBacklog } from '../src/core/board';

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
    workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }), workspaceFolders: [] },
    window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, dispose() {} }), showErrorMessage: async () => undefined },
  };
});

const { BacklogStore } = await import('../src/backlogStore');

const item = (id: string, where?: string): BacklogItem => ({ id, prompt: `prompt ${id}`, createdAt: 1, ...(where ? { choice: { where } } : {}) });

describe('backlogItemBelongs: prompts for later from the host-wide file', () => {
  const ours = (dir: string) => dir.startsWith('/ws/a');
  const exists = (dir: string) => dir !== '/gone';
  it("takes those for this project's worktrees, and those that name no project, not another project's", () => {
    expect(backlogItemBelongs(item('1'), ours, exists)).toBe(true);
    expect(backlogItemBelongs(item('2', 'main'), ours, exists)).toBe(true);
    expect(backlogItemBelongs(item('3', 'new'), ours, exists)).toBe(true);
    expect(backlogItemBelongs(item('4', '/ws/a/worktrees/feat'), ours, exists)).toBe(true);
    expect(backlogItemBelongs(item('5', '/ws/b/worktrees/feat'), ours, exists)).toBe(false);
    // A worktree since removed: no project says it is theirs, so the first to open takes it.
    expect(backlogItemBelongs(item('6', '/gone'), ours, exists)).toBe(true);
  });
});

describe('BacklogStore.adopt', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlog-'));
    const old = join(dir, 'global', 'backlog.json');
    return { dir, old, project: (name: string) => join(dir, name, 'backlog.json') };
  };
  const write = (file: string, items: BacklogItem[]) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, serializeBacklog(items));
  };
  const belongsTo = (root: string) => (i: BacklogItem) => backlogItemBelongs(i, (d) => d.startsWith(root), () => true);

  it("moves this project's prompts (and those naming none) out of the host-wide file, leaving another project's", async () => {
    const { old, project } = setup();
    write(old, [item('1', 'main'), item('2', '/ws/a/wt'), item('3', '/ws/b/wt')]);
    const a = new BacklogStore(project('a'));
    await a.load();
    expect(await a.adopt(old, belongsTo('/ws/a'))).toBe(2);
    expect(a.all().map((i) => i.id)).toEqual(['1', '2']);
    expect(parseBacklog(readFileSync(old, 'utf8')).map((i) => i.id)).toEqual(['3']);
    // The other project, opening later, takes the rest: the old file goes.
    const b = new BacklogStore(project('b'));
    await b.load();
    expect(await b.adopt(old, belongsTo('/ws/b'))).toBe(1);
    expect(b.all().map((i) => i.id)).toEqual(['3']);
    expect(existsSync(old)).toBe(false);
    expect(await b.adopt(old, belongsTo('/ws/b'))).toBe(0);
    a.dispose();
    b.dispose();
  });

  it('does not double a prompt a move cut short already added', async () => {
    const { old, project } = setup();
    write(old, [item('1'), item('2')]);
    write(project('a'), [item('1')]);
    const a = new BacklogStore(project('a'));
    await a.load();
    await a.adopt(old, belongsTo('/ws/a'));
    expect(a.all().map((i) => i.id)).toEqual(['1', '2']);
    a.dispose();
  });

  it('leaves a damaged host-wide file as it is', async () => {
    const { old, project } = setup();
    write(old, []);
    writeFileSync(old, '{ not json');
    const a = new BacklogStore(project('a'));
    await a.load();
    await expect(a.adopt(old, belongsTo('/ws/a'))).rejects.toThrow();
    expect(readFileSync(old, 'utf8')).toBe('{ not json');
    a.dispose();
  });

  it('adopts nothing from its own file (a window with no folder uses the host-wide one)', async () => {
    const { old } = setup();
    write(old, [item('1')]);
    const s = new BacklogStore(old);
    await s.load();
    expect(await s.adopt(old, () => true)).toBe(0);
    expect(s.all().map((i) => i.id)).toEqual(['1']);
    s.dispose();
  });
});
