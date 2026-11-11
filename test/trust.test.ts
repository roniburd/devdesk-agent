import { describe, expect, it } from 'vitest';
import { claudeConfigFilePath, needsTrust, repoRootFromGitFile, trustNotice, trustWorktree } from '../src/core/trust';

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

describe('trustWorktree', () => {
  const ws = { dir: '/ws' };
  const wsWorktree = { dir: '/ws/worktrees/feat' };
  const wsPkg = { dir: '/ws/worktrees/feat/src/PkgA', gitRoot: '/ws/worktrees/feat/src/PkgA', repoRoot: '/ws/src/PkgA' };
  const claudeWorktree = { dir: '/ws/src/PkgA/.claude/worktrees/fix', gitRoot: '/ws/src/PkgA/.claude/worktrees/fix', repoRoot: '/ws/src/PkgA' };

  it('trusts the folders Claude would ask in, when it trusts their parent, and keeps every other key', () => {
    const config = { numStartups: 7, oauthAccount: { email: 'me@x' }, projects: { '/ws': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] }, '/other': { lastCost: 1 } } };
    const next = trustWorktree(config, { parent: ws, folders: [wsWorktree, wsPkg, claudeWorktree] });
    // The workspace worktree itself is trusted already (no git root stops the walk up to /ws).
    expect(next?.trusted).toEqual(['/ws/worktrees/feat/src/PkgA', '/ws/src/PkgA/.claude/worktrees/fix']);
    expect(next?.json).toMatchObject({ numStartups: 7, oauthAccount: { email: 'me@x' } });
    const projects = next!.json.projects as Record<string, Record<string, unknown>>;
    expect(projects['/ws']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
    expect(projects['/other']).toEqual({ lastCost: 1 });
    expect(projects['/ws/worktrees/feat/src/PkgA']).toMatchObject({ hasTrustDialogAccepted: true, allowedTools: [], mcpServers: {} });
    expect(needsTrust(next!.json, wsPkg)).toBe(false);
    expect(needsTrust(next!.json, claudeWorktree)).toBe(false);
    // The input is not changed.
    expect(Object.keys(config.projects)).toEqual(['/ws', '/other']);
  });

  it('keeps the fields of a record the folder has, setting only hasTrustDialogAccepted', () => {
    const config = { projects: { '/ws': { hasTrustDialogAccepted: true }, '/ws/src/PkgA/.claude/worktrees/fix': { hasTrustDialogAccepted: false, allowedTools: ['Read'], lastSessionId: 's' } } };
    const next = trustWorktree(config, { parent: ws, folders: [claudeWorktree] });
    expect((next!.json.projects as Record<string, unknown>)['/ws/src/PkgA/.claude/worktrees/fix']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'], lastSessionId: 's' });
  });

  it('trusts nothing when Claude does not trust the parent', () => {
    expect(trustWorktree({ projects: { '/elsewhere': { hasTrustDialogAccepted: true } } }, { parent: ws, folders: [wsPkg] })).toBeUndefined();
    expect(trustWorktree({}, { parent: ws, folders: [wsPkg] })).toBeUndefined();
    // A git repository is not trusted by a trusted folder above it, so neither are its worktrees.
    const repo = { dir: '/dev/repo', gitRoot: '/dev/repo', repoRoot: '/dev/repo' };
    const wt = { dir: '/dev/repo/.claude/worktrees/x', gitRoot: '/dev/repo/.claude/worktrees/x', repoRoot: '/dev/repo' };
    expect(trustWorktree({ projects: { '/dev': { hasTrustDialogAccepted: true } } }, { parent: repo, folders: [wt] })).toBeUndefined();
  });

  it('never trusts a folder outside the parent, the parent itself, or the home folder', () => {
    const config = { projects: { '/': { hasTrustDialogAccepted: true } } };
    const git = (dir: string) => ({ dir, gitRoot: dir, repoRoot: dir });
    expect(trustWorktree({ projects: { '/ws': { hasTrustDialogAccepted: true } } }, { parent: ws, folders: [git('/elsewhere'), git('/wsx/a'), git('/ws')] })).toBeUndefined();
    expect(trustWorktree(config, { parent: { dir: '/' }, folders: [git('/Users/me')], home: '/Users/me' })).toBeUndefined();
    expect(trustWorktree(config, { parent: { dir: '/' }, folders: [git('/Users/me/x')], home: '/Users/me' })?.trusted).toEqual(['/Users/me/x']);
    expect(trustWorktree({ projects: { '/ws': { hasTrustDialogAccepted: true } } }, { parent: ws, folders: [git('ws/rel')] })).toBeUndefined();
  });

  it('is idempotent: nothing changes once the folders are trusted', () => {
    const config = { projects: { '/ws': { hasTrustDialogAccepted: true } } };
    const once = trustWorktree(config, { parent: ws, folders: [wsPkg, wsPkg] });
    expect(once?.trusted).toEqual(['/ws/worktrees/feat/src/PkgA']);
    expect(trustWorktree(once!.json, { parent: ws, folders: [wsPkg] })).toBeUndefined();
  });

  it('does not touch a config it does not understand, nor a linked worktree of a trusted repository', () => {
    expect(trustWorktree(null, { parent: ws, folders: [wsPkg] })).toBeUndefined();
    expect(trustWorktree([], { parent: ws, folders: [wsPkg] })).toBeUndefined();
    expect(trustWorktree({ projects: [] }, { parent: ws, folders: [wsPkg] })).toBeUndefined();
    const trusted = { projects: { '/ws': { hasTrustDialogAccepted: true }, '/ws/src/PkgA': { hasTrustDialogAccepted: true } } };
    expect(trustWorktree(trusted, { parent: ws, folders: [claudeWorktree, wsPkg] })).toBeUndefined();
  });

  it('writes nothing for a sandboxed Claude, which never asks', () => {
    expect(trustWorktree({ projects: {} }, { parent: ws, folders: [wsPkg] }, { CLAUDE_CODE_SANDBOXED: '1' })).toBeUndefined();
  });
});
