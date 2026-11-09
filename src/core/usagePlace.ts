import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { workspaceProvider } from './workspaceProvider';
import { trimSlashes } from './paths';
import { gitRootFor, workspaceRootFor } from './worktrees';

/**
 * Where a Claude request ran, as the board groups sessions: its project (a package workspace, a git repository's main
 * worktree, or a plain folder) and the worktree in it (`main`, or the worktree's name). Decided from the `cwd` its
 * transcript records, when the usage is counted. No `vscode`: it runs in the usage worker.
 */
export type PlaceKind = 'workspace' | 'git' | 'folder';

/** How the usage views name a place's kind. */
export function placeKindLabel(kind: PlaceKind): string {
  return kind === 'workspace' ? (workspaceProvider?.label ?? 'workspace') : kind;
}

export interface Place {
  project: string;
  kind: PlaceKind;
  worktree: string;
}

export const MAIN = 'main';
/** The project of requests whose transcript records no `cwd`, and of days counted before DevDesk counted projects. */
export const UNKNOWN = '(unknown)';
/** The project of DevDesk's own calls (its insights). */
export const DEVDESK = '(DevDesk)';
/** Sessions, or projects, past a day's top ones, summed. */
export const OTHER = '*';

export const unknownPlace = (): Place => ({ project: UNKNOWN, kind: 'folder', worktree: MAIN });
export const devdeskPlace = (): Place => ({ project: DEVDESK, kind: 'folder', worktree: MAIN });

/** `<parent>/.claude/worktrees/<name>[/…]`: a Claude Code worktree, in a git repository or in a workspace's package. */
const CLAUDE_WORKTREE = /^(.*?)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/;

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** `path`, else the nearest directory above it that exists. */
function nearestExisting(path: string): string {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(dir) || dirname(dir) === dir) return dir;
  }
}

/** The real path of `path`, or of the nearest directory above it that exists followed by the rest of `path`. */
function realish(path: string): string {
  const above = nearestExisting(path);
  return join(real(above), relative(above, path));
}

/**
 * The package workspace worktree a deleted `path` was in: each `<root>/worktrees/<name>` in it, deepest first, until
 * `<root>` is a package workspace root.
 */
function deletedWorkspaceWorktree(path: string): Place | undefined {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] !== 'worktrees') continue;
    const root = parts.slice(0, i).join('/') || '/';
    if (existsSync(root) && workspaceRootFor(root) === root) return { project: root, kind: 'workspace', worktree: parts[i + 1] };
  }
  return undefined;
}

/** The top of the git worktree containing `dir` (where its `.git` is), else undefined. */
function gitTop(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** The place of a directory that exists (a real path). */
function placeOfExisting(dir: string): Place {
  const ws = workspaceRootFor(dir);
  if (ws) {
    const prefix = `${ws}/worktrees/`;
    return { project: ws, kind: 'workspace', worktree: dir.startsWith(prefix) ? dir.slice(prefix.length).split('/')[0] : MAIN };
  }
  const repo = gitRootFor(dir);
  if (repo) {
    const top = gitTop(dir);
    return { project: repo, kind: 'git', worktree: top && top !== repo ? basename(top) : MAIN };
  }
  return { project: dir, kind: 'folder', worktree: MAIN };
}

/**
 * The place of a session's `cwd`. A Claude Code worktree (`…/.claude/worktrees/<x>`) is worktree `<x>` of what holds
 * it, whether it still exists or not. A path that no longer exists is a package workspace's worktree by its path, else is placed
 * where the nearest directory above it that exists is (as worktree `<x>` when it was in a git repository's
 * `.worktrees/<x>` or `worktrees/<x>`), else is a folder of its own.
 */
export function placeOf(cwd: string): Place {
  const path = trimSlashes(cwd);
  const claude = CLAUDE_WORKTREE.exec(path);
  if (claude) return { ...placeOf(claude[1] || '/'), worktree: claude[2] };
  // Resolve symlinks (also of a deleted path's parents), so that one folder is one project however it was reached.
  const resolved = realish(path);
  if (resolved !== path && CLAUDE_WORKTREE.test(resolved)) return placeOf(resolved);
  if (existsSync(resolved)) return placeOfExisting(resolved);
  const ws = deletedWorkspaceWorktree(resolved);
  if (ws) return ws;
  const existing = real(nearestExisting(resolved));
  const above = placeOfExisting(existing);
  if (above.kind === 'folder') return { project: resolved, kind: 'folder', worktree: MAIN };
  const linked = above.kind === 'git' ? deletedGitWorktree(resolved, existing) : undefined;
  return linked ? { ...above, worktree: linked } : above;
}

/** Folders that commonly hold `git worktree add` worktrees inside their repository. */
const WORKTREE_FOLDERS = new Set(['.worktrees', 'worktrees']);

/**
 * The name of the deleted `git worktree add` worktree a deleted `path` was in, when it sat in a folder that holds
 * worktrees (`<repo>/.worktrees/<x>[/…]`): the first missing folder right under one. `existing` is the nearest folder
 * above `path` that exists.
 */
function deletedGitWorktree(path: string, existing: string): string | undefined {
  const parts = path.split('/');
  const first = existing === '/' ? 1 : existing.split('/').length;
  for (let i = first - 1; i < parts.length - 1; i++) if (WORKTREE_FOLDERS.has(parts[i])) return parts[i + 1];
  return undefined;
}

/** `placeOf`, remembered per `cwd` (one resolver per count); a missing `cwd` is the Unknown project. */
export function placeResolver(): (cwd: string | undefined) => Place {
  const cache = new Map<string, Place>();
  return (cwd) => {
    if (!cwd) return unknownPlace();
    let place = cache.get(cwd);
    if (!place) cache.set(cwd, (place = placeOf(cwd)));
    return place;
  };
}

const SPECIAL_LABELS: Record<string, string> = { [UNKNOWN]: 'Unknown project', [DEVDESK]: 'DevDesk insights', [OTHER]: 'Other projects' };

/**
 * Short names for projects: the folder's name, with as many parent folders as it takes to tell apart projects that
 * share it; the special projects in words.
 */
export function projectLabels(projects: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const tail = (p: string, n: number) => p.split('/').filter(Boolean).slice(-n).join('/') || p;
  const paths = [...new Set(projects.filter((p) => !SPECIAL_LABELS[p]))];
  for (let n = 1, left = paths; left.length; n++) {
    const count = new Map<string, number>();
    for (const p of left) count.set(tail(p, n), (count.get(tail(p, n)) ?? 0) + 1);
    const next: string[] = [];
    for (const p of left) {
      const label = tail(p, n);
      // Unique, or no parent left to add: the label is final (the full path when it is still shared).
      if (count.get(label) === 1) labels.set(p, label);
      else if (label === tail(p, n + 1)) labels.set(p, p);
      else next.push(p);
    }
    left = next;
  }
  return new Map(projects.map((p) => [p, SPECIAL_LABELS[p] ?? labels.get(p) ?? p]));
}

/** A project's tooltip: its full path, or what a special project holds. */
export function projectTitle(project: string): string {
  if (project === UNKNOWN) return 'Requests whose transcript records no folder, and days counted before DevDesk counted projects';
  if (project === DEVDESK) return "DevDesk's own calls (the board's insights)";
  if (project === OTHER) return "Projects past a day's top 30, summed";
  return project;
}
