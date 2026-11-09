import { DEFAULT_SERVER } from './tmux';
import { type HookRecord, MOVED_DETAIL, type SessionCard, type SessionState } from './sessions';

/**
 * Updates that show before the next full refresh of the sessions (tmux, processes, transcripts): a hook record just
 * written (`withRecord`), and the turn of a session the board just started on a prompt (`withPendingTurns`).
 */

/**
 * `card` with what a newer hook record of its session says (state, detail, prompt, turn times), or `card` itself when
 * the record is not newer or the card does not show a running session's record. What an insight said for the turn
 * or the wait that ended goes with it.
 */
export function withRecord(card: SessionCard, record: HookRecord): SessionCard {
  if (card.sessionId !== record.sessionId || !hasRecord(card.state)) return card;
  if (card.updatedAt !== undefined && record.updatedAt <= card.updatedAt) return card;
  // Its conversation went on in a background job, as its transcript says: the pane's Claude still writes records
  // under this id, which the refresh corrects again.
  if (card.detail === MOVED_DETAIL) return card;
  const next: SessionCard = { ...card, state: record.state, detail: record.detail, updatedAt: record.updatedAt };
  if (record.prompt) next.prompt = record.prompt;
  // The same finished turn (an idle reminder rewrote it): keep what the card says, which may be the insight's answer.
  const sameDone = record.state === 'done' && card.state === 'done' && record.turnEndedAt !== undefined && record.turnEndedAt === card.turnEndedAt;
  if (!sameDone) {
    if (record.asksQuestion) next.asksQuestion = true;
    else delete next.asksQuestion;
  }
  delete next.turnStartedAt;
  delete next.turnEndedAt;
  if (record.turnStartedAt !== undefined) next.turnStartedAt = record.turnStartedAt;
  if (record.turnEndedAt !== undefined) next.turnEndedAt = record.turnEndedAt;
  if (next.state !== 'working' || next.turnStartedAt !== card.turnStartedAt) delete next.liveStatus;
  // A wait is identified by its record's time, which just changed.
  delete next.askSummary;
  return next;
}

/** States a card takes from its session's hook record (a live session with hooks). */
const hasRecord = (state: SessionState) => state === 'working' || state === 'waiting' || state === 'done' || state === 'idle' || state === 'blocked';

/** `cards` with each newer record in `records` (by session id) applied; the same array when none applies. */
export function withRecords(cards: SessionCard[], records: ReadonlyMap<string, HookRecord>): SessionCard[] {
  if (!records.size) return cards;
  let changed = false;
  const next = cards.map((c) => {
    const r = c.sessionId ? records.get(c.sessionId) : undefined;
    const patched = r ? withRecord(c, r) : c;
    if (patched !== c) changed = true;
    return patched;
  });
  return changed ? next : cards;
}

/** A session the board started on a prompt, by its tmux server and session, until Claude reports its first turn. */
export interface PendingTurn {
  server: string;
  session: string;
  prompt: string;
  at: number;
}

/** How long a started session shows as working before Claude reports its first turn; after that it shows as it is. */
export const PENDING_TURN_MS = 60_000;
/** A started session whose tmux pane shows no Claude this long after the start is shown as it is (Claude exited). */
export const PENDING_STOPPED_MS = 15_000;
/**
 * A started session that has been idle this long since its last hook record (SessionStart) is shown as it is: Claude
 * submits its first prompt once every SessionStart hook has finished, which can take 15 s, so no turn by then means
 * the prompt started none.
 */
export const PENDING_IDLE_MS = 30_000;
/** What the card of a session the board just started says until Claude reports its first turn. */
export const STARTING_DETAIL = 'Starting Claude';

/**
 * `cards` with each session the board just started on a prompt shown as working on it while Claude starts (its card is
 * `unknown`, or `idle` from SessionStart, or briefly `stopped` before Claude runs in its pane), and the pending turns
 * still to wait for: Claude's first turn since the start (a hook record's turn start), a question or error (`waiting`,
 * `blocked`, as a trust dialog), or the time limits end one. Only for sessions with DevDesk's hooks, whose records end it.
 */
export function withPendingTurns(cards: SessionCard[], pending: readonly PendingTurn[], now: number): { cards: SessionCard[]; pending: PendingTurn[] } {
  const left: PendingTurn[] = [];
  let changed = false;
  const next = cards.map((c) => c);
  for (const p of pending) {
    const age = now - p.at;
    if (age >= PENDING_TURN_MS) continue;
    const i = next.findIndex((c) => c.tmuxSession === p.session && (c.tmuxServer ?? DEFAULT_SERVER) === p.server && c.state !== 'parked');
    if (i < 0) {
      left.push(p); // not listed yet
      continue;
    }
    const card = next[i];
    // A card from before the start: a session of the same name that ended, not listed as such yet.
    if (card.updatedAt !== undefined && card.updatedAt < p.at) {
      left.push(p);
      continue;
    }
    // Not `working`: a card shown working by this pending turn is it (Claude's own working records have a turn start).
    if ((card.turnStartedAt !== undefined && card.turnStartedAt >= p.at) || card.state === 'waiting' || card.state === 'blocked' || card.state === 'done') continue;
    if (card.state === 'stopped' && age >= PENDING_STOPPED_MS) continue;
    if (card.state === 'idle' && card.updatedAt !== undefined && now - card.updatedAt >= PENDING_IDLE_MS) continue;
    left.push(p);
    next[i] = { ...card, state: 'working', detail: STARTING_DETAIL, prompt: p.prompt, updatedAt: card.updatedAt ?? p.at };
    changed = true;
  }
  return { cards: changed ? next : cards, pending: left };
}
