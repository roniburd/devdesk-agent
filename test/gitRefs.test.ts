import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseCache, type Runner, execGit, resolveBase } from '../src/core/git';
import { gitFingerprint, readRefs, withMainline } from '../src/core/gitRefs';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

let tmp: string;
let origin: string;
let repo: string;
let wt: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'devdesk-refs-'));
  origin = join(tmp, 'origin');
  await mkdir(origin);
  git(origin, 'init', '-q', '-b', 'main');
  await writeFile(join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  git(tmp, 'clone', '-q', origin, 'repo');
  repo = join(tmp, 'repo');
  wt = join(tmp, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readRefs', () => {
  it('reads HEAD and resolves names the way git rev-parse does, in a clone and in a linked worktree', async () => {
    for (const dir of [repo, wt]) {
      const refs = await readRefs(dir);
      expect(refs?.head).toBe(git(dir, 'rev-parse', 'HEAD'));
      for (const name of ['main', 'origin/main', 'origin/HEAD', 'feat']) expect(await refs?.resolve(name)).toBe(git(dir, 'rev-parse', name));
      expect(await refs?.resolve('origin/mainline')).toBeUndefined();
    }
  });

  it('reads packed refs', async () => {
    git(repo, 'pack-refs', '--all');
    const refs = await readRefs(repo);
    expect(await refs?.resolve('origin/main')).toBe(git(repo, 'rev-parse', 'origin/main'));
    expect(refs?.head).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('is undefined outside a git repository', async () => {
    expect(await readRefs(tmp)).toBeUndefined();
  });
});

describe('resolveBase with a BaseCache', () => {
  const counting = () => {
    const calls: string[] = [];
    const run: Runner = (args, cwd) => {
      calls.push(args[0]);
      return execGit(args, cwd);
    };
    return { run, calls };
  };

  it('computes the merge-base again only when HEAD or the mainline ref moves', async () => {
    const cache = new BaseCache();
    const { run, calls } = counting();
    const first = await resolveBase(run, wt, 'branch', cache);
    expect(first.label).toBe('merge-base(origin/HEAD)');
    const merges = calls.filter((c) => c === 'merge-base').length;
    expect(merges).toBe(3); // origin/mainline and mainline do not exist
    expect(await resolveBase(run, wt, 'branch', cache)).toEqual(first);
    expect(calls.filter((c) => c === 'merge-base').length).toBe(merges);
    expect(cache.hits).toBe(1);

    // A commit moves HEAD: the merge-base is computed again, trying the mainline that matched first.
    await writeFile(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'feature');
    calls.length = 0;
    expect(await resolveBase(run, wt, 'branch', cache)).toEqual(first);
    expect(calls).toEqual(['merge-base']);

    // Mainline moves (a fetch): computed again.
    await writeFile(join(origin, 'c.txt'), 'c\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'upstream');
    git(repo, 'fetch', '-q');
    calls.length = 0;
    await resolveBase(run, wt, 'branch', cache);
    expect(calls).toEqual(['merge-base']);

    cache.clear();
    calls.length = 0;
    await resolveBase(run, wt, 'branch', cache);
    expect(calls.filter((c) => c === 'merge-base').length).toBe(3);
  });

  it('in uncommitted mode, reads HEAD from its file and counts the commits ahead once per merge-base and HEAD', async () => {
    const cache = new BaseCache();
    const { run, calls } = counting();
    const head = git(wt, 'rev-parse', 'HEAD');
    const first = await resolveBase(run, wt, 'uncommitted', cache);
    expect(first).toEqual({ ref: head, label: 'HEAD', ahead: 1 });
    expect(calls).not.toContain('rev-parse');
    calls.length = 0;
    expect(await resolveBase(run, wt, 'uncommitted', cache)).toEqual(first);
    expect(calls).toEqual([]);
  });

  it('without a cache, behaves as before', async () => {
    expect(await resolveBase(execGit, wt, 'branch')).toEqual(await resolveBase(execGit, wt, 'branch', new BaseCache()));
  });
});

describe('gitFingerprint', () => {
  it('changes on git add, a commit and a fetch, not on an edit git has not seen', async () => {
    const fp = () => gitFingerprint(wt, 'origin/HEAD');
    const start = await fp();
    expect(start).toBeDefined();
    await writeFile(join(wt, 'edit.txt'), 'x\n');
    expect(await fp()).toBe(start);
    git(wt, 'add', 'edit.txt');
    const added = await fp();
    expect(added).not.toBe(start);
    git(wt, 'commit', '-qm', 'edit');
    const committed = await fp();
    expect(committed).not.toBe(added);
    await writeFile(join(origin, 'up.txt'), 'u\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'up');
    git(repo, 'fetch', '-q');
    expect(await fp()).not.toBe(committed);
    expect(await gitFingerprint(tmp)).toBeUndefined();
  });

  it('read before the first load, completed with the mainline that load found, matches the next read', async () => {
    const before = await gitFingerprint(wt);
    const cache = new BaseCache();
    await resolveBase(execGit, wt, 'branch', cache);
    const entry = cache.getBase(wt);
    expect(entry).toBeDefined();
    expect(withMainline(before!, entry!.upstreamSha)).toBe(await gitFingerprint(wt, entry!.upstream));
    // One read with the mainline already in it stays as it is.
    const full = (await gitFingerprint(wt, entry!.upstream))!;
    expect(withMainline(full, 'other')).toBe(full);
  });
});
