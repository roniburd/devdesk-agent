import { posix } from 'node:path';
import { parseGitdirFile } from './worktrees';

/**
 * Whether Claude Code will ask to trust a folder before a session starts there, as the CLI (2.1.316, still so in
 * 2.1.319) decides from its global config file (`~/.claude.json`). The board never accepts the dialog for the user;
 * only `devdesk.worktrees.autoTrust` writes the file, for worktrees DevDesk made in a folder Claude trusts.
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
  return parseGitdirFile(content, gitRoot)?.repo;
}

/** What the box says before a session starts in a folder Claude has not trusted (`folder` as the user knows it). */
export function trustNotice(folder: string): string {
  return `Claude has not trusted ${folder} yet: the session asks whether to trust the folder before it starts, so it opens for you to answer.`;
}

/**
 * The record the CLI makes for a folder it has none for when its trust dialog is accepted (2.1.319): its defaults, with
 * `hasTrustDialogAccepted` set.
 */
const NEW_PROJECT: Readonly<Record<string, unknown>> = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

/** Folders DevDesk just made for a worktree, and the folder they were made in. */
export interface WorktreeTrust {
  /** The workspace root (or repository) the worktree belongs to: Claude must trust it already. */
  parent: TrustPlace;
  /** The new worktree, and the git packages in it: each inside `parent.dir`. */
  folders: readonly TrustPlace[];
  /** The home folder: never trusted (the CLI never records its trust). */
  home?: string;
}

const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Claude's global config with the folders of `trust` accepted as trusted (`projects[<folder>].hasTrustDialogAccepted`),
 * as if the user had answered Claude's dialog there, and which folders those are; undefined when nothing changes.
 * A folder is trusted only when Claude trusts `trust.parent` already and the folder is inside it (never the parent
 * itself, nor the home folder), and only when Claude would ask there (a linked worktree of a trusted repository is
 * trusted already). Every other key, and every other field of a folder's record, stays as it was.
 */
export function trustWorktree(
  claudeJson: unknown,
  trust: WorktreeTrust,
  env: Record<string, string | undefined> = {},
): { json: Record<string, unknown>; trusted: string[] } | undefined {
  if (!plainObject(claudeJson)) return undefined;
  if (claudeJson.projects !== undefined && !plainObject(claudeJson.projects)) return undefined;
  if (needsTrust(claudeJson, trust.parent, env)) return undefined;
  const parent = key(trust.parent.dir);
  const inside = (dir: string) => dir !== parent && dir.startsWith(parent === '/' ? '/' : `${parent}/`);
  const projects: Record<string, unknown> = { ...((claudeJson.projects as Record<string, unknown> | undefined) ?? {}) };
  const trusted: string[] = [];
  for (const folder of trust.folders) {
    const dir = key(folder.dir);
    if (!posix.isAbsolute(dir) || !inside(dir) || (trust.home && dir === key(trust.home)) || trusted.includes(dir)) continue;
    if (!needsTrust({ projects }, folder, env)) continue;
    const record = projects[dir];
    projects[dir] = { ...(plainObject(record) ? record : NEW_PROJECT), hasTrustDialogAccepted: true };
    trusted.push(dir);
  }
  return trusted.length ? { json: { ...claudeJson, projects }, trusted } : undefined;
}
