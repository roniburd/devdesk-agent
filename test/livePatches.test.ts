import { describe, expect, it } from 'vitest';
import {
  PENDING_IDLE_MS,
  PENDING_STOPPED_MS,
  PENDING_TURN_MS,
  type PendingTurn,
  STARTING_DETAIL,
  withPendingTurns,
  withRecord,
  withRecords,
} from '../src/core/livePatches';
import { type HookRecord, MOVED_DETAIL, type SessionCard } from '../src/core/sessions';
import { type Insight, withInsight, withInsights } from '../src/core/insights';

const NOW = 1_800_000_000_000;

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  sessionId: 's1',
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  state: 'done',
  detail: 'All tests pass.',
  prompt: 'run the tests',
  updatedAt: NOW - 10_000,
  attached: false,
  turnStartedAt: NOW - 60_000,
  turnEndedAt: NOW - 10_000,
  name: 'Tests',
  ...over,
});

const rec = (over: Partial<HookRecord> = {}): HookRecord => ({
  sessionId: 's1',
  pid: 100,
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  cwd: '/w',
  event: 'UserPromptSubmit',
  state: 'working',
  detail: 'Thinking',
  prompt: 'fix the build',
  updatedAt: NOW,
  turnStartedAt: NOW,
  ...over,
});

describe('withRecord', () => {
  it('takes the state, detail, prompt and turn times of a newer record, keeping the rest of the card', () => {
    const next = withRecord(card({ asksQuestion: true, insightSummary: 'Tests pass' }), rec());
    expect(next).toMatchObject({ state: 'working', detail: 'Thinking', prompt: 'fix the build', updatedAt: NOW, turnStartedAt: NOW, name: 'Tests', insightSummary: 'Tests pass' });
    expect(next.turnEndedAt).toBeUndefined();
    expect(next.asksQuestion).toBeUndefined();
  });

  it('keeps the card for a record that is not newer, another session, or a card without a live record', () => {
    const c = card();
    expect(withRecord(c, rec({ updatedAt: c.updatedAt! }))).toBe(c);
    expect(withRecord(c, rec({ sessionId: 's2' }))).toBe(c);
    for (const state of ['parked', 'stopped', 'unknown'] as const) {
      const other = card({ state });
      expect(withRecord(other, rec())).toBe(other);
    }
  });

  it('takes what the record waits on, and drops it once it waits no more', () => {
    const waiting = withRecord(card({ state: 'working' }), rec({ event: 'PermissionRequest', state: 'waiting', detail: 'Asking: which?', waitKind: 'question' }));
    expect(waiting.waitKind).toBe('question');
    expect(withRecord(waiting, rec({ updatedAt: NOW + 1 })).waitKind).toBeUndefined();
  });

  it('keeps the prompt when the record has none, and takes asksQuestion from it', () => {
    const next = withRecord(card({ state: 'working' }), rec({ event: 'Stop', state: 'done', detail: 'Shall I?', prompt: undefined, asksQuestion: true }));
    expect(next).toMatchObject({ prompt: 'run the tests', asksQuestion: true });
  });
});

describe('withRecord after the transcript', () => {
  it('keeps a card whose conversation moved to a background job', () => {
    const moved = card({ state: 'idle', detail: MOVED_DETAIL });
    expect(withRecord(moved, rec({ state: 'waiting', detail: 'Claude needs your permission' }))).toBe(moved);
    const byKind = card({ state: 'idle', detail: 'Moved on', endKind: 'moved' });
    expect(withRecord(byKind, rec({ state: 'waiting', detail: 'Claude needs your permission' }))).toBe(byKind);
  });

  it('takes the error and end kinds from the record, dropping those of the state it replaces', () => {
    const interrupted = card({ state: 'done', detail: 'Interrupted', endKind: 'interrupted' });
    const blocked = withRecord(interrupted, rec({ event: 'StopFailure', state: 'blocked', detail: 'rate_limit: slow down', errorKind: 'rate_limit' }));
    expect(blocked).toMatchObject({ state: 'blocked', errorKind: 'rate_limit' });
    expect(blocked).not.toHaveProperty('endKind');
    expect(withRecord(blocked, rec({ updatedAt: NOW + 1 }))).not.toHaveProperty('errorKind');
  });

  it("takes the question mark from the record, which keeps it when the same finished turn is rewritten", () => {
    const done = card({ asksQuestion: true });
    const reminder = rec({ event: 'Notification', state: 'done', detail: 'All tests pass.', prompt: undefined, turnStartedAt: done.turnStartedAt, turnEndedAt: done.turnEndedAt, asksQuestion: true });
    expect(withRecord(done, reminder).asksQuestion).toBe(true);
    expect(withRecord(done, { ...reminder, event: 'Stop', turnEndedAt: NOW, asksQuestion: undefined }).asksQuestion).toBeUndefined();
  });
});

