import { describe, expect, it } from 'vitest';
import { claudeConfigFilePath, needsTrust, repoRootFromGitFile, trustNotice } from '../src/core/trust';

const trusting = (...paths: string[]) => ({ projects: Object.fromEntries(paths.map((p) => [p, { hasTrustDialogAccepted: true }])) });

describe('claudeConfigFilePath', () => {
  it('is .claude.json in $CLAUDE_CONFIG_DIR, else in the home directory', () => {
    expect(claudeConfigFilePath({}, '/Users/me')).toBe('/Users/me/.claude.json');
    expect(claudeConfigFilePath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/Users/me')).toBe('/cfg/.claude.json');
    expect(claudeConfigFilePath({ CLAUDE_CONFIG_DIR: '  ' }, '/Users/me')).toBe('/Users/me/.claude.json');
  });
});

describe('needsTrust', () => {
  it('trusts a folder accepted exactly, and nothing in a config without projects', () => {
    expect(needsTrust(trusting('/w/repo'), { dir: '/w/repo' })).toBe(false);
    expect(needsTrust(trusting('/w/repo'), { dir: '/w/repo/' })).toBe(false);
    expect(needsTrust({}, { dir: '/w/repo' })).toBe(true);
    expect(needsTrust(undefined, { dir: '/w/repo' })).toBe(true);
    expect(needsTrust({ projects: { '/w/repo': { hasTrustDialogAccepted: false } } }, { dir: '/w/repo' })).toBe(true);
    expect(needsTrust({ projects: { '/w/repo': { hasTrustDialogAccepted: 'yes' } } }, { dir: '/w/repo' })).toBe(true);
  });

  it('outside git, trusts a folder under any accepted one', () => {
    expect(needsTrust(trusting('/w'), { dir: '/w/acme/worktrees/feat-a' })).toBe(false);
    expect(needsTrust(trusting('/'), { dir: '/w/acme' })).toBe(false);
    expect(needsTrust(trusting('/w/other'), { dir: '/w/acme' })).toBe(true);
    expect(needsTrust(trusting('/w/acm'), { dir: '/w/acme' })).toBe(true);
  });

  it('inside a git repository, looks up only to its root', () => {
    expect(needsTrust(trusting('/w/repo'), { dir: '/w/repo/pkg', gitRoot: '/w/repo', repoRoot: '/w/repo' })).toBe(false);
    expect(needsTrust(trusting('/w'), { dir: '/w/repo/pkg', gitRoot: '/w/repo', repoRoot: '/w/repo' })).toBe(true);
    expect(needsTrust(trusting('/w/repo/pkg'), { dir: '/w/repo/pkg/src', gitRoot: '/w/repo', repoRoot: '/w/repo' })).toBe(false);
    // A workspace package (where a Claude Code worktree session starts) is not trusted by its workspace root.
    expect(needsTrust(trusting('/ws'), { dir: '/ws/src/PkgA', gitRoot: '/ws/src/PkgA', repoRoot: '/ws/src/PkgA' })).toBe(true);
  });

  it("trusts a linked worktree as its repository, but not the worktree's parents", () => {
    const wt = { dir: '/w/repo/.claude/worktrees/fix', gitRoot: '/w/repo/.claude/worktrees/fix', repoRoot: '/w/repo' };
    expect(needsTrust(trusting('/w/repo'), wt)).toBe(false);
    expect(needsTrust(trusting('/w/repo/.claude/worktrees/fix'), wt)).toBe(false);
    expect(needsTrust(trusting('/w/repo/.claude'), wt)).toBe(true);
  });

  it('checks only the folder when the git root is not above it', () => {
    expect(needsTrust(trusting('/w'), { dir: '/w/x', gitRoot: '/elsewhere' })).toBe(true);
    expect(needsTrust(trusting('/w/x'), { dir: '/w/x', gitRoot: '/elsewhere' })).toBe(false);
  });

  it('never asks in a sandboxed Claude', () => {
    expect(needsTrust({}, { dir: '/w' }, { CLAUDE_CODE_SANDBOXED: '1' })).toBe(false);
  });
});

describe('repoRootFromGitFile', () => {
  it("reads the main repository from a linked worktree's .git file", () => {
    expect(repoRootFromGitFile('gitdir: /w/repo/.git/worktrees/fix\n', '/w/repo/.claude/worktrees/fix')).toBe('/w/repo');
    expect(repoRootFromGitFile('gitdir: ../../../.git/worktrees/fix\n', '/w/repo/.claude/worktrees/fix')).toBe('/w/repo');
  });

  it('is undefined for a submodule or anything else', () => {
    expect(repoRootFromGitFile('gitdir: /w/repo/.git/modules/sub\n', '/w/repo/sub')).toBeUndefined();
    expect(repoRootFromGitFile('nonsense', '/w/x')).toBeUndefined();
  });

  it('finds the main repository under nested folders, from the last .git/worktrees', () => {
    expect(repoRootFromGitFile('gitdir: /a/b/c/repo/.git/worktrees/fix\r\n', '/x')).toBe('/a/b/c/repo');
    expect(repoRootFromGitFile('gitdir: /w/old/.git/worktrees/x/repo/.git/worktrees/fix\n', '/x')).toBe('/w/old/.git/worktrees/x/repo');
    expect(repoRootFromGitFile('gitdir: /w/repo/.git/worktrees/fix/\n', '/x')).toBe('/w/repo');
  });

  it('is undefined when the git directory is below a worktree id, or at the top', () => {
    expect(repoRootFromGitFile('gitdir: /w/repo/.git/worktrees/fix/modules/sub\n', '/x')).toBeUndefined();
    expect(repoRootFromGitFile('gitdir: /.git/worktrees/fix\n', '/x')).toBeUndefined();
  });
});

describe('trustNotice', () => {
  it('names the folder and says the session opens', () => {
    expect(trustNotice('/w/repo')).toMatch(/\/w\/repo.*opens/);
  });
});
