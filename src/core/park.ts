import type { EndedRecord } from './ended';
import { runningCount } from './sessionChildren';
import type { SessionCard } from './sessions';
import { DEFAULT_SERVER, isSessionId } from './tmux';

/**
 * When DevDesk parks its sessions (ends their tmux session and Claude, keeping the row to resume them). All times in
 * milliseconds; 0 turns a rule off.
 */
export interface ParkPolicy {
  /** Any parkable session inactive this long (`devdesk.sessions.parkAfterDays`); 0 turns parking off altogether. */
  anyMs: number;
  /** A finished session the user has read, that neither ended on an error nor asks a question (`parkReadAfterMinutes`). */
  readMs: number;
  /** Keep at most this many DevDesk sessions running (`maxLiveSessions`); 0: no limit. */
  maxLive: number;
  /** Free memory is low (`parkBelowFreeMemoryPercent`): park one more idle session. */
  lowMemory: boolean;
  /** The limit and low memory park only sessions inactive at least this long (`devdesk.sessions.idleMinutes`). */
  idleMs: number;
}

/** Why a session is parked, for the log. */
export type ParkReason = 'inactive' | 'read' | 'limit' | 'memory';

export interface ParkPick {
  card: SessionCard;
  reason: ParkReason;
}

/** A live state a session may be parked in: its turn is over and nothing waits on the user. */
const PARKABLE: ReadonlySet<string> = new Set(['done', 'idle', 'blocked', 'parked']);

/** A DevDesk (`cc-`) session on `server` with a conversation to resume. */
const ownSession = (c: SessionCard, server: string) => isSessionId(c.sessionId) && !!c.tmuxSession?.startsWith('cc-') && c.tmuxServer === server;

/**
 * A session that may be parked, whatever its age: DevDesk's own, whose turn is over, that started nothing still running,
 * and that no terminal shows (`attached`). A parked row whose tmux session is still there (Claude exited to a shell) is
 * included: parking it closes that shell.
 */
export function parkable(c: SessionCard, server: string): boolean {
  return ownSession(c, server) && PARKABLE.has(c.state) && !c.attached && runningCount(c.children ?? []) === 0 && c.updatedAt !== undefined;
}

/** A session whose last turn still asks something of the user: it ended on an error, asks a question, or is unread. */
function needsYou(c: SessionCard, read: (c: SessionCard) => boolean): boolean {
  const state = c.state === 'parked' ? c.lastState : c.state;
  return state === 'blocked' || !!c.asksQuestion || !read(c);
}

/** A DevDesk session whose Claude still runs (counts against `maxLive`). */
const live = (c: SessionCard, server: string) => ownSession(c, server) && c.state !== 'parked' && c.state !== 'stopped';

/**
 * The sessions to park now (see `ParkPolicy`), each once:
 * 1. by age: past `readMs` if read and finished, else past `anyMs`;
 * 2. over `maxLive` running sessions, the least recently active idle ones, those that need the user last;
 * 3. on low memory, one more of those.
 * `read` says whether the user has read what a session shows.
 */
export function parkPlan(
  cards: readonly SessionCard[],
  now: number,
  policy: ParkPolicy,
  server: string,
  read: (c: SessionCard) => boolean,
): ParkPick[] {
  if (!(policy.anyMs > 0)) return [];
  const candidates = cards.filter((c) => parkable(c, server));
  const age = (c: SessionCard) => now - (c.updatedAt ?? now);
  const picks: ParkPick[] = [];
  const rest: SessionCard[] = [];
  for (const c of candidates) {
    if (age(c) > policy.anyMs) picks.push({ card: c, reason: 'inactive' });
    else if (policy.readMs > 0 && age(c) > policy.readMs && !needsYou(c, read)) picks.push({ card: c, reason: 'read' });
    else rest.push(c);
  }
  // Read ones before those that need the user, oldest first.
  const idle = rest
    .filter((c) => age(c) >= policy.idleMs)
    .sort((a, b) => Number(needsYou(a, read)) - Number(needsYou(b, read)) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  const parkedLive = picks.filter((p) => live(p.card, server)).length;
  const over = policy.maxLive > 0 ? cards.filter((c) => live(c, server)).length - parkedLive - policy.maxLive : 0;
  // A row left with a shell does not count as live, so parking it does not bring the count down: skip those.
  const liveIdle = idle.filter((c) => live(c, server));
  for (const c of liveIdle.splice(0, Math.max(0, over))) picks.push({ card: c, reason: 'limit' });
  if (policy.lowMemory && liveIdle.length) picks.push({ card: liveIdle[0], reason: 'memory' });
  return picks;
}

/**
 * The conversation to resume in tmux session `session` on `server` when a terminal on it is restored but the session
 * is gone: the newest one DevDesk parked there (not one the user ended or that crashed), unless it already runs again
 * (`running`: session ids with a live process).
 */
export function parkedIn(session: string, server: string, ended: readonly EndedRecord[], running: ReadonlySet<string>): EndedRecord | undefined {
  return ended
    .filter((r) => r.endReason === 'parked' && r.tmuxSession === session && (r.tmuxServer ?? DEFAULT_SERVER) === server && !running.has(r.sessionId))
    .sort((a, b) => b.endedAt - a.endedAt)[0];
}

/** Percent of memory available, from Linux's `/proc/meminfo` (`MemAvailable` of `MemTotal`); undefined if missing. */
export function meminfoFreePercent(text: string): number | undefined {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return total && available !== undefined ? (available / total) * 100 : undefined;
}

/** Percent of memory available as macOS's memory pressure sees it (`sysctl -n kern.memorystatus_level`); undefined if not a number. */
export function memorystatusFreePercent(text: string): number | undefined {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}
