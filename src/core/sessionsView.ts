import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { runningCount, type SessionChild } from './sessionChildren';
import { INTERRUPTED_DETAIL, type SessionCard, type SessionState, type WaitKind } from './sessions';
import { DEFAULT_SERVER } from './tmux';
import { oneLine, truncate } from './text';

export interface CardView {
  id: string;
  /** `main`, the worktree name, or `no worktree`. */
  worktree: string;
  hasWorktree: boolean;
  /**
   * A name the user gave (/rename), else DevDesk's few-word Haiku title, else Claude Code's own name for the session,
   * else the last prompt, else a fallback that still tells sessions apart.
   */
  title: string;
  /** The last prompt, when the title is something else. */
  prompt: string;
  /** Claude's latest recap, with how long ago it was written (`2h ago`). */
  summary: string;
  /** `Started 2h ago · active 5m ago`. */
  times: string;
  /** Where it runs: the tmux session, or `not in tmux`, and the directory. */
  location: string;
  state: SessionState;
  stateLabel: string;
  ago: string;
  detail: string;
  /** What Claude is doing now, from DevDesk's Haiku insight (working sessions; else empty). */
  liveStatus: string;
  /** Where the work stands, from DevDesk's Haiku insight, with how long ago (`(5m ago)`); empty without one. */
  insight: string;
  attached: boolean;
  /** Runs in a tmux pane, so the Claude view can open a terminal on it. */
  inTmux: boolean;
}

const LABELS: Record<SessionState, string> = {
  waiting: 'NEEDS INPUT',
  blocked: 'BLOCKED',
  working: 'WORKING',
  done: 'DONE',
  idle: 'READY',
  unknown: 'NO STATUS',
  stopped: 'NOT RUNNING',
  parked: 'PARKED',
};

