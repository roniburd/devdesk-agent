import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVDESK, OTHER, placeOf, placeResolver, projectLabels, projectTitle, UNKNOWN } from '../src/core/usagePlace';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'devdesk-place-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A git repository with a linked worktree outside it and a Claude Code worktree inside it. */
function git(): { repo: string; linked: string } {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git', 'worktrees', 'side'), { recursive: true });
  mkdirSync(join(repo, 'lib'), { recursive: true });
  const linked = join(dir, 'side');
  mkdirSync(linked);
  writeFileSync(join(linked, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'side')}\n`);
  const claude = join(repo, '.claude', 'worktrees', 'cw');
  mkdirSync(join(repo, '.git', 'worktrees', 'cw'), { recursive: true });
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'cw')}\n`);
  return { repo, linked };
}

describe('placeOf', () => {

  it('puts a git repository and its linked and Claude Code worktrees under the main repository', () => {
    const { repo, linked } = git();
    expect(placeOf(repo)).toEqual({ project: repo, kind: 'git', worktree: 'main' });
    expect(placeOf(join(repo, 'lib'))).toEqual({ project: repo, kind: 'git', worktree: 'main' });
    expect(placeOf(linked)).toEqual({ project: repo, kind: 'git', worktree: 'side' });
    expect(placeOf(join(repo, '.claude', 'worktrees', 'cw'))).toEqual({ project: repo, kind: 'git', worktree: 'cw' });
  });

  it('places a deleted Claude Code worktree of a git repository by its path', () => {
    const { repo } = git();
    expect(placeOf(join(repo, '.claude', 'worktrees', 'old'))).toEqual({ project: repo, kind: 'git', worktree: 'old' });
  });

  it('keeps a plain folder as its own project', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(placeOf(`${plain}/`)).toEqual({ project: plain, kind: 'folder', worktree: 'main' });
  });

  it('puts a deleted folder inside a project under that project, and one outside any as a folder', () => {
    const { repo } = git();
    expect(placeOf(join(repo, 'tmp', 'x'))).toEqual({ project: repo, kind: 'git', worktree: 'main' });
    const gone = join(dir, 'nothing', 'here');
    expect(placeOf(gone)).toEqual({ project: gone, kind: 'folder', worktree: 'main' });
  });

  it("places a deleted `git worktree add` worktree in the repository's .worktrees or worktrees folder as that worktree", () => {
    const { repo } = git();
    mkdirSync(join(repo, '.worktrees'));
    expect(placeOf(join(repo, '.worktrees', 'feat'))).toEqual({ project: repo, kind: 'git', worktree: 'feat' });
    expect(placeOf(join(repo, '.worktrees', 'feat', 'src'))).toEqual({ project: repo, kind: 'git', worktree: 'feat' });
    // The folder holding worktrees is gone too.
    expect(placeOf(join(repo, 'worktrees', 'old', 'lib'))).toEqual({ project: repo, kind: 'git', worktree: 'old' });
    // A worktrees folder that exists inside the deleted part's parents but above the missing part is not one.
    mkdirSync(join(repo, 'lib', 'worktrees', 'keep'), { recursive: true });
    expect(placeOf(join(repo, 'lib', 'worktrees', 'keep', 'gone'))).toEqual({ project: repo, kind: 'git', worktree: 'main' });
  });

  it('places a symlinked path where its real path is', () => {
    const { repo } = git();
    const link = join(dir, 'link');
    symlinkSync(repo, link);
    expect(placeOf(join(link, 'lib'))).toEqual({ project: repo, kind: 'git', worktree: 'main' });
  });
});

describe('placeOf, review cases', () => {
  it('places a deleted folder reached through a symlinked parent where its real path is', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const link = join(dir, 'link');
    symlinkSync(plain, link);
    expect(placeOf(join(link, 'gone'))).toEqual({ project: join(plain, 'gone'), kind: 'folder', worktree: 'main' });
  });

});

describe('placeResolver', () => {
  it('sends a missing cwd to the Unknown project and checks each directory once', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const place = placeResolver();
    expect(place(undefined)).toEqual({ project: UNKNOWN, kind: 'folder', worktree: 'main' });
    const first = place(plain);
    rmSync(plain, { recursive: true });
    expect(place(plain)).toBe(first);
  });
});

describe('projectLabels', () => {
  it('names projects by their folder, with the parent when two share a name, and the special ones in words', () => {
    const labels = projectLabels(['/a/devdesk', '/b/devdesk', '/c/other', UNKNOWN, DEVDESK, OTHER]);
    expect(Object.fromEntries(labels)).toEqual({
      '/a/devdesk': 'a/devdesk',
      '/b/devdesk': 'b/devdesk',
      '/c/other': 'other',
      [UNKNOWN]: 'Unknown project',
      [DEVDESK]: 'DevDesk insights',
      [OTHER]: 'Other projects',
    });
    expect(Object.fromEntries(projectLabels(['/a/x/dev', '/b/x/dev', '/c/y/dev']))).toEqual({
      '/a/x/dev': 'a/x/dev',
      '/b/x/dev': 'b/x/dev',
      '/c/y/dev': 'y/dev',
    });
    expect(projectTitle('/c/other')).toBe('/c/other');
    expect(projectTitle(UNKNOWN)).toMatch(/no folder/);
  });
});