describe('withRecords', () => {
  it('applies records by session id and returns the same array when none applies', () => {
    const cards = [card(), card({ id: 's2', sessionId: 's2' })];
    expect(withRecords(cards, new Map())).toBe(cards);
    expect(withRecords(cards, new Map([['s3', rec({ sessionId: 's3' })]]))).toBe(cards);
    const next = withRecords(cards, new Map([['s2', rec({ sessionId: 's2' })]]));
    expect(next.map((c) => c.state)).toEqual(['done', 'working']);
    expect(next[0]).toBe(cards[0]);
  });
});

describe('withPendingTurns', () => {
  const pending: PendingTurn = { server: 'devdesk', session: 'cc-main-2', prompt: 'add a test', at: NOW - 1000 };
  const starting = (over: Partial<SessionCard> = {}) =>
    card({ id: 'tmux:devdesk:%9', sessionId: undefined, tmuxSession: 'cc-main-2', tmuxPane: '%9', state: 'unknown', detail: 'no hooks', prompt: undefined, updatedAt: undefined, turnStartedAt: undefined, turnEndedAt: undefined, ...over });

  it('shows the started session as working on its prompt while Claude starts', () => {
    const done = card();
    for (const c of [starting(), starting({ id: 's9', sessionId: 's9', state: 'idle', detail: 'Ready', updatedAt: NOW - 500 }), starting({ state: 'stopped' })]) {
      const { cards, pending: left } = withPendingTurns([done, c], [pending], NOW);
      expect(cards[1]).toMatchObject({ state: 'working', detail: STARTING_DETAIL, prompt: 'add a test', updatedAt: c.updatedAt ?? pending.at });
      expect(cards[0]).toBe(done);
      expect(left).toEqual([pending]);
    }
  });

  it('keeps showing it when applied again to the cards it made', () => {
    const once = withPendingTurns([starting()], [pending], NOW);
    const twice = withPendingTurns(once.cards, once.pending, NOW + 100);
    expect(twice.pending).toEqual([pending]);
    expect(twice.cards[0]).toMatchObject({ state: 'working', detail: STARTING_DETAIL });
  });

  it('leaves the card of an ended session of the same name alone, still waiting for the new one', () => {
    const old = starting({ id: 's0', sessionId: 's0', state: 'done', updatedAt: pending.at - 5000 });
    expect(withPendingTurns([old], [pending], NOW)).toEqual({ cards: [old], pending: [pending] });
  });

  it('keeps waiting for a session not listed yet, and returns the same cards', () => {
    const cards = [card()];
    expect(withPendingTurns(cards, [pending], NOW)).toEqual({ cards, pending: [pending] });
    expect(withPendingTurns(cards, [pending], NOW).cards).toBe(cards);
  });

  it('ends once Claude reports a turn since the start, a question or an error', () => {
    const ended = [
      starting({ id: 's9', sessionId: 's9', state: 'working', detail: 'Thinking', turnStartedAt: NOW - 500 }),
      starting({ id: 's9', sessionId: 's9', state: 'idle', turnStartedAt: NOW - 500 }),
      starting({ id: 's9', sessionId: 's9', state: 'waiting', detail: 'Trust this folder?' }),
      starting({ id: 's9', sessionId: 's9', state: 'blocked', detail: 'Error' }),
      starting({ state: 'parked' }),
    ];
    for (const c of ended) {
      const { cards, pending: left } = withPendingTurns([c], [pending], NOW);
      expect(cards[0]).toBe(c);
      expect(left).toEqual(c.state === 'parked' ? [pending] : []);
    }
  });

  it('ends after its time limits, and only matches its own server', () => {
    expect(withPendingTurns([starting()], [{ ...pending, at: NOW - PENDING_TURN_MS }], NOW).pending).toEqual([]);
    expect(withPendingTurns([starting({ state: 'stopped' })], [{ ...pending, at: NOW - PENDING_STOPPED_MS }], NOW).pending).toEqual([]);
    // Idle since SessionStart for a while: the prompt started no turn. Before that, other SessionStart hooks may still run.
    const at = NOW - PENDING_IDLE_MS - 1000;
    const idle = starting({ id: 's9', sessionId: 's9', state: 'idle', updatedAt: at + 500 });
    expect(withPendingTurns([idle], [{ ...pending, at }], NOW)).toEqual({ cards: [idle], pending: [] });
    expect(withPendingTurns([idle], [{ ...pending, at }], NOW - 1000).cards[0]).toMatchObject({ state: 'working' });
    const other = starting({ tmuxServer: 'default' });
    expect(withPendingTurns([other], [pending], NOW).cards[0]).toBe(other);
  });
});

