import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverFeatures, type Feature, findGitPlace, gitPlace, gitRootFor, isGitWorkspace, isPlainFolder, parseGitdirFile, sameFeature } from '../src/core/worktrees';

describe('git repositories', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });

  async function repoWithWorktrees(): Promise<string> {
    const base = realpathSync(await mkdtemp(join(tmpdir(), 'devdesk-git-')));
    const repo = join(base, 'myrepo');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-fix-login', join(repo, '.claude', 'worktrees', 'fix-login'));
    git(repo, 'worktree', 'add', '-q', '-b', 'side', join(base, 'side-checkout'));
    git(repo, 'worktree', 'add', '-q', '-b', 'gone', join(base, 'gone'));
    await rm(join(base, 'gone'), { recursive: true });
    return base;
  }

  it('lists the repository as main, then each linked worktree that still exists, each its own one package', async () => {
    root = await repoWithWorktrees();
    const repo = join(root, 'myrepo');
    const fix = join(repo, '.claude', 'worktrees', 'fix-login');
    expect(isGitWorkspace(repo)).toBe(true);
    const features = await discoverFeatures(repo);
    expect(features.map((f) => [f.name, f.dir, f.isMain, f.packages])).toEqual([
      ['main', repo, true, [{ name: 'myrepo', dir: repo }]],
      ['fix-login', fix, false, [{ name: 'myrepo', dir: fix }]],
      ['side-checkout', join(root, 'side-checkout'), false, [{ name: 'myrepo', dir: join(root, 'side-checkout') }]],
    ]);
  });

  it('resolves any folder in the repository or one of its worktrees to the main worktree', async () => {
    root = await repoWithWorktrees();
    const repo = join(root, 'myrepo');
    await mkdir(join(repo, 'lib', 'deep'), { recursive: true });
    expect(gitRootFor(repo)).toBe(repo);
    expect(gitRootFor(join(repo, 'lib', 'deep'))).toBe(repo);
    expect(gitRootFor(join(repo, '.claude', 'worktrees', 'fix-login'))).toBe(repo);
    expect(gitRootFor(join(root, 'side-checkout'))).toBe(repo);
    expect(gitRootFor(root)).toBeUndefined();
  });

});

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** Paths ending in `/` are directories; others are files. */
export async function makeTree(base: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const full = join(base, p);
    if (p.endsWith('/')) await mkdir(full, { recursive: true });
    else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, 'gitdir: elsewhere\n');
    }
  }
}

describe('plain folders', () => {
  it('lists a folder that is neither a package workspace nor in a git repository as main alone, with no packages', async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'devdesk-plain-')));
    await makeTree(root, ['notes.md', 'src/main/java/', 'worktrees/old/']);
    expect(isPlainFolder(root)).toBe(true);
    expect(isGitWorkspace(root)).toBe(false);
    expect((await discoverFeatures(root, { claudeWorktrees: true })).map((f) => [f.name, f.dir, f.isMain, f.packages])).toEqual([['main', root, true, []]]);
  });
});

describe('missing root', () => {
  it('returns an empty main feature for a missing root', async () => {
    const features = await discoverFeatures(join(tmpdir(), 'devdesk-does-not-exist'));
    expect(features).toHaveLength(1);
    expect(features[0].packages).toEqual([]);
  });
});

describe('sameFeature', () => {
  const feature: Feature = { name: 'feat-a', dir: '/ws/worktrees/feat-a', isMain: false, packages: [{ name: 'PkgA', dir: '/ws/worktrees/feat-a/src/PkgA' }] };

  it('is true for a copy with the same packages', () => {
    expect(sameFeature(feature, { ...feature, packages: feature.packages.map((p) => ({ ...p })) })).toBe(true);
  });

  it('is false when the name, directory, real directory or packages differ', () => {
    expect(sameFeature(feature, { ...feature, name: 'feat-b' })).toBe(false);
    expect(sameFeature(feature, { ...feature, dir: '/ws/worktrees/feat-b' })).toBe(false);
    expect(sameFeature(feature, { ...feature, realDir: '/private/ws/worktrees/feat-a' })).toBe(false);
    expect(sameFeature(feature, { ...feature, packages: [] })).toBe(false);
    expect(sameFeature(feature, { ...feature, packages: [...feature.packages, { name: 'PkgB', dir: '/ws/worktrees/feat-a/src/PkgB' }] })).toBe(false);
    expect(sameFeature(feature, { ...feature, packages: [{ name: 'PkgB', dir: '/ws/worktrees/feat-a/src/PkgB' }] })).toBe(false);
  });
});

describe('parseGitdirFile', () => {
  it('resolves the git directory from the folder and finds the main repository', () => {
    expect(parseGitdirFile('gitdir: ../../../.git/worktrees/fix\n', '/w/repo/.claude/worktrees/fix')).toEqual({ gitDir: '/w/repo/.git/worktrees/fix', repo: '/w/repo' });
    expect(parseGitdirFile('gitdir: /w/repo/.git/modules/sub\n', '/w/repo/sub')).toEqual({ gitDir: '/w/repo/.git/modules/sub', repo: undefined });
    expect(parseGitdirFile('nonsense', '/w')).toBeUndefined();
  });

  it('takes the last .git/worktrees of a nested path, and only when the worktree id ends it', () => {
    expect(parseGitdirFile('gitdir: /w/old/.git/worktrees/x/repo/.git/worktrees/fix', '/x')?.repo).toBe('/w/old/.git/worktrees/x/repo');
    expect(parseGitdirFile('gitdir: /w/repo/.git/worktrees/fix/modules/sub', '/x')?.repo).toBeUndefined();
  });
});

describe('gitPlace', () => {
  let root: string;
  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'gitplace-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('gives the top and the main repository of a repository, a linked worktree and a submodule', async () => {
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git', 'worktrees', 'side'), { recursive: true });
    await mkdir(join(repo, 'lib'), { recursive: true });
    const side = join(root, 'side');
    await mkdir(join(side, 'deep'), { recursive: true });
    await writeFile(join(side, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'side')}\n`);
    const sub = join(repo, 'sub');
    await mkdir(sub);
    await writeFile(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');

    expect(gitPlace(repo)).toEqual({ top: repo, repo });
    expect(gitPlace(join(repo, 'lib'))).toBeUndefined();
    expect(findGitPlace(join(repo, 'lib'))).toEqual({ top: repo, repo });
    expect(findGitPlace(join(side, 'deep'))).toEqual({ top: side, repo });
    expect(findGitPlace(sub)).toEqual({ top: sub, repo: sub });
    expect(findGitPlace(root)).toBeUndefined();
  });
});
