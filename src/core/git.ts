import { readRefs, type Refs } from './gitRefs';
import { ExecError, execText } from './shellRun';

export type Runner = (args: string[], cwd: string) => Promise<string>;

/** A git runner; with `timeoutMs`, a git that has not exited by then is killed and the call rejects. */
export const gitRunner = (timeoutMs?: number): Runner => (args, cwd) =>
  execText('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeoutMs }).catch((err: unknown) => {
    if (err instanceof ExecError && err.killed && timeoutMs) throw new Error(`git ${args[0]} timed out after ${timeoutMs / 1000}s`);
    throw err;
  });

export const execGit: Runner = gitRunner();

export type DiffMode = 'branch' | 'uncommitted';

export interface BaseRef {
  ref: string;
  label: string;
  /** Uncommitted mode: commits on HEAD that mainline does not have, so a committed feature does not look clean. */
  ahead?: number;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | '?';

export interface FileChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
}

async function tryRun(run: Runner, args: string[], cwd: string): Promise<string | undefined> {
  try {
    return (await run(args, cwd)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Each package's merge-base with mainline, kept while HEAD and the mainline ref it was computed from (read from the
 * repository's files, no git) are unchanged, and the commits HEAD is ahead of it. `clear()` forgets it all (Refresh).
 */
export class BaseCache {
  private readonly bases = new Map<string, { head: string; upstream: string; upstreamSha: string; base: BaseRef }>();
  private readonly ahead = new Map<string, { key: string; count: number | undefined }>();
  /** Loads that reused a cached merge-base (for the log and tests). */
  hits = 0;

  getBase(dir: string) {
    return this.bases.get(dir);
  }

  setBase(dir: string, entry: { head: string; upstream: string; upstreamSha: string; base: BaseRef } | undefined): void {
    if (entry) this.bases.set(dir, entry);
    else this.bases.delete(dir);
  }

  /** The mainline ref the merge-base of `dir` was last computed against, if known. */
  upstream(dir: string): string | undefined {
    return this.bases.get(dir)?.upstream;
  }

  getAhead(dir: string, key: string): { count: number | undefined } | undefined {
    const e = this.ahead.get(dir);
    return e?.key === key ? e : undefined;
  }

  setAhead(dir: string, key: string, count: number | undefined): void {
    this.ahead.set(dir, { key, count });
  }

  clear(): void {
    this.bases.clear();
    this.ahead.clear();
  }
}

/**
 * The base the working tree of `dir` is compared with. With `cache` (and the repository's refs readable from its files),
 * the merge-base is computed only when HEAD or its mainline ref moved, HEAD is read from its file, and the commits not
 * on mainline are counted once per (merge-base, HEAD).
 */
export async function resolveBase(run: Runner, dir: string, mode: DiffMode, cache?: BaseCache): Promise<BaseRef> {
  const refs = cache ? await readRefs(dir) : undefined;
  // The merge-base fails in an empty repo too, so vs mainline it is the only git process in the usual case.
  const mainline = cache ? await cachedMergeBase(run, dir, cache, refs) : (await mergeBase(run, dir))?.base;
  if (mode === 'branch' && mainline) return mainline;
  // Use the commit SHA rather than the symbolic 'HEAD' so content URIs change when HEAD moves.
  const head = refs?.head ?? (await tryRun(run, ['rev-parse', '--verify', '-q', 'HEAD'], dir));
  if (!head) return { ref: '', label: 'empty repo' };
  if (mode === 'uncommitted') {
    const ahead = mainline ? await countAhead(run, dir, mainline.ref, head, cache) : undefined;
    return ahead !== undefined ? { ref: head, label: 'HEAD', ahead } : { ref: head, label: 'HEAD' };
  }
  return { ref: head, label: 'HEAD (no mainline)' };
}

async function countAhead(run: Runner, dir: string, base: string, head: string, cache?: BaseCache): Promise<number | undefined> {
  const key = `${base}..${head}`;
  const cached = cache?.getAhead(dir, key);
  if (cached) return cached.count;
  const out = await tryRun(run, ['rev-list', '--count', key], dir);
  const count = out ? Number(out) : undefined;
  cache?.setAhead(dir, key, count);
  return count;
}

async function cachedMergeBase(run: Runner, dir: string, cache: BaseCache, refs: Refs | undefined): Promise<BaseRef | undefined> {
  const head = refs?.head;
  const entry = cache.getBase(dir);
  if (refs && head && entry && entry.head === head && (await refs.resolve(entry.upstream)) === entry.upstreamSha) {
    cache.hits++;
    return entry.base;
  }
  // The mainline that matched last time first: a git repository need not try the other names before its own again.
  const found = await mergeBase(run, dir, entry?.upstream);
  const upstreamSha = found && refs ? await refs.resolve(found.upstream) : undefined;
  cache.setBase(dir, found && head && upstreamSha ? { head, upstream: found.upstream, upstreamSha, base: found.base } : undefined);
  return found?.base;
}

/** The branches "vs mainline" diffs against, the first that exists. */
export const MAINLINE_CANDIDATES = ['origin/mainline', 'mainline', 'origin/HEAD', 'origin/main', 'main', 'origin/master', 'master'];

async function mergeBase(run: Runner, dir: string, first?: string): Promise<{ base: BaseRef; upstream: string } | undefined> {
  // Some repositories track mainline, most their default branch.
  const candidates = first ? [first, ...MAINLINE_CANDIDATES.filter((c) => c !== first)] : MAINLINE_CANDIDATES;
  for (const upstream of candidates) {
    const ref = await tryRun(run, ['merge-base', 'HEAD', upstream], dir);
    if (ref) return { base: { ref, label: `merge-base(${upstream})` }, upstream };
  }
  return undefined;
}

/** Parses `git diff --name-status -z` output: status, path (two paths for R/C), all NUL-terminated. */
export function parseNameStatus(out: string): FileChange[] {
  const changes: FileChange[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++];
    if (!token) continue;
    const status = token[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (oldPath !== undefined && path !== undefined) changes.push({ status, oldPath, path });
    } else {
      const path = tokens[i++];
      if (path !== undefined) changes.push({ status, path });
    }
  }
  return changes;
}

const entries = (out: string) => out.split('\0').filter(Boolean);

/** Working tree vs `baseRef` (staged and unstaged), plus untracked files. Empty `baseRef` = empty repository. */
export async function listChanges(run: Runner, dir: string, baseRef: string): Promise<FileChange[]> {
  const [untrackedOut, trackedOut] = await Promise.all([
    run(['ls-files', '-z', '--others', '--exclude-standard'], dir),
    run(baseRef ? ['diff', '--name-status', '-z', '-M', baseRef, '--'] : ['ls-files', '-z'], dir),
  ]);
  const untracked = entries(untrackedOut);
  const tracked = baseRef ? parseNameStatus(trackedOut) : entries(trackedOut).map((path): FileChange => ({ status: 'A', path }));
  // A path deleted from the index but still on disk is reported by both; show it once, as modified vs the base.
  const byPath = new Map(tracked.map((c) => [c.path, c]));
  const changes = [...tracked];
  for (const path of untracked) {
    const existing = byPath.get(path);
    if (!existing) changes.push({ status: '?', path });
    else if (existing.status === 'D') existing.status = 'M';
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function showFile(run: Runner, dir: string, ref: string, path: string): Promise<string> {
  if (!ref) return '';
  try {
    return await run(['show', `${ref}:${path}`], dir);
  } catch {
    return '';
  }
}

export type DiffLeft = { ref: string; path: string } | 'empty';
export type DiffRight = 'working' | 'empty';

export function diffSides(change: FileChange, base: BaseRef): { left: DiffLeft; right: DiffRight } {
  const added = change.status === 'A' || change.status === '?';
  return {
    left: added || !base.ref ? 'empty' : { ref: base.ref, path: change.oldPath ?? change.path },
    right: change.status === 'D' ? 'empty' : 'working',
  };
}