export function formatAgo(updatedAt: number | undefined, now: number): string {
  if (updatedAt === undefined) return '';
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `formatAgo` as a phrase: `5m ago`, `just now`, or '' without a time. */
export function timeAgo(at: number | undefined, now: number): string {
  const text = formatAgo(at, now);
  return text && text !== 'just now' ? `${text} ago` : text;
}

export { truncate };

/** `cwd` relative to the feature directory (`src/Pkg`), or its last two segments outside any feature. */
function where(card: SessionCard): string {
  const cwd = card.cwd;
  if (!cwd) return '';
  if (card.featureDir && cwd.startsWith(`${card.featureDir}/`)) return cwd.slice(card.featureDir.length + 1);
  if (card.featureDir && cwd === card.featureDir) return '';
  return cwd.split('/').slice(-2).join('/');
}

/** `tmux <session>`, naming the server when it is not the VS Code one (`your tmux` for the default server). */
function tmuxLabel(card: SessionCard, vscodeServer: string | undefined): string {
  if (!card.tmuxSession) return 'not in tmux';
  const server = card.tmuxServer ?? DEFAULT_SERVER;
  if (vscodeServer === undefined || server === vscodeServer) return `tmux ${card.tmuxSession}`;
  return `tmux ${card.tmuxSession} (${server === DEFAULT_SERVER ? 'your tmux' : `server ${server}`})`;
}

/** `vscodeServer`: the tmux server DevDesk runs its sessions on; sessions elsewhere get their server in the location. */
export function cardView(card: SessionCard, now: number, vscodeServer?: string): CardView {
  const inTmux = !!card.tmuxPane;
  const location = [tmuxLabel(card, vscodeServer), where(card)].filter(Boolean).join(' · ');
  const prompt = card.prompt ? oneLine(card.prompt) : '';
  const given = card.name ? oneLine(card.name) : '';
  const name = (card.nameByUser && given) || (card.insightTitle ? oneLine(card.insightTitle) : '') || given;
  const title = name || prompt || (card.cwd ? `Claude in ${basename(card.cwd)}` : card.tmuxSession ?? 'Claude');
  const ago = (at: number | undefined) => timeAgo(at, now);
  const summaryAgo = ago(card.summaryAt);
  const times = [card.startedAt !== undefined ? `Started ${ago(card.startedAt)}` : '', card.updatedAt !== undefined ? `active ${ago(card.updatedAt)}` : '']
    .filter(Boolean)
    .join(' · ');
  return {
    id: card.id,
    worktree: card.featureName ?? 'no worktree',
    hasWorktree: !!card.featureName,
    title: truncate(title, 120),
    prompt: name && prompt ? truncate(prompt, 300) : '',
    summary: card.summary ? `${truncate(oneLine(card.summary), 500)}${summaryAgo ? ` (${summaryAgo})` : ''}` : '',
    times: times.charAt(0).toUpperCase() + times.slice(1),
    location,
    state: card.state,
    stateLabel: LABELS[card.state],
    ago: formatAgo(card.updatedAt, now),
    detail: truncate(oneLine(card.detail), 160),
    liveStatus: card.liveStatus ? truncate(oneLine(card.liveStatus), 120) : '',
    insight: card.insightSummary ? `${truncate(oneLine(card.insightSummary), 300)}${ago(card.insightSummaryAt) ? ` (${ago(card.insightSummaryAt)})` : ''}` : '',
    attached: card.attached,
    inTmux,
  };
}

/**
 * What tells a session apart from others with the same title: its last prompt when its title is a name, else when it
 * started, else its tmux session.
 */
function distinction(card: SessionCard, now: number): string {
  const v = cardView(card, now);
  if (v.prompt) return truncate(oneLine(card.prompt ?? ''), 60);
  const started = timeAgo(card.startedAt, now);
  return started ? `started ${started}` : card.tmuxSession ?? '';
}

/** `distinction` for each card whose title another card shares; '' for the others. */
export function distinctions(cards: readonly SessionCard[], titles: readonly string[], now: number): string[] {
  const count = new Map<string, number>();
  for (const t of titles) count.set(t, (count.get(t) ?? 0) + 1);
  return cards.map((card, i) => ((count.get(titles[i]) ?? 0) > 1 ? distinction(card, now) : ''));
}

export function transitionsToWaiting(prev: readonly SessionCard[], next: readonly SessionCard[]): string[] {
  const before = new Map(prev.map((c) => [c.id, c.state]));
  return next.filter((c) => c.state === 'waiting' && before.get(c.id) !== 'waiting').map((c) => c.id);
}

const BADGE_LEVELS: readonly { state: SessionState; one: string; many: string }[] = [
  { state: 'waiting', one: 'needs you', many: 'need you' },
  { state: 'blocked', one: 'blocked on an error', many: 'blocked on an error' },
  { state: 'working', one: 'working', many: 'working' },
];

/** The activity bar badge: the count of the most urgent kind of session (needs you, then blocked, then working), or none. */
export function badgeFor(cards: readonly SessionCard[]): { value: number; tooltip: string } | undefined {
  for (const level of BADGE_LEVELS) {
    const n = cards.filter((c) => c.state === level.state).length;
    if (n) return { value: n, tooltip: `${n} Claude session${n === 1 ? ` ${level.one}` : `s ${level.many}`}` };
  }
  return undefined;
}

/**
 * A done session whose subagents, background shells or workflows still run: its turn ended, but Claude picks up again
 * when they finish (for example after a background `sleep 600` it started to wait for a build).
 */
export function waitsOnBackground(card: SessionCard): boolean {
  return card.state === 'done' && !!card.children && runningBackground(card.children);
}

/** Some background child (or a child of one) still runs; a foreground one left running by an interrupted turn does not count. */
function runningBackground(children: readonly SessionChild[]): boolean {
  return children.some((c) => c.background && runningCount([c]) > 0);
}

/** A done session not updated for `idleMs` sorts as idle (after working ones), unless it waits on background work; it still looks done. */
export function displayState(card: SessionCard, now: number, idleMs: number): SessionState {
  const stale = card.updatedAt !== undefined && now - card.updatedAt > idleMs;
  return card.state === 'done' && stale && !waitsOnBackground(card) ? 'idle' : card.state;
}

const RANK: Record<SessionState, number> = { waiting: 0, blocked: 1, done: 4, working: 3, idle: 5, unknown: 6, stopped: 7, parked: 8 };

/**
 * The order of working sessions, kept between re-sorts: their `updatedAt` changes with every hook event, so sorting
 * them newest first moves rows all the time. Shared by the Claude view and the Claude Board, so both show one order.
 */
export class SettledOrder {
  private keys = new Map<string, number>();
  private sortedAt = -Infinity;
  private top = 0;

  /**
   * `fresh` (newest first) in the order kept since the last re-sort, at most `everyMs` ago (`0`: every time). A session
   * that was not working at the last call goes first, as the newest.
   */
  arrange<T extends { id: string }>(fresh: readonly T[], now: number, everyMs: number): T[] {
    if (everyMs <= 0 || now - this.sortedAt >= everyMs || now < this.sortedAt) {
      this.keys = new Map(fresh.map((c, i) => [c.id, i]));
      this.sortedAt = now;
      this.top = 0;
      return [...fresh];
    }
    const keys = new Map<string, number>();
    // Newly working ones keep their fresh order among themselves, above every kept one.
    const added = fresh.filter((c) => !this.keys.has(c.id));
    this.top -= added.length;
    added.forEach((c, i) => keys.set(c.id, this.top + i));
    for (const c of fresh) if (!keys.has(c.id)) keys.set(c.id, this.keys.get(c.id)!);
    this.keys = keys;
    return [...fresh].sort((a, b) => keys.get(a.id)! - keys.get(b.id)!);
  }
}

/** How `attentionOrder` keeps working sessions in place: `order` re-sorts them at most every `everyMs`. */
export interface Settle {
  order: SettledOrder;
  everyMs: number;
}

/**
 * Attention order (Orca's): needs input, blocked, unread done, working, read done, idle, then sessions without status;
 * unread before read within each, then newest first. `unreadFirst` puts every unread session above every read one.
 * Working sessions (and done ones waiting on background work) sort as read, so they don't jump each time they show
 * something new; with `settle` they also keep their order between its re-sorts.
 */
export function attentionOrder(
  cards: readonly SessionCard[],
  now: number,
  idleMs: number,
  unread: ReadonlySet<string>,
  unreadFirst = false,
  settle?: Settle,
): SessionCard[] {
  const working = (c: SessionCard): boolean => waitsOnBackground(c) || displayState(c, now, idleMs) === 'working';
  const rank = (c: SessionCard): number => {
    if (working(c)) return unreadFirst ? 10 + RANK.working : RANK.working * 2 + 1;
    const state = displayState(c, now, idleMs);
    const r = state === 'done' && unread.has(c.id) ? 2 : RANK[state];
    const u = unread.has(c.id) ? 0 : 1;
    return unreadFirst ? u * 10 + r : r * 2 + u;
  };
  const sorted = [...cards].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id));
  if (!settle) return sorted;
  // Working sessions share one rank, so they are one run of `sorted`.
  const first = sorted.findIndex(working);
  if (first < 0) {
    settle.order.arrange([], now, settle.everyMs);
    return sorted;
  }
  let end = first;
  while (end < sorted.length && working(sorted[end])) end++;
  return [...sorted.slice(0, first), ...settle.order.arrange(sorted.slice(first, end), now, settle.everyMs), ...sorted.slice(end)];
}

