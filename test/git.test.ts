import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffSides, execGit, listChanges, parseNameStatus, resolveBase, showFile } from '../src/core/git';

const IDENTITY = [
  '-c', 'user.name=Test',
  '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
];
const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);

let tmp: string;
let main: string;
let wt: string;
let mergeBase: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'devdesk-git-'));
  main = join(tmp, 'Pkg');
  await mkdir(main);
  await git(main, 'init', '-q', '-b', 'mainline');
  await writeFile(join(main, 'a.txt'), 'a1\n');
  await writeFile(join(main, 'b.txt'), 'b1\n');
  await writeFile(join(main, 'gone.txt'), 'g\n');
  await writeFile(join(main, 'old.txt'), 'same content here\n'.repeat(5));
  await git(main, 'add', '.');
  await git(main, 'commit', '-qm', 'base');
  mergeBase = (await git(main, 'rev-parse', 'mainline')).trim();

  wt = join(tmp, 'wt');
  await git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  await writeFile(join(wt, 'a.txt'), 'a2\n');
  await git(wt, 'commit', '-qam', 'feature change');
  await writeFile(join(wt, 'b.txt'), 'b2\n'); // uncommitted edit
  await rm(join(wt, 'gone.txt')); // uncommitted delete
  await git(wt, 'mv', 'old.txt', 'new.txt'); // staged rename
  await writeFile(join(wt, 'c.txt'), 'c\n'); // untracked
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('resolveBase', () => {
  it('uses the HEAD commit SHA for uncommitted mode, so the ref changes when HEAD moves', async () => {
    const head = (await git(wt, 'rev-parse', 'HEAD')).trim();
    expect(await resolveBase(execGit, wt, 'uncommitted')).toEqual({ ref: head, label: 'HEAD', ahead: 1 });
  });
  it('counts no commits ahead on mainline itself', async () => {
    expect(await resolveBase(execGit, main, 'uncommitted')).toMatchObject({ label: 'HEAD', ahead: 0 });
  });
  it('uses the merge-base with mainline for branch mode', async () => {
    expect(await resolveBase(execGit, wt, 'branch')).toEqual({ ref: mergeBase, label: 'merge-base(mainline)' });
  });
  it('falls back to HEAD when there is no mainline', async () => {
    const dir = join(tmp, 'NoMainline');
    await mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'trunk');
    await writeFile(join(dir, 'x.txt'), 'x\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-qm', 'x');
    const head = (await git(dir, 'rev-parse', 'HEAD')).trim();
    expect(await resolveBase(execGit, dir, 'branch')).toEqual({ ref: head, label: 'HEAD (no mainline)' });
    expect(await resolveBase(execGit, dir, 'uncommitted')).toEqual({ ref: head, label: 'HEAD' });
  });
  it('reports an empty repository', async () => {
    const dir = join(tmp, 'Empty');
    await mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'mainline');
    expect(await resolveBase(execGit, dir, 'branch')).toEqual({ ref: '', label: 'empty repo' });
  });
});

describe('listChanges', () => {
  it('shows committed, uncommitted, deleted, renamed and untracked changes vs the merge-base', async () => {
    expect(await listChanges(execGit, wt, mergeBase)).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'M', path: 'b.txt' },
      { status: '?', path: 'c.txt' },
      { status: 'D', path: 'gone.txt' },
      { status: 'R', oldPath: 'old.txt', path: 'new.txt' },
    ]);
  });
  it('shows only uncommitted changes vs HEAD', async () => {
    expect(await listChanges(execGit, wt, 'HEAD')).toEqual([
      { status: 'M', path: 'b.txt' },
      { status: '?', path: 'c.txt' },
      { status: 'D', path: 'gone.txt' },
      { status: 'R', oldPath: 'old.txt', path: 'new.txt' },
    ]);
  });
  it('lists staged files as added and others as untracked in an empty repository', async () => {
    const dir = join(tmp, 'EmptyWithFiles');
    await mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'mainline');
    await writeFile(join(dir, 's.txt'), 's\n');
    await git(dir, 'add', 's.txt');
    await writeFile(join(dir, 'u.txt'), 'u\n');
    expect(await listChanges(execGit, dir, '')).toEqual([
      { status: 'A', path: 's.txt' },
      { status: '?', path: 'u.txt' },
    ]);
  });
});

