import { INTERRUPTED_DETAIL, type SessionCard } from './sessions';
import { attentionOrder, waitsOnBackground, type Settle } from './sessionsView';

/** How the Claude view and the Claude Board order sessions (setting `devdesk.sessions.sort`). */
export type SortMode = 'urgency' | 'attention';

export function isSortMode(v: unknown): v is SortMode {
  return v === 'urgency' || v === 'attention';
}

/**
 * Urgency ranks, most urgent first: needs you, recently finished, working, stuck, the rest (read or older done, ready,
 * no status), not running, parked.
 */
export type UrgencyRank = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface UrgencyOptions {
  now: number;
  /** A working session with no hook event for this long is stuck (`devdesk.sessions.stuckMinutes`). */
  stuckMs: number;
  /** A finished turn counts as recently finished, while unread, for this long (`devdesk.sessions.recentlyFinishedMinutes`). */
  recentMs: number;
  unread: ReadonlySet<string>;
}

/** The working (not stuck) sessions, and done ones waiting on background work: they keep their order with `settle`. */
function isWorking(c: SessionCard, o: UrgencyOptions): boolean {
  return waitsOnBackground(c) || (c.state === 'working' && !isStuck(c, o));
}

function isStuck(c: SessionCard, o: UrgencyOptions): boolean {
  return c.state === 'working' && c.updatedAt !== undefined && o.now - c.updatedAt > o.stuckMs;
}

/**
 * A session's urgency rank. Recently finished: a turn that ended (not by Esc) less than `recentMs` ago, unread. A done
 * session waiting on background work ranks as working; a working one with no hook event for `stuckMs` as stuck.
 */
export function urgencyRank(c: SessionCard, o: UrgencyOptions): UrgencyRank {
  switch (c.state) {
    case 'waiting':
    case 'blocked':
      return 0;
    case 'working':
      return isStuck(c, o) ? 3 : 2;
    case 'done': {
      if (waitsOnBackground(c)) return 2;
      const recent = c.updatedAt !== undefined && o.now - c.updatedAt <= o.recentMs;
      return recent && o.unread.has(c.id) && c.detail !== INTERRUPTED_DETAIL ? 1 : 4;
    }
    case 'stopped':
      return 5;
    case 'parked':
      return 6;
    default:
      return 4;
  }
}

/**
 * Urgency order: what needs you on top (oldest waiting first, so the longest wait is answered first), then recently
 * finished unread turns, working, stuck, the rest, not running, parked; newest first within each of those (the rest:
 * unread first). Ties go by id, so rows never swap on a refresh. With `settle`, working sessions keep their order
 * between its re-sorts (their `updatedAt` changes with every hook event).
 */
export function urgencyOrder(cards: readonly SessionCard[], o: UrgencyOptions, settle?: Settle): SessionCard[] {
  const ranked = cards.map((c) => ({ c, r: urgencyRank(c, o), u: o.unread.has(c.id) ? 0 : 1, t: c.updatedAt ?? 0 }));
  ranked.sort(
    (a, b) =>
      a.r - b.r ||
      (a.r === 4 ? a.u - b.u : 0) ||
      (a.r === 0 ? a.t - b.t : b.t - a.t) ||
      a.c.id.localeCompare(b.c.id),
  );
  const sorted = ranked.map((x) => x.c);
  if (!settle) return sorted;
  // Working sessions share one rank, so they are one run of `sorted`.
  const first = sorted.findIndex((c) => isWorking(c, o));
  if (first < 0) {
    settle.order.arrange([], o.now, settle.everyMs);
    return sorted;
  }
  let end = first;
  while (end < sorted.length && isWorking(sorted[end], o)) end++;
  return [...sorted.slice(0, first), ...settle.order.arrange(sorted.slice(first, end), o.now, settle.everyMs), ...sorted.slice(end)];
}

export interface SortOptions extends UrgencyOptions {
  mode: SortMode;
  /** Attention order only: a done session not updated for this long sorts as idle (`devdesk.sessions.idleMinutes`). */
  idleMs: number;
  /** Attention order only: every unread session above every read one (`devdesk.sessions.unreadFirst`). */
  unreadFirst: boolean;
  settle?: Settle;
}

/** The sessions in the order `mode` names: `urgency` (`urgencyOrder`) or `attention` (`attentionOrder`). */
export function sortSessions(cards: readonly SessionCard[], o: SortOptions): SessionCard[] {
  return o.mode === 'urgency' ? urgencyOrder(cards, o, o.settle) : attentionOrder(cards, o.now, o.idleMs, o.unread, o.unreadFirst, o.settle);
}

/**
 * The most urgent session in each worktree (by `featureDir`), for the Worktrees view: each worktree's first session in
 * the order `devdesk.sessions.sort` names. Working sessions are not settled here: only each worktree's first counts.
 */
export function urgentByWorktree(cards: readonly SessionCard[], o: Omit<SortOptions, 'settle'>): Map<string, SessionCard> {
  const result = new Map<string, SessionCard>();
  for (const c of sortSessions(cards, o)) if (c.featureDir && !result.has(c.featureDir)) result.set(c.featureDir, c);
  return result;
}