/** What the card of a refresh shows with a newer hook record read since, and its session's insight. */
function shown(c: SessionCard, record: HookRecord, insight: Insight | undefined): SessionCard {
  const [next] = withInsights(withRecords([c], new Map([[record.sessionId, record]])), new Map([[record.sessionId, insight]]));
  return next;
}

describe('a record patch with and without a matching insight', () => {
  const working = card({ state: 'working', turnStartedAt: NOW - 5000, turnEndedAt: undefined, updatedAt: NOW - 1000 });

  it('keeps the status for the same working turn only', () => {
    const insight: Insight = { statusFor: NOW - 5000, status: 'Editing', summary: 'Half done', title: 'Fix build' };
    const tool = rec({ event: 'PreToolUse', detail: 'Bash', turnStartedAt: NOW - 5000 });
    expect(shown(working, tool, insight)).toMatchObject({ liveStatus: 'Editing', insightSummary: 'Half done', insightTitle: 'Fix build', detail: 'Bash' });
    expect(shown(working, tool, undefined).liveStatus).toBeUndefined();
    const next = shown(working, rec({ turnStartedAt: NOW }), insight);
    expect(next.liveStatus).toBeUndefined();
    expect(next).toMatchObject({ insightSummary: 'Half done', insightTitle: 'Fix build', turnStartedAt: NOW });
    const done = shown(working, rec({ event: 'Stop', state: 'done', detail: 'Done', turnStartedAt: NOW - 5000, turnEndedAt: NOW }), insight);
    expect(done.liveStatus).toBeUndefined();
    expect(done.asksQuestion).toBeUndefined();
  });

  it('drops the ask of a wait that ended', () => {
    const waiting = card({ state: 'waiting', updatedAt: NOW - 1000, turnEndedAt: undefined });
    const insight: Insight = { askFor: NOW - 1000, ask: 'Approve the edit?' };
    expect(withInsight(waiting, insight).askSummary).toBe('Approve the edit?');
    expect(shown(waiting, rec({ event: 'PostToolUse', detail: 'Edit', turnStartedAt: waiting.turnStartedAt }), insight).askSummary).toBeUndefined();
    expect(shown(waiting, rec({ state: 'waiting', detail: 'Claude needs your permission' }), insight).askSummary).toBeUndefined();
  });

  it("keeps the insight's waiting-for-you answer when the same finished turn is rewritten", () => {
    const done = card();
    const reminder = rec({ event: 'Notification', state: 'done', detail: 'All tests pass.', prompt: undefined, turnStartedAt: done.turnStartedAt, turnEndedAt: done.turnEndedAt });
    expect(shown(done, { ...reminder, asksQuestion: true }, { doneFor: done.turnEndedAt, waitingForUser: false }).asksQuestion).toBeUndefined();
    expect(shown(done, reminder, { doneFor: done.turnEndedAt, waitingForUser: true }).asksQuestion).toBe(true);
    // An insight about another turn: the hook's heuristic, which the hook keeps when it rewrites the same turn.
    expect(shown(card({ asksQuestion: true }), { ...reminder, asksQuestion: true }, { doneFor: NOW - 99_000, waitingForUser: false }).asksQuestion).toBe(true);
  });

  it("takes a new finished turn's question mark from its record", () => {
    const done = card();
    const insight: Insight = { doneFor: done.turnEndedAt, waitingForUser: true };
    const stop = rec({ event: 'Stop', state: 'done', detail: 'Shall I?', turnStartedAt: NOW - 3000, turnEndedAt: NOW });
    expect(shown(done, stop, insight).asksQuestion).toBeUndefined();
    expect(shown(done, { ...stop, asksQuestion: true }, insight).asksQuestion).toBe(true);
    expect(shown(done, { ...stop, asksQuestion: true }, undefined).asksQuestion).toBe(true);
    expect(shown(done, stop, undefined).asksQuestion).toBeUndefined();
  });
});