/**
 * What a session shows of itself, hashed (it is persisted); any change to it (a new state or detail, a subagent
 * finishing, a crash) is news to read. Not the time: a hook rewriting the same state (Claude's idle reminder a minute
 * after a turn ends) or a session ageing is not news.
 */
export function cardSignature(c: SessionCard): string {
  return createHash('sha1').update(JSON.stringify(shownParts(c))).digest('base64url').slice(0, 16);
}

/** What `cardSignature` hashes, readable (for the read-state log and diagnostics). */
export interface ShownParts {
  state: SessionState;
  detail: string;
  crashed?: boolean;
  children?: [string, SessionChild['state']][];
}

/**
 * Kept as a tuple in `cardSignature` so existing saved signatures stay valid. A parked session shows the state it ended
 * in, so parking it (or resuming it) is not news.
 */
function shownParts(c: SessionCard): [SessionState, string, boolean | undefined, [string, SessionChild['state']][] | undefined] {
  return [c.state === 'parked' ? c.lastState ?? 'done' : c.state, c.detail, c.crashed, c.children?.map((k) => [k.id, k.state] as [string, SessionChild['state']])];
}

export function cardShown(c: SessionCard): ShownParts {
  const [state, detail, crashed, children] = shownParts(c);
  return { state, detail, crashed, children };
}

/**
 * What changed between two `cardShown` results, as short text (`state working→done; detail "a"→"b"; child x running→done`);
 * empty when nothing did.
 */
