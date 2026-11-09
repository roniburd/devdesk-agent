import { posix } from 'node:path';

/**
 * Whether Claude Code will ask to trust a folder before a session starts there, as the CLI (2.1.316) decides from its
 * global config file (`~/.claude.json`, read only: the board never accepts the dialog for the user).
 *
 * The CLI trusts a folder when `projects[<key>].hasTrustDialogAccepted` is true for:
 * - its project key: the main repository's root (a linked worktree counts as its repository), else the folder; or
 * - the folder or a folder above it, up to the root of the git repository (or worktree) it is in, or up to `/` when
 *   it is in none.
 * `CLAUDE_CODE_SANDBOXED` in Claude's environment skips the dialog.
 */
export interface TrustPlace {
  /** The folder the session starts in (its real path: the CLI keys by what `process.cwd()` says). */
  dir: string;
  /** The nearest folder at or above `dir` holding `.git` (a directory or a worktree's file); undefined outside git. */
  gitRoot?: string;
  /** The main repository's root when `gitRoot` is a linked worktree's; else `gitRoot`. */
  repoRoot?: string;
}

/** Claude Code's global config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function claudeConfigFilePath(env: Record<string, string | undefined>, home: string): string {
  return posix.join(env.CLAUDE_CONFIG_DIR?.trim() || home, '.claude.json');
}

/** A key as the CLI stores it: absolute, normalized, without a trailing slash. */
function key(path: string): string {
  const p = posix.normalize(path);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** True when the config says Claude has not trusted `place` yet (so the session will ask first). */
export function needsTrust(claudeJson: unknown, place: TrustPlace, env: Record<string, string | undefined> = {}): boolean {
  if (env.CLAUDE_CODE_SANDBOXED) return false;
  const projects = (claudeJson as { projects?: unknown } | null | undefined)?.projects;
  if (!projects || typeof projects !== 'object') return true;
  const trusted = (path: string) => (projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>)[key(path)]?.hasTrustDialogAccepted === true;
  const project = place.repoRoot ?? place.gitRoot ?? place.dir;
  if (trusted(project)) return false;
  const stop = place.gitRoot ? key(place.gitRoot) : undefined;
  let at = key(place.dir);
  // A gitRoot that is not above dir bounds nothing: check dir alone.
  if (stop && at !== stop && !at.startsWith(stop.endsWith('/') ? stop : `${stop}/`)) return !trusted(at);
  for (;;) {
    if (trusted(at)) return false;
    if (at === stop) return true;
    const up = posix.dirname(at);
    if (up === at) return true;
    at = up;
  }
}

/**
 * The main repository's root from a linked worktree's `.git` file (`gitdir: /repo/.git/worktrees/<name>`), or
 * undefined when the file does not point into one (a submodule, or not a worktree).
 */
export function repoRootFromGitFile(content: string, gitRoot: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return undefined;
  const gitdir = posix.resolve(gitRoot, m[1]);
  const at = gitdir.lastIndexOf('/.git/worktrees/');
  return at > 0 ? gitdir.slice(0, at) : undefined;
}

/** What the box says before a session starts in a folder Claude has not trusted (`folder` as the user knows it). */
export function trustNotice(folder: string): string {
  return `Claude has not trusted ${folder} yet: the session asks whether to trust the folder before it starts, so it opens for you to answer.`;
}
