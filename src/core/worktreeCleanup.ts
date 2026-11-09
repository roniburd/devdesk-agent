import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { MAINLINE_CANDIDATES, type Runner } from './git';
import type { Feature } from './worktrees';

/** What Clean Up Worktrees knows about one package (git repository) of a worktree. */
export interface PackageFacts {
  name: string;
  dir: string;
  /** Uncommitted changes, untracked files included. */
  dirty: boolean;
  /** The base branches it was compared with (empty: none of them exists). */
  bases: string[];
  /** Commits of HEAD whose change is in none of `bases` (compared by patch, so rebased and cherry-picked commits count as in). */
  unmerged: number;
  /** The newest of its HEAD commit's time and its HEAD reflog's change time (a commit, checkout, reset or rebase), in ms. */
  lastActivityMs: number;
  /** Its branch, undefined when HEAD is detached. */
  branch?: string;
  /** Git failed on it: it is never a candidate. */
  error?: string;
}

/** What Clean Up Worktrees knows about a worktree, beyond its packages. */
export interface CleanupFacts {
  feature: Feature;
  packages: PackageFacts[];
  /** `git worktree lock` (Claude Code locks the worktrees of running agents). */
  locked: boolean;
  /** Its Claude sessions that are not parked: running, waiting or stopped in a live tmux session. */
  liveSessions: number;
  /** This VS Code window has one of its folders open. */
  openHere: boolean;
}

export type CleanupVerdict = { candidate: true; reason: string } | { candidate: false; reason: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ago(ms: number): string {
  const hours = ms / 3600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Whether a worktree is ready to clean up, and why (the quick pick shows it): it is not the workspace, not open in this
 * window, not locked, has no live Claude session, no package with uncommitted changes or with commits outside its base
 * branches, and nothing happened in it for `idleDays`.
 */
export function cleanupVerdict(f: CleanupFacts, now: number, idleDays: number): CleanupVerdict {
  const no = (reason: string): CleanupVerdict => ({ candidate: false, reason });
  if (f.feature.isMain) return no('the workspace itself');
  if (f.openHere) return no('open in this window');
  if (f.locked) return no('locked');
  if (f.liveSessions) return no(`${plural(f.liveSessions, 'live Claude session')}`);
  if (!f.packages.length) return no('no git packages');
  const failed = f.packages.find((p) => p.error);
  if (failed) return no(`git failed in ${failed.name}: ${failed.error}`);
  const dirty = f.packages.filter((p) => p.dirty);
  if (dirty.length) return no(`uncommitted changes in ${dirty.map((p) => p.name).join(', ')}`);
  const noBase = f.packages.find((p) => !p.bases.length);
  if (noBase) return no(`no base branch to compare ${noBase.name} with`);
  const unmerged = f.packages.filter((p) => p.unmerged > 0);
  if (unmerged.length) {
    return no(unmerged.map((p) => `${plural(p.unmerged, 'commit')} not in ${p.bases.join(' or ')}`).join('; '));
  }
  const last = Math.max(...f.packages.map((p) => p.lastActivityMs));
  if (now - last < idleDays * 86400_000) return no(`active ${ago(now - last)}`);
  const bases = [...new Set(f.packages.flatMap((p) => p.bases))];
  return { candidate: true, reason: `merged into ${bases.join(' or ')}, last active ${ago(now - last)}` };
}

const tryRun = (run: Runner, args: string[], dir: string) => run(args, dir).then((s) => s.trim(), () => undefined);

/** The base branches to compare with: those of `configured` that exist, else the first of the usual mainline names that does. */
export async function existingBases(run: Runner, dir: string, configured: readonly string[]): Promise<string[]> {
  const exists = async (ref: string) => (await tryRun(run, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], dir)) !== undefined;
  if (configured.length) {
    const found = await Promise.all(configured.map(async (b) => ((await exists(b)) ? b : undefined)));
    return found.filter((b): b is string => !!b);
  }
  for (const b of MAINLINE_CANDIDATES) if (await exists(b)) return [b];
  return [];
}

/**
 * The commits of HEAD whose change is in none of `bases`: `git cherry <base>` per base (a `+` is a commit whose patch
 * is not in it), intersected. A commit missing from one base's list is in that base.
 */
export async function unmergedCommits(run: Runner, dir: string, bases: readonly string[]): Promise<string[]> {
  let left: Set<string> | undefined;
  for (const base of bases) {
    const out = await run(['cherry', base, 'HEAD'], dir);
    const plus = new Set(out.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim()));
    left = left ? new Set([...left].filter((c) => plus.has(c))) : plus;
    if (!left.size) break;
  }
  return [...(left ?? [])];
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Gathers a package's facts. Read-only: `status` runs with `--no-optional-locks`, so it doesn't rewrite the index. */
export async function packageFacts(run: Runner, pkg: { name: string; dir: string }, configuredBases: readonly string[]): Promise<PackageFacts> {
  const { name, dir } = pkg;
  try {
    const [status, bases, commitTime, reflogPath, branch] = await Promise.all([
      run(['--no-optional-locks', 'status', '--porcelain'], dir),
      existingBases(run, dir, configuredBases),
      tryRun(run, ['log', '-1', '--format=%ct'], dir),
      tryRun(run, ['rev-parse', '--git-path', 'logs/HEAD'], dir),
      tryRun(run, ['symbolic-ref', '-q', '--short', 'HEAD'], dir),
    ]);
    const unmerged = bases.length ? (await unmergedCommits(run, dir, bases)).length : 0;
    const reflog = reflogPath ? (isAbsolute(reflogPath) ? reflogPath : resolve(dir, reflogPath)) : undefined;
    const lastActivityMs = Math.max(Number(commitTime ?? 0) * 1000, reflog ? mtimeMs(reflog) : 0);
    return { name, dir, dirty: status.trim() !== '', bases, unmerged, lastActivityMs, branch: branch || undefined };
  } catch (err) {
    return { name, dir, dirty: false, bases: [], unmerged: 0, lastActivityMs: 0, error: (err as Error).message.split('\n')[0] };
  }
}

/** True when the linked git worktree at `dir` is locked (`git worktree lock`): its `.git` file points at a folder with a `locked` file. */
export function isLockedWorktree(dir: string): boolean {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(dir, '.git'), 'utf8'));
    if (!m) return false;
    const admin = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
    return existsSync(join(admin, 'locked'));
  } catch {
    return false;
  }
}