export function shownChange(before: ShownParts, after: ShownParts): string {
  const q = (s: string) => JSON.stringify(truncate(oneLine(s), 80));
  const out: string[] = [];
  if (before.state !== after.state) out.push(`state ${before.state}→${after.state}`);
  if (before.detail !== after.detail) out.push(`detail ${q(before.detail)}→${q(after.detail)}`);
  if (!!before.crashed !== !!after.crashed) out.push(after.crashed ? 'crashed' : 'no longer crashed');
  const was = new Map(before.children ?? []);
  const now = new Map(after.children ?? []);
  for (const [id, state] of now) {
    const prev = was.get(id);
    if (prev === undefined) out.push(`child ${id} ${state} (new)`);
    else if (prev !== state) out.push(`child ${id} ${prev}→${state}`);
  }
  for (const id of was.keys()) if (!now.has(id)) out.push(`child ${id} gone`);
  if (!before.children !== !after.children && !out.some((o) => o.startsWith('child'))) out.push(after.children ? 'children listed' : 'children no longer listed');
  return out.join('; ');
}

/** Most sessions remembered per host; past it, those gone from the listing longest are forgotten. */
export const SEEN_LIMIT = 500;

/**
 * What the user has seen of each session (its signature) after a refresh. `looked`: sessions whose terminal has been
 * in front long enough. `seed`: the first load, when everything already there counts as seen. New sessions are unseen.
 * Sessions missing from this listing keep what was seen of them: a listing can miss sessions for a moment (a hook
 * record rewritten or unreadable mid-read, an overloaded machine), and forgetting them then would turn them all unread
 * once they are listed again, or in the next window if this one closes first. Listed sessions come first, then the
 * unlisted ones in the order they were before, so the ones gone longest come last and are dropped past `limit`.
 */
export function nextSeen(
  seen: ReadonlyMap<string, string>,
  cards: readonly SessionCard[],
  looked: ReadonlySet<string>,
  seed = false,
  limit = SEEN_LIMIT,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const c of cards) {
    const sig = seed || looked.has(c.id) ? cardSignature(c) : seen.get(c.id);
    if (sig !== undefined) result.set(c.id, sig);
  }
  const listed = new Set(cards.map((c) => c.id));
  for (const [id, sig] of seen) {
    if (result.size >= limit) break;
    if (!listed.has(id)) result.set(id, sig);
  }
  return result;
}

/**
 * `seen` after the user marks a session read (what it shows now counts as seen) or unread (nothing of it counts as
 * seen, until its terminal is in front again).
 */
export function markSeen(seen: ReadonlyMap<string, string>, card: SessionCard, read: boolean): Map<string, string> {
  const result = new Map(seen);
  if (read) result.set(card.id, cardSignature(card));
  else result.delete(card.id);
  return result;
}

/**
 * The read state of a host's first load (nothing saved for this host yet), from `shared`: what was saved for every host
 * together before read state was kept per host. A listed session takes its entry there, so one the user had not read
 * stays unread; the other listed sessions count as read (the first load counts as seen). Unlisted entries of `shared`
 * are kept too (another workspace's sessions on this host), after the listed ones.
 */
export function firstSeen(shared: ReadonlyMap<string, string>, cards: readonly SessionCard[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const c of cards) result.set(c.id, shared.get(c.id) ?? cardSignature(c));
  for (const [id, sig] of shared) if (!result.has(id)) result.set(id, sig);
  return result;
}

/** How long a read or unread mark by hand is saved again when another window's write undoes it. */
export const HAND_MARK_MS = 30_000;

/** A session marked read (`signature`: what it shows) or unread (undefined) by hand, and when. */
export interface HandMark {
  signature: string | undefined;
  /** `cardSignature` when it was marked: once the session shows something else, the mark no longer stands. */
  shown: string;
  at: number;
}

/**
 * `saved` with this window's recent marks by hand put back where another window's write undid them (it saved its copy
 * from before the mark reached it). A mark stands for `HAND_MARK_MS`, while its session is listed and shows what it
 * showed when marked, and until its terminal has been in front long enough (`looked`). Returns the marks still standing.
 */
