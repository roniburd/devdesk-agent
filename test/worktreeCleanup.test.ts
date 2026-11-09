import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execGit } from '../src/core/git';
import { type CleanupFacts, cleanupVerdict, existingBases, isLockedWorktree, packageFacts, type PackageFacts } from '../src/core/worktreeCleanup';
import type { Feature } from '../src/core/worktrees';

const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 9);

const feature: Feature = { name: 'fix', dir: '/r/.claude/worktrees/fix', isMain: false, packages: [{ name: 'r', dir: '/r/.claude/worktrees/fix' }] };
const pkg = (p: Partial<PackageFacts> = {}): PackageFacts => ({ name: 'r', dir: feature.dir, dirty: false, bases: ['main'], unmerged: 0, lastActivityMs: NOW - 5 * DAY, ...p });
const facts = (f: Partial<CleanupFacts> = {}): CleanupFacts => ({ feature, packages: [pkg()], locked: false, liveSessions: 0, openHere: false, ...f });

describe('cleanupVerdict', () => {
  it('lists a merged, clean, idle worktree with why', () => {
    expect(cleanupVerdict(facts(), NOW, 3)).toEqual({ candidate: true, reason: 'merged into main, last active 5 days ago' });
  });

  it.each<[string, Partial<CleanupFacts>, string]>([
    ['the workspace', { feature: { ...feature, isMain: true } }, 'the workspace itself'],
    ['open here', { openHere: true }, 'open in this window'],
    ['locked', { locked: true }, 'locked'],
    ['a live session', { liveSessions: 2 }, '2 live Claude sessions'],
    ['uncommitted changes', { packages: [pkg({ dirty: true })] }, 'uncommitted changes in r'],
    ['unmerged commits', { packages: [pkg({ unmerged: 1, bases: ['main', 'v2'] })] }, '1 commit not in main or v2'],
    ['no base branch', { packages: [pkg({ bases: [] })] }, 'no base branch to compare r with'],
    ['git failing', { packages: [pkg({ error: 'boom' })] }, 'git failed in r: boom'],
    ['recent activity', { packages: [pkg({ lastActivityMs: NOW - 2 * 3600_000 })] }, 'active 2 h ago'],
  ])('keeps a worktree with %s', (_, f, reason) => {
    expect(cleanupVerdict(facts(f), NOW, 3)).toEqual({ candidate: false, reason });
  });

  it('uses the newest activity of all packages', () => {
    const packages = [pkg(), pkg({ name: 'b', lastActivityMs: NOW - DAY })];
    expect(cleanupVerdict(facts({ packages }), NOW, 3).candidate).toBe(false);
    expect(cleanupVerdict(facts({ packages }), NOW, 0.5).candidate).toBe(true);
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();

let base: string | undefined;
afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  base = undefined;
});

async function commit(dir: string, file: string, text: string): Promise<void> {
  await writeFile(join(dir, file), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', file);
}

/** A repository on `main` with a linked worktree on branch `fix` (one commit of its own). */
async function repo(): Promise<{ dir: string; wt: string }> {
  base = realpathSync(await mkdtemp(join(tmpdir(), 'devdesk-clean-')));
  const dir = join(base, 'repo');
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', 'main');
  await commit(dir, 'README.md', 'hi\n');
  const wt = join(dir, '.claude', 'worktrees', 'fix');
  git(dir, 'worktree', 'add', '-q', '-b', 'fix', wt);
  await commit(wt, 'fix.txt', 'fix\n');
  return { dir, wt };
}

describe('packageFacts', { timeout: 60_000 }, () => {
  it('counts a commit not in main, and none once main has it', async () => {
    const { dir, wt } = await repo();
    expect(await packageFacts(execGit, { name: 'fix', dir: wt }, [])).toMatchObject({ dirty: false, bases: ['main'], unmerged: 1, branch: 'fix' });
    git(dir, 'merge', '-q', '--ff-only', 'fix');
    expect((await packageFacts(execGit, { name: 'fix', dir: wt }, [])).unmerged).toBe(0);
  });

  it('counts a cherry-picked (or rebased) commit as merged', async () => {
    const { dir, wt } = await repo();
    await commit(dir, 'other.txt', 'other\n');
    git(dir, 'cherry-pick', 'fix');
    expect((await packageFacts(execGit, { name: 'fix', dir: wt }, [])).unmerged).toBe(0);
  });

  it('counts a commit as merged when any configured base has it', async () => {
    const { dir, wt } = await repo();
    git(dir, 'branch', 'v2', 'fix');
    expect((await packageFacts(execGit, { name: 'fix', dir: wt }, ['main'])).unmerged).toBe(1);
    expect((await packageFacts(execGit, { name: 'fix', dir: wt }, ['main', 'v2', 'missing'])).bases).toEqual(['main', 'v2']);
    expect((await packageFacts(execGit, { name: 'fix', dir: wt }, ['main', 'v2'])).unmerged).toBe(0);
  });

  it('sees untracked files as uncommitted changes', async () => {
    const { wt } = await repo();
    await writeFile(join(wt, 'wip.txt'), 'wip\n');
    expect((await packageFacts(execGit, { name: 'fix', dir: wt }, [])).dirty).toBe(true);
  });

  it('reports git failing instead of throwing', async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'devdesk-clean-')));
    expect((await packageFacts(execGit, { name: 'x', dir: base }, [])).error).toBeTruthy();
  });
});

describe('existingBases', { timeout: 60_000 }, () => {
  it('falls back to the first mainline name that exists', async () => {
    const { wt } = await repo();
    expect(await existingBases(execGit, wt, [])).toEqual(['main']);
  });
});

describe('isLockedWorktree', { timeout: 60_000 }, () => {
  it('sees git worktree lock', async () => {
    const { dir, wt } = await repo();
    expect(isLockedWorktree(wt)).toBe(false);
    git(dir, 'worktree', 'lock', wt);
    expect(isLockedWorktree(wt)).toBe(true);
    expect(isLockedWorktree(dir)).toBe(false);
  });
});
