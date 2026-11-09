import type { BlockedKind, ProgramState, ProgramStatus } from './programStatus';
import { MOVED_DETAIL, type SessionCard, type SessionState, type WaitKind } from './sessions';

/**
 * How Claude's own report (OSC 7501, through the Program Status relay) and the hook record share a card. Hooks say
 * more (the prompt, the tool, the reply), so they win, except in two cases:
 *
 * - `ahead`: Claude reports, after the last hook event, that it waits for you (blocked) while the record still says
 *   working; or that it needs you to sign in (blocked, kind `auth`, which no hook reports) while the record says the
 *   turn ended. The card waits at once, with Claude's message, until a hook event catches up.
 * - `quiet`: the record says working or waiting, has not changed for `quietMs`, and Claude has since reported another
 *   state. A hook event was lost or never comes (a permission denied with Esc, a crash of the hook script): the card
 *   takes Claude's state. A wait the hooks recorded (tied to its tool call) only ends this way, never at once.
 *
 * A hook event newer than the report always wins. A record of a finished turn (done, ready, blocked) is quiet by
 * design, so only `ahead`'s sign-in overrides it. While a subagent reports blocked, Claude reporting working does not
 * end the hook's wait (the subagent's wait shows on its session's card). Either way the card says where its state came
 * from (`statusFrom`), and the next hook event takes it back.
 */
export interface MergeOptions {
  now: number;
  /** How long a working or waiting hook record must be unchanged before Claude's report replaces it; 0: never. */
  quietMs: number;
}

/** Where a card's state came from when it is Claude's report on a hooked card, and the hook record's time. */
export type StatusFrom = NonNullable<SessionCard['statusFrom']>;

type Phase = 'working' | 'waiting' | 'ended';

const HOOK_PHASES: Partial<Record<SessionState, Phase>> = { working: 'working', waiting: 'waiting', done: 'ended', idle: 'ended', blocked: 'ended' };
const REPORT_PHASES: Record<ProgramState, Phase> = { working: 'working', blocked: 'waiting', done: 'ended', idle: 'ended', error: 'ended' };

/** Which rule lets `status` replace the hooked `card`'s state, or undefined when the hook record keeps it. */
export function mergeReason(card: SessionCard, status: ProgramStatus, o: MergeOptions): StatusFrom['reason'] | undefined {
  const hook = HOOK_PHASES[card.state];
  if (!hook || card.updatedAt === undefined || card.detail === MOVED_DETAIL) return undefined;
  // A hook event newer than the report wins.
  if (status.at <= card.updatedAt) return undefined;
  const reported = REPORT_PHASES[status.state];
  if (hook === reported) return undefined;
  if (hook === 'waiting' && reported === 'working' && status.blockedChildren) return undefined;
  if (status.state === 'blocked' && (hook === 'working' || (hook === 'ended' && status.kind === 'auth'))) return 'ahead';
  if (hook !== 'ended' && o.quietMs > 0 && o.now - card.updatedAt >= o.quietMs) return 'quiet';
  return undefined;
}

const KIND_DETAIL: Record<BlockedKind, string> = {
  permission: 'Waiting for your approval',
  question: 'Waiting for your answer',
  auth: 'Waiting for you to sign in',
};
/** A sign-in is input the user gives, shown like an MCP server's input form. */
const KIND_WAITS: Record<BlockedKind, WaitKind> = { permission: 'permission', question: 'question', auth: 'elicitation' };

/**
 * `card` in the state `status` reports: working; waiting (blocked on a permission, a question or a sign-in, which needs
 * you); done or idle at the prompt; blocked (an error). Claude's message is the detail.
 */
export function reportedCard(card: SessionCard, status: ProgramStatus): SessionCard {
  const base: SessionCard = { ...card, updatedAt: status.at };
  delete base.waitKind;
  switch (status.state) {
    case 'working':
      return { ...base, state: 'working', detail: status.msg ?? 'Working' };
    case 'blocked':
      return {
        ...base,
        state: 'waiting',
        detail: status.msg ?? (status.kind ? KIND_DETAIL[status.kind] : 'Waiting for you'),
        ...(status.kind ? { waitKind: KIND_WAITS[status.kind] } : {}),
      };
    case 'error':
      return { ...base, state: 'blocked', detail: status.msg ?? 'Error' };
    case 'done':
      return { ...base, state: 'done', detail: status.msg ?? 'Finished its turn' };
    case 'idle':
      return { ...base, state: 'idle', detail: status.msg ?? 'At the prompt' };
  }
}

/** The hooked `card` with `status` merged in by the rules above (`card` itself when the hook record keeps it). */
export function mergedCard(card: SessionCard, status: ProgramStatus, o: MergeOptions): SessionCard {
  const reason = mergeReason(card, status, o);
  if (!reason) return card;
  const next: SessionCard = { ...reportedCard(card, status), statusFrom: { reason, hookAt: card.updatedAt! } };
  // What the hook record or an insight said about its turn or wait no longer describes this state.
  delete next.askSummary;
  if (next.state !== 'working') delete next.liveStatus;
  if (next.state !== 'done') delete next.asksQuestion;
  return next;
}

/** The hover line of a card whose state is Claude's report (`statusFrom`); undefined for others. */
export function statusFromText(card: SessionCard, now: number): string | undefined {
  const from = card.statusFrom;
  if (!from) return undefined;
  if (from.reason === 'ahead') return "Status from Claude: its hooks haven't reported this yet";
  const minutes = Math.max(1, Math.round((now - from.hookAt) / 60_000));
  return `Status from Claude, hooks quiet (no hook event for ${minutes} min)`;
}