export function withHandMarks(
  saved: ReadonlyMap<string, string>,
  marks: ReadonlyMap<string, HandMark>,
  cards: readonly SessionCard[],
  looked: ReadonlySet<string>,
  now: number,
): { seen: ReadonlyMap<string, string>; marks: Map<string, HandMark> } {
  const standing = new Map<string, HandMark>();
  for (const [id, mark] of marks) {
    const card = cards.find((c) => c.id === id);
    if (card && now - mark.at < HAND_MARK_MS && !looked.has(id) && cardSignature(card) === mark.shown) standing.set(id, mark);
  }
  if (![...standing].some(([id, m]) => saved.get(id) !== m.signature)) return { seen: saved, marks: standing };
  const seen = new Map(saved);
  for (const [id, m] of standing) {
    if (m.signature === undefined) seen.delete(id);
    else seen.set(id, m.signature);
  }
  return { seen, marks: standing };
}

/** Sessions where something happened since the user last looked at them. */
export function unreadCards(seen: ReadonlyMap<string, string>, cards: readonly SessionCard[]): Set<string> {
  return new Set(cards.filter((c) => seen.get(c.id) !== cardSignature(c)).map((c) => c.id));
}

/** A finer state for icons and labels: which kind of input, an error or a usage limit, stuck or crashed. */
export type StateLook =
  | 'question'
  | 'permission'
  | 'plan'
  | 'input'
  | 'limited'
  | 'error'
  | 'working'
  | 'stuck'
  | 'background'
  | 'done'
  | 'asked'
  | 'interrupted'
  | 'idle'
  | 'unknown'
  | 'crashed'
  | 'stopped'
  | 'parked';

const WAIT_LOOKS: Record<WaitKind, StateLook> = { question: 'question', plan: 'plan', permission: 'permission', elicitation: 'input' };

const LIMIT_RE = /\b(rate|usage)[ _-]?limit|limit (reached|exceeded)|\blimited\b/i;

/**
 * `stuckMs`: a working session with no hook event for this long looks stuck. A finished turn looks done (or interrupted,
 * when Esc ended it) however long ago it ended; `idleMs` only changes where it sorts (see `displayState`).
 */
export function stateLook(card: SessionCard, now: number, stuckMs: number): StateLook {
  const state = card.state;
  switch (state) {
    case 'waiting':
      if (card.waitKind) return WAIT_LOOKS[card.waitKind];
      // A record from an older hook script says what it waits on only in its detail.
      if (card.detail.startsWith('Asking:')) return 'question';
      if (card.detail.startsWith('Plan ready')) return 'plan';
      return /permission/i.test(card.detail) ? 'permission' : 'input';
    case 'blocked':
      return LIMIT_RE.test(card.detail) ? 'limited' : 'error';
    case 'working':
      return card.updatedAt !== undefined && now - card.updatedAt > stuckMs ? 'stuck' : 'working';
    case 'stopped':
      return card.crashed ? 'crashed' : 'stopped';
    case 'parked':
      return card.crashed ? 'crashed' : 'parked';
    case 'done':
      if (waitsOnBackground(card)) return 'background';
      if (card.detail === INTERRUPTED_DETAIL) return 'interrupted';
      return card.asksQuestion ? 'asked' : 'done';
    default:
      return state;
  }
}

/**
 * How a parked session's last turn ended (done, asked you, interrupted, blocked, usage limit), so its row keeps that
 * icon and colour once it stops running; undefined for other sessions, a crashed one, or a turn that never ended.
 */
function finishedLook(card: SessionCard, now: number, stuckMs: number): StateLook | undefined {
  if (card.state !== 'parked' || card.crashed || (card.lastState !== 'done' && card.lastState !== 'blocked')) return undefined;
  return stateLook({ ...card, state: card.lastState, children: undefined }, now, stuckMs);
}

/** The look a row is drawn with (its finished look when parked), and its label (`DONE · PARKED (NOT RUNNING)`). */
export function shownLook(card: SessionCard, now: number, stuckMs: number): { look: StateLook; label: string } {
  const look = stateLook(card, now, stuckMs);
  const finished = finishedLook(card, now, stuckMs);
  return finished ? { look: finished, label: `${LOOK_LABELS[finished]} · ${LOOK_LABELS[look]}` } : { look, label: LOOK_LABELS[look] };
}

