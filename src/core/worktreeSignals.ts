import { resolve } from 'node:path';
import { isWithin } from './paths';

/** What the Worktrees view needs of a Claude session card. */
export interface CardLike {
  id: string;
  featureDir?: string;
  cwd?: string;
  state: string;
  detail: string;
  updatedAt?: number;
}

/** A card as last seen, to tell what changed on the next list. */
export type SeenCards = ReadonlyMap<string, { state: string; detail: string; updatedAt?: number }>;

/** How active a worktree's sessions are: `busy` while one works, `session` while one runs, else absent. */
export type Activity = 'busy' | 'session';

const LIVE = new Set(['working', 'waiting', 'blocked', 'done', 'idle', 'unknown']);

export interface SessionSignals {
  /** Each worktree's activity, by worktree directory. */
  activity: Map<string, Activity>;
  /** Files a session started editing since the last list: their packages changed. */
  touchedPaths: string[];
  /** Worktrees whose session finished a turn since the last list: anything in them may have changed (a Bash command). */
  touchedWorktrees: string[];
  /** Pass to the next call. */
  seen: Map<string, { state: string; detail: string; updatedAt?: number }>;
}

/**
 * What the Claude sessions say about the worktrees: which are active, which files a session started editing ("Editing
 * <path>", relative to its cwd), and which worktrees a session finished a turn in. A card seen for the first time
 * signals nothing (its worktree was loaded with what it had done so far).
 */
export function sessionSignals(prev: SeenCards, cards: readonly CardLike[]): SessionSignals {
  const activity = new Map<string, Activity>();
  const touchedPaths: string[] = [];
  const touchedWorktrees = new Set<string>();
  const seen = new Map<string, { state: string; detail: string; updatedAt?: number }>();
  for (const card of cards) {
    seen.set(card.id, { state: card.state, detail: card.detail, updatedAt: card.updatedAt });
    const dir = card.featureDir;
    if (!dir) continue;
    if (card.state === 'working') activity.set(dir, 'busy');
    else if (LIVE.has(card.state) && !activity.has(dir)) activity.set(dir, 'session');
    const old = prev.get(card.id);
    if (!old || (old.updatedAt === card.updatedAt && old.detail === card.detail && old.state === card.state)) continue;
    const editing = /^Editing (.+)$/.exec(card.detail);
    if (editing && (old.detail !== card.detail || old.updatedAt !== card.updatedAt)) touchedPaths.push(resolve(card.cwd ?? dir, editing[1]));
    if (old.state === 'working' && card.state !== 'working') touchedWorktrees.add(dir);
  }
  return { activity, touchedPaths, touchedWorktrees: [...touchedWorktrees], seen };
}

/**
 * The package directory, of those given, that contains `path` (the deepest, so a Claude Code worktree inside a
 * package wins over the package), mapping a symlink-resolved path (`/private/var/…`) back through `realDirs`.
 */
export function packageForPath(path: string, packageDirs: readonly string[], realDirs: ReadonlyMap<string, string> = new Map()): string | undefined {
  const candidates = [path];
  for (const [real, dir] of realDirs) if (isWithin(path, real)) candidates.push(dir + path.slice(real.length));
  let best: string | undefined;
  for (const p of candidates) {
    for (const dir of packageDirs) {
      if (isWithin(p, dir) && (!best || dir.length > best.length)) best = dir;
    }
  }
  return best;
}