describe('listChanges edge cases', () => {
  it('reports a path removed from the index but still on disk once, as modified', async () => {
    const dir = join(tmp, 'Uncached');
    await mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'mainline');
    await writeFile(join(dir, 'foo.txt'), 'foo\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-qm', 'foo');
    await git(dir, 'rm', '-q', '--cached', 'foo.txt');
    expect(await listChanges(execGit, dir, 'HEAD')).toEqual([{ status: 'M', path: 'foo.txt' }]);
  });
  it('returns paths with quotes, backslashes and newlines verbatim', async () => {
    const dir = join(tmp, 'Quoted');
    await mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'mainline');
    await writeFile(join(dir, 'tracked"q.txt'), 'x\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-qm', 'q');
    await writeFile(join(dir, 'tracked"q.txt'), 'y\n');
    await writeFile(join(dir, 'notes"v2.md'), 'n\n');
    await writeFile(join(dir, 'a\\b.txt'), 'b\n');
    await writeFile(join(dir, 'line\nbreak.txt'), 'l\n');
    const expected = [
      { status: '?', path: 'a\\b.txt' },
      { status: '?', path: 'line\nbreak.txt' },
      { status: '?', path: 'notes"v2.md' },
      { status: 'M', path: 'tracked"q.txt' },
    ].sort((a, b) => a.path.localeCompare(b.path));
    expect(await listChanges(execGit, dir, 'HEAD')).toEqual(expected);
  });
});

describe('showFile', () => {
  it('returns content at a ref, or empty when absent', async () => {
    expect(await showFile(execGit, wt, mergeBase, 'a.txt')).toBe('a1\n');
    expect(await showFile(execGit, wt, mergeBase, 'missing.txt')).toBe('');
    expect(await showFile(execGit, wt, '', 'a.txt')).toBe('');
  });
});

describe('parseNameStatus', () => {
  it('parses NUL-separated modifications, renames and paths with spaces', () => {
    expect(parseNameStatus('M\0x\0R087\0old\0new\0A\0y z\0')).toEqual([
      { status: 'M', path: 'x' },
      { status: 'R', oldPath: 'old', path: 'new' },
      { status: 'A', path: 'y z' },
    ]);
  });
});

describe('diffSides', () => {
  const base = { ref: 'abc', label: 'merge-base(mainline)' };
  it('diffs modified files against the base', () => {
    expect(diffSides({ status: 'M', path: 'x' }, base)).toEqual({ left: { ref: 'abc', path: 'x' }, right: 'working' });
  });
  it('uses an empty left side for added and untracked files', () => {
    expect(diffSides({ status: 'A', path: 'x' }, base)).toEqual({ left: 'empty', right: 'working' });
    expect(diffSides({ status: '?', path: 'x' }, base)).toEqual({ left: 'empty', right: 'working' });
  });
  it('uses an empty right side for deleted files', () => {
    expect(diffSides({ status: 'D', path: 'x' }, base)).toEqual({ left: { ref: 'abc', path: 'x' }, right: 'empty' });
  });
  it('uses the old path on the left for renames', () => {
    expect(diffSides({ status: 'R', oldPath: 'old', path: 'new' }, base)).toEqual({
      left: { ref: 'abc', path: 'old' },
      right: 'working',
    });
  });
  it('uses an empty left side when the base is an empty repository', () => {
    expect(diffSides({ status: 'M', path: 'x' }, { ref: '', label: 'empty repo' })).toEqual({ left: 'empty', right: 'working' });
  });
});