/** Codicon and theme colour per look, for tree rows; each look has its own shape, so colour is never the only cue. */
export const LOOK_ICONS: Record<StateLook, { icon: string; color?: string }> = {
  question: { icon: 'question', color: 'charts.yellow' },
  permission: { icon: 'shield', color: 'charts.yellow' },
  plan: { icon: 'checklist', color: 'charts.yellow' },
  input: { icon: 'bell-dot', color: 'charts.yellow' },
  limited: { icon: 'clock', color: 'charts.orange' },
  error: { icon: 'error', color: 'charts.red' },
  working: { icon: 'loading~spin', color: 'charts.blue' },
  stuck: { icon: 'watch', color: 'charts.orange' },
  background: { icon: 'sync~spin', color: 'charts.blue' },
  done: { icon: 'check', color: 'charts.green' },
  asked: { icon: 'comment-discussion', color: 'charts.green' },
  interrupted: { icon: 'debug-stop', color: 'charts.purple' },
  idle: { icon: 'circle-outline', color: 'disabledForeground' },
  unknown: { icon: 'circle-large-outline' },
  crashed: { icon: 'debug-disconnect', color: 'charts.red' },
  stopped: { icon: 'circle-slash', color: 'disabledForeground' },
  parked: { icon: 'debug-pause', color: 'disabledForeground' },
};

/**
 * How a session row marks its read state, as a file decoration (tree labels cannot be bold): with `dimRead` read titles
 * are greyed, with `badge` unread rows get a dot. Undefined when the row needs no decoration.
 */
export function readDecoration(unread: boolean, opts: { dimRead: boolean; badge: boolean }): { badge?: string; color?: string; tooltip: string } | undefined {
  if (unread) return opts.badge ? { badge: '\u25CF', tooltip: 'Unread' } : undefined;
  return opts.dimRead ? { color: 'descriptionForeground', tooltip: 'Read' } : undefined;
}

/** Tooltip and screen reader text per look. */
const LOOK_LABELS: Record<StateLook, string> = {
  question: 'QUESTION FOR YOU',
  permission: 'NEEDS PERMISSION',
  plan: 'PLAN TO REVIEW',
  input: 'NEEDS INPUT',
  limited: 'USAGE LIMIT',
  error: 'BLOCKED',
  working: 'WORKING',
  stuck: 'NO PROGRESS (STUCK?)',
  background: 'WAITING ON BACKGROUND WORK',
  done: 'DONE',
  asked: 'DONE (ASKED YOU)',
  interrupted: 'DONE (INTERRUPTED)',
  idle: 'READY',
  unknown: 'NO STATUS',
  crashed: 'CRASHED',
  stopped: 'NOT RUNNING',
  parked: 'PARKED (NOT RUNNING)',
};

/** Short state text for a Worktrees row. */
export const LOOK_TEXT: Record<StateLook, string> = {
  question: '? question',
  permission: '? needs permission',
  plan: '? plan to review',
  input: '? needs input',
  limited: '◷ usage limit',
  error: '✕ blocked',
  working: '⟳ working',
  stuck: '⟳ stuck?',
  background: '⟳ background',
  done: '✓ done',
  asked: '✓ asked you',
  interrupted: '■ interrupted',
  idle: '○ ready',
  unknown: '● claude',
  crashed: '✕ crashed',
  stopped: '○ not running',
  parked: '⏸ parked',
};

/** The most urgent session in each worktree (by `featureDir`), for the Worktrees view. */
export function urgentByWorktree(
  cards: readonly SessionCard[],
  now: number,
  idleMs: number,
  unread: ReadonlySet<string>,
): Map<string, SessionCard> {
  const result = new Map<string, SessionCard>();
  for (const c of attentionOrder(cards, now, idleMs, unread)) if (c.featureDir && !result.has(c.featureDir)) result.set(c.featureDir, c);
  return result;
}

/**
 * Splits a worktree's sessions (in attention order, so parked ones last, newest first) into those listed and the
 * parked ones past `limit`, which fold into one row.
 */
export function foldParked(cards: readonly SessionCard[], limit: number): { shown: SessionCard[]; folded: SessionCard[] } {
  const parked = cards.filter((c) => c.state === 'parked');
  const folded = parked.slice(Math.max(0, limit));
  const hidden = new Set(folded);
  return { shown: cards.filter((c) => !hidden.has(c)), folded };
}
